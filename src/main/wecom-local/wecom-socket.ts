// One long connection to WeCom's AI bot API: subscribe with the Bot ID and Secret, keep it alive, and
// match each reply's acknowledgement by its req_id. Frames sharing a req_id go one at a time, since
// WeCom acknowledges them by that id alone.
import { randomBytes } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { z } from 'zod'

export const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'
const HANDSHAKE_TIMEOUT_MS = 15_000
const HEARTBEAT_MS = 30_000
const MISSED_PONGS = 2
export const WECOM_ACK_TIMEOUT_MS = 15_000
/** How long past its timeout a frame's ack may still come and holds its req_id. */
const WECOM_LATE_ACK_MS = 30_000
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

const WecomFrame = z.object({
  cmd: z.string().optional(),
  headers: z.object({ req_id: z.string().optional() }).optional(),
  body: z.unknown().optional(),
  errcode: z.number().optional()
})
export type WecomFrame = z.infer<typeof WecomFrame>

export type WecomInboundFrame = WecomFrame & { cmd: string; headers: { req_id: string } }

/** WeCom answered and refused: nothing was shown. */
export class WecomRefused extends Error {
  constructor(readonly errcode: number) {
    super(`WeCom refused the request (errcode ${errcode})`)
    this.name = 'WecomRefused'
  }
}

/** No answer came (timeout, or the connection closed first): WeCom may or may not have shown it. */
export class WecomUnanswered extends Error {
  constructor() {
    super('WeCom did not answer in time')
    this.name = 'WecomUnanswered'
  }
}

/** Never written: no subscribed connection was open. */
export class WecomOffline extends Error {
  constructor() {
    super('Not connected to WeCom')
    this.name = 'WecomOffline'
  }
}

