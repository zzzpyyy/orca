// What one WeCom callback says, read into what the inbox keeps. Media arrive only in single chats;
// groups bring the @mention's text, mixed and quoted messages.
import { z } from 'zod'
import type { WecomArrival, WecomBody, WecomMedia } from './wecom-inbox-rows'
import { maskImText } from '../im-stream/im-stream-step'

const Text = z.object({ content: z.string() })
const Media = z.object({ url: z.string().min(1), aeskey: z.string().optional() })
const MixedItem = z.object({
  msgtype: z.string(),
  text: Text.optional(),
  image: Media.optional()
})
const Quote = z.object({
  msgtype: z.string(),
  text: Text.optional(),
  image: Media.optional(),
  mixed: z.object({ msg_item: z.array(MixedItem) }).optional(),
  voice: Text.optional(),
  file: Media.optional()
})

const Callback = z.object({
  msgid: z.string().min(1).max(256),
  chatid: z.string().min(1).max(256).optional(),
  chattype: z.enum(['single', 'group']),
  from: z.object({ userid: z.string().min(1).max(256) }),
  msgtype: z.string(),
  text: Text.optional(),
  image: Media.optional(),
  mixed: z.object({ msg_item: z.array(MixedItem) }).optional(),
  voice: Text.optional(),
  file: Media.optional(),
  video: Media.optional(),
  quote: Quote.optional()
})

const MAX_MEDIA = 10
const UNSUPPORTED_NAMES: Record<string, string> = {
  emotion: '表情',
  location: '位置',
  link: '链接',
  stream: '流式消息',
  event: '事件'
}

/** A group message names the bot first ("@Orca 帮我看看"); the mention is not the request. */
function withoutLeadingMention(text: string): string {
  return text.replace(/^(?:\s*@\S+)+\s*/u, '')
}

function remote(kind: WecomMedia['kind'], media: z.infer<typeof Media>): WecomMedia {
  return {
    state: 'remote',
    kind,
    url: media.url,
    ...(media.aeskey ? { aeskey: media.aeskey } : {})
  }
}

function quoteText(quote: z.infer<typeof Quote>): string {
  switch (quote.msgtype) {
    case 'text':
      return quote.text?.content ?? ''
    case 'voice':
      return quote.voice?.content ?? ''
    case 'mixed':
      return (quote.mixed?.msg_item ?? [])
        .map((item) => (item.msgtype === 'text' ? (item.text?.content ?? '') : '[图片]'))
        .join('')
    case 'image':
      return '[图片]'
    case 'file':
      return '[文件]'
    default:
      return `[${quote.msgtype}]`
  }
}

function previewOf(body: WecomBody): string {
  const text = body.text.replace(/\s+/g, ' ').trim()
  const shown = text || (body.media[0] ? `[${body.media[0].kind}]` : `[${body.unsupported ?? ''}]`)
  const masked = maskImText(shown)
  return masked.length <= 40 ? masked : `${masked.slice(0, 39)}…`
}

/** A message callback as the inbox keeps it; null when it is not a person's message. */
export function readWecomCallback(reqId: string, value: unknown): WecomArrival | null {
  const parsed = Callback.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const m = parsed.data
  const chat = m.chattype === 'group' ? m.chatid : m.from.userid
  if (!chat) {
    return null
  }
  const media: WecomMedia[] = []
  let text = ''
  let voice = false
  let unsupported: string | undefined
  switch (m.msgtype) {
    case 'text':
      text = m.text?.content ?? ''
      break
    case 'voice':
      // WeCom sends the transcript, never the audio.
      text = m.voice?.content ?? ''
      voice = true
      break
    case 'mixed':
      for (const item of m.mixed?.msg_item ?? []) {
        if (item.msgtype === 'text' && item.text) {
          text += item.text.content
        } else if (item.msgtype === 'image' && item.image) {
          media.push(remote('image', item.image))
        }
      }
      break
    case 'image':
    case 'file':
    case 'video': {
      const source = m[m.msgtype]
      if (source) {
        media.push(remote(m.msgtype, source))
      } else {
        unsupported = m.msgtype
      }
      break
    }
    default:
      unsupported = UNSUPPORTED_NAMES[m.msgtype] ?? m.msgtype.slice(0, 32)
  }
  if (m.chattype === 'group') {
    text = withoutLeadingMention(text)
  }
  if (m.quote?.msgtype === 'image' && m.quote.image) {
    media.push(remote('image', m.quote.image))
  } else if (m.quote?.msgtype === 'file' && m.quote.file) {
    media.push(remote('file', m.quote.file))
  }
  const quote = m.quote ? quoteText(m.quote).trim() : ''
  if (!text.trim() && media.length === 0 && !quote && !unsupported) {
    unsupported = m.msgtype.slice(0, 32) || 'empty'
  }
  const body: WecomBody = {
    text,
    ...(quote ? { quote } : {}),
    ...(voice ? { voice: true as const } : {}),
    media: media.slice(0, MAX_MEDIA),
    ...(media.length > MAX_MEDIA ? { mediaLeftOut: media.length - MAX_MEDIA } : {}),
    ...(unsupported ? { unsupported } : {})
  }
  return {
    mid: m.msgid,
    reqId,
    chat,
    kind: m.chattype,
    from: m.from.userid,
    body,
    preview: previewOf(body)
  }
}
