// Hands an allowed chat's next message to its native chat through the external conversation seam,
// one at a time per chat so each message gets a turn of its own. A message the chat can't take is
// owed its own notice instead, never dropped.
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import type { Delivery } from '../external-conversations/external-conversation-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Bot } from '../../shared/bot-types'
import { wecomConversation, type WecomBinding } from './wecom-binding'
import { WECOM_COPY } from './wecom-copy'
import { wecomInput } from './wecom-input'
import type { WecomStore } from './wecom-store-ops'

const NOTE =
  'Your final answer is sent back to the owner in WeCom (企业微信), which shows Markdown. You cannot send files there.'

export type WecomAdmitted = { mid: string; sessionId: string; messageId: string }

export type WecomDeliveryDeps = {
  runtime: OrcaRuntimeService
  store: WecomStore
  binding: WecomBinding
  signal: AbortSignal
  /** Media URLs may name this machine while a local mock stands in for WeCom. */
  loopback: boolean
  bot: () => Bot | null
  changed: () => void
  admitted: (admitted: WecomAdmitted) => void
}

const RETRY_LATER = new Set(['delivery_backlog_full', 'connectors_disabled'])

/** Delivers until no chat has a message ready; 'retry' when the seam asked to wait. */
export async function deliverWecomMessages(deps: WecomDeliveryDeps): Promise<'retry' | null> {
  const { runtime, store, binding: b, signal } = deps
  const seam = runtime.getExternalConversationSeam()
  if (!seam || !b.owner) {
    return null
  }
  const owner = b.owner
  const host = runtimeConversationHost(runtime)
  for (let row = await store.next(b.account); row && !signal.aborted;) {
    const bot = deps.bot()
    if (!bot) {
      return null
    }
    const input = await wecomInput(row, bot.agent, signal, deps.loopback)
    if (JSON.stringify(input.body.media) !== JSON.stringify(row.body.media)) {
      await store.body(b.account, row.mid, input.body)
    }
    const key = wecomConversation(b, row.chat)
    const mid = row.mid
    if ((await seam.goneChats.linkedChatOf(host, key)) === 'gone') {
      seam.goneChats.release(key)
    }
    const start = async (): Promise<Delivery> =>
      (
        await seam.start(host, key, mid, {
          agent: bot.agent,
          target: { kind: 'bot', botId: bot.id },
          prompt: input.prompt,
          note: NOTE,
          storedImages: input.storedImages,
          transportSignal: signal,
          asker: {
            userId: owner.slice(0, 128),
            role: 'owner',
            place: {
              kind: row!.chat_kind === 'group' ? 'group_message' : 'direct_message',
              id: row!.chat
            },
            text: input.prompt,
            context: []
          },
          reply: { account: b.account }
        })
      ).initial
    let initial = await start()
    // The chat was deleted after the check: its link goes, and the message opens a new chat.
    if (initial.outcome === 'refused' && initial.reason === 'chat_gone') {
      seam.goneChats.release(key)
      initial = await start()
    }
    if (signal.aborted) {
      return null
    }
    if (initial.outcome === 'refused') {
      if (RETRY_LATER.has(initial.reason)) {
        return 'retry'
      }
      const text =
        initial.reason === 'bot_paused' || initial.reason === 'bot_not_found'
          ? WECOM_COPY.paused
          : WECOM_COPY.refused(initial.reason)
      await store.owe(b.account, mid, 'review', text)
      deps.changed()
    } else {
      const admitted = await replyRowOf(seam.linkedChat(key, bot.id)?.sessionId, b.account, mid)
      if (admitted) {
        await store.admitted(b.account, mid, input.notice)
        deps.admitted(admitted)
        deps.changed()
      } else {
        // No outbox row means no answer would ever come: the owner is told instead.
        await store.owe(b.account, mid, 'review', WECOM_COPY.unconfirmedDelivery)
        deps.changed()
      }
    }
    row = await store.next(b.account)
  }
  return null
}

async function replyRowOf(
  sessionId: string | undefined,
  account: string,
  mid: string
): Promise<WecomAdmitted | null> {
  const journal = getStructuredAgentSessionHost()?.deps.store.connectorReplies()
  if (!sessionId || !journal) {
    return null
  }
  const row = (await journal.read(sessionId)).find(
    (entry) => entry.account === account && entry.deliveryId === mid
  )
  return row ? { mid, sessionId, messageId: row.messageId } : null
}
