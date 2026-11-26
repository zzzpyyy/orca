// The reply WeCom shows for one message from the moment it arrives: a stream message opened at once
// ("received" or "queued"), edited with the turn's progress at most once a second, and finished with
// the answer while WeCom still takes edits. Only the connection that received the message can edit
// it; past its window, or once WeCom refuses edits, the answer goes as pushed messages.
import { setTimeout as delay } from 'node:timers/promises'
import { ImLiveStream, type ImStreamDegrade } from '../im-stream/im-stream-live'
import { renderImProgress } from '../im-stream/im-stream-progress'
import { IM_STREAM_MIN_GAP_MS } from '../im-stream/im-stream-throttle'
import { EMPTY_IM_TURN_VIEW, type ImTurnView } from '../im-stream/im-stream-turn-view'
import { clampUtf8TextTail, isUtf8ByteLengthWithinLimit } from '../../shared/text/utf8-byte-limits'
import { WECOM_COPY, WECOM_PROGRESS } from './wecom-copy'
import { WECOM_MESSAGE_BYTES } from './wecom-final'
import { WecomOffline, WecomRefused, WecomUnanswered, type WecomSocket } from './wecom-socket'

/** Live progress stops here, leaving time to finish the message before WeCom closes it (~6 min). */
export const WECOM_STREAM_LIVE_MS = 5 * 60_000
/** The last moment a finishing frame is written. */
export const WECOM_STREAM_FINAL_MS = 5.5 * 60_000

const EXPIRED = new Set([846608, 846605])
const PERMISSION = new Set([48002, 60011, 60020])
const RATE_LIMITED = new Set([45009, 45033, 45047])

/** What a refused frame means for the stream; null for a blip worth another frame. */
export function wecomStreamProblem(error: unknown): ImStreamDegrade | null {
  if (error instanceof WecomUnanswered || error instanceof WecomOffline) {
    return null
  }
  if (!(error instanceof WecomRefused)) {
    return 'failed'
  }
  if (EXPIRED.has(error.errcode)) {
    return 'expired'
  }
  if (PERMISSION.has(error.errcode)) {
    return 'permission'
  }
  return RATE_LIMITED.has(error.errcode) ? 'rate_limited' : 'failed'
}

/** Progress within one frame: the answer so far keeps its newest part. */
function fitted(text: string): string {
  const max = WECOM_MESSAGE_BYTES - 64
  return isUtf8ByteLengthWithinLimit(text, max) ? text : `…${clampUtf8TextTail(text, max).text}`
}

export type WecomTurnStreamDeps = {
  socket: WecomSocket
  reqId: string
  streamId: string
  receivedAt: number
  /** Messages of the same chat ahead of this one when it arrived. */
  ahead: number
  /** Live progress problems other than its window closing, for the connector's status. */
  onProblem: (problem: Exclude<ImStreamDegrade, 'expired'>) => void
  /** The owner is told once that the answer will follow, when no stream frame could show it. */
  pushNotice: (text: string) => Promise<void>
  now?: () => number
}

export class WecomTurnStream {
  private readonly live: ImLiveStream
  private readonly now: () => number
  private shown = false
  private finished = false
  private lastText: string
  private lastWriteAt = Number.NEGATIVE_INFINITY
  private settling: Promise<void> | null = null
  private noticePushed = false
  private readonly closeTimer: NodeJS.Timeout

  constructor(private readonly deps: WecomTurnStreamDeps) {
    this.now = deps.now ?? Date.now
    this.lastText = deps.ahead > 0 ? WECOM_COPY.queued(deps.ahead) : WECOM_COPY.received
    this.live = new ImLiveStream({
      write: (text) => this.frame(text),
      classify: wecomStreamProblem,
      render: (view) => this.render(view),
      deadline: deps.receivedAt + WECOM_STREAM_LIVE_MS,
      onDegraded: (reason) => {
        void this.degraded(reason)
      },
      now: this.now
    })
    const left = deps.receivedAt + WECOM_STREAM_LIVE_MS - this.now()
    this.closeTimer = setTimeout(() => this.live.degrade('expired'), Math.max(0, left))
    this.closeTimer.unref?.()
  }

