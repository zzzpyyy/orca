// One WeCom message as the bot's agent reads it: the owner's words, then its media fetched into the
// attachment store (images go with the words where the agent views them), and the owner's notice
// for any it could not read.
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { parseAgentSessionAttachmentStorePath } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { sanitizeAgentSessionAttachmentName } from '../../shared/agent-session/agent-session-attachments'
import { imageExtension } from '../external-conversations/connector-asker-images'
import {
  formatNativeChatFileReference,
  getAgentImageHandling
} from '../../shared/native-chat/input/composer/agent-image-paste'
import { fetchWecomMedia, WecomMediaTooLarge } from './wecom-media'
import { WECOM_COPY } from './wecom-copy'
import type { WecomBody, WecomMedia, WecomMessageRow } from './wecom-inbox-rows'

/** WeCom's media URLs stop working about five minutes after the message. */
export const WECOM_MEDIA_URL_MS = 5 * 60_000

export type WecomInput = {
  prompt: string
  storedImages: string[]
  /** For the owner, ahead of the answer: attachments Orca never showed the agent. */
  notice: string | null
  /** The body with fetched media as stored paths, so a retry fetches nothing twice. */
  body: WecomBody
}

/** The attachment store sweeps unclaimed uploads; reuse only a regular file still in it. */
async function storedFileAvailable(path: string): Promise<boolean> {
  const store = getAgentSessionAttachmentStore()
  const ref = store && parseAgentSessionAttachmentStorePath(store.rootDir, path)
  if (!ref || path !== join(store.rootDir, ref.uploadId, ref.name)) {
    return false
  }
  try {
    const [dir, file] = await Promise.all([lstat(dirname(path)), lstat(path)])
    return dir.isDirectory() && file.isFile()
  } catch (error) {
    const code = errnoCodeOrUnknown(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false
    }
    throw error
  }
}

async function fetched(
  media: WecomMedia,
  index: number,
  receivedAt: number,
  signal: AbortSignal,
  loopback: boolean
): Promise<WecomMedia> {
  if (media.state === 'failed') {
    return media
  }
  if (media.state === 'stored') {
    return (await storedFileAvailable(media.path))
      ? media
      : { state: 'failed', kind: media.kind, why: 'expired' }
  }
  if (Date.now() - receivedAt >= WECOM_MEDIA_URL_MS) {
    return { state: 'failed', kind: media.kind, why: 'expired' }
  }
  const store = getAgentSessionAttachmentStore()
  if (!store) {
    throw new Error('Attachment storage unavailable')
  }
  try {
    const { bytes, name } = await fetchWecomMedia(media, signal, loopback)
    const extension = media.kind === 'image' ? imageExtension(bytes) : null
    if (media.kind === 'image' && !extension) {
      return { state: 'failed', kind: media.kind, why: 'unreadable' }
    }
    const fileName =
      media.kind === 'image'
        ? `image-${index + 1}${extension}`
        : sanitizeAgentSessionAttachmentName(name || `${media.kind}-${index + 1}`)
    return { state: 'stored', kind: media.kind, path: await store.storeFile(fileName, bytes) }
  } catch (error) {
    signal.throwIfAborted()
    return {
      state: 'failed',
      kind: media.kind,
      why: error instanceof WecomMediaTooLarge ? 'too_large' : 'unreadable'
    }
  }
}

export async function wecomInput(
  row: Pick<WecomMessageRow, 'chat_kind' | 'received_at'> & { body: WecomBody },
  agent: string,
  signal: AbortSignal,
  loopback: boolean
): Promise<WecomInput> {
  const media: WecomMedia[] = []
  for (const [index, item] of row.body.media.entries()) {
    media.push(await fetched(item, index, row.received_at, signal, loopback))
  }
  const body: WecomBody = { ...row.body, media }
  const seesImages = getAgentImageHandling(agent) === 'attachment'
  const place = row.chat_kind === 'group' ? 'in a WeCom group' : 'in WeCom'
  const lines: string[] = []
  if (body.text.trim()) {
    lines.push(body.text)
  }
  if (body.voice) {
    lines.push(`(This was a voice message ${place}; the text is WeCom's transcript.)`)
  }
  if (body.quote) {
    lines.push(`The owner quoted an earlier message:\n> ${body.quote.split('\n').join('\n> ')}`)
  }
  const storedImages: string[] = []
  for (const item of media) {
    if (item.state !== 'stored') {
      continue
    }
    if (item.kind === 'image' && seesImages) {
      storedImages.push(item.path)
    } else {
      const what = item.kind === 'image' ? 'an image' : item.kind === 'video' ? 'a video' : 'a file'
      lines.push(`The owner sent ${what} ${place}: ${formatNativeChatFileReference(item.path)}`)
    }
  }
  if (storedImages.length > 0 && !body.text.trim()) {
    lines.unshift(
      `The owner sent ${storedImages.length > 1 ? 'these images' : 'this image'} ${place}.`
    )
  }
  const failed = media.flatMap((item) => (item.state === 'failed' ? [item.why] : []))
  if (failed.length > 0) {
    lines.push(
      `${failed.length} attachment(s) could not be read (${[...new Set(failed)].join(', ')}). Do not guess what they contain.`
    )
  }
  if (body.mediaLeftOut) {
    lines.push(`${body.mediaLeftOut} more attachment(s) were left out of this message.`)
  }
  const notices = [
    ...(failed.length > 0 ? [WECOM_COPY.mediaFailed(failed)] : []),
    ...(body.mediaLeftOut ? [WECOM_COPY.mediaLeftOut(body.mediaLeftOut)] : [])
  ]
  return {
    prompt: lines.join('\n\n') || 'The owner sent an empty message.',
    storedImages,
    notice: notices.length > 0 ? notices.join('\n') : null,
    body
  }
}
