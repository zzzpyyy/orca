// A received DingTalk message's way into its chat: kept in the ledger first, its images and files
// fetched once, then sent to the linked chat or a new one, which also replaces a chat deleted in
// Orca. Each step's state is in the ledger, so a restart picks the message up where it stopped.
import type { Bot } from '../../shared/bot-types'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import {
  schemas,
  stableSendUuid,
  type ConversationRow,
  type DingTalkBinding,
  type DingTalkInbound,
  type DingTalkSetup,
  type InboxRow
} from './dingtalk-domain'
import { bindingBotId, bindingFor, decideInbound } from './dingtalk-inbound'
import type { DingTalkLedger } from './dingtalk-ledger'
import { conversationKey } from './dingtalk-local-conversation'
import { replayDingTalkInbox } from './dingtalk-local-recovery'
import { prepareDingTalkMessage } from './dingtalk-media'
import { replyTarget } from './dingtalk-reply-delivery'
import type { DingTalkTurnDeliveries } from './dingtalk-turns'
import type { DwsBoundary } from './dws/dingtalk-dws-boundary'
import { fetchDwsResources, sendDwsMarkdown } from './dws/dingtalk-dws-messages'

export type DingTalkInboxDeps = {
  ledger: DingTalkLedger
  dws: Pick<DwsBoundary, 'exec'>
  seam: () => ExternalConversationSeam | null
  host: () => ExternalConversationHost
  bots: () => readonly Bot[]
  setup: () => DingTalkSetup | null
  turns: DingTalkTurnDeliveries
  /** Saves a fetched file where the chat can read it; its path. */
  storeFile: (name: string, bytes: Buffer) => Promise<string>
  onError: (error: unknown) => void
  /** A conversation's chat is linked or changed. */
  onLinked: () => void
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The connector ref a message's asker carries; the journal hands it back on a joined message. */
export const dingTalkMessageRef = (event: Pick<DingTalkInbound, 'groupId' | 'messageId'>): string =>
  `dingtalk:${event.groupId}:${event.messageId}`

function askerFor(binding: DingTalkBinding, event: DingTalkInbound, body: string): ConnectorAsker {
  const person = { userId: event.senderOpenId, name: event.senderName || undefined }
  const said = { text: body, context: [], messageRef: dingTalkMessageRef(event) }
  return binding.kind === 'dm'
    ? {
        ...person,
        role: binding.dm.owner ? 'owner' : 'member',
        place: { kind: 'direct_message', id: binding.dm.openDingTalkId },
        ...said
      }
    : { ...person, role: 'member', place: { kind: 'group_message', id: event.groupId }, ...said }
}

const labelOf = (binding: DingTalkBinding, event: DingTalkInbound): string =>
  (binding.kind === 'dm' ? binding.dm.name || event.senderName : binding.group.name) || ''

export class DingTalkInbox {
  constructor(private readonly deps: DingTalkInboxDeps) {}

  async receive(event: DingTalkInbound): Promise<void> {
    const setup = this.deps.setup()
    if (!setup?.enabled) {
      return
    }
    const decision = decideInbound(setup, event)
    if (decision.kind === 'drop') {
      return
    }
    const key = `${event.profile}\u0000${event.messageId}`
    const { ledger } = this.deps
    const inserted = await ledger.putInbox({
      key,
      event,
      externalId: decision.externalId,
      body: decision.body,
      state: 'pending',
      deliveryId: decision.deliveryId,
      reason: '',
      updatedAt: Date.now()
    })
    if (!inserted) {
      return
    }
    const known = ledger.snapshot().conversations[decision.externalId]
    const { binding } = decision
    await ledger.putConversation({
      externalId: decision.externalId,
      profile: event.profile,
      groupId: event.groupId,
      conversationId: schemas.ConversationId.parse(event.conversationId),
      botId: bindingBotId(binding),
      sessionId: known?.sessionId ?? '',
      latestMessageId: event.messageId,
      updatedAt: Date.now(),
      ...(binding.kind === 'dm' ? { dmOpenId: binding.dm.openDingTalkId } : {}),
      label: labelOf(binding, event)
    })
    await this.deliver(key)
  }

  /** Every pending row whose binding still stands, as after a restart or a setup change. */
  replay(): void {
    const setup = this.deps.setup()
    if (setup?.enabled) {
      replayDingTalkInbox(this.deps.ledger, (inboxKey) =>
        this.deliver(inboxKey).catch(this.deps.onError)
      )
    }
  }

  async deliver(inboxKey: string): Promise<void> {
    const { ledger } = this.deps
    const setup = this.deps.setup()
    const pending = ledger.snapshot().inbox[inboxKey]
    // Authorized again at delivery: a person or group the setup dropped since gets nothing in.
    const binding = pending && setup?.enabled ? bindingFor(setup, pending.event) : null
    if (!pending || pending.state !== 'pending' || !binding) {
      return
    }
    // A replay and a live event can race for one pending row; the loser stops here.
    try {
      await ledger.transitionInbox(inboxKey, 'pending', 'delivering')
    } catch (error) {
      this.deps.onError(error)
      return
    }
    try {
      const row = pending.prepared ? pending : await this.prepare(pending, binding)
      if (!row.body) {
        await ledger.transitionInbox(inboxKey, 'delivering', 'filtered', { reason: 'empty' })
        return
      }
      await this.send(row, binding)
    } catch (error) {
      if (ledger.snapshot().inbox[inboxKey]?.state === 'delivering') {
        await ledger.transitionInbox(inboxKey, 'delivering', 'failed', {
          reason: messageOf(error).slice(0, 300)
        })
      }
    }
    if (
      this.deps.turns.landed(inboxKey) &&
      ledger.snapshot().inbox[inboxKey]?.state === 'delivered'
    ) {
      await ledger.transitionInbox(inboxKey, 'delivered', 'attributed')
    }
  }

  /** Fetches the message's images and files once; what can't be read is said to the asker too. */
  private async prepare(row: InboxRow, binding: DingTalkBinding): Promise<InboxRow> {
    const { dws, ledger } = this.deps
    const prepared = await prepareDingTalkMessage(
      {
        fetch: (profile, messageId, dir) => fetchDwsResources(dws, profile, messageId, dir),
        store: this.deps.storeFile
      },
      row.event,
      row.body
    )
    if (prepared.unread.length > 0) {
      await this.tellUnread(row, binding, prepared.unread, Boolean(prepared.body))
    }
    await ledger.patchInbox(row.key, {
      body: prepared.body,
      images: prepared.images,
      prepared: true
    })
    return ledger.snapshot().inbox[row.key]!
  }

  private async tellUnread(
    row: InboxRow,
    binding: DingTalkBinding,
    unread: readonly string[],
    rest: boolean
  ): Promise<void> {
    const target = replyTarget(this.deps.setup(), {
      profile: row.event.profile,
      groupId: row.event.groupId,
      dmOpenId: binding.kind === 'dm' ? binding.dm.openDingTalkId : undefined
    })
    if (!target) {
      return
    }
    const text = `（Orca 读不了这条消息里的：${unread.join('、')}${rest ? '；其余内容已转给 Orca。' : '。'}）`
    const uuid = stableSendUuid(`${row.key}:unread`)
    const outcome = await sendDwsMarkdown(this.deps.dws, row.event.profile, target, text, uuid)
    if (outcome.kind !== 'sent') {
      this.deps.onError(new Error(`unread notice not sent: ${outcome.error}`))
    }
  }

  private async send(row: InboxRow, binding: DingTalkBinding): Promise<void> {
    const { ledger } = this.deps
    const seam = this.deps.seam()
    if (!seam) {
      await ledger.transitionInbox(row.key, 'delivering', 'failed', {
        reason: 'connectors_disabled'
      })
      return
    }
    const botId = bindingBotId(binding)
    const bot = this.deps.bots().find((entry) => entry.id === botId)
    if (!bot) {
      throw new Error(`DingTalk bot not found: ${botId}`)
    }
    const key = conversationKey(row.externalId)
    const host = this.deps.host()
    const asker = askerFor(binding, row.event, row.body)
    const images = row.images?.length ? { storedImages: row.images } : {}
    let linked = seam.linkedChat(key, botId)
    // Its chat was deleted in Orca: the message starts a new one instead of going nowhere.
    if (linked && (await seam.goneChats.linkedChatOf(host, key)) === 'gone') {
      seam.goneChats.release(key)
      linked = null
    }
    const result = linked
      ? await seam.send(host, key, row.deliveryId, { text: row.body, asker, ...images })
      : (
          await seam.start(host, key, row.deliveryId, {
            agent: bot.agent,
            target: { kind: 'bot', botId },
            prompt: row.body,
            asker,
            ...images
          })
        ).initial
    await (result.outcome === 'accepted'
      ? ledger.transitionInbox(row.key, 'delivering', 'delivered')
      : ledger.transitionInbox(row.key, 'delivering', 'failed', { reason: result.reason }))
    await this.recordChat(row, seam.linkedChat(key)?.sessionId ?? '')
  }

  private async recordChat(row: InboxRow, sessionId: string): Promise<void> {
    const conversation: ConversationRow | undefined =
      this.deps.ledger.snapshot().conversations[row.externalId]
    if (conversation && sessionId && conversation.sessionId !== sessionId) {
      await this.deps.ledger.putConversation({ ...conversation, sessionId, updatedAt: Date.now() })
      this.deps.onLinked()
    }
  }
}
