// Follows one admitted message's turn in its chat's journal (the structured agent session's own
// publications, never a transcript file) and hands each new view to its WeCom stream.
import { readImTurnView, type ImTurnView } from '../im-stream/im-stream-turn-view'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

export class WecomTurnFollow {
  private release: (() => void) | null = null
  private reading = false
  private again = false
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
    this.release = host.observeJournalPublications(
      this.sessionId,
      () => this.read(),
      () => this.read()
    )
  }

  stop(): void {
    this.stopped = true
    this.release?.()
    this.release = null
  }

  /** Publications come faster than reads: one read at a time, and one more after it if any came. */
  private read(): void {
    if (this.stopped) {
      return
    }
    if (this.reading) {
      this.again = true
      return
    }
    this.reading = true
    void (async () => {
      try {
        do {
          this.again = false
          const reads = await getStructuredAgentSessionHost()?.journalReads(this.sessionId)
          if (!reads || this.stopped) {
            return
          }
          const view = await readImTurnView(reads, this.messageId)
          if (this.stopped) {
            return
          }
          this.onView(view)
          if (view.phase === 'ended') {
            this.stop()
            return
          }
        } while (this.again)
      } catch {
        // Progress is best effort; the final answer comes through the outbox.
      } finally {
        this.reading = false
      }
    })()
  }
}
