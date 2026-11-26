// Keeps one binding's long connection open: reconnects with backoff after a drop, and stops for good
// when WeCom refuses the Bot ID and Secret or another client takes the bot's one connection.
import { setTimeout as delay } from 'node:timers/promises'
import { WecomRefused, WecomSocket, type WecomInboundFrame } from './wecom-socket'

const FIRST_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 60_000

export type WecomLinkEnd = 'replaced' | 'auth-failed' | 'stopped'

export type WecomLinkDeps = {
  url: string
  botKey: string
  secret: string
  signal: AbortSignal
  onFrame: (socket: WecomSocket, frame: WecomInboundFrame) => void
  onPhase: (phase: 'connecting' | 'retrying') => void
  /** Subscribed: frames may be written on it now. */
  onOpen: (socket: WecomSocket) => void
  onClose: (socket: WecomSocket) => void
}

export async function keepWecomLinked(deps: WecomLinkDeps): Promise<WecomLinkEnd> {
  let backoff = FIRST_BACKOFF_MS
  while (!deps.signal.aborted) {
    const socket: WecomSocket = new WecomSocket(deps.url, (frame) => deps.onFrame(socket, frame))
    deps.onPhase('connecting')
    let openedAt: number | null = null
    try {
      await socket.open(deps.botKey, deps.secret, deps.signal)
      openedAt = Date.now()
      deps.onOpen(socket)
      if ((await socket.ended).kind === 'replaced') {
        return 'replaced'
      }
    } catch (error) {
      if (error instanceof WecomRefused) {
        return 'auth-failed'
      }
    } finally {
      socket.close()
      deps.onClose(socket)
    }
    if (deps.signal.aborted) {
      break
    }
    // A link that stayed up a while starts over; one dropped at once backs off further.
    if (openedAt !== null && Date.now() - openedAt > MAX_BACKOFF_MS) {
      backoff = FIRST_BACKOFF_MS
    }
    deps.onPhase('retrying')
    await delay(backoff, undefined, { signal: deps.signal }).catch(() => undefined)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
  return 'stopped'
}
