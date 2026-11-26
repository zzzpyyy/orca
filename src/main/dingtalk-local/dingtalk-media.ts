// What a received DingTalk message carries besides words: dws writes an image as
// `[图片消息](mediaId=…)`, a file as `[文件] name file_id=…`, voice and video by their own tags.
// Images reach the turn as images, files as saved paths; anything else is named in the message,
// never dropped. Regexes spell CJK as escapes: the orcad bundle must stay ASCII.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import {
  imageExtension,
  MAX_ASKER_IMAGE_BYTES,
  MAX_ASKER_IMAGES
} from '../external-conversations/connector-asker-images'
import type { DingTalkMessageId, DingTalkProfile } from './dingtalk-domain'
import type { DwsDownloads } from './dws/dingtalk-dws-messages'

// [图片消息](mediaId=x) or [图片](mediaId=x)
const IMAGE = /\[(?:\u56fe\u7247\u6d88\u606f|\u56fe\u7247)\]\(mediaId=[^\s)]+\)/g
// [文件] name file_id=x, fileId: x
const FILE = /\[\u6587\u4ef6\]\s*([^\r\n]*?)\s+file[_-]?id\s*[:=]\s*["']?[^"'\s)\]}>,]+/gi
// [语音消息] / [视频消息], with or without a mediaId
const OTHER_MEDIA =
  /\[(\u8bed\u97f3\u6d88\u606f|\u89c6\u9891\u6d88\u606f)\](?:\(mediaId=[^\s)]+\))?/g
// 注意：如需下载使用dws chat message download-media命令下载
const DOWNLOAD_HINT =
  /\s*\u6ce8\u610f\uff1a\u5982\u9700\u4e0b\u8f7d\u4f7f\u7528dws\s+(?:chat message download-media|drive download)\u547d\u4ee4\u4e0b\u8f7d\s*/g
// A whole message that is only one bracketed tag, as DingTalk writes a type it has no text for.
const ONLY_TAG = /^\[[^\]\n]{1,20}\]$/

export const DINGTALK_MAX_FILE_BYTES = 30 * 1024 * 1024

export type DingTalkMediaPlan = {
  /** The person's words with the media tags taken out. */
  text: string
  images: number
  files: string[]
  /** Media Orca does not read, by DingTalk's tag: voice, video, or a type with no text. */
  unsupported: string[]
}

export function planDingTalkMedia(content: string): DingTalkMediaPlan {
  const files: string[] = []
  const unsupported: string[] = []
  let images = 0
  let text = content.replace(DOWNLOAD_HINT, '\n')
  text = text.replace(IMAGE, () => {
    images += 1
    return ''
  })
  text = text.replace(FILE, (_, name: string) => {
    files.push(name.trim() || 'file')
    return ''
  })
  text = text.replace(OTHER_MEDIA, (_, tag: string) => {
    unsupported.push(tag)
    return ''
  })
  text = text.trim()
  if (ONLY_TAG.test(text)) {
    unsupported.push(text.slice(1, -1))
    text = ''
  }
  return { text, images, files, unsupported }
}

export const hasDingTalkMedia = (plan: DingTalkMediaPlan): boolean =>
  plan.images > 0 || plan.files.length > 0

export type DingTalkPrepared = {
  /** Empty when nothing in the message could be read: no turn starts, the asker is told why. */
  body: string
  images: string[]
  /** What could not be read, in the asker's words; their reply says so first. */
  unread: string[]
}

type Prepare = {
  fetch: (
    profile: DingTalkProfile,
    messageId: DingTalkMessageId,
    dir: string
  ) => Promise<DwsDownloads>
  store: (name: string, bytes: Buffer) => Promise<string>
}

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 160)

/** The turn's text and images for one message: images it can show, saved files named by path, and
 *  a line for each thing that could not be had, which the agent reads and the asker is told. */
export async function prepareDingTalkMessage(
  deps: Prepare,
  event: { profile: DingTalkProfile; messageId: DingTalkMessageId },
  content: string
): Promise<DingTalkPrepared> {
  const plan = planDingTalkMedia(content)
  const notes = plan.unsupported.map((tag) => `[${tag}]: Orca can't read this message type`)
  const unread = plan.unsupported.map((tag) => tag)
  const images: string[] = []
  const saved: string[] = []
  if (hasDingTalkMedia(plan)) {
    const dir = await mkdtemp(join(tmpdir(), 'orca-dingtalk-media-'))
    try {
      const downloaded = await deps.fetch(event.profile, event.messageId, dir)
      for (const relative of downloaded.paths) {
        const path = resolve(dir, relative)
        // dws keeps downloads inside the folder it runs in; anything else is not read.
        if (!path.startsWith(`${resolve(dir)}${sep}`)) {
          continue
        }
        const size = (await stat(path)).size
        const name = basename(path)
        if (size > DINGTALK_MAX_FILE_BYTES) {
          notes.push(`${name}: larger than ${DINGTALK_MAX_FILE_BYTES >> 20} MB, not read`)
          unread.push(`${name}（超过 ${DINGTALK_MAX_FILE_BYTES >> 20} MB）`)
          continue
        }
        const bytes = await readFile(path)
        const extension = imageExtension(bytes)
        if (extension && images.length < MAX_ASKER_IMAGES && size <= MAX_ASKER_IMAGE_BYTES) {
          images.push(await deps.store(`dingtalk-image${extension}`, bytes))
        } else {
          saved.push(await deps.store(name, bytes))
        }
      }
      const missing = plan.images + plan.files.length - downloaded.paths.length
      if (missing > 0) {
        const why = downloaded.failures[0] ?? 'dws returned no file'
        notes.push(`${missing} attachment(s) could not be downloaded: ${why.slice(0, 160)}`)
        unread.push(`${missing} 个附件下载失败`)
      }
    } catch (error) {
      notes.push(`Attachments could not be read: ${reasonOf(error)}`)
      unread.push('附件读取失败')
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  if (!plan.text && images.length === 0 && saved.length === 0) {
    return { body: '', images, unread }
  }
  const lines = [plan.text || (images.length > 0 ? '(image)' : '')]
  if (saved.length > 0) {
    lines.push('', 'Attached files, saved on this computer:', ...saved.map((path) => `- ${path}`))
  }
  if (notes.length > 0) {
    lines.push('', ...notes.map((note) => `(${note})`))
  }
  return { body: lines.join('\n').trim(), images, unread }
}
