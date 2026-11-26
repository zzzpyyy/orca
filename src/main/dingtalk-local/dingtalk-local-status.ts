import type { DingTalkSetup } from './dingtalk-domain'
import type { LedgerSnapshot } from './dingtalk-ledger'

export type DingTalkConversationStatus = {
  externalId: string
  kind: 'dm' | 'group'
  label: string
  botId: string
  /** The chat it is linked to now; empty once that chat is gone. */
  sessionId: string
  updatedAt: number
}

export type DingTalkLocalStatus = {
  enabled: boolean
  autoReply: boolean
  streaming: boolean
  configPath: string
  /** The dws found on PATH, or why none runs. */
  dws: { version: string } | { missing: string } | null
  consumers: number
  /** Why a message listener stopped, one line each; empty while all listen. */
  consumerErrors: string[]
  pendingMessages: number
  pendingReplies: number
  uncertainReplies: number
  failedReplies: number
  /** Why the newest reply lost its card or did not post: the missing permission or failing call. */
  degraded: string
  lastError: string
  conversations: DingTalkConversationStatus[]
}

export function statusOf(input: {
  setup: DingTalkSetup | null
  configPath: string
  dws: DingTalkLocalStatus['dws']
  consumerCount: number
  consumerErrors: readonly string[]
  ledger: LedgerSnapshot
  degraded: string
  lastError: string
  sessionOf: (externalId: string) => string | null
}): DingTalkLocalStatus {
  const { ledger, setup } = input
  const replies = Object.values(ledger.replies)
  return {
    enabled: setup?.enabled === true,
    autoReply: setup?.autoReply === true,
    streaming: setup?.streaming !== false,
    configPath: input.configPath,
    dws: input.dws,
    consumers: input.consumerCount,
    consumerErrors: [...input.consumerErrors],
    pendingMessages: Object.values(ledger.inbox).filter(
      (row) => row.state === 'pending' || row.state === 'delivering'
    ).length,
    pendingReplies: replies.filter((row) => row.state === 'queued' || row.state === 'sending')
      .length,
    uncertainReplies: replies.filter((row) => row.state === 'uncertain').length,
    failedReplies: replies.filter((row) => row.state === 'failed').length,
    degraded: input.degraded,
    lastError: input.lastError,
    conversations: Object.values(ledger.conversations)
      .map((row) => ({
        externalId: row.externalId,
        kind: row.dmOpenId ? ('dm' as const) : ('group' as const),
        label: row.label || row.groupId,
        botId: row.botId,
        sessionId: input.sessionOf(row.externalId) ?? '',
        updatedAt: row.updatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
}
