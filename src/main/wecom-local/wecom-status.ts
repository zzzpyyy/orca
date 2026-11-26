// The setup dialog's view of one connection: what it waits on and what the owner should look at.
// Only the Bot ID's last characters show; the Secret is never part of it.
import type {
  WecomLocalState,
  WecomLocalStatus,
  WecomStreamProblem
} from '../../shared/bots/wecom-local'
import type { WecomBinding, WecomChat } from './wecom-binding'
import type { WecomPairingCode } from './wecom-pairing'

export function wecomLocalStateOf(input: {
  binding: WecomBinding
  phase: WecomLocalStatus
  botTakes: boolean
  counts: { review: number; unconfirmed: number }
  chats: readonly WecomChat[]
  pairing: WecomPairingCode | null
  streamProblem: WecomStreamProblem | undefined
  replyError: number | undefined
  sessionId: string | undefined
}): WecomLocalState {
  const { counts, pairing } = input
  return {
    status: input.phase === 'listening' && !input.botTakes ? 'paused' : input.phase,
    botHint: input.binding.botKey.slice(-4),
    ...(pairing ? { pairingText: pairing.code, pairingFor: pairing.for } : {}),
    groups: input.chats.filter((chat) => chat.kind === 'group').length,
    ...(input.streamProblem ? { streaming: input.streamProblem } : {}),
    ...(counts.unconfirmed > 0 ? { unconfirmed: counts.unconfirmed } : {}),
    ...(counts.review > 0 ? { review: counts.review } : {}),
    ...(input.replyError !== undefined ? { replyError: input.replyError } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {})
  }
}
