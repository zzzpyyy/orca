// The one-time code that pairs a WeCom chat: shown in Orca, sent by the owner to the bot. A direct
// message pairs whoever sends it first as the owner; a group pairs only for that owner. Single use,
// gone after five minutes.
import { randomBytes } from 'node:crypto'
import type { WecomArrival } from './wecom-inbox-rows'

export const WECOM_PAIRING_MS = 5 * 60_000

export type WecomPairingCode = { code: string; expires: number; for: 'dm' | 'group' }

export class WecomPairing {
  private current: WecomPairingCode | null = null
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly onExpired: (kind: 'dm' | 'group') => void) {}

  begin(kind: 'dm' | 'group', now = Date.now()): void {
    this.clear()
    this.current = {
      code: `Orca ${randomBytes(8).toString('hex')}`,
      expires: now + WECOM_PAIRING_MS,
      for: kind
    }
    this.timer = setTimeout(() => {
      this.current = null
      this.onExpired(kind)
    }, WECOM_PAIRING_MS)
    this.timer.unref?.()
  }

  get shown(): WecomPairingCode | null {
    return this.current && Date.now() < this.current.expires ? this.current : null
  }

  /** The chat kind this arrival pairs, when it carries the live code from the right person. */
  matches(arrival: WecomArrival, at: number, owner: string | null): 'single' | 'group' | null {
    const pairing = this.current
    // Contained, not equal: a bot name with a space leaves part of its @mention before the code.
    if (!pairing || at >= pairing.expires || !arrival.body.text.includes(pairing.code)) {
      return null
    }
    if (pairing.for === 'dm') {
      return owner === null && arrival.kind === 'single' && arrival.chat === arrival.from
        ? 'single'
        : null
    }
    return arrival.kind === 'group' && owner !== null && arrival.from === owner ? 'group' : null
  }

  clear(): void {
    clearTimeout(this.timer)
    this.current = null
  }
}
