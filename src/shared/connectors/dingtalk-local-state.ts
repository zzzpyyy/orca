// What a bot's DingTalk card and setup read from its host: the bot's own entries, whether dws runs,
// and how its listeners and replies stand.
import type {
  DingTalkLocalDmEntry,
  DingTalkLocalGroupEntry
} from '../rpc-contract/bots-dingtalk-local-params'

export type DingTalkLocalConversation = {
  externalId: string
  kind: 'dm' | 'group'
  label: string
  /** The chat it is linked to now; empty once that chat is gone. */
  sessionId: string
  updatedAt: number
}

export type DingTalkLocalBotState = {
  /** The connector runs on this host; false on one without it. */
  available: boolean
  enabled: boolean
  autoReply: boolean
  streaming: boolean
  dws: { version: string } | { missing: string } | null
  listeners: number
  listenerErrors: string[]
  pendingMessages: number
  pendingReplies: number
  failedReplies: number
  uncertainReplies: number
  /** Why the newest reply lost its card or did not post. */
  degraded: string
  lastError: string
  dms: DingTalkLocalDmEntry[]
  groups: DingTalkLocalGroupEntry[]
  conversations: DingTalkLocalConversation[]
}

export type DingTalkLocalProfile = {
  profile: string
  corpName: string
  userName: string
  status: string
  current: boolean
}

export type DingTalkLocalProfiles = {
  dws: { version: string } | { missing: string }
  profiles: DingTalkLocalProfile[]
  /** Why the list could not be read, when dws runs. */
  error: string
}

export type DingTalkLocalPerson = { openDingTalkId: string; name: string; title: string }
export type DingTalkLocalGroupMatch = { groupId: string; name: string }
