// The bot's WeCom row in its Connectors list: what the connection does now, what needs a look, and
// the chat the owner's WeCom messages go to.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { WecomLocalState } from '../../../../../shared/bots/wecom-local'
import { WecomIcon } from '../../icons/WecomIcon'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { BotConnectorRowFrame } from '../BotConnectorRow'
import { openBotSession } from '../bot-session-open'
import { BotWecomSetup } from './BotWecomSetup'
import { wecomErrorLine, wecomNeedsOwner, wecomStatusLine, wecomStreamingLine } from './wecom-copy'
import { wecomCall } from './wecom-local-client'

function WecomReview({ bot, state }: { bot: Bot; state: WecomLocalState }): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState<string | null>(null)
  const call = (key: string, method: 'dismiss' | 'resend', params?: unknown): void => {
    setBusy(key)
    void wecomCall(bot, method, params)
      .catch((error: unknown) => toast.error(wecomErrorLine(error, t)))
      .finally(() => setBusy(null))
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2" role="status">
      {state.review ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.wecom.review',
            '{{count}} WeCom messages didn’t reach the bot’s chat. WeCom was told why.',
            {
              count: state.review,
              defaultValue_one: 'A WeCom message didn’t reach the bot’s chat. WeCom was told why.'
            }
          )}
        </p>
      ) : null}
      {state.unconfirmed ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.wecom.unconfirmed',
            '{{count}} replies may not have reached WeCom. Orca never sends one twice on its own: check WeCom, then resend any that are missing.',
            {
              count: state.unconfirmed,
              defaultValue_one:
                'A reply may not have reached WeCom. Orca never sends it twice on its own: check WeCom, then resend it if it’s missing.'
            }
          )}
        </p>
      ) : null}
      {state.unconfirmedReplies?.length ? (
        <ul className="flex flex-col gap-1">
          {state.unconfirmedReplies.map((reply) => (
            <li key={reply.mid} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs">{reply.preview}</span>
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => call(reply.mid, 'resend', { botId: bot.id, mid: reply.mid })}
              >
                {t('bots.wecom.resend', 'Resend')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {state.replyError !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.wecom.replyError',
            'WeCom refused a reply (error {{code}}). Orca keeps trying.',
            { code: state.replyError }
          )}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={busy !== null}
        onClick={() => call('dismiss', 'dismiss')}
      >
        {t('bots.wecom.dismiss', 'Dismiss')}
      </Button>
    </div>
  )
}

export function BotWecomCard({
  bot,
  state
}: {
  bot: Bot
  state: WecomLocalState
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const streaming = wecomStreamingLine(state, t)
  const looks =
    state.review ||
    state.unconfirmed ||
    state.streaming !== undefined ||
    state.replyError !== undefined
  return (
    <BotConnectorRowFrame
      icon={<WecomIcon className="size-4" />}
      logo={<BotAppBrandLogo app={{ id: 'wecom-local' }} />}
      name={t('bots.wecom.name', 'WeCom')}
      description={t(
        'bots.wecom.line',
        'Your WeCom DMs and groups with an AI bot, on this computer'
      )}
      status={
        wecomNeedsOwner(state)
          ? { label: t('bots.wecom.needsLook', 'Needs a look'), tone: 'attention' }
          : null
      }
    >
      <p className="text-xs text-muted-foreground">{wecomStatusLine(state, t)}</p>
      <p className="text-xs text-muted-foreground">
        {streaming ??
          t(
            'bots.wecom.streaming',
            'Replies show the bot’s thinking, steps and answer as it works, then the full answer.'
          )}
      </p>
      {looks ? <WecomReview bot={bot} state={state} /> : null}
      <div className="flex flex-wrap gap-2">
        {state.sessionId ? (
          <Button size="sm" onClick={() => openBotSession(bot, state.sessionId!)}>
            {t('bots.wecom.openConversation', 'Open conversation')}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {t('bots.wecom.settings', 'Connection settings')}
        </Button>
      </div>
      {open ? <BotWecomSetup bot={bot} onClose={() => setOpen(false)} /> : null}
    </BotConnectorRowFrame>
  )
}
