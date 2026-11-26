// The local DingTalk connector: dws listeners for each bound group and authorized DM, the inbox that
// takes their messages into chats, and the replies its turns post back.
import { join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import { watchChatNews } from '../external-conversations/external-conversation-chat'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import type { ImJournal } from '../im-stream/im-stream-follow'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  readDingTalkSetup,
  schemas,
  writeDingTalkSetup,
  type ConversationRow,
  type DingTalkProfile,
  type DingTalkSetup
} from './dingtalk-domain'
import { DingTalkInbox } from './dingtalk-inbox-delivery'
import { DingTalkLedger } from './dingtalk-ledger'
import { conversationKey } from './dingtalk-local-conversation'
import { recoverDingTalkLedger } from './dingtalk-local-recovery'
import { statusOf, type DingTalkLocalStatus } from './dingtalk-local-status'
import { DingTalkReplies } from './dingtalk-reply-delivery'
import { DingTalkTurnEnds } from './dingtalk-turn-end'
import { DingTalkTurnDeliveries } from './dingtalk-turns'
import {
  DwsBoundary,
  type DwsConsumer,
  type DwsEvent,
  type DwsSource
} from './dws/dingtalk-dws-boundary'
import { dwsVersion } from './dws/dingtalk-dws-directory'

export type DingTalkLocalConnector = {
  start(): Promise<void>
  stop(): Promise<void>
  reload(): Promise<void>
  status(): DingTalkLocalStatus
  setup(): DingTalkSetup | null
  /** Writes the setup file whole and starts listening as it says. */
  saveSetup(setup: DingTalkSetup): Promise<void>
  dws: Pick<DwsBoundary, 'exec'>
}

type ConnectorDeps = {
  userDataPath: string
  configPath?: string
  seam: () => ExternalConversationSeam | null
  host: () => ExternalConversationHost
  bots: () => readonly Bot[]
  /** The setup or what it shows changed, for the bots whose page lists it. */
  changed?: (botIds: readonly string[]) => void
  journal?: () => ImJournal | null
  storeFile?: (name: string, bytes: Buffer) => Promise<string>
}

export const dingTalkConfigPath = (userDataPath: string): string =>
  process.env.DINGTALK_LOCAL_CONFIG?.trim() || join(userDataPath, 'dingtalk-local.json')

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

async function storeAttachment(name: string, bytes: Buffer): Promise<string> {
  const store = getAgentSessionAttachmentStore()
  if (!store) {
    throw new Error('no attachment store')
  }
  return await store.storeFile(name, bytes)
}

/** The listeners a setup needs: one @-mention listener per account, one per all-message group, one
 *  per authorized person. */
function listenersOf(setup: DingTalkSetup): [DingTalkProfile, DwsSource][] {
  const atProfiles = new Set<DingTalkProfile>()
  const listeners: [DingTalkProfile, DwsSource][] = []
  for (const group of setup.groups) {
    if (group.mode === 'at') {
      atProfiles.add(group.profile)
    } else {
      listeners.push([group.profile, { kind: 'group', groupId: group.groupId }])
    }
  }
  for (const profile of atProfiles) {
    listeners.push([profile, { kind: 'at' }])
  }
  for (const dm of setup.dms) {
    listeners.push([dm.profile, { kind: 'dm', openDingTalkId: dm.openDingTalkId }])
  }
  return listeners
}

