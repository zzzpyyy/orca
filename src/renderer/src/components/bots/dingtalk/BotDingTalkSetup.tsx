// "Add connector → DingTalk": the dws account on the bot's computer, the people who may message the
// bot one to one, its groups, and how it replies. dws keeps the sign-in; the owner runs it themselves.
import React, { useEffect, useId, useState } from 'react'
import { Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel, DialogError } from '@/components/ui/dialog-parts'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  DingTalkLocalBotState,
  DingTalkLocalProfiles
} from '../../../../../shared/connectors/dingtalk-local-state'
import type {
  DingTalkLocalDmEntry,
  DingTalkLocalGroupEntry
} from '../../../../../shared/rpc-contract/bots-dingtalk-local-params'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { botErrorMessage } from '../bot-presentation'
import { useBotHostLabel } from '../use-bot-host-label'
import { dingTalkCall, useDingTalkState } from './dingtalk-local-client'
import { DingTalkGroupList, DingTalkPeopleList } from './dingtalk-setup-lists'

const DWS_RELEASES = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases'
const LOGIN_COMMAND = 'dws auth login'

type Draft = {
  autoReply: boolean
  streaming: boolean
  dms: DingTalkLocalDmEntry[]
  groups: DingTalkLocalGroupEntry[]
}

const draftOf = (state: DingTalkLocalBotState): Draft => ({
  // A first setup answers by default; a saved one keeps what it says.
  autoReply: state.dms.length + state.groups.length > 0 ? state.autoReply : true,
  streaming: state.streaming,
  dms: state.dms,
  groups: state.groups
})

function useDwsProfiles(bot: Bot, open: boolean) {
  const { hostId, id } = bot
  const [read, setRead] = useState<DingTalkLocalProfiles | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!open) {
      return
    }
    let alive = true
    setError(null)
    void dingTalkCall<DingTalkLocalProfiles>({ hostId, id }, 'profiles', {})
      .then((profiles) => alive && setRead(profiles))
      .catch((cause: unknown) => alive && setError(botErrorMessage(cause)))
    return () => {
      alive = false
    }
  }, [hostId, id, open, round])
  return { read, error, refresh: () => setRound((value) => value + 1) }
}

