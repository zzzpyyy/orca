// Follows one admitted message's turn in its chat's journal (the structured agent session's own
// publications, never a transcript file) and hands each new view to its WeCom stream.
import { followImJournal } from '../im-stream/im-stream-follow'
import { readImTurnView, type ImTurnView } from '../im-stream/im-stream-turn-view'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

export class WecomTurnFollow {
  private release: (() => void) | null = null
  private stopped = false

  constructor(
    private readonly sessionId: string,
    private readonly messageId: string,
    private readonly onView: (view: ImTurnView) => void
  ) {}

  start(): void {
    const host = getStructuredAgentSessionHost()
    if (!host || this.stopped) {
      return
    }
    // Progress is best effort; the final answer comes through the outbox.
    this.release = followImJournal(host, this.sessionId, async (reads, active) => {
      const view = await readImTurnView(reads, this.messageId)
      if (!active()) {
        return 'stop'
      }
      this.onView(view)
      return view.phase === 'ended' ? 'stop' : undefined
    })
  }

  stop(): void {
    this.stopped = true
    this.release?.()
    this.release = null
  }
}
