// WeCom on the bot's host: the owner enters their AI bot's Bot ID and Secret (sealed there, never
// shown again), then pairs their DM, and later groups, with a code the bot is sent.
import React, { useId, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import type { Bot } from '../../../../../shared/bot-types'
import type { WecomLocalState } from '../../../../../shared/bots/wecom-local'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { wecomErrorLine, wecomNeedsCredentials, wecomStatusLine } from './wecom-copy'
import { wecomCall, useWecomState, type WecomMethod } from './wecom-local-client'

const WECOM_ADMIN_URL = 'https://work.weixin.qq.com/wework_admin/frame'

function CredentialsForm({
  bot,
  formId,
  busy,
  onSubmit
}: {
  bot: Bot
  formId: string
  busy: boolean
  onSubmit: (botKey: string, secret: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const botKeyId = useId()
  const secretId = useId()
  const [botKey, setBotKey] = useState('')
  const [secret, setSecret] = useState('')
  return (
    <form
      id={formId}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!botKey.trim() || !secret || busy) {
          return
        }
        // The field forgets the Secret the moment it is sent.
        const sent = secret
        setSecret('')
        onSubmit(botKey.trim(), sent)
      }}
    >
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.wecom.steps',
          'In the WeCom admin console, open Apps, create an AI bot, choose API mode with a long connection, and copy its Bot ID and Secret.'
        )}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => openBotHostPageOrSay(bot.hostId, WECOM_ADMIN_URL, { local: 'system' })}
      >
        <ExternalLink />
        {t('bots.wecom.openConsole', 'Open WeCom admin console')}
      </Button>
      <Label htmlFor={botKeyId}>{t('bots.wecom.botId', 'Bot ID')}</Label>
      <Input
        id={botKeyId}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        maxLength={128}
        value={botKey}
        onChange={(event) => setBotKey(event.target.value)}
      />
      <Label htmlFor={secretId}>{t('bots.wecom.secret', 'Secret')}</Label>
      <Input
        id={secretId}
        type="password"
        autoComplete="off"
        spellCheck={false}
        maxLength={256}
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.wecom.sealed',
          'The bot’s computer seals the Secret with its keychain. Orca never shows it again.'
        )}
      </p>
    </form>
  )
}

function PairingCode({ state }: { state: WecomLocalState }): React.JSX.Element | null {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  if (!state.pairingText) {
    return null
  }
  const code = state.pairingText
  return (
    <div className="flex flex-col gap-2">
      {state.pairingFor === 'group' ? (
        <p className="text-sm">
          {t(
            'bots.wecom.pairGroupSteps',
            'Add the bot to the group, then @mention it with this code from your own account. It expires in five minutes.'
          )}
        </p>
      ) : null}
      <code className="block rounded-md bg-muted p-2 font-mono text-xs break-all select-all">
        {code}
      </code>
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() =>
          void window.api.ui
            .writeClipboardText(code)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? t('bots.wecom.copied', 'Copied') : t('bots.wecom.copyCode', 'Copy code')}
      </Button>
    </div>
  )
}

export function BotWecomSetup({
  bot,
  onClose
}: {
  bot: Bot
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const formId = useId()
  const state = useWecomState(bot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (method: WecomMethod, params?: unknown): void => {
    setBusy(true)
    setError(null)
    void wecomCall(bot, method, params)
      .catch((cause: unknown) => setError(wecomErrorLine(cause, t)))
      .finally(() => setBusy(false))
  }
  const entering = state ? wecomNeedsCredentials(state) : false
  const live = state && !entering
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent surface="security" aria-describedby={undefined}>
        <div className="flex items-center gap-2">
          <BotAppBrandLogo app={{ id: 'wecom-local' }} />
          <DialogTitle>{t('bots.wecom.title', 'WeCom on this bot’s computer')}</DialogTitle>
        </div>
        <p className="text-sm text-muted-foreground" role="status">
          {state
            ? wecomStatusLine(state, t)
            : state === null
              ? t('bots.wecom.hostError', 'Couldn’t read the bot’s computer.')
              : t('bots.wecom.loading', 'Checking the bot’s computer…')}
        </p>
        {state?.botHint && live ? (
          <p className="text-xs text-muted-foreground">
            {t('bots.wecom.botHint', 'Bot ID ending in {{hint}}', { hint: state.botHint })}
          </p>
        ) : null}
        {entering ? (
          <CredentialsForm
            bot={bot}
            formId={formId}
            busy={busy}
            onSubmit={(botKey, secret) => run('connect', { botId: bot.id, botKey, secret })}
          />
        ) : null}
        {state ? <PairingCode state={state} /> : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('bots.wecom.close', 'Close')}
          </Button>
          {live ? (
            <Button variant="outline" disabled={busy} onClick={() => run('remove')}>
              {t('bots.wecom.disconnect', 'Disconnect WeCom')}
            </Button>
          ) : null}
          {state?.status === 'listening' && state.pairingFor !== 'group' ? (
            <Button variant="outline" disabled={busy} onClick={() => run('pairGroup')}>
              {t('bots.wecom.pairGroup', 'Pair a group')}
            </Button>
          ) : null}
          {state?.status === 'replaced' || state?.status === 'auth-failed' ? (
            <Button
              variant={entering ? 'outline' : 'default'}
              disabled={busy}
              onClick={() => run('reconnect')}
            >
              {t('bots.wecom.reconnect', 'Reconnect')}
            </Button>
          ) : null}
          {entering ? (
            <Button type="submit" form={formId} disabled={busy}>
              {t('bots.wecom.connect', 'Connect and pair')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
