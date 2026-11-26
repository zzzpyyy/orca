// The bot host's WeCom connector (`bots.wecomLocal.*`), read and changed as its own Orca account.
import { useEffect, useState } from 'react'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { botTarget } from '@/lib/bot-hosts'
import { botHostHas } from '@/lib/bot-host-status'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { BOTS_WECOM_LOCAL_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import type { Bot } from '../../../../../shared/bot-types'
import type { WecomLocalState } from '../../../../../shared/bots/wecom-local'

export type WecomMethod =
  | 'state'
  | 'connect'
  | 'pairGroup'
  | 'reconnect'
  | 'dismiss'
  | 'resend'
  | 'remove'

export function wecomCall(
  bot: Bot,
  method: WecomMethod,
  params: unknown = { botId: bot.id }
): Promise<WecomLocalState> {
  return callRuntimeRpc<WecomLocalState>(botTarget(bot), `bots.wecomLocal.${method}`, params)
}

/** The bot's WeCom state, read again whenever the host says the bot's settings changed; undefined
 *  until read or on a host without WeCom, null when the host could not be read. */
export function useWecomState(bot: Bot | null): WecomLocalState | null | undefined {
  const [read, setRead] = useState<{ key: string; state: WecomLocalState | null } | null>(null)
  const key = bot ? JSON.stringify([bot.hostId, bot.id]) : ''
  useEffect(() => {
    if (!bot || !botHostHas(bot.hostId, BOTS_WECOM_LOCAL_CAPABILITY)) {
      return
    }
    let active = true
    let generation = 0
    const refresh = (): void => {
      generation += 1
      const id = generation
      void wecomCall(bot, 'state')
        .catch(() => null)
        .then((state) => {
          if (active && id === generation) {
            setRead({ key, state })
          }
        })
    }
    refresh()
    const release = onBotsChanged(refresh, bot.hostId, {
      botId: bot.id,
      kinds: ['settings', 'bot']
    })
    return () => {
      active = false
      release()
    }
  }, [bot, key])
  return read?.key === key ? read.state : undefined
}
