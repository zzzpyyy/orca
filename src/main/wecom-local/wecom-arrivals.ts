// What one received message comes to: the pairing code that allows its chat, a message the inbox
// keeps (the owner's, in a chat they allowed), or nothing. Anyone else's message is not Orca's to
// answer, so it is left without a reply.
import { wecomStreamId, type WecomBinding } from './wecom-binding'
import { WECOM_COPY } from './wecom-copy'
import type { WecomArrival } from './wecom-inbox-rows'
import type { WecomPairing } from './wecom-pairing'
import type { WecomSocket } from './wecom-socket'
import type { WecomStore } from './wecom-store-ops'

export type WecomArrivalOutcome =
  | { kind: 'paired'; chat: 'single' | 'group' }
  | { kind: 'ignored' }
  /** notice: the reply it is owed instead of a turn (a type Orca can't read, or a paused bot). */
  | { kind: 'kept'; fresh: boolean; ahead: number; notice: string | null }

export async function admitWecomArrival(
  deps: { store: WecomStore; binding: WecomBinding; pairing: WecomPairing; botTakes: boolean },
  socket: WecomSocket,
  arrival: WecomArrival,
  at: number
): Promise<WecomArrivalOutcome> {
  const { store, binding: b, pairing } = deps
  const pairs = pairing.matches(arrival, at, b.owner)
  if (
    pairs &&
    (await store.pair(b.account, arrival.from, { chat: arrival.chat, kind: pairs }, at))
  ) {
    pairing.clear()
    if (pairs === 'single') {
      b.owner = arrival.from
      b.pairedAt = at
    }
    await socket
      .request('aibot_respond_msg', arrival.reqId, {
        msgtype: 'stream',
        stream: {
          id: wecomStreamId(b.account, arrival.mid),
          finish: true,
          content: pairs === 'single' ? WECOM_COPY.paired : WECOM_COPY.groupPaired
        }
      })
      .catch(() => undefined)
    return { kind: 'paired', chat: pairs }
  }
  if (!b.owner || arrival.from !== b.owner) {
    return { kind: 'ignored' }
  }
  const chats = await store.chats(b.account)
  if (!chats.some((chat) => chat.chat === arrival.chat && chat.kind === arrival.kind)) {
    return { kind: 'ignored' }
  }
  const notice =
    arrival.body.unsupported !== undefined
      ? WECOM_COPY.unsupported(arrival.body.unsupported)
      : deps.botTakes
        ? null
        : WECOM_COPY.paused
  const { fresh, ahead } = await store.receive(b.account, arrival, at, notice)
  return { kind: 'kept', fresh, ahead, notice }
}
