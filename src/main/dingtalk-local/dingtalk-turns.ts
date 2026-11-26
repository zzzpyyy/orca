import {
  stableReplyId,
  stableSendUuid,
  type ConversationRow,
  type DingTalkExternalId,
  type DingTalkLedgerState,
  type InboxRow,
  type ReplyRow
} from './dingtalk-domain'

export type TurnObservation = {
  kind: 'turn-ended'
  source: string
  externalId: string
  turnId: number | null
  origin?: string
  lastAssistantMessage?: string
  /** The delivery that alone started this turn, from its turn-started event; it owns the turn. */
  deliveryId?: string
  /** Deliveries of turns this one replaced before they ended; it answered them too. */
  foldedDeliveryIds?: readonly string[]
  /** Rows whose messages joined this turn while it ran, as its journal shows; it answered them. */
  joinedKeys?: readonly string[]
}

export type TurnAttribution =
  | { kind: 'reply'; reply: ReplyRow; inboxKeys: string[] }
  | {
      kind: 'ignore'
      reason:
        | 'wrong_source'
        | 'not_delivery'
        | 'missing_turn'
        | 'missing_text'
        | 'conversation_missing'
        | 'already_replied'
    }

export function attributeTurnEnded(
  state: DingTalkLedgerState,
  event: TurnObservation,
  now = Date.now(),
  sweepable: (row: InboxRow) => boolean = () => true
): TurnAttribution {
  if (event.source !== 'dingtalk') {
    return { kind: 'ignore', reason: 'wrong_source' }
  }
  if (event.origin !== 'delivery') {
    return { kind: 'ignore', reason: 'not_delivery' }
  }
  if (event.turnId === null) {
    return { kind: 'ignore', reason: 'missing_turn' }
  }
  const text = event.lastAssistantMessage?.trim()
  if (!text) {
    return { kind: 'ignore', reason: 'missing_text' }
  }
  const conversation = state.conversations[event.externalId]
  if (!conversation) {
    return { kind: 'ignore', reason: 'conversation_missing' }
  }
  const replyKey = stableReplyId(conversation.externalId, event.turnId)
  // A repeated completion must not attribute a newer delivered row to an older turn's reply.
  if (state.replies[replyKey]) {
    return { kind: 'ignore', reason: 'already_replied' }
  }
  const inboxKeys = answeredInboxKeys(state, event, sweepable)
  const reply: ReplyRow = {
    key: replyKey,
    externalId: conversation.externalId,
    profile: conversation.profile,
    groupId: conversation.groupId,
    text: `${mergedPrefix(inboxKeys.map((key) => state.inbox[key]!))}${text}`,
    uuid: stableSendUuid(replyKey),
    turnId: event.turnId,
    state: 'queued',
    error: '',
    updatedAt: now,
    ...(conversation.dmOpenId ? { dmOpenId: conversation.dmOpenId } : {})
  }
  return { kind: 'reply', reply, inboxKeys }
}

const SNIPPET_CHARS = 20

/** One answer to several messages says which, so no ask looks ignored. */
export function mergedPrefix(rows: readonly InboxRow[]): string {
  if (rows.length < 2) {
    return ''
  }
  const quoted = [...rows]
    .sort(
      (a, b) => a.event.createTime.localeCompare(b.event.createTime) || a.updatedAt - b.updatedAt
    )
    .map((row) => {
      const line = row.body.split('\n')[0]!.replace(/\s+/g, ' ').trim()
      return `「${line.length > SNIPPET_CHARS ? `${line.slice(0, SNIPPET_CHARS)}…` : line}」`
    })
  return `（这条回复合并回答了 ${rows.length} 条消息：${quoted.join('')}）\n\n`
}

/** The messages a turn answered: the one delivery that started it, those of turns it replaced, and
 *  those its journal shows joined it, else every sweepable message of the conversation still in
 *  flight, since a busy chat folds those into its running turn. */
function answeredInboxKeys(
  state: DingTalkLedgerState,
  event: TurnObservation,
  sweepable: (row: InboxRow) => boolean
): string[] {
  const rows = Object.values(state.inbox).filter((row) => row.externalId === event.externalId)
  const joined = new Set(event.joinedKeys)
  const folded = new Set(event.foldedDeliveryIds)
  const inFlight = (row: InboxRow) => row.state === 'delivered' || row.state === 'delivering'
  const carried = (row: InboxRow) =>
    inFlight(row) && (joined.has(row.key) || folded.has(row.deliveryId))
  const answered = event.deliveryId
    ? rows.filter((row) => row.deliveryId === event.deliveryId || carried(row))
    : rows.filter((row) => carried(row) || (inFlight(row) && sweepable(row)))
  return answered.map((row) => row.key)
}

const turnKey = (externalId: string, turnId: number | null): string =>
  `${externalId}\u0000${turnId}`

