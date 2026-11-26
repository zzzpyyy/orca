import { useEffect, useState } from 'react'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { useBotHostHas } from '@/lib/bot-host-status'
import { BOTS_DINGTALK_LOCAL_RUNTIME_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import type { Bot } from '../../../../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { DingTalkLocalBotState } from '../../../../../shared/connectors/dingtalk-local-state'

export function dingTalkCall<T>(
  bot: BotRef,
  method: 'state' | 'profiles' | 'searchPeople' | 'searchGroups' | 'save' | 'remove',
  params: unknown = { botId: bot.id }
): Promise<T> {
  return callBotRpc<T>(bot, `bots.dingtalkLocal.${method}`, params)
}

/** The bot's DingTalk state on its host, read again whenever the host says its settings changed;
 *  undefined while reading or on a host without the connector, null when the read failed. */
export function useDingTalkState(bot: Bot | null): DingTalkLocalBotState | null | undefined {
  const hostId = bot?.hostId ?? LOCAL_EXECUTION_HOST_ID
  const botId = bot?.id ?? null
  const has = useBotHostHas(hostId, BOTS_DINGTALK_LOCAL_RUNTIME_CAPABILITY)
  const [read, setRead] = useState<{ key: string; state: DingTalkLocalBotState | null } | null>(
    null
  )
  const key = botId && has ? JSON.stringify([hostId, botId]) : ''
  useEffect(() => {
    if (!botId || !has) {
      return
    }
    let active = true
    let generation = 0
    const refresh = (): void => {
      generation += 1
      const id = generation
      void dingTalkCall<DingTalkLocalBotState>({ hostId, id: botId }, 'state')
        .catch(() => null)
        .then((state) => {
          if (active && id === generation) {
            setRead({ key, state })
          }
        })
    }
    refresh()
    const release = onBotsChanged(refresh, hostId, {
      botId,
      kinds: ['settings', 'bot']
    })
    return () => {
      active = false
      release()
    }
  }, [botId, has, hostId, key])
  return read?.key === key && key ? read.state : undefined
}

/** The bot has DingTalk people or groups set up on its host. */
export const dingTalkAdded = (state: DingTalkLocalBotState | null | undefined): boolean =>
  Boolean(state && state.dms.length + state.groups.length > 0)
