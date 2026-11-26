// Every reply the connector posts to DingTalk: a card that opens when an IM-started turn begins and
// follows it, then the answer in it and in continuation messages; or, with streaming off, no card
// or a refused one, the answer as messages. Each part has its own dws uuid and the ledger records
// how many landed, so a retry or a restart sends the rest and never a part twice.
import { ImReplyStream, type ImStreamPhase, type ImStreamPort } from '../im-stream/im-reply-stream'
import { imAnswerText } from '../im-stream/im-turn-view'
import { watchImTurn, type ImTurnJournal, type ImTurnWatch } from '../im-stream/im-turn-watch'
import {
  stableReplyId,
  stableSendUuid,
  type ConversationRow,
  type DingTalkProfile,
  type DingTalkSetup,
  type ReplyRow
} from './dingtalk-domain'
import type { DingTalkLedger } from './dingtalk-ledger'
import type { DwsBoundary } from './dws/dingtalk-dws-boundary'
import {
  openDwsCard,
  sendDwsMarkdown,
  updateDwsCard,
  type DwsCardFlow,
  type DwsTarget
} from './dws/dingtalk-dws-messages'

/** Characters one message or card carries; DingTalk's own limit is larger but undocumented for
 *  dws, so a long answer splits well under it. */
export const DINGTALK_REPLY_CHARS = 3_500
const RETRY_MS = [2_000, 8_000]
const FLOW: Record<ImStreamPhase, DwsCardFlow> = { progress: 2, done: 3, failed: 5 }

/** Where a reply to `row` may go: its group or person, while the setup still lets them in. */
export function replyTarget(
  setup: DingTalkSetup | null,
  row: Pick<ConversationRow | ReplyRow, 'profile' | 'groupId' | 'dmOpenId'>
): DwsTarget | null {
  if (!setup?.enabled || !setup.autoReply) {
    return null
  }
  if (row.dmOpenId) {
    const dm = setup.dms.find(
      (entry) => entry.profile === row.profile && entry.openDingTalkId === row.dmOpenId
    )
    return dm ? { kind: 'dm', openDingTalkId: dm.openDingTalkId } : null
  }
  const group = setup.groups.find(
    (entry) => entry.profile === row.profile && entry.groupId === row.groupId
  )
  return group ? { kind: 'group', groupId: group.groupId } : null
}

export type DingTalkRepliesDeps = {
  ledger: DingTalkLedger
  dws: Pick<DwsBoundary, 'exec'>
  setup: () => DingTalkSetup | null
  journal: () => ImTurnJournal | null
  /** The chat a conversation is linked to now. */
  sessionOf: (row: ConversationRow) => string | null
  /** Why a reply lost its card or could not be sent; for the connector's status. */
  onDegraded: (reason: string) => void
  delay?: (ms: number) => Promise<void>
}

type Live = { stream: ImReplyStream; watch: ImTurnWatch | null; held?: true }

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300)

export class DingTalkReplies {
  private readonly live = new Map<string, Live>()
  private readonly sending = new Set<string>()

  constructor(private readonly deps: DingTalkRepliesDeps) {}

  private port(profile: DingTalkProfile, target: DwsTarget, card: boolean): ImStreamPort {
    const { dws } = this.deps
    return {
      ...(card
        ? { open: (placeholder: string) => openDwsCard(dws, profile, target, placeholder) }
        : {}),
      update: (handle, content, phase) => updateDwsCard(dws, profile, handle, content, FLOW[phase]),
      send: async (text, key) => {
        const outcome = await sendDwsMarkdown(dws, profile, target, text, stableSendUuid(key))
        if (outcome.kind !== 'sent') {
          throw new Error(outcome.error || 'dws did not send')
        }
      }
    }
  }

  private stream(key: string, profile: DingTalkProfile, target: DwsTarget, card: boolean) {
    return new ImReplyStream({
      port: this.port(profile, target, card),
      store: {
        read: () => this.deps.ledger.stream(key),
        write: (record) => this.deps.ledger.putStream(key, record)
      },
      key,
      maxChars: DINGTALK_REPLY_CHARS,
      onDegraded: this.deps.onDegraded
    })
  }

