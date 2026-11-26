// The owner's resend of a reply WeCom may not have shown. A pushed message isn't idempotent, so Orca
// never repeats one on its own; only the owner, who can see the WeCom chat, sends it again, labeled
// as a resend, and it stays listed until WeCom confirms every part.
import { WECOM_ERRORS } from '../../shared/bots/wecom-local'
import { WECOM_COPY } from './wecom-copy'
import { wecomFinalParts } from './wecom-final'
import { WecomOffline } from './wecom-socket'
import type { WecomStore } from './wecom-store-ops'

export async function resendWecomReply(
  store: Pick<WecomStore, 'resendable' | 'resent'>,
  account: string,
  mid: string,
  push: (chat: string, text: string) => Promise<void>
): Promise<void> {
  const reply = await store.resendable(account, mid)
  if (!reply) {
    return
  }
  for (const part of wecomFinalParts(`${WECOM_COPY.resent}\n\n${reply.text}`)) {
    try {
      await push(reply.chat, part)
    } catch (error) {
      throw new Error(
        error instanceof WecomOffline ? WECOM_ERRORS.notConnected : WECOM_ERRORS.resendUnconfirmed
      )
    }
  }
  await store.resent(account, mid)
}