function SwitchRow({
  label,
  note,
  checked,
  onChange
}: {
  label: string
  note: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

export function BotDingTalkSetup({
  bot,
  open,
  onOpenChange
}: {
  bot: Bot
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const host = useBotHostLabel(bot.hostId)
  const state = useDingTalkState(open ? bot : null)
  const profiles = useDwsProfiles(bot, open)
  const profileId = useId()
  const [edited, setDraft] = useState<Draft | null>(null)
  const [picked, setProfile] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What the host has until the owner edits, so a refresh mid-edit keeps the edits.
  const draft = edited ?? (state ? draftOf(state) : null)
  const accounts = profiles.read?.profiles ?? []
  const used = draft?.dms[0]?.profile ?? draft?.groups[0]?.profile
  const profile =
    (
      accounts.find((entry) => entry.profile === picked) ??
      accounts.find((entry) => entry.profile === used) ??
      accounts.find((entry) => entry.current) ??
      accounts[0]
    )?.profile ?? ''
  const close = (next: boolean): void => {
    if (busy) {
      return
    }
    if (!next) {
      setDraft(null)
      setError(null)
    }
    onOpenChange(next)
  }
  const dws = profiles.read?.dws
  const missing = dws && 'missing' in dws ? dws.missing : null
  const noAccount = Boolean(dws && !missing && accounts.length === 0)
  const save = (): void => {
    if (!draft || busy) {
      return
    }
    setBusy(true)
    setError(null)
    void dingTalkCall<DingTalkLocalBotState>(bot, 'save', { botId: bot.id, ...draft })
      .then(() => {
        setBusy(false)
        setDraft(null)
        onOpenChange(false)
      })
      .catch((cause: unknown) => {
        setBusy(false)
        setError(botErrorMessage(cause))
      })
  }
  const where = host
    ? t('bots.dingtalk.onHost', 'on {{host}}', { host })
    : t('bots.dingtalk.onThisComputer', 'on this computer')
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="form" surface="security" scrollable busy={busy}>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <BotAppBrandLogo app={{ id: 'dingtalk' }} />
            <DialogTitle>
              {t('bots.dingtalk.setupTitle', 'DingTalk for {{bot}}', { bot: bot.name })}
            </DialogTitle>
          </div>
          <DialogDescription>
            {t(
              'bots.dingtalk.setupLine',
              'Messages reach {{bot}} through dws, DingTalk’s command line, signed in to your own account {{where}}.',
              { bot: bot.name, where }
            )}
          </DialogDescription>
        </DialogHeader>
        {state === null ? (
          <DialogError>
            {t(
              'bots.dingtalk.hostError',
              'Couldn’t read the DingTalk setup on the bot’s computer.'
            )}
          </DialogError>
        ) : null}
        <section className="space-y-2" aria-live="polite">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor={profileId}>{t('bots.dingtalk.account', 'DingTalk account')}</Label>
              <Select value={profile} onValueChange={setProfile} disabled={accounts.length === 0}>
                <SelectTrigger id={profileId} className="w-full">
                  <SelectValue
                    placeholder={
                      dws
                        ? t('bots.dingtalk.noAccount', 'No account signed in')
                        : t('bots.dingtalk.checking', 'Checking dws…')
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((entry) => (
                    <SelectItem key={entry.profile} value={entry.profile}>
                      {[entry.userName, entry.corpName].filter(Boolean).join(' · ') ||
                        entry.profile}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('bots.dingtalk.refreshAccounts', 'Check dws again')}
              onClick={profiles.refresh}
            >
              <RefreshCw />
            </Button>
          </div>
          {missing ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'bots.dingtalk.dwsMissing',
                'dws isn’t installed {{where}}. Install the official release, then check again.',
                { where }
              )}{' '}
              <Button
                type="button"
                variant="link"
                size="inlineText"
                onClick={(event) => openAppHttpLink(DWS_RELEASES, { event })}
              >
                {t('bots.dingtalk.getDws', 'Get dws')}
                <ExternalLink />
              </Button>
            </p>
          ) : null}
          {noAccount ? (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">
                {t(
                  'bots.dingtalk.signIn',
                  'Sign in to dws {{where}} with this command, then check again. dws keeps the sign-in; Orca never sees it.',
                  { where }
                )}
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs select-all">
                  {LOGIN_COMMAND}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('bots.dingtalk.copyCommand', 'Copy command')}
                  onClick={() => void window.api.ui.writeClipboardText(LOGIN_COMMAND)}
                >
                  <Copy />
                </Button>
              </div>
            </div>
          ) : null}
          {profiles.read?.error || profiles.error ? (
            <DialogError>{profiles.read?.error || profiles.error}</DialogError>
          ) : null}
        </section>
        {draft ? (
          <>
            <DingTalkPeopleList
              bot={bot}
              profile={profile}
              dms={draft.dms}
              onChange={(dms) => setDraft({ ...draft, dms })}
            />
            <DingTalkGroupList
              bot={bot}
              profile={profile}
              groups={draft.groups}
              onChange={(groups) => setDraft({ ...draft, groups })}
            />
            <section className="space-y-3">
              <SwitchRow
                label={t('bots.dingtalk.autoReply', 'Reply in DingTalk')}
                note={t(
                  'bots.dingtalk.autoReplyNote',
                  'Each answer is posted back where it was asked. Off, answers stay in Orca.'
                )}
                checked={draft.autoReply}
                onChange={(autoReply) => setDraft({ ...draft, autoReply })}
              />
              <SwitchRow
                label={t('bots.dingtalk.streaming', 'Show progress while it works')}
                note={t(
                  'bots.dingtalk.streamingNote',
                  'A card shows the steps and is replaced by the answer. Off, only the answer is posted. Both settings hold for every bot using DingTalk {{where}}.',
                  { where }
                )}
                checked={draft.streaming}
                onChange={(streaming) => setDraft({ ...draft, streaming })}
              />
            </section>
          </>
        ) : null}
        {error ? <DialogError>{error}</DialogError> : null}
        <DialogFooter>
          <DialogCancel />
          <Button size="sm" disabled={!draft || busy} onClick={save}>
            {busy ? t('bots.dingtalk.saving', 'Saving…') : t('bots.dingtalk.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
