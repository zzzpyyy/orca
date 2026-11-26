// `bots.dingtalkLocal.*`: a bot's local DingTalk setup on the host that runs its connector. dws holds
// the DingTalk sign-in; nothing here reads, takes or returns a credential.
import {
  DingTalkLocalBot,
  DingTalkLocalSave,
  DingTalkLocalSearch
} from '../../../../shared/rpc-contract/bots-dingtalk-local-params'
import {
  dingTalkBotState,
  dingTalkProfiles,
  removeDingTalkBot,
  saveDingTalkBot,
  searchDingTalkGroups,
  searchDingTalkPeople
} from '../../../dingtalk-local/dingtalk-local-setup'
import { defineMethod, type RpcContext } from '../core'

function connector(context: RpcContext) {
  const connector = context.runtime.dingtalkLocal
  if (!connector) {
    throw new Error('Local DingTalk setup is unavailable on this host')
  }
  return connector
}

function botIdsWith(context: RpcContext, botId: string): string[] {
  const botIds = context.runtime.bots.list().map((bot) => bot.id)
  if (!botIds.includes(botId)) {
    throw new Error(`Bot not found: ${botId}`)
  }
  return botIds
}

export const BOT_DINGTALK_LOCAL_METHODS = [
  defineMethod({
    name: 'bots.dingtalkLocal.state',
    permission: 'accounts-admin',
    params: DingTalkLocalBot,
    handler: ({ botId }, context) => dingTalkBotState(connector(context), botId)
  }),
  defineMethod({
    name: 'bots.dingtalkLocal.profiles',
    permission: 'accounts-admin',
    params: null,
    handler: (_, context) => dingTalkProfiles(connector(context))
  }),
  defineMethod({
    name: 'bots.dingtalkLocal.searchPeople',
    permission: 'accounts-admin',
    params: DingTalkLocalSearch,
    handler: ({ profile, query }, context) =>
      searchDingTalkPeople(connector(context), profile, query)
  }),
  defineMethod({
    name: 'bots.dingtalkLocal.searchGroups',
    permission: 'accounts-admin',
    params: DingTalkLocalSearch,
    handler: ({ profile, query }, context) =>
      searchDingTalkGroups(connector(context), profile, query)
  }),
  defineMethod({
    name: 'bots.dingtalkLocal.save',
    permission: 'accounts-admin',
    params: DingTalkLocalSave,
    handler: async (input, context) => {
      await saveDingTalkBot(connector(context), botIdsWith(context, input.botId), input)
      return dingTalkBotState(connector(context), input.botId)
    }
  }),
  defineMethod({
    name: 'bots.dingtalkLocal.remove',
    permission: 'accounts-admin',
    params: DingTalkLocalBot,
    handler: async ({ botId }, context) => {
      await removeDingTalkBot(connector(context), botIdsWith(context, botId), botId)
      return dingTalkBotState(connector(context), botId)
    }
  })
] as const
