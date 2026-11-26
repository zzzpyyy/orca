import { createHash } from 'node:crypto'
import { z } from 'zod'

/** One owner's bot on this host: which WeCom bot it listens as, and who paired it. */
export const WecomBinding = z.object({
  account: z.string(),
  bot: z.string(),
  botKey: z.string(),
  owner: z.string().nullable(),
  pairedAt: z.number().int().nullable()
})
export type WecomBinding = z.infer<typeof WecomBinding>

export const WecomChat = z.object({
  chat: z.string(),
  kind: z.enum(['single', 'group'])
})
export type WecomChat = z.infer<typeof WecomChat>

/** The conversation one allowed chat is, named so another owner, bot or chat never shares it. */
export function wecomConversation(b: WecomBinding, chat: string) {
  return {
    source: 'wecom-local' as const,
    externalId: createHash('sha256')
      .update(JSON.stringify([b.account, b.bot, b.botKey, b.owner, chat]))
      .digest('hex')
  }
}

/** The owner's own single chat with the bot: WeCom names it by their user id. */
export function wecomDirectChat(b: WecomBinding): WecomChat | null {
  return b.owner ? { chat: b.owner, kind: 'single' } : null
}

/** A stream message's id, the same after a restart so a retried frame edits the same message. */
export function wecomStreamId(account: string, mid: string): string {
  return createHash('sha256')
    .update(JSON.stringify([account, mid]))
    .digest('hex')
    .slice(0, 32)
}