/** One watch's turns: the delivery each named turn answers, and rows answered before they landed. */
export class DingTalkTurnDeliveries {
  // Kept until the turn's reply is stored, so a repeated or concurrent end stays on its own row.
  private readonly named = new Map<string, string>()
  // Turns a newer turn of the same chat replaced before their end was heard, under that turn's key.
  private readonly replaced = new Map<string, { by: string; at: number }>()
  // Each conversation's turn told started whose end isn't heard yet, and its chat.
  private readonly running = new Map<string, { at: number; paneKey: string }>()
  private readonly answeredEarly = new Set<string>()
  private watchedSince = Number.POSITIVE_INFINITY

  /** A new watch: rows delivered before it belong to turns whose end it never hears. */
  watch(now = Date.now()): void {
    this.named.clear()
    this.replaced.clear()
    this.running.clear()
    this.answeredEarly.clear()
    this.watchedSince = now
  }

  /** A turn began; the turn it replaced, if any. One its chat began while the conversation's last
   *  turn had no end heard replaced that turn: a message sent mid-turn can make the chat restart,
   *  and the old turn never ends. */
  start(
    externalId: string,
    at: number,
    deliveryId: string | undefined,
    paneKey: string
  ): number | null {
    const key = turnKey(externalId, at)
    if (deliveryId) {
      this.named.set(key, deliveryId)
    }
    const open = this.running.get(externalId)
    this.running.set(externalId, { at, paneKey })
    if (!open || open.at === at || open.paneKey !== paneKey) {
      return null
    }
    this.replaced.set(turnKey(externalId, open.at), { by: key, at: open.at })
    return open.at
  }

  /** A turn's end was heard, so a turn starting after it replaces nothing. */
  ending(externalId: string, turnId: number | null): void {
    if (turnId === null || this.running.get(externalId)?.at === turnId) {
      this.running.delete(externalId)
    }
  }

  /** The deliveries of the turns `key` replaced, oldest first; it answers them too. */
  private carried(key: string): string[] {
    const ids: string[] = []
    for (const [old, entry] of this.replaced) {
      if (entry.by === key) {
        const owner = this.named.get(old)
        ids.push(...this.carried(old), ...(owner ? [owner] : []))
      }
    }
    return ids
  }

  /** The turns `turnId` replaced, once its end is heard; their cards close with it. */
  takeReplaced(externalId: string, turnId: number): number[] {
    const key = turnKey(externalId, turnId)
    const taken: number[] = []
    for (const [old, entry] of this.replaced) {
      if (entry.by === key) {
        taken.push(...this.takeReplaced(externalId, entry.at), entry.at)
        this.replaced.delete(old)
        this.named.delete(old)
      }
    }
    return taken
  }

  attribute(
    state: DingTalkLedgerState,
    event: Omit<TurnObservation, 'deliveryId' | 'foldedDeliveryIds'>
  ): TurnAttribution {
    const key = turnKey(event.externalId, event.turnId)
    // Replaced, yet its end came after all (told after the next turn began): it answered its own.
    this.replaced.delete(key)
    const deliveryId = this.named.get(key)
    const result = attributeTurnEnded(
      state,
      { ...event, deliveryId, foldedDeliveryIds: this.carried(key) },
      Date.now(),
      (row) => this.sweepable(row)
    )
    if (result.kind === 'ignore' && result.reason !== 'already_replied') {
      this.named.delete(key)
    }
    return result
  }

  /** Whether a turn that just began answers a DingTalk message: the delivery that started it, one of
   *  a turn it replaced, or one still in flight from this watch. An owner's turn typed in Orca
   *  answers none. */
  answersMessage(state: DingTalkLedgerState, externalId: string, at: number): boolean {
    const key = turnKey(externalId, at)
    const deliveryId = this.named.get(key)
    const folded = this.carried(key)
    return Object.values(state.inbox).some(
      (row) =>
        row.externalId === externalId &&
        (folded.includes(row.deliveryId) ||
          (deliveryId
            ? row.deliveryId === deliveryId
            : (row.state === 'delivered' || row.state === 'delivering') && this.sweepable(row)))
    )
  }

  /** The turn's reply is stored and its rows claimed. */
  end(externalId: string, turnId: number | null): void {
    this.named.delete(turnKey(externalId, turnId))
  }

  answerEarly(inboxKey: string): void {
    this.answeredEarly.add(inboxKey)
  }

  /** Whether a turn answered this row before its delivery landed; answered once. */
  landed(inboxKey: string): boolean {
    return this.answeredEarly.delete(inboxKey)
  }

  private sweepable(row: InboxRow): boolean {
    return (
      row.updatedAt >= this.watchedSince &&
      !this.answeredEarly.has(row.key) &&
      ![...this.named.values()].includes(row.deliveryId)
    )
  }
}

export function conversationKeyFor(row: ConversationRow): {
  source: 'dingtalk'
  externalId: DingTalkExternalId
} {
  return { source: 'dingtalk', externalId: row.externalId }
}
