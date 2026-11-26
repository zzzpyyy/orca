import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import * as z from 'zod'
import type { ImStreamRecord } from '../im-stream/im-reply-stream'

const Profile = z
  .string()
  .regex(/^[^:,\s]+:[^:,\s]+$/)
  .brand<'DingTalkProfile'>()
const GroupId = z.string().min(1).max(256).brand<'DingTalkGroupId'>()
const MessageId = z.string().min(1).max(512).brand<'DingTalkMessageId'>()
const ConversationId = z.string().min(1).max(512).brand<'DingTalkConversationId'>()
const ExternalId = z
  .string()
  .regex(/^dt1_[A-Za-z0-9_-]{16,256}$/)
  .brand<'DingTalkExternalId'>()
const DeliveryId = z
  .string()
  .regex(/^dtd1_[A-Za-z0-9_-]{16,256}$/)
  .brand<'DingTalkDeliveryId'>()
const ReplyId = z
  .string()
  .regex(/^dtr1_[A-Za-z0-9_-]{16,256}$/)
  .brand<'DingTalkReplyId'>()

export type DingTalkProfile = z.infer<typeof Profile>
export type DingTalkGroupId = z.infer<typeof GroupId>
export type DingTalkMessageId = z.infer<typeof MessageId>
export type DingTalkConversationId = z.infer<typeof ConversationId>
export type DingTalkExternalId = z.infer<typeof ExternalId>
export type DingTalkDeliveryId = z.infer<typeof DeliveryId>
export type DingTalkReplyId = z.infer<typeof ReplyId>

export const DingTalkMode = z.enum(['at', 'all'])
const GroupSetup = z.object({
  profile: Profile,
  groupId: GroupId,
  botId: z.string().min(1).max(128),
  mode: DingTalkMode.default('at'),
  prefix: z.string().max(64).default('/tsbot'),
  requirePrefix: z.boolean().default(true),
  selfNames: z.array(z.string().min(1).max(80)).max(10).default([]),
  selfOpenId: z.string().max(256).default(''),
  noiseFilter: z.boolean().default(true),
  /** How the setup lists the group; never used to route. */
  name: z.string().max(80).default('')
})
/** One person whose 1:1 messages to the profile's account reach the bot; no one else's do. */
const DmSetup = z.object({
  profile: Profile,
  botId: z.string().min(1).max(128),
  openDingTalkId: z.string().min(1).max(256),
  name: z.string().max(80).default(''),
  /** The bot owner's own account: their turns typed in Orca post back here, as Slack does. */
  owner: z.boolean().default(false)
})
const Setup = z.object({
  enabled: z.boolean().default(false),
  dwsPath: z.string().min(1).default('dws'),
  autoReply: z.boolean().default(false),
  /** Each IM-started turn's reply opens at once and shows progress until the answer replaces it. */
  streaming: z.boolean().default(true),
  groups: z.array(GroupSetup).max(200).default([]),
  dms: z.array(DmSetup).max(50).default([])
})

export type DingTalkGroupSetup = z.infer<typeof GroupSetup>
export type DingTalkDmSetup = z.infer<typeof DmSetup>
export type DingTalkSetup = z.infer<typeof Setup>
/** What a message came through, and so who may send one: a group binding or one authorized person. */
export type DingTalkBinding =
  | { kind: 'group'; group: DingTalkGroupSetup }
  | { kind: 'dm'; dm: DingTalkDmSetup }
export type DingTalkSetupInput = z.input<typeof Setup>

export type DingTalkInbound = {
  profile: DingTalkProfile
  source: 'at' | 'group' | 'dm'
  /** A DM's DingTalk conversation id; its replies go to `senderOpenId`. */
  groupId: DingTalkGroupId
  conversationId: DingTalkConversationId
  messageId: DingTalkMessageId
  senderOpenId: string
  senderName: string
  content: string
  createTime: string
}

export type InboxState =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'attributed'
  | 'filtered'
  | 'failed'
export type ReplyState = 'queued' | 'sending' | 'sent' | 'uncertain' | 'failed'

export type InboxRow = {
  key: string
  event: DingTalkInbound
  externalId: DingTalkExternalId
  body: string
  state: InboxState
  deliveryId: DingTalkDeliveryId
  reason: string
  updatedAt: number
  /** Its media fetched and `body` final: a redelivery sends the same words and images. */
  prepared?: true
  images?: string[]
}

