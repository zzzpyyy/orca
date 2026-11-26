// The people and groups a bot's DingTalk setup lists, and the dws search that adds one.
import React, { useId, useState } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  DingTalkLocalGroupMatch,
  DingTalkLocalPerson
} from '../../../../../shared/connectors/dingtalk-local-state'
import type {
  DingTalkLocalDmEntry,
  DingTalkLocalGroupEntry
} from '../../../../../shared/rpc-contract/bots-dingtalk-local-params'
import { botErrorMessage } from '../bot-presentation'
import { dingTalkCall } from './dingtalk-local-client'

type Match = { id: string; name: string; detail: string }

function DingTalkSearch({
  bot,
  profile,
  method,
  label,
  placeholder,
  taken,
  onAdd
}: {
  bot: Bot
  profile: string
  method: 'searchPeople' | 'searchGroups'
  label: string
  placeholder: string
  taken: (id: string) => boolean
  onAdd: (match: Match) => void
}): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<Match[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trimmed = query.trim()
  const search = (): void => {
    if (!trimmed || !profile || busy) {
      return
    }
    setBusy(true)
    setError(null)
    const read =
      method === 'searchPeople'
        ? dingTalkCall<DingTalkLocalPerson[]>(bot, method, { profile, query: trimmed }).then(
            (people) =>
              people.map((person) => ({
                id: person.openDingTalkId,
                name: person.name,
                detail: person.title
              }))
          )
        : dingTalkCall<DingTalkLocalGroupMatch[]>(bot, method, { profile, query: trimmed }).then(
            (groups) => groups.map((group) => ({ id: group.groupId, name: group.name, detail: '' }))
          )
    void read
      .then(setFound)
      .catch((cause: unknown) => {
        setFound(null)
        setError(botErrorMessage(cause))
      })
      .finally(() => setBusy(false))
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={query}
          placeholder={placeholder}
          disabled={!profile}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              search()
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!profile || busy || !trimmed}
          onClick={search}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Search />}
          {t('bots.dingtalk.search', 'Search')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {found?.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('bots.dingtalk.noMatches', 'No matches')}
        </p>
      ) : null}
      {found && found.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {found.map((match) => (
            <li key={match.id} className="flex items-center gap-2 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-sm">
                {match.name || match.id}
                {match.detail ? (
                  <span className="text-xs text-muted-foreground"> · {match.detail}</span>
                ) : null}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={taken(match.id)}
                onClick={() => onAdd(match)}
              >
                {taken(match.id)
                  ? t('bots.dingtalk.added', 'Added')
                  : t('bots.dingtalk.add', 'Add')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function EntryRow({
  name,
  removeLabel,
  onRemove,
  children
}: {
  name: string
  removeLabel: string
  onRemove: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex items-center gap-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <X />
      </Button>
    </li>
  )
}

export function DingTalkPeopleList({
  bot,
  profile,
  dms,
  onChange
}: {
  bot: Bot
  profile: string
  dms: readonly DingTalkLocalDmEntry[]
  onChange: (dms: DingTalkLocalDmEntry[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const same = (dm: DingTalkLocalDmEntry, id: string): boolean =>
    dm.profile === profile && dm.openDingTalkId === id
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t('bots.dingtalk.people', 'Direct messages')}</h3>
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.dingtalk.peopleNote',
          'Only the people listed here can message {{bot}} one to one. Mark yourself so your messages count as yours and what you type in Orca is posted back to you.',
          { bot: bot.name }
        )}
      </p>
      {dms.length > 0 ? (
        <ul className="divide-y divide-border">
          {dms.map((dm) => {
            const name = dm.name || dm.openDingTalkId
            return (
              <EntryRow
                key={`${dm.profile}:${dm.openDingTalkId}`}
                name={name}
                removeLabel={t('bots.dingtalk.removeEntry', 'Remove {{name}}', { name })}
                onRemove={() => onChange(dms.filter((entry) => entry !== dm))}
              >
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={dm.owner}
                    onCheckedChange={(checked) =>
                      onChange(
                        dms.map((entry) =>
                          entry === dm ? { ...entry, owner: checked === true } : entry
                        )
                      )
                    }
                  />
                  {t('bots.dingtalk.thisIsMe', 'This is me')}
                </label>
              </EntryRow>
            )
          })}
        </ul>
      ) : null}
      <DingTalkSearch
        bot={bot}
        profile={profile}
        method="searchPeople"
        label={t('bots.dingtalk.addPerson', 'Add a person')}
        placeholder={t('bots.dingtalk.personPlaceholder', 'Name or phone number')}
        taken={(id) => dms.some((dm) => same(dm, id))}
        onAdd={(match) =>
          onChange([
            ...dms,
            { profile, openDingTalkId: match.id, name: match.name.slice(0, 80), owner: false }
          ])
        }
      />
    </section>
  )
}

export function DingTalkGroupList({
  bot,
  profile,
  groups,
  onChange
}: {
  bot: Bot
  profile: string
  groups: readonly DingTalkLocalGroupEntry[]
  onChange: (groups: DingTalkLocalGroupEntry[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const modeLabel = (group: DingTalkLocalGroupEntry, mode: 'at' | 'all'): string =>
    mode === 'all'
      ? t('bots.dingtalk.modeAll', 'Every message')
      : group.requirePrefix && group.prefix
        ? t('bots.dingtalk.modeAtPrefix', '@mention with {{prefix}}', { prefix: group.prefix })
        : t('bots.dingtalk.modeAt', '@mention')
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t('bots.dingtalk.groups', 'Groups')}</h3>
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.dingtalk.groupsNote',
          'In these groups, anyone can ask {{bot}} as the group setting says.',
          { bot: bot.name }
        )}
      </p>
      {groups.length > 0 ? (
        <ul className="divide-y divide-border">
          {groups.map((group) => {
            const name = group.name || group.groupId
            return (
              <EntryRow
                key={`${group.profile}:${group.groupId}`}
                name={name}
                removeLabel={t('bots.dingtalk.removeEntry', 'Remove {{name}}', { name })}
                onRemove={() => onChange(groups.filter((entry) => entry !== group))}
              >
                <Select
                  value={group.mode}
                  onValueChange={(mode) =>
                    onChange(
                      groups.map((entry) =>
                        entry === group
                          ? {
                              ...entry,
                              mode: mode === 'all' ? 'all' : 'at',
                              requirePrefix: mode !== 'all'
                            }
                          : entry
                      )
                    )
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-52"
                    aria-label={t('bots.dingtalk.groupMode', 'When {{name}} reaches the bot', {
                      name
                    })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="at">{modeLabel(group, 'at')}</SelectItem>
                    <SelectItem value="all">{modeLabel(group, 'all')}</SelectItem>
                  </SelectContent>
                </Select>
              </EntryRow>
            )
          })}
        </ul>
      ) : null}
      <DingTalkSearch
        bot={bot}
        profile={profile}
        method="searchGroups"
        label={t('bots.dingtalk.addGroup', 'Add a group')}
        placeholder={t('bots.dingtalk.groupPlaceholder', 'Group name')}
        taken={(id) => groups.some((group) => group.profile === profile && group.groupId === id)}
        onAdd={(match) =>
          onChange([
            ...groups,
            {
              profile,
              groupId: match.id,
              name: match.name.slice(0, 80),
              mode: 'at',
              prefix: '/tsbot',
              requirePrefix: true
            }
          ])
        }
      />
    </section>
  )
}