  /** The first frame, at once; also what a message waiting its turn shows. */
  open(): void {
    this.live.update(EMPTY_IM_TURN_VIEW)
  }

  update(view: ImTurnView): void {
    this.live.update(view)
  }

  on(socket: WecomSocket): boolean {
    return this.deps.socket === socket
  }

  /** Whether the final answer may still go in this message's own last frame. */
  canFinish(socket: WecomSocket | null): boolean {
    return (
      !this.finished &&
      this.live.degraded === null &&
      socket === this.deps.socket &&
      socket.ready &&
      this.now() < this.deps.receivedAt + WECOM_STREAM_FINAL_MS
    )
  }

  /** Stops live frames and waits for any finishing frame a degrade began. */
  async settle(): Promise<void> {
    clearTimeout(this.closeTimer)
    await this.live.close()
    await this.settling
  }

  /** The last frame, after any frame in flight and the one-second gap. Throws as the socket does;
   *  the same frame may be written again, since it edits the same message. */
  async finish(text: string): Promise<void> {
    await this.settle()
    await this.gap()
    this.lastWriteAt = this.now()
    await this.deps.socket.request('aibot_respond_msg', this.deps.reqId, {
      msgtype: 'stream',
      stream: { id: this.deps.streamId, finish: true, content: text }
    })
    this.finished = true
  }

  /** The answer goes as pushed messages: this one stops showing progress, if WeCom still takes it. */
  async release(): Promise<void> {
    await this.settle()
    if (this.finished || !this.shown || !this.canFinishAfterDegrade()) {
      this.finished = true
      return
    }
    await this.finishQuietly(`${this.lastText}\n\n${WECOM_COPY.answerBelow}`)
  }

  /** Its connection ended: nothing more is written. */
  dispose(): void {
    clearTimeout(this.closeTimer)
    this.finished = true
    void this.live.close()
  }

  private render(view: ImTurnView): string {
    if (view.phase === 'waiting' && !view.thinking && view.steps.length === 0 && !view.answer) {
      return this.lastText === WECOM_COPY.received || !this.shown
        ? this.lastText
        : WECOM_COPY.received
    }
    return fitted(renderImProgress(view, WECOM_PROGRESS))
  }

  private async frame(text: string): Promise<void> {
    this.lastWriteAt = this.now()
    await this.deps.socket.request('aibot_respond_msg', this.deps.reqId, {
      msgtype: 'stream',
      stream: { id: this.deps.streamId, finish: false, content: text }
    })
    this.shown = true
    this.lastText = text
  }

  private async gap(): Promise<void> {
    const wait = this.lastWriteAt + IM_STREAM_MIN_GAP_MS - this.now()
    if (wait > 0) {
      await delay(wait)
    }
  }

  private canFinishAfterDegrade(): boolean {
    return this.deps.socket.ready && this.now() < this.deps.receivedAt + WECOM_STREAM_FINAL_MS
  }

  private async finishQuietly(text: string): Promise<void> {
    this.finished = true
    await this.gap()
    await this.deps.socket
      .request('aibot_respond_msg', this.deps.reqId, {
        msgtype: 'stream',
        stream: { id: this.deps.streamId, finish: true, content: text }
      })
      .catch(() => undefined)
  }

  private degraded(reason: ImStreamDegrade): Promise<void> {
    this.settling ??= (async () => {
      await this.live.close()
      if (reason !== 'expired') {
        this.deps.onProblem(reason)
      }
      if (this.shown && reason !== 'permission' && this.canFinishAfterDegrade()) {
        await this.finishQuietly(`${this.lastText}\n\n${WECOM_COPY.stillWorking}`)
        return
      }
      this.finished = true
      if (!this.shown && !this.noticePushed) {
        this.noticePushed = true
        await this.deps.pushNotice(WECOM_COPY.progressNotice).catch(() => undefined)
      }
    })()
    return this.settling
  }
}
