// `bots.dingtalkLocal.*`: a bot's local DingTalk setup on its host, read and written through dws. No
// credential passes here: dws keeps its own sign-in, the owner signs in with it.
import * as z from 'zod'

const Id = z.string().min(1).max(256)
/** A dws profile, `corpId:userId`. */
const Profile = z.string().regex(/^[^:,\s]+:[^:,\s]+$/)

export const DingTalkLocalBot = z.strictObject({ botId: z.string().min(1).max(128) })
export const DingTalkLocalSearch = z.strictObject({
  profile: Profile,
  query: z.string().trim().min(1).max(80)
})

const DingTalkLocalDm = z.strictObject({
  profile: Profile,
  openDingTalkId: Id,
  name: z.string().max(80),
  owner: z.boolean()
})
const DingTalkLocalGroup = z.strictObject({
  profile: Profile,
  groupId: Id,
  name: z.string().max(80),
  mode: z.enum(['at', 'all']),
  prefix: z.string().max(64),
  requirePrefix: z.boolean()
})

/** The bot's whole DingTalk setup; autoReply and streaming hold for every DingTalk bot here. */
export const DingTalkLocalSave = DingTalkLocalBot.extend({
  autoReply: z.boolean(),
  streaming: z.boolean(),
  dms: z.array(DingTalkLocalDm).max(50),
  groups: z.array(DingTalkLocalGroup).max(200)
})

export type DingTalkLocalDmEntry = z.infer<typeof DingTalkLocalDm>
export type DingTalkLocalGroupEntry = z.infer<typeof DingTalkLocalGroup>
export type DingTalkLocalSaveInput = z.infer<typeof DingTalkLocalSave>
