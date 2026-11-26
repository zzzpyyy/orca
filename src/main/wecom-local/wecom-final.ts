// A message's final reply, sent at most once: part 1 in the stream's last frame while WeCom may
// still take it (repeating that frame, same stream id, edits the same message), otherwise every
// part as a pushed message. A push WeCom may have shown is never sent again; it is counted as
// unconfirmed for the owner to resend. Each attempt is written down before it goes, so a restart
// resumes.
import { ANSWER_CUT_NOTE, capAnswer } from '../connector-cloud/connector-snapshot'
import { splitImText } from '../im-stream/im-stream-chunks'
import { WECOM_COPY, WECOM_PART_LABEL } from './wecom-copy'
import { WecomOffline, WecomRefused, WecomUnanswered } from './wecom-socket'
import type { WecomMessageRow } from './wecom-inbox-rows'
import type { WecomStore } from './wecom-store-ops'

/** WeCom's limit for one stream frame's or one pushed markdown message's content. */
export const WECOM_MESSAGE_BYTES = 20_480
/** Above this many messages (WeCom allows 30 a minute per chat) the rest stays in Orca. */
export const WECOM_MAX_PARTS = 8
const PART_ROOM_BYTES = 1024

/** The reply as the messages it goes in, in order; the same text always splits the same way. */
export function wecomFinalParts(text: string): string[] {
  const parts = splitImText(text, WECOM_MESSAGE_BYTES, WECOM_PART_LABEL)
  if (parts.length <= WECOM_MAX_PARTS) {
    return parts
  }
  for (let room = PART_ROOM_BYTES; ; room *= 2) {
    const cut = capAnswer(text, WECOM_MAX_PARTS * (WECOM_MESSAGE_BYTES - room))
    const noted = cut.endsWith(ANSWER_CUT_NOTE)
      ? `${cut.slice(0, -ANSWER_CUT_NOTE.length)}${WECOM_COPY.restInOrca}`
      : cut
    const fitted = splitImText(noted, WECOM_MESSAGE_BYTES, WECOM_PART_LABEL)
    if (fitted.length <= WECOM_MAX_PARTS) {
      return fitted
    }
  }
}

export type WecomFinalPort = {
  /** Whether this connection may still write the message's stream frames. */
  canFinishStream(row: WecomMessageRow): boolean
  finishStream(row: WecomMessageRow, text: string): Promise<void>
  push(row: WecomMessageRow, text: string): Promise<void>
}

export type WecomFinalResult = { kind: 'done' } | { kind: 'retry'; errcode?: number }

type Chosen = WecomMessageRow & { final_via: 'stream' | 'push'; final_text: string }

export function finalChosen(row: WecomMessageRow | null): row is Chosen {
  return Boolean(row && row.final_via && row.final_text !== null && row.answered === 0)
}

/** Part 1 in the stream; 'push' when it goes as a pushed message instead, 'sent' when it is
 *  settled (shown, or given up as unconfirmed). */
async function streamPart(
  store: Pick<WecomStore, 'finalToPush' | 'partSending' | 'partSent' | 'partRefused'>,
  account: string,
  row: Chosen,
  text: string,
  port: WecomFinalPort
): Promise<'sent' | 'push' | WecomFinalResult> {
  const { mid } = row
  // An earlier frame's outcome is unknown: only the same frame may follow it.
  const unknown = row.part_sending === 1
  if (!port.canFinishStream(row)) {
    if (unknown) {
      await store.partSent(account, mid, 1, false)
      return 'sent'
    }
    await store.finalToPush(account, mid)
    return 'push'
  }
  if (!unknown) {
    await store.partSending(account, mid, 1)
  }
  try {
    await port.finishStream(row, text)
  } catch (error) {
    if (error instanceof WecomRefused) {
      if (unknown) {
        // Most likely the earlier frame finished the stream.
        await store.partSent(account, mid, 1, false)
        return 'sent'
      }
      await store.partRefused(account, mid, 1)
      await store.finalToPush(account, mid)
      return 'push'
    }
    if (error instanceof WecomOffline && !unknown) {
      await store.partRefused(account, mid, 1)
    }
    return { kind: 'retry' }
  }
  await store.partSent(account, mid, 1, true)
  return 'sent'
}

export async function sendWecomFinal(
  store: Pick<WecomStore, 'finalToPush' | 'partSending' | 'partSent' | 'partRefused'>,
  account: string,
  chosen: Chosen,
  port: WecomFinalPort
): Promise<WecomFinalResult> {
  const parts = wecomFinalParts(chosen.final_text)
  const { mid } = chosen
  let via = chosen.final_via
  let sending = chosen.part_sending
  for (let part = chosen.parts_sent + 1; part <= parts.length; part++) {
    const text = parts[part - 1]!
    if (part === 1 && via === 'stream') {
      const outcome = await streamPart(
        store,
        account,
        { ...chosen, part_sending: sending },
        text,
        port
      )
      if (outcome === 'sent') {
        sending = null
        continue
      }
      if (outcome !== 'push') {
        return outcome
      }
      via = 'push'
      sending = null
    }
    if (sending === part) {
      // Sent before a restart or a lost answer, and WeCom may have shown it: never twice.
      await store.partSent(account, mid, part, false)
      sending = null
      continue
    }
    await store.partSending(account, mid, part)
    sending = part
    let shown = true
    try {
      await port.push({ ...chosen, final_via: via }, text)
    } catch (error) {
      if (!(error instanceof WecomUnanswered)) {
        await store.partRefused(account, mid, part)
        return {
          kind: 'retry',
          ...(error instanceof WecomRefused ? { errcode: error.errcode } : {})
        }
      }
      shown = false
    }
    await store.partSent(account, mid, part, shown)
    sending = null
  }
  return { kind: 'done' }
}