export type ConversationRow = {
  externalId: DingTalkExternalId
  profile: DingTalkProfile
  groupId: DingTalkGroupId
  conversationId: DingTalkConversationId
  botId: string
  sessionId: string
  latestMessageId: DingTalkMessageId
  updatedAt: number
  /** Set for a DM: the person its replies go to. */
  dmOpenId?: string
  /** The sender or group as the setup names it, for the connector's conversation list. */
  label?: string
}

export type ReplyRow = {
  key: DingTalkReplyId
  externalId: DingTalkExternalId
  profile: DingTalkProfile
  groupId: DingTalkGroupId
  text: string
  uuid: string
  turnId: number
  state: ReplyState
  error: string
  updatedAt: number
  dmOpenId?: string
}

export type DingTalkLedgerState = {
  version: 1
  inbox: Record<string, InboxRow>
  conversations: Record<string, ConversationRow>
  replies: Record<string, ReplyRow>
  watermarks: Record<string, string>
  /** Each streamed reply's card and how much of its answer landed, by reply key. */
  streams: Record<string, ImStreamRecord>
}

export function parseDingTalkSetup(raw: unknown, botIds: readonly string[] = []): DingTalkSetup {
  const setup = Setup.parse(raw)
  const known = new Set(botIds)
  for (const entry of [...setup.groups, ...setup.dms]) {
    if (known.size > 0 && !known.has(entry.botId)) {
      throw new Error(`unknown DingTalk bot ${entry.botId}`)
    }
  }
  for (const group of setup.groups) {
    if (group.mode === 'all' && group.requirePrefix) {
      throw new Error(`group ${group.groupId} in all mode must disable requirePrefix`)
    }
  }
  const bindings = new Set<string>()
  for (const group of setup.groups) {
    const key = `${group.profile}\u0000${group.groupId}`
    if (bindings.has(key)) {
      throw new Error(`duplicate DingTalk group binding ${group.groupId}`)
    }
    bindings.add(key)
  }
  const people = new Set<string>()
  for (const dm of setup.dms) {
    const key = `${dm.profile}\u0000${dm.openDingTalkId}`
    if (people.has(key)) {
      throw new Error(`duplicate DingTalk DM binding ${dm.openDingTalkId}`)
    }
    people.add(key)
  }
  return setup
}

/** A missing file means the connector is off. */
export async function readDingTalkSetup(
  path: string,
  botIds: readonly string[] = []
): Promise<DingTalkSetup> {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  const raw: unknown = text === null ? { enabled: false } : JSON.parse(text)
  return parseDingTalkSetup(raw, botIds)
}

/** Replaces the setup file whole, readable by this user only. */
export async function writeDingTalkSetup(path: string, setup: DingTalkSetup): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(setup, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

function stable<T extends string>(
  prefix: string,
  parts: readonly string[],
  parse: (value: string) => T
): T {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('base64url')
  return parse(`${prefix}${digest.slice(0, 43)}`)
}

export function stableExternalId(
  profile: DingTalkProfile,
  conversationId: DingTalkConversationId
): DingTalkExternalId {
  return stable('dt1_', [profile, conversationId], ExternalId.parse)
}

export function stableDeliveryId(
  profile: DingTalkProfile,
  messageId: DingTalkMessageId
): DingTalkDeliveryId {
  return stable('dtd1_', [profile, messageId], DeliveryId.parse)
}

export function stableReplyId(externalId: DingTalkExternalId, turnId: number): DingTalkReplyId {
  return stable('dtr1_', [externalId, String(turnId)], ReplyId.parse)
}

/** The reply that posts a turn the owner typed in Orca, by the turn's journal record. */
export function stableOwnTurnReplyId(
  externalId: DingTalkExternalId,
  turnItemId: string
): DingTalkReplyId {
  return stable('dtr1_', [externalId, 'orca', turnItemId], ReplyId.parse)
}

/** The dws idempotency key of one message a reply sends, from the reply's or a part's key. */
export function stableSendUuid(key: string): string {
  return `dt-local-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`
}

export const schemas = {
  Profile,
  GroupId,
  MessageId,
  ConversationId,
  ExternalId,
  DeliveryId,
  ReplyId
}
