import type { ReplyRow } from './dingtalk-domain'
import type { DingTalkLedger } from './dingtalk-ledger'
import { reconcileLedger } from './dingtalk-reconcile'

/** How long a reply that failed to post is retried at the next start. */
const RETRY_FAILED_MS = 24 * 60 * 60 * 1000

/** After a restart: a delivery cut off goes again, and a reply cut off, or failed lately, posts the
 *  parts it had not posted. A part's dws uuid stays the same, so one dws did take is not repeated. */
export async function recoverDingTalkLedger(
  ledger: DingTalkLedger,
  sendReply: (reply: ReplyRow) => Promise<void>,
  now = Date.now()
): Promise<void> {
  const snapshot = ledger.snapshot()
  for (const row of Object.values(snapshot.inbox)) {
    if (row.state === 'delivering') {
      await ledger.transitionInbox(row.key, 'delivering', 'pending', {
        reason: 'recovered after restart'
      })
    }
  }
  for (const row of Object.values(snapshot.replies)) {
    if (
      row.state === 'sending' ||
      row.state === 'uncertain' ||
      (row.state === 'failed' && now - row.updatedAt < RETRY_FAILED_MS)
    ) {
      await ledger.transitionReply(row.key, row.state, 'queued')
    }
  }
  for (const row of Object.values(ledger.snapshot().replies)) {
    if (row.state === 'queued') {
      void sendReply(row)
    }
  }
}

export function replayDingTalkInbox(
  ledger: DingTalkLedger,
  deliver: (inboxKey: string) => Promise<void>
): void {
  const snapshot = ledger.snapshot()
  for (const command of reconcileLedger(snapshot, { delivering: new Set(), sending: new Set() })) {
    if (command.kind === 'deliver') {
      void deliver(command.inboxKey)
    }
  }
}
