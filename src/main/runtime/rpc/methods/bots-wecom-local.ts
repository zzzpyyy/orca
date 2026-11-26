import {
  WecomLocalBot,
  WecomLocalConnect,
  WecomLocalResend
} from '../../../../shared/rpc-contract/bots-wecom-local-params'
import { WecomLocalHost } from '../../../wecom-local/wecom-local-host'
import { defineMethod, type RpcContext } from '../core'

function host(context: RpcContext) {
  const host = context.runtime.localConnectors.find(WecomLocalHost)
  if (!host) {
    throw new Error('Local WeCom setup is unavailable on this host')
  }
  return host
}

/** Each change answers with the bot's new state, so the dialog needs no second call. */
function change<TName extends string>(
  name: TName,
  act: (wecom: ReturnType<typeof host>, botId: string) => Promise<void>
) {
  return defineMethod({
    name,
    permission: 'accounts-admin',
    params: WecomLocalBot,
    handler: async ({ botId }, context) => {
      await act(host(context), botId)
      return host(context).state(botId)
    }
  })
}

export const BOT_WECOM_LOCAL_METHODS = [
  defineMethod({
    name: 'bots.wecomLocal.state',
    permission: 'accounts-admin',
    params: WecomLocalBot,
    handler: ({ botId }, context) => host(context).state(botId)
  }),
  defineMethod({
    name: 'bots.wecomLocal.connect',
    permission: 'accounts-admin',
    params: WecomLocalConnect,
    handler: async ({ botId, botKey, secret }, context) => {
      await host(context).connect(botId, botKey, secret)
      return host(context).state(botId)
    }
  }),
  change('bots.wecomLocal.pairGroup', (wecom, botId) => wecom.pairGroup(botId)),
  change('bots.wecomLocal.reconnect', (wecom, botId) => wecom.reconnect(botId)),
  change('bots.wecomLocal.dismiss', (wecom, botId) => wecom.dismiss(botId)),
  defineMethod({
    name: 'bots.wecomLocal.resend',
    permission: 'accounts-admin',
    params: WecomLocalResend,
    handler: async ({ botId, mid }, context) => {
      await host(context).resend(botId, mid)
      return host(context).state(botId)
    }
  }),
  change('bots.wecomLocal.remove', (wecom, botId) => wecom.remove(botId))
]
