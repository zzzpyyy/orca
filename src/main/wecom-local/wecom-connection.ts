// One bot's WeCom connection: admits only the owner's messages in chats paired with a code, hands each
// to the bot's chat and streams its answer. A refused Secret or a takeover ends it until reconnect.
import type { WecomLocalState, WecomLocalStatus } from '../../shared/bots/wecom-local'
import type { Bot } from '../../shared/bot-types'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import type { ImStreamDegrade } from '../im-stream/im-stream-live'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { admitWecomArrival } from './wecom-arrivals'
import { wecomConversation, type WecomBinding } from './wecom-binding'
import { deliverWecomMessages } from './wecom-delivery'
import type { WecomArrival } from './wecom-inbox-rows'
import { keepWecomLinked } from './wecom-link'
import { readWecomCallback } from './wecom-message'
import { WecomPairing } from './wecom-pairing'
import { sendWecomReplies, wecomReplyJournal } from './wecom-replies'
import { WecomReplyStreams } from './wecom-reply-streams'
import type { WecomInboundFrame, WecomSocket } from './wecom-socket'
import { wecomLocalStateOf } from './wecom-status'
import type { WecomStore } from './wecom-store-ops'

const RETRY_MS = 15_000

export type WecomConnectionDeps = {
  runtime: OrcaRuntimeService
  store: WecomStore
  binding: WecomBinding
  /** Null when the saved Secret no longer opens here. */
  secret: string | null
  url: string
  loopback: boolean
}

export class WecomConnection {
  private readonly controller = new AbortController()
  private readonly signal = this.controller.signal
  private socket: WecomSocket | null = null
  private phase: WecomLocalStatus = 'connecting'
  private readonly pairing = new WecomPairing((kind) => {
    if (kind === 'dm' && !this.binding.owner) {
      this.setPhase('expired')
      this.controller.abort()
      this.socket?.close()
    } else {
      this.changed()
    }
  })
  private readonly streams: WecomReplyStreams
  private inbound: Promise<void> = Promise.resolve()
  private listening: Promise<void> | undefined
  private work: Promise<void> | undefined
  private again = false
  private retry: NodeJS.Timeout | undefined
  private release: (() => void) | undefined
  private streamProblem: Exclude<ImStreamDegrade, 'expired'> | undefined
  private replyError: number | undefined
  readonly binding: WecomBinding
  /** A proactive WeCom message on this connection, for the owner's resend. */
  readonly push = (chat: string, text: string): Promise<void> => this.streams.push(chat, text)

  constructor(private readonly deps: WecomConnectionDeps) {
    this.binding = deps.binding
    this.streams = new WecomReplyStreams(
      deps.binding.account,
      () => this.socket,
      (problem) => {
        this.streamProblem = problem
        this.changed()
      }
    )
  }

  start(pair: boolean): void {
    if (!this.deps.secret) {
      this.setPhase('secret-unreadable')
      return
    }
    if (pair) {
      this.pairing.begin('dm')
    } else if (!this.binding.owner) {
      this.setPhase('expired')
      return
    }
    this.watch()
    this.listening = this.listen(this.deps.secret)
    this.wake()
  }

  /** The owner's next code, sent in a group with the bot, adds that group; false before the DM pairs. */
  pairGroup(): boolean {
    if (!this.binding.owner || this.signal.aborted) {
      return false
    }
    this.pairing.begin('group')
    this.changed()
    return true
  }

  watch(): void {
    this.release?.()
    this.release = undefined
    if (this.signal.aborted || !this.binding.owner) {
      return
    }
    try {
      this.release = this.deps.runtime
        .getExternalConversationSeam()
        ?.watch(runtimeConversationHost(this.deps.runtime), (event) => {
          if (event.kind === 'turn-ended' && event.conversation.source === 'wecom-local') {
            this.wake()
          }
        })
    } catch {
      // Connectors are off; repliesFilled still wakes the outbox.
    }
  }

  async state(): Promise<WecomLocalState> {
    const { account, owner } = this.binding
    const [counts, chats] = await Promise.all([
      this.deps.store.counts(account),
      this.deps.store.chats(account)
    ])
    const bot = this.bot()
    const seam = this.deps.runtime.getExternalConversationSeam()
    return wecomLocalStateOf({
      binding: this.binding,
      phase: this.phase,
      botTakes: bot !== null,
      counts,
      chats,
      pairing: this.pairing.shown,
      streamProblem: this.streamProblem,
      replyError: this.replyError,
      sessionId:
        owner && bot
          ? seam?.linkedChat(wecomConversation(this.binding, owner), bot.id)?.sessionId
          : undefined
    })
  }

  async dismiss(): Promise<void> {
    await this.deps.store.dismiss(this.binding.account)
    this.replyError = undefined
    this.streamProblem = undefined
    this.changed()
  }

  async stop(): Promise<void> {
    this.controller.abort()
    this.pairing.clear()
    clearTimeout(this.retry)
    this.release?.()
    this.socket?.close()
    this.streams.drop(null)
    await Promise.allSettled([this.listening, this.work, this.inbound])
  }

