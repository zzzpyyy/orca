// The answers WeCom is owed: each filled outbox row of this binding's chats, and each notice for a
// message no turn answers. The final text is chosen once; wecom-final sends it at most once.
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { ANSWER_CUT_NOTE } from '../connector-cloud/connector-snapshot'
import { imAnswerText } from '../im-stream/im-stream-mask'
import { readImTurnView } from '../im-stream/im-stream-turn-view'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { wecomConversation, type WecomBinding } from './wecom-binding'
import { WECOM_COPY } from './wecom-copy'
import { finalChosen, sendWecomFinal, type WecomFinalPort } from './wecom-final'
import type { WecomMessageRow } from './wecom-inbox-rows'
import type { WecomStore } from './wecom-store-ops'

const PAGE = 32

export type WecomRepliesDeps = {
  store: WecomStore
  binding: WecomBinding
  signal: AbortSignal
  port: WecomFinalPort
  /** Before the final is chosen: stops the message's live frames; whether its stream may finish. */
  prepare: (row: WecomMessageRow) => Promise<'stream' | 'push'>
  /** After the final is chosen to go as pushed messages: the stream stops showing progress. */
  releaseStream: (mid: string) => Promise<void>
  done: (mid: string) => void
}

export type WecomRepliesResult = { retry: boolean; errcode?: number }

/** The outbox, once the structured agent session host has started. */
export async function wecomReplyJournal(
  runtime: OrcaRuntimeService
): Promise<ConnectorReplyJournal | null> {
  const journal = getStructuredAgentSessionHost()?.deps.store.connectorReplies()
  if (journal) {
    return journal
  }
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  return getStructuredAgentSessionHost()?.deps.store.connectorReplies() ?? null
}

type Filled = JournalConnectorReplyRow & { fill: NonNullable<JournalConnectorReplyRow['fill']> }

/** A long answer's prose was capped in its row: the turn's own answer is read whole from the journal. */
async function answerOf(row: Filled): Promise<string> {
  const prose = row.fill.prose ?? ''
  if (!prose.endsWith(ANSWER_CUT_NOTE)) {
    return prose
  }
  try {
    const reads = await getStructuredAgentSessionHost()?.journalReads(row.sessionId)
    const whole = reads ? (await readImTurnView(reads, row.messageId)).answer : ''
    return whole.length > prose.length - ANSWER_CUT_NOTE.length ? whole : prose
  } catch {
    return prose
  }
}

async function finalText(
  row: Filled,
  own: WecomMessageRow,
  answerer: WecomMessageRow | null,
  joined: readonly WecomMessageRow[]
): Promise<string> {
  if (row.fill.answerDeliveryId !== row.deliveryId) {
    return [own.notice, WECOM_COPY.merged(answerer?.preview ?? '…')].filter(Boolean).join('\n\n')
  }
  // Masked as its progress was, so the final shows no key the stream hid.
  const answer = row.fill.outcome === 'answered' ? imAnswerText((await answerOf(row)).trim()) : ''
  const failure = row.fill.outcome === 'failed' ? row.fill.failure : undefined
  return [
    own.notice,
    joined.length > 0 ? WECOM_COPY.mergedWith(joined.map((entry) => entry.preview)) : null,
    answer ||
      (failure
        ? WECOM_COPY.failed(failure)
        : WECOM_COPY.outcome(row.fill.outcome, row.fill.toolsRan))
  ]
    .filter(Boolean)
    .join('\n\n')
}

async function owedRows(
  journal: Pick<ConnectorReplyJournal, 'readOwed'>,
  binding: WecomBinding,
  conversations: ReadonlySet<string>,
  signal: AbortSignal
): Promise<Filled[]> {
  const owed: Filled[] = []
  let after: string | null = null
  while (!signal.aborted) {
    const rows = await journal.readOwed(binding.account, after, PAGE)
    for (const row of rows) {
      after = row.deliveryId
      if (
        row.fill &&
        row.account === binding.account &&
        row.conversation.source === 'wecom-local' &&
        conversations.has(row.conversation.externalId)
      ) {
        owed.push({ ...row, fill: row.fill })
      }
    }
    if (rows.length < PAGE) {
      break
    }
  }
  return owed
}

async function sendChosen(
  deps: WecomRepliesDeps,
  row: WecomMessageRow,
  text: string
): Promise<WecomRepliesResult & { sent: boolean }> {
  const { store, binding } = deps
  let chosen = row
  if (!finalChosen(chosen)) {
    const via = await deps.prepare(row)
    const picked = await store.chooseFinal(binding.account, row.mid, via, text)
    if (!picked || !finalChosen(picked)) {
      return { retry: false, sent: picked?.answered === 1 }
    }
    chosen = picked
  }
  if (!finalChosen(chosen)) {
    return { retry: false, sent: false }
  }
  if (chosen.final_via === 'push') {
    await deps.releaseStream(row.mid)
  }
  const result = await sendWecomFinal(store, binding.account, chosen, deps.port)
  if (result.kind === 'retry') {
    return { retry: true, sent: false, ...(result.errcode ? { errcode: result.errcode } : {}) }
  }
  await store.answered(binding.account, row.mid)
  deps.done(row.mid)
  return { retry: false, sent: true }
}

export async function sendWecomReplies(
  journal: Pick<ConnectorReplyJournal, 'readOwed' | 'sent'>,
  deps: WecomRepliesDeps
): Promise<WecomRepliesResult> {
  const { store, binding: b, signal } = deps
  const result: WecomRepliesResult = { retry: false }
  const failed = (outcome: WecomRepliesResult): void => {
    result.retry ||= outcome.retry
    if (outcome.errcode) {
      result.errcode = outcome.errcode
    }
  }
  await store.settleAnswered(b.account)
  const conversations = new Set(
    (await store.chats(b.account)).map((chat) => wecomConversation(b, chat.chat).externalId)
  )
  const owed = await owedRows(journal, b, conversations, signal)
  const messages = new Map<string, WecomMessageRow>()
  for (const row of owed) {
    const message = await store.message(b.account, row.deliveryId)
    if (message) {
      messages.set(row.deliveryId, message)
    }
  }
  for (const row of owed) {
    if (signal.aborted) {
      return result
    }
    const own = messages.get(row.deliveryId)
    const key = { account: b.account, deliveryId: row.deliveryId }
    // Delivered before a restart that came before its admission was kept: admitted first.
    if (own?.state === 'pending') {
      continue
    }
    if (!own || own.answered === 1) {
      await journal.sent([key])
      if (own) {
        await store.settled(b.account, own.mid)
      }
      continue
    }
    const joined = owed.flatMap((other) => {
      const message = messages.get(other.deliveryId)
      return other.deliveryId !== row.deliveryId &&
        other.fill.answerDeliveryId === row.deliveryId &&
        message
        ? [message]
        : []
    })
    const answerer =
      messages.get(row.fill.answerDeliveryId) ??
      (await store.message(b.account, row.fill.answerDeliveryId))
    const outcome = await sendChosen(deps, own, await finalText(row, own, answerer, joined))
    if (outcome.sent) {
      await journal.sent([key])
      await store.settled(b.account, own.mid)
    } else {
      failed(outcome)
    }
  }
  for (const notice of await store.owedNotices(b.account)) {
    if (signal.aborted) {
      return result
    }
    const outcome = await sendChosen(deps, notice, notice.final_text ?? '')
    if (!outcome.sent) {
      failed(outcome)
    }
  }
  return result
}
