// A WeCom message's image, file or video: fetched from the short-lived URL its frame names (valid
// about five minutes) and opened with that URL's own AES key.
import { createDecipheriv } from 'node:crypto'
import { MAX_ASKER_IMAGE_BYTES } from '../external-conversations/connector-asker-images'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session/agent-session-attachments'

export type WecomMediaKind = 'image' | 'file' | 'video'

const DOWNLOAD_TIMEOUT_MS = 60_000
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

export const WECOM_MEDIA_MAX_BYTES: Record<WecomMediaKind, number> = {
  image: MAX_ASKER_IMAGE_BYTES,
  file: Math.min(AGENT_SESSION_ATTACHMENT_MAX_BYTES, 20 * 1024 * 1024),
  video: Math.min(AGENT_SESSION_ATTACHMENT_MAX_BYTES, 20 * 1024 * 1024)
}

export class WecomMediaTooLarge extends Error {
  constructor() {
    super('The WeCom attachment is larger than Orca takes')
    this.name = 'WecomMediaTooLarge'
  }
}

/** AES-256-CBC with the key's first 16 bytes as IV, PKCS#7 padded to 32-byte blocks (WeCom's scheme). */
export function decryptWecomMedia(encrypted: Uint8Array, aeskey: string): Buffer {
  const key = Buffer.from(aeskey, 'base64')
  if (key.length !== 32 || encrypted.length === 0 || encrypted.length % 16 !== 0) {
    throw new Error('Unreadable WeCom attachment')
  }
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  const pad = plain.at(-1) ?? 0
  if (pad < 1 || pad > 32 || pad > plain.length) {
    throw new Error('Unreadable WeCom attachment')
  }
  for (let index = plain.length - pad; index < plain.length; index++) {
    if (plain[index] !== pad) {
      throw new Error('Unreadable WeCom attachment')
    }
  }
  return plain.subarray(0, plain.length - pad)
}

/** The name a download's Content-Disposition gives, if any. */
export function dispositionName(header: string | null): string | undefined {
  if (!header) {
    return undefined
  }
  const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(header)?.[1]
  const plain = /filename="?([^";]+)"?/i.exec(header)?.[1]
  try {
    return decodeURIComponent(encoded ?? plain ?? '') || undefined
  } catch {
    return plain || undefined
  }
}

/** Only https, and plain http only to this machine when a local mock stands in for WeCom. */
function allowedUrl(value: string, loopback: boolean): URL {
  const url = new URL(value)
  if (url.username || url.password) {
    throw new Error('Unexpected WeCom attachment URL')
  }
  if (url.protocol === 'https:') {
    return url
  }
  if (loopback && url.protocol === 'http:' && LOOPBACK.has(url.hostname)) {
    return url
  }
  throw new Error('Unexpected WeCom attachment URL')
}

export async function fetchWecomMedia(
  source: { url: string; aeskey?: string; kind: WecomMediaKind },
  signal: AbortSignal,
  loopback: boolean,
  request: typeof fetch = fetch
): Promise<{ bytes: Buffer; name?: string }> {
  const limit = WECOM_MEDIA_MAX_BYTES[source.kind]
  const response = await request(allowedUrl(source.url, loopback), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    redirect: 'error'
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Could not download the WeCom attachment')
  }
  const declared = Number(response.headers.get('content-length'))
  // Encrypted bytes carry at most one block of padding over the file itself.
  if (Number.isFinite(declared) && declared > limit + 32) {
    await response.body.cancel().catch(() => undefined)
    throw new WecomMediaTooLarge()
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit + 32) {
      await response.body.cancel().catch(() => undefined)
      throw new WecomMediaTooLarge()
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  const bytes = source.aeskey ? decryptWecomMedia(raw, source.aeskey) : raw
  if (bytes.length === 0) {
    throw new Error('Empty WeCom attachment')
  }
  if (bytes.length > limit) {
    throw new WecomMediaTooLarge()
  }
  const name = dispositionName(response.headers.get('content-disposition'))
  return { bytes, ...(name ? { name } : {}) }
}