export function installDingTalkLocalConnector(deps: ConnectorDeps): DingTalkLocalConnector {
  const configPath = deps.configPath ?? dingTalkConfigPath(deps.userDataPath)
  const ledger = new DingTalkLedger(join(deps.userDataPath, 'dingtalk-local-ledger.json'))
  let currentSetup: DingTalkSetup | null = null
  const dws = new DwsBoundary(() => currentSetup?.dwsPath ?? 'dws')
  let consumers: DwsConsumer[] = []
  let releaseWatch: (() => void) | null = null
  let releaseNews: (() => void) | null = null
  let running = false
  // Bumped by stop() so a reload awaiting stopConsumers() does not install consumers afterwards.
  let lifecycle = 0
  let lastError = ''
  let degraded = ''
  let dwsState: DingTalkLocalStatus['dws'] = null
  const botIds = (): string[] => deps.bots().map((bot) => bot.id)
  const changed = (): void => {
    deps.changed?.(botIds())
  }
  const recordError = (error: unknown): void => {
    lastError = messageOf(error).slice(0, 300)
    changed()
  }
  const journal = deps.journal ?? (() => getStructuredAgentSessionHost())
  const sessionOfId = (externalId: string): string | null =>
    deps.seam()?.linkedChat(conversationKey(schemas.ExternalId.parse(externalId)))?.sessionId ??
    null
  const sessionOf = (row: ConversationRow): string | null => sessionOfId(row.externalId)
  const turns = new DingTalkTurnDeliveries()
  const replies = new DingTalkReplies({
    ledger,
    dws,
    setup: () => currentSetup,
    journal,
    sessionOf,
    onDegraded: (reason) => {
      if (degraded !== reason) {
        degraded = reason
        changed()
      }
    }
  })
  const inbox = new DingTalkInbox({
    ledger,
    dws,
    seam: deps.seam,
    host: deps.host,
    bots: deps.bots,
    setup: () => currentSetup,
    turns,
    storeFile: deps.storeFile ?? storeAttachment,
    onError: recordError,
    onLinked: changed
  })
  const turnEnds = new DingTalkTurnEnds({
    ledger,
    setup: () => currentSetup,
    turns,
    replies,
    journal,
    sessionOf
  })

  const readSetup = (): Promise<DingTalkSetup> => readDingTalkSetup(configPath, botIds())

  const onEvent = (event: DwsEvent): void => {
    try {
      void inbox
        .receive({ ...event, conversationId: schemas.ConversationId.parse(event.conversationId) })
        .catch(recordError)
    } catch (error) {
      recordError(error)
    }
  }

  const stopConsumers = async (): Promise<void> => {
    const active = consumers
    consumers = []
    await Promise.all(active.map((consumer) => consumer.stop()))
  }

  const reload = async (): Promise<void> => {
    currentSetup = await readSetup()
    if (!running) {
      return
    }
    const generation = lifecycle
    await stopConsumers()
    dwsState = currentSetup.enabled ? await dwsVersion(dws) : null
    if (!running || generation !== lifecycle || !currentSetup.enabled) {
      changed()
      return
    }
    // Turns are watched, and the last run's replies finished, only once the setup turns on.
    if (!releaseWatch) {
      watch()
      await recoverDingTalkLedger(ledger, (reply) => replies.send(reply))
    }
    for (const [profile, source] of listenersOf(currentSetup)) {
      consumers.push(dws.consume(profile, source, onEvent))
    }
    inbox.replay()
    changed()
  }

  const onTurn: Parameters<ExternalConversationSeam['watch']>[1] = (event) => {
    if (event.kind === 'turn-started') {
      turnEnds.started(event)
    } else if (event.kind === 'turn-ended') {
      void turnEnds.ended(event).catch(recordError)
    }
  }

  const watch = (): void => {
    const seam = deps.seam()
    if (!seam) {
      return
    }
    turns.watch()
    const host = deps.host()
    try {
      releaseWatch = seam.watch(host, onTurn)
    } catch (error) {
      recordError(error)
      return
    }
    releaseNews = host.chat
      ? watchChatNews(
          host.chat,
          (news) => {
            if (news.kind === 'turn-ended') {
              void turnEnds.chatTurnEnded(news).catch(recordError)
            }
          },
          'dingtalk-local'
        )
      : null
  }

  return {
    dws,
    start: async () => {
      if (running) {
        return
      }
      running = true
      await ledger.load()
      if (ledger.readError) {
        running = false
        lastError = `DingTalk ledger unreadable, connector not started: ${ledger.readError}`
        throw new Error(lastError)
      }
      await reload()
    },
    stop: async () => {
      if (!running) {
        return
      }
      running = false
      lifecycle += 1
      releaseWatch?.()
      releaseNews?.()
      releaseWatch = null
      releaseNews = null
      await stopConsumers()
      await replies.stop()
      await dws.close()
    },
    reload,
    setup: () => currentSetup,
    saveSetup: async (setup) => {
      await writeDingTalkSetup(configPath, setup)
      await reload()
    },
    status: () =>
      statusOf({
        setup: currentSetup,
        configPath,
        dws: dwsState,
        consumerCount: consumers.length,
        consumerErrors: [...dws.consumerErrors.values()],
        ledger: ledger.snapshot(),
        degraded,
        lastError,
        sessionOf: sessionOfId
      })
  }
}
