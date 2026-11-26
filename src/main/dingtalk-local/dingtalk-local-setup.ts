// A bot's DingTalk setup as its Connectors page reads and writes it: its own DM and group entries in
// the host's one setup file, and the parts of the connector's status that are about that bot.
import type {
  DingTalkLocalBotState,
  DingTalkLocalGroupMatch,
  DingTalkLocalPerson,
  DingTalkLocalProfiles
} from '../../shared/connectors/dingtalk-local-state'
import type { DingTalkLocalSaveInput } from '../../shared/rpc-contract/bots-dingtalk-local-params'
import {
  parseDingTalkSetup,
  readDingTalkSetup,
  schemas,
  type DingTalkGroupSetup
} from './dingtalk-domain'
import type { DingTalkLocalConnector } from './dingtalk-local-connector'
import type { DingTalkLocalStatus } from './dingtalk-local-status'
import {
  dwsProfiles,
  dwsSearchGroups,
  dwsSearchPeople,
  dwsVersion
} from './dws/dingtalk-dws-directory'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function dingTalkBotState(
  connector: DingTalkLocalConnector,
  botId: string
): DingTalkLocalBotState {
  const status = connector.status()
  const setup = connector.setup()
  return {
    available: true,
    enabled: status.enabled,
    autoReply: status.autoReply,
    streaming: status.streaming,
    dws: status.dws,
    listeners: status.consumers,
    listenerErrors: status.consumerErrors,
    pendingMessages: status.pendingMessages,
    pendingReplies: status.pendingReplies,
    failedReplies: status.failedReplies,
    uncertainReplies: status.uncertainReplies,
    degraded: status.degraded,
    lastError: status.lastError,
    dms: (setup?.dms ?? [])
      .filter((dm) => dm.botId === botId)
      .map(({ profile, openDingTalkId, name, owner }) => ({
        profile,
        openDingTalkId,
        name,
        owner
      })),
    groups: (setup?.groups ?? [])
      .filter((group) => group.botId === botId)
      .map(({ profile, groupId, name, mode, prefix, requirePrefix }) => ({
        profile,
        groupId,
        name,
        mode,
        prefix,
        requirePrefix
      })),
    conversations: status.conversations
      .filter((row) => row.botId === botId)
      .map(({ botId: _botId, ...row }) => row)
  }
}

export async function dingTalkProfiles(
  connector: DingTalkLocalConnector
): Promise<DingTalkLocalProfiles> {
  const dws = await dwsVersion(connector.dws)
  if ('missing' in dws) {
    return { dws, profiles: [], error: '' }
  }
  try {
    return { dws, profiles: await dwsProfiles(connector.dws), error: '' }
  } catch (error) {
    return { dws, profiles: [], error: messageOf(error).slice(0, 300) }
  }
}

export const searchDingTalkPeople = (
  connector: DingTalkLocalConnector,
  profile: string,
  query: string
): Promise<DingTalkLocalPerson[]> =>
  dwsSearchPeople(connector.dws, schemas.Profile.parse(profile), query)

export const searchDingTalkGroups = (
  connector: DingTalkLocalConnector,
  profile: string,
  query: string
): Promise<DingTalkLocalGroupMatch[]> =>
  dwsSearchGroups(connector.dws, schemas.Profile.parse(profile), query)

// One read-modify-write of the setup file at a time.
/** What saving a bot's setup needs of the connector. */
type SetupWriter = Pick<DingTalkLocalConnector, 'setup' | 'saveSetup' | 'dws'> & {
  status(): Pick<DingTalkLocalStatus, 'configPath'>
}

const saving = new WeakMap<SetupWriter, Promise<unknown>>()

/**
 * Replaces the bot's entries and keeps every other live bot's; a group keeps what only the file sets.
 * Read from disk, so a file that does not parse fails the save instead of being written over.
 */
export function saveDingTalkBot(
  connector: SetupWriter,
  botIds: readonly string[],
  input: DingTalkLocalSaveInput
): Promise<void> {
  const run = (saving.get(connector) ?? Promise.resolve())
    .catch(() => {})
    .then(() => writeBot(connector, botIds, input))
  saving.set(connector, run)
  return run
}

async function writeBot(
  connector: SetupWriter,
  botIds: readonly string[],
  input: DingTalkLocalSaveInput
): Promise<void> {
  const current = await readDingTalkSetup(connector.status().configPath)
  const { botId } = input
  const live = new Set(botIds)
  const others = <T extends { botId: string }>(entries: readonly T[]): T[] =>
    entries.filter((entry) => entry.botId !== botId && live.has(entry.botId))
  // The account's own name, so "@name /tsbot …" reads as "/tsbot …".
  const accounts = input.groups.length > 0 ? await dwsProfiles(connector.dws).catch(() => []) : []
  const groups: DingTalkGroupSetup[] = input.groups.map((group) => {
    const kept = current.groups.find(
      (entry) =>
        entry.botId === botId && entry.profile === group.profile && entry.groupId === group.groupId
    )
    const own = accounts.find((entry) => entry.profile === group.profile)?.userName.trim()
    return {
      selfOpenId: kept?.selfOpenId ?? '',
      noiseFilter: kept?.noiseFilter ?? true,
      selfNames: kept?.selfNames.length ? kept.selfNames : own ? [own] : [],
      ...group,
      profile: schemas.Profile.parse(group.profile),
      groupId: schemas.GroupId.parse(group.groupId),
      botId
    }
  })
  const dms = [...others(current.dms), ...input.dms.map((dm) => ({ ...dm, botId }))]
  const allGroups = [...others(current.groups), ...groups]
  const next = parseDingTalkSetup(
    {
      ...current,
      enabled: dms.length + allGroups.length > 0,
      autoReply: input.autoReply,
      streaming: input.streaming,
      dms,
      groups: allGroups
    },
    botIds
  )
  await connector.saveSetup(next)
}

export async function removeDingTalkBot(
  connector: SetupWriter,
  botIds: readonly string[],
  botId: string
): Promise<void> {
  const current = connector.setup()
  await saveDingTalkBot(connector, botIds, {
    botId,
    autoReply: current?.autoReply ?? false,
    streaming: current?.streaming ?? true,
    dms: [],
    groups: []
  })
}