export function wecomReqId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomBytes(6).toString('hex')}`
}

/** WeCom's endpoint; an override (a local mock) is taken only on this machine's loopback. */
export function wecomSocketUrl(override: string | undefined): string {
  if (!override) {
    return WECOM_WS_URL
  }
  try {
    const url = new URL(override)
    if ((url.protocol === 'ws:' || url.protocol === 'wss:') && LOOPBACK_HOSTS.has(url.hostname)) {
      return url.toString()
    }
  } catch {
    // Not a URL: WeCom's own endpoint.
  }
  return WECOM_WS_URL
}

export type WecomSocketEnd =
  | { kind: 'auth'; errcode: number }
  /** WeCom keeps one connection per bot; a newer subscription closed this one. */
  | { kind: 'replaced' }
  | { kind: 'closed' }

/** A frame's ack: WeCom's errcode, or null when the connection ended first. */
type Pending = { ack: (errcode: number | null) => void }

function parse(data: RawData): WecomFrame | null {
  try {
    return WecomFrame.safeParse(JSON.parse(data.toString())).data ?? null
  } catch {
    return null
  }
}

const ReplacedEvent = z.object({ event: z.object({ eventtype: z.literal('disconnected_event') }) })

function isReplacedEvent(frame: WecomFrame): boolean {
  return frame.cmd === 'aibot_event_callback' && ReplacedEvent.safeParse(frame.body).success
}

export class WecomSocket {
  private socket: WebSocket | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly chains = new Map<string, Promise<void>>()
  private heartbeat: NodeJS.Timeout | null = null
  private unanswered = 0
  private subscribed = false
  private done = false
  private settleEnd: (end: WecomSocketEnd) => void = () => undefined
  /** Settles once, when the connection is over for any reason. */
  readonly ended = new Promise<WecomSocketEnd>((resolve) => {
    this.settleEnd = resolve
  })

  constructor(
    private readonly url: string,
    private readonly onFrame: (frame: WecomInboundFrame) => void
  ) {}

  /** Opens and subscribes; resolves once WeCom took the Bot ID and Secret, rejects otherwise. */
  open(botKey: string, secret: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new WecomOffline())
        return
      }
      const socket = new WebSocket(this.url, {
        perMessageDeflate: false,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAX_FRAME_BYTES
      })
      this.socket = socket
      const subscribeId = wecomReqId('aibot_subscribe')
      const onAbort = (): void => this.close()
      signal.addEventListener('abort', onAbort, { once: true })
      // A link that opens but never answers the subscription is as good as closed.
      const unanswered = setTimeout(() => this.close(), HANDSHAKE_TIMEOUT_MS + WECOM_ACK_TIMEOUT_MS)
      unanswered.unref?.()
      void this.ended.then(() => clearTimeout(unanswered))
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            cmd: 'aibot_subscribe',
            headers: { req_id: subscribeId },
            body: { bot_id: botKey, secret }
          })
        )
      })
      socket.on('message', (data: RawData) => {
        const frame = parse(data)
        if (!frame) {
          return
        }
        if (!frame.cmd && frame.headers?.req_id === subscribeId) {
          clearTimeout(unanswered)
          if (frame.errcode === 0) {
            this.subscribed = true
            this.startHeartbeat()
            resolve()
          } else {
            const errcode = typeof frame.errcode === 'number' ? frame.errcode : -1
            this.end({ kind: 'auth', errcode })
            reject(new WecomRefused(errcode))
          }
          return
        }
        this.received(frame)
      })
      socket.on('close', () => {
        signal.removeEventListener('abort', onAbort)
        this.end({ kind: 'closed' })
        reject(new WecomOffline())
      })
      // A failed handshake or a broken link: 'close' follows and ends it.
      socket.on('error', () => undefined)
    })
  }

  get ready(): boolean {
    return !this.done && this.subscribed && this.socket?.readyState === WebSocket.OPEN
  }

  /** One frame answered by its own acknowledgement; frames sharing a req_id wait their turn. */
  request(cmd: string, reqId: string, body: unknown): Promise<void> {
    const previous = this.chains.get(reqId) ?? Promise.resolve()
    let freed = Promise.resolve()
    const answer = previous.then(() => {
      const sent = this.send(cmd, reqId, body)
      freed = sent.free
      return sent.answer
    })
    const free = answer.catch(() => undefined).then(() => freed)
    this.chains.set(reqId, free)
    void free.finally(() => {
      if (this.chains.get(reqId) === free) {
        this.chains.delete(reqId)
      }
    })
    return answer
  }

  close(): void {
    this.end({ kind: 'closed' })
  }

  /** `answer` settles with the frame's acknowledgement or its timeout; `free` once no ack of it can
   *  still come, so a late ack is never credited to the next frame on the same req_id. */
  private send(
    cmd: string,
    reqId: string,
    body: unknown
  ): { answer: Promise<void>; free: Promise<void> } {
    const socket = this.socket
    if (!socket || !this.ready) {
      return { answer: Promise.reject(new WecomOffline()), free: Promise.resolve() }
    }
    let freeIt = (): void => undefined
    const free = new Promise<void>((resolve) => (freeIt = resolve))
    const answer = new Promise<void>((resolve, reject) => {
      let late: NodeJS.Timeout | undefined
      const unanswered = (): void => {
        clearTimeout(timer)
        reject(new WecomUnanswered())
        late ??= setTimeout(done, WECOM_LATE_ACK_MS)
        late.unref?.()
      }
      const timer = setTimeout(unanswered, WECOM_ACK_TIMEOUT_MS)
      timer.unref?.()
      const done = (): void => {
        clearTimeout(timer)
        clearTimeout(late)
        if (this.pending.get(reqId) === entry) {
          this.pending.delete(reqId)
        }
        freeIt()
      }
      // Settling twice is a no-op, so a late ack only frees the req_id.
      const entry: Pending = {
        ack: (errcode) => {
          if (errcode === 0) {
            resolve()
          } else {
            reject(errcode === null ? new WecomUnanswered() : new WecomRefused(errcode))
          }
          done()
        }
      }
      this.pending.set(reqId, entry)
      // A write that errors may still have left in part: its outcome is unknown, never "not sent".
      socket.send(JSON.stringify({ cmd, headers: { req_id: reqId }, body }), (error) => {
        if (error && this.pending.get(reqId) === entry) {
          unanswered()
        }
      })
    })
    return { answer, free }
  }

  private received(frame: WecomFrame): void {
    const reqId = frame.headers?.req_id
    if (typeof reqId !== 'string' || !reqId) {
      return
    }
    if (frame.cmd) {
      if (isReplacedEvent(frame)) {
        this.end({ kind: 'replaced' })
        return
      }
      this.onFrame({ ...frame, cmd: frame.cmd, headers: { req_id: reqId } })
      return
    }
    if (reqId.startsWith('ping_')) {
      this.unanswered = 0
      return
    }
    this.pending.get(reqId)?.ack(typeof frame.errcode === 'number' ? frame.errcode : -1)
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.unanswered >= MISSED_PONGS) {
        this.end({ kind: 'closed' })
        return
      }
      this.unanswered++
      this.socket?.send(JSON.stringify({ cmd: 'ping', headers: { req_id: wecomReqId('ping') } }))
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private end(end: WecomSocketEnd): void {
    if (this.done) {
      return
    }
    this.done = true
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
    }
    for (const waiting of this.pending.values()) {
      waiting.ack(null)
    }
    this.socket?.terminate()
    this.settleEnd(end)
  }
}
