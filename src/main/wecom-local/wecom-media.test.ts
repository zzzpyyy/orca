// WeCom's attachment encryption (AES-256-CBC, IV = key's first 16 bytes, PKCS#7 to 32 bytes) opens
// what it sealed and refuses anything whose padding was tampered with.
import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { decryptWecomMedia } from './wecom-media'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

function sealLikeWecom(plain: Buffer, key: Buffer): Buffer {
  const pad = 32 - (plain.length % 32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([
    cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])),
    cipher.final()
  ])
}

describe('decryptWecomMedia', () => {
  it('round-trips every length across a padding block, and rejects tampered padding', () => {
    // Fixed, so the tampered block decrypts the same way every run.
    const key = Buffer.from('synthetic-wecom-media-key-32byte')
    const aeskey = key.toString('base64')
    for (const length of [1, 31, 32, 33, 1000]) {
      const plain = randomBytes(length)
      expect(decryptWecomMedia(sealLikeWecom(plain, key), aeskey).equals(plain)).toBe(true)
    }
    const sealed = sealLikeWecom(Buffer.from('synthetic attachment'), key)
    const tampered = Buffer.from(sealed)
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1)
    expect(() => decryptWecomMedia(tampered, aeskey)).toThrow('Unreadable WeCom attachment')
    expect(() => decryptWecomMedia(sealed, randomBytes(16).toString('base64'))).toThrow()
  })
})
