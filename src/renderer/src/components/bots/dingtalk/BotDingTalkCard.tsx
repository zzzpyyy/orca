// A bot's DingTalk row: who and where it answers, whether dws listens and replies post, and each
// DingTalk conversation's chat, which opens again from here after its tab is closed.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { DingTalkLocalBotState } from '../../../../../shared/connectors/dingtalk-local-state'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { BotConnectorDetails, BotConnectorRowFrame } from '../BotConnectorRow'
import { BotConnectorSection } from '../bot-connector-people'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { botErrorMessage } from '../bot-presentation'
import { openBotSession } from '../bot-session-open'
import { BotDingTalkSetup } from './BotDingTalkSetup'
import { dingTalkCall } from './dingtalk-local-client'

/** What the owner has to fix, in one line; null while all is well. */
export function dingTalkProblem(state: DingTalkLocalBotState, t: Translate): string | null {
  if (state.dws && 'missing' in state.dws) {
    return t('bots.dingtalk.problemDws', 'dws isn’t running: {{reason}}', {
      reason: state.dws.missing
    })
  }
  if (state.listenerErrors.length > 0) {
    return t('bots.dingtalk.problemListener', 'A listener stopped: {{reason}}', {
      reason: state.listenerErrors[0]
    })
  }
  if (state.failedReplies + state.uncertainReplies > 0) {
    return t(
      'bots.dingtalk.problemReplies',
      '{{count}} replies didn’t post. Orca retries on restart.',
      {
        count: state.failedReplies + state.uncertainReplies,
        defaultValue_one: 'A reply didn’t post. Orca retries on restart.'
      }
    )
  }
  if (state.degraded) {
    return t(
      'bots.dingtalk.problemDegraded',
      'Live progress is off for now, so DingTalk gets a notice and then the answer: {{reason}}',
      { reason: state.degraded }
    )
  }
  return null
}

export function BotDingTalkCard({
  bot,
  state,
  title
}: {
  bot: Bot
  state: DingTalkLocalBotState
  title?: BotConnectorTitle
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const [setupOpen, setSetupOpen] = useState(false)
  const problem = dingTalkProblem(state, t)
  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('bots.dingtalk.removeTitle', 'Remove DingTalk from {{name}}?', { name: bot.name }),
      description: t(
        'bots.dingtalk.removeNote',
        'DingTalk messages stop reaching {{name}}. Its chats stay in Orca, and dws stays signed in.',
        { name: bot.name }
      ),
      confirmLabel: t('bots.dingtalk.removeConfirm', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await dingTalkCall(bot, 'remove').catch((error: unknown) =>
        toast.error(botErrorMessage(error))
      )
    }
  }
  const reach = [
    t('bots.dingtalk.people', '{{count}} people', {
      count: state.dms.length,
      defaultValue_one: '{{count}} person'
    }),
    t('bots.dingtalk.groups', '{{count}} groups', {
      count: state.groups.length,
      defaultValue_one: '{{count}} group'
    })
  ].join(' · ')
  return (
    <BotConnectorRowFrame
      icon={null}
      logo={<BotAppBrandLogo app={{ id: 'dingtalk' }} />}
      name={title ?? t('bots.dingtalk.name', 'DingTalk')}
      description={problem ?? reach}
      status={
        problem ? { label: t('bots.dingtalk.needsLook', 'Needs a look'), tone: 'attention' } : null
      }
      fix={
        problem
          ? { label: t('bots.dingtalk.openSetup', 'Open setup'), onClick: () => setSetupOpen(true) }
          : null
      }
      actions={{
        link: {
          label: t('bots.dingtalk.editSetup', 'Edit people and groups'),
          onClick: () => setSetupOpen(true)
        },
        remove: {
          label: t('bots.dingtalk.remove', 'Remove DingTalk…'),
          onSelect: () => void remove()
        }
      }}
    >
      {problem ? (
        <p role="status" className="text-xs text-muted-foreground">
          {problem}
        </p>
      ) : null}
      <BotConnectorDetails
        rows={[
          { label: t('bots.dingtalk.reachLabel', 'Answers'), value: reach },
          {
            label: t('bots.dingtalk.dwsLabel', 'dws'),
            value:
              state.dws && 'version' in state.dws
                ? t('bots.dingtalk.listening', '{{version}}, {{count}} listening', {
                    version: state.dws.version,
                    count: state.listeners
                  })
                : t('bots.dingtalk.notRunning', 'Not running')
          },
          {
            label: t('bots.dingtalk.repliesLabel', 'Replies'),
            value: !state.autoReply
              ? t('bots.dingtalk.repliesOff', 'Stay in Orca')
              : state.streaming
                ? t('bots.dingtalk.repliesLive', 'Posted with live progress')
                : t('bots.dingtalk.repliesFinal', 'Posted when done')
          }
        ]}
      />
      <BotConnectorSection
        title={t('bots.dingtalk.conversations', 'Conversations')}
        count={state.conversations.length}
      >
        {state.conversations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('bots.dingtalk.noConversations', 'None yet. The first message starts one.')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {state.conversations.map((conversation) => (
              <li key={conversation.externalId} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {conversation.label}
                  <span className="text-xs text-muted-foreground">
                    {' · '}
                    {conversation.kind === 'dm'
                      ? t('bots.dingtalk.kindDm', 'Direct message')
                      : t('bots.dingtalk.kindGroup', 'Group')}
                  </span>
                </span>
                {conversation.sessionId ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => openBotSession(bot, conversation.sessionId)}
                  >
                    {t('bots.dingtalk.openConversation', 'Open conversation')}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t('bots.dingtalk.chatGone', 'Next message starts a new chat')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </BotConnectorSection>
      <BotDingTalkSetup bot={bot} open={setupOpen} onOpenChange={setSetupOpen} />
    </BotConnectorRowFrame>
  )
}
