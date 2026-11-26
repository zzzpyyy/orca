// The reply message each received message is streamed into, keyed by message id: opened on arrival,
// fed its turn's views, and finished with the answer or released when it goes as pushed messages.
// Streams belong to the connection that received their message; a new connection drops them.
import type { ImStreamDegrade } from '../im-stream/im-stream-live'
import { wecomStreamId } from './wecom-binding'
import type { WecomFinalPort } from './wecom-final'
import type { WecomArrival, WecomMessageRow } from './wecom-inbox-rows'
import { WecomOffline, wecomReqId, type WecomSocket } from './wecom-socket'
import { WecomTurnFollow } from './wecom-turn-follow'
import { WecomTurnStream } from './wecom-turn-stream'

type Live = { stream: WecomTurnStream; follow: WecomTurnFollow | null }

export class WecomReplyStreams {
  private readonly live = new Map<string, Live>()

  constructor(
    private readonly account: string,
    private readonly socket: () => WecomSocket | null,
    private readonly onProblem: (problem: Exclude<ImStreamDegrade, 'expired'>) => void
  ) {}

  /** The stream for a message just received; `show` puts up "received" or "queued" at once. */
  open(socket: WecomSocket, arrival: WecomArrival, at: number, ahead: number, show: boolean): void {
    const stream = new WecomTurnStream({
      socket,
      reqId: arrival.reqId,
      streamId: wecomStreamId(this.account, arrival.mid),
      receivedAt: at,
      ahead,
      onProblem: this.onProblem,
      pushNotice: (text) => this.push(arrival.chat, text)
    })
    this.live.set(arrival.mid, { stream, follow: null })
    if (show) {
      stream.open()
    }
  }

  /** The delivered message's turn, followed in its chat's journal. */
  follow(mid: string, sessionId: string, messageId: string): void {
    const entry = this.live.get(mid)
    if (!entry || entry.follow) {
      return
    }
    entry.follow = new WecomTurnFollow(sessionId, messageId, (view) => entry.stream.update(view))
    entry.follow.start()
  }

  /** Every stream but those of `keep`, whose connection still edits them. */
  drop(keep: WecomSocket | null): void {
    for (const [mid, entry] of this.live) {
      if (!keep || !entry.stream.on(keep)) {
        this.finished(mid)
      }
    }
  }

  /** WeCom's proactive message; not idempotent, so wecom-final never repeats one it may have shown. */
  push(chat: string, text: string): Promise<void> {
    const socket = this.socket()
    if (!socket?.ready) {
      return Promise.reject(new WecomOffline())
    }
    return socket.request('aibot_send_msg', wecomReqId('aibot_send_msg'), {
      chatid: chat,
      msgtype: 'markdown',
      markdown: { content: text }
    })
  }

  readonly port: WecomFinalPort = {
    canFinishStream: (row) => this.live.get(row.mid)?.stream.canFinish(this.socket()) ?? false,
    finishStream: async (row, text) => {
      const entry = this.live.get(row.mid)
      if (!entry) {
        throw new WecomOffline()
      }
      await entry.stream.finish(text)
    },
    push: (row, text) => this.push(row.chat, text)
  }

  /** Before the final is chosen: no more progress; whether the stream itself may carry the answer. */
  async prepare(row: WecomMessageRow): Promise<'stream' | 'push'> {
    const entry = this.live.get(row.mid)
    if (!entry) {
      return 'push'
    }
    entry.follow?.stop()
    await entry.stream.settle()
    return entry.stream.canFinish(this.socket()) ? 'stream' : 'push'
  }

  async release(mid: string): Promise<void> {
    await this.live.get(mid)?.stream.release()
  }

  finished(mid: string): void {
    const entry = this.live.get(mid)
    entry?.follow?.stop()
    entry?.stream.dispose()
    this.live.delete(mid)
  }
}