  /** Delivers what is ready and sends what is owed; once at a time, again if woken meanwhile. */
  wake(): void {
    if (this.signal.aborted || !this.binding.owner || this.retry) {
      return
    }
    if (this.work) {
      this.again = true
      return
    }
    this.work = this.drain()
      .then((retry) => {
        if (retry) {
          this.retryLater()
        }
      })
      .catch(() => this.retryLater())
      .finally(() => {
        this.work = undefined
        if (this.again) {
          this.again = false
          this.wake()
        }
      })
  }

  private bot(): Bot | null {
    const { runtime } = this.deps
    return (
      (runtime.bots.enabled() &&
        runtime.bots.list().find((bot) => bot.id === this.binding.bot && !bot.paused)) ||
      null
    )
  }

  private changed(): void {
    this.deps.runtime.notifyBotsChanged({ botIds: [this.binding.bot], kinds: ['settings'] })
  }

  private setPhase(phase: WecomLocalStatus): void {
    if (phase !== this.phase) {
      this.phase = phase
      this.changed()
    }
  }

  private retryLater(): void {
    if (this.signal.aborted || this.retry) {
      return
    }
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.wake()
    }, RETRY_MS)
    this.retry.unref?.()
  }

  private async listen(secret: string): Promise<void> {
    const end = await keepWecomLinked({
      url: this.deps.url,
      botKey: this.binding.botKey,
      secret,
      signal: this.signal,
      onFrame: (socket, frame) => this.framed(socket, frame),
      onPhase: (phase) => this.setPhase(phase),
      onOpen: (socket) => {
        this.socket = socket
        this.setPhase(this.binding.owner ? 'listening' : 'pairing')
        // An earlier connection's streams can't be edited from this one: their answers are pushed.
        this.streams.drop(socket)
        this.wake()
      },
      onClose: (socket) => {
        if (this.socket === socket) {
          this.socket = null
        }
      }
    })
    if (end !== 'stopped' && !this.signal.aborted) {
      // Over until the owner reconnects: what is owed waits in the inbox.
      this.setPhase(end)
      this.controller.abort()
      clearTimeout(this.retry)
      this.streams.drop(null)
    }
  }

  private framed(socket: WecomSocket, frame: WecomInboundFrame): void {
    if (frame.cmd !== 'aibot_msg_callback') {
      return
    }
    const arrival = readWecomCallback(frame.headers.req_id, frame.body)
    if (!arrival) {
      return
    }
    const at = Date.now()
    this.inbound = this.inbound
      .then(() => this.received(socket, arrival, at))
      .catch(() => console.warn('[wecom] Could not keep a WeCom message'))
  }

  private async received(socket: WecomSocket, arrival: WecomArrival, at: number): Promise<void> {
    if (this.signal.aborted) {
      return
    }
    const outcome = await admitWecomArrival(
      {
        store: this.deps.store,
        binding: this.binding,
        pairing: this.pairing,
        botTakes: this.bot() !== null
      },
      socket,
      arrival,
      at
    )
    if (outcome.kind === 'paired') {
      if (outcome.chat === 'single') {
        this.setPhase('listening')
        this.watch()
      }
      this.changed()
    } else if (outcome.kind === 'kept' && outcome.fresh && socket === this.socket) {
      this.streams.open(socket, arrival, at, outcome.ahead, outcome.notice === null)
    }
    this.wake()
  }

  /** Answers first, so a chat's finished turn lets its next message go; then deliveries. */
  private async drain(): Promise<boolean> {
    let retry = await this.sendOwed()
    if (this.bot() && !this.signal.aborted) {
      const delivered = await deliverWecomMessages({
        runtime: this.deps.runtime,
        store: this.deps.store,
        binding: this.binding,
        signal: this.signal,
        loopback: this.deps.loopback,
        bot: () => this.bot(),
        changed: () => this.changed(),
        admitted: ({ mid, sessionId, messageId }) => {
          this.streams.follow(mid, sessionId, messageId)
          // Its turn may already have ended (a delivery replayed after a restart).
          this.again = true
        }
      })
      retry ||= delivered === 'retry'
    }
    return retry
  }

  private async sendOwed(): Promise<boolean> {
    if (!this.socket?.ready) {
      // Sent once connected: connecting wakes the outbox.
      return false
    }
    const journal = await wecomReplyJournal(this.deps.runtime)
    if (!journal) {
      return true
    }
    const result = await sendWecomReplies(journal, {
      store: this.deps.store,
      binding: this.binding,
      signal: this.signal,
      port: this.streams.port,
      prepare: (row) => this.streams.prepare(row),
      releaseStream: (mid) => this.streams.release(mid),
      done: (mid) => this.streams.finished(mid)
    })
    if (result.errcode !== this.replyError) {
      this.replyError = result.errcode
      this.changed()
    }
    return result.retry
  }
}