  /** An IM-started turn began: its reply card opens now and shows the turn's progress. */
  begin(conversation: ConversationRow, at: number): void {
    const key = stableReplyId(conversation.externalId, at)
    const setup = this.deps.setup()
    const target = replyTarget(setup, conversation)
    if (!target || !setup?.streaming || this.live.has(key) || this.deps.ledger.stream(key)) {
      return
    }
    const stream = this.stream(key, conversation.profile, target, true)
    const live: Live = { stream, watch: null }
    this.live.set(key, live)
    const sessionId = this.deps.sessionOf(conversation)
    const journal = this.deps.journal()
    void stream.begin().then(() => {
      // The answer may have landed while the card opened, or a newer turn replaced this one.
      if (this.live.get(key) !== live || live.held || !sessionId || !journal) {
        return
      }
      live.watch = watchImTurn(journal, sessionId, at, (view) => stream.progress(view))
    })
  }

  /** A turn a newer one replaced: its card stops following and shows `text` until that turn ends
   *  (settle), or until its own end is heard after all (send). */
  hold(key: string, text: string): void {
    const live = this.live.get(key)
    if (!live) {
      return
    }
    live.held = true
    live.watch?.stop()
    live.watch = null
    live.stream.note(text)
  }

  /** The journal id of the turn a reply's card follows, once seen. */
  turnItemId(key: string): string | null {
    return this.live.get(key)?.watch?.turnItemId() ?? null
  }

  /** A streamed turn that ended with no answer to post: its card says how it went. */
  async settle(key: string, text: string, phase: 'done' | 'failed'): Promise<void> {
    const live = this.live.get(key)
    if (!live) {
      return
    }
    this.drop(key)
    await live.stream.finish(text, phase).catch((error: unknown) => {
      this.deps.onDegraded(`reply card not closed: ${reasonOf(error)}`)
    })
  }

  /** Posts a queued reply: into its live card, else as messages; retried, then marked failed. */
  async send(reply: ReplyRow): Promise<void> {
    const target = replyTarget(this.deps.setup(), reply)
    if (!target || this.sending.has(reply.key)) {
      return
    }
    this.sending.add(reply.key)
    const { ledger } = this.deps
    try {
      await ledger.transitionReply(reply.key, 'queued', 'sending')
      const stream =
        this.live.get(reply.key)?.stream ?? this.stream(reply.key, reply.profile, target, false)
      this.drop(reply.key)
      const delay = this.deps.delay ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
      for (let attempt = 0; ; attempt++) {
        try {
          // Masked as its progress was, so the final shows no key the card hid.
          await stream.finish(imAnswerText(reply.text))
          break
        } catch (error) {
          if (attempt >= RETRY_MS.length) {
            throw error
          }
          await delay(RETRY_MS[attempt]!)
        }
      }
      await ledger.transitionReply(reply.key, 'sending', 'sent', { error: '' })
      const record = ledger.stream(reply.key)
      // Posted as the setup asks, so an older reply's fallback reason no longer holds.
      if (
        record &&
        !record.error &&
        !record.cardRefused &&
        (record.handle || !this.deps.setup()?.streaming)
      ) {
        this.deps.onDegraded('')
      }
    } catch (error) {
      const reason = reasonOf(error)
      this.deps.onDegraded(`reply not sent: ${reason}`)
      if (ledger.snapshot().replies[reply.key]?.state === 'sending') {
        await ledger.transitionReply(reply.key, 'sending', 'failed', { error: reason })
      }
    } finally {
      this.sending.delete(reply.key)
    }
  }

  private drop(key: string): void {
    const live = this.live.get(key)
    live?.watch?.stop()
    this.live.delete(key)
  }

  /** Stops every card's progress; their records stay, so the next start finishes them. */
  async stop(): Promise<void> {
    const active = [...this.live.values()]
    this.live.clear()
    await Promise.all(
      active.map(async (live) => {
        live.watch?.stop()
        await live.stream.close()
      })
    )
  }
}
