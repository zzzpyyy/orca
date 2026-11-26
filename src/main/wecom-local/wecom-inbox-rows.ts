// What the WeCom inbox keeps of each message, from its arrival until its reply settled.
import { z } from 'zod'

/** What the inbox keeps of an undelivered message; media URLs give way to stored paths. */
export const WecomMedia = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('remote'),
    kind: z.enum(['image', 'file', 'video']),
    url: z.string(),
    aeskey: z.string().optional()
  }),
  z.object({
    state: z.literal('stored'),
    kind: z.enum(['image', 'file', 'video']),
    path: z.string()
  }),
  z.object({
    state: z.literal('failed'),
    kind: z.enum(['image', 'file', 'video']),
    why: z.enum(['expired', 'too_large', 'unreadable'])
  })
])
export type WecomMedia = z.infer<typeof WecomMedia>

export const WecomBody = z.object({
  text: z.string(),
  quote: z.string().optional(),
  voice: z.literal(true).optional(),
  media: z.array(WecomMedia),
  /** Media past the per-message limit, named in the notice rather than dropped unseen. */
  mediaLeftOut: z.number().int().positive().optional(),
  /** A message type WeCom passes that Orca can't read: answered with a notice, never delivered. */
  unsupported: z.string().optional()
})
export type WecomBody = z.infer<typeof WecomBody>

export type WecomArrival = {
  mid: string
  reqId: string
  chat: string
  kind: 'single' | 'group'
  from: string
  body: WecomBody
  preview: string
}

export const WecomMessageRow = z.object({
  mid: z.string(),
  req_id: z.string(),
  chat: z.string(),
  chat_kind: z.enum(['single', 'group']),
  received_at: z.number(),
  preview: z.string(),
  /** pending: not yet delivered. admitted: delivered, its turn's answer owed. notice and review:
   *  never delivered, owed only their own notice; review stays listed for the owner to look at. */
  state: z.enum(['pending', 'admitted', 'notice', 'review', 'settled']),
  final_via: z.enum(['stream', 'push']).nullable(),
  final_text: z.string().nullable(),
  parts_sent: z.number(),
  part_sending: z.number().nullable(),
  answered: z.number(),
  unconfirmed: z.number(),
  notice: z.string().nullable()
})
export type WecomMessageRow = z.infer<typeof WecomMessageRow>

export const WECOM_MESSAGE_COLUMNS =
  'mid,req_id,chat,chat_kind,received_at,preview,state,final_via,final_text,parts_sent,part_sending,answered,unconfirmed,notice'
