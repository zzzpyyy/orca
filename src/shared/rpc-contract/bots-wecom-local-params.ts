import { z } from 'zod'
export const WecomLocalBot = z.strictObject({ botId: z.string().min(1) })
/** An unconfirmed reply the owner asked to send again, by its WeCom message id. */
export const WecomLocalResend = WecomLocalBot.extend({ mid: z.string().min(1).max(256) })
/** The owner's WeCom Bot ID and Secret, entered in Orca; the host seals the Secret and never returns it. */
export const WecomLocalConnect = WecomLocalBot.extend({
  botKey: z.string().trim().min(1).max(128),
  secret: z.string().min(1).max(256)
})
