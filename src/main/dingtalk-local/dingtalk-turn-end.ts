// What a DingTalk conversation's chat turns post back: an IM-started turn's card as it starts, its
// answer once it ends (one answer names the messages it covered), and in the owner's own DM a turn
// they typed in Orca with its answer, as Slack posts an owner's Orca messages to threads they began.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isTextBlock } from '../../shared/native-chat/native-chat-types'
import type { ChatNews } from '../external-conversations/external-conversation-chat'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { isPersonsMessage } from '../external-conversations/slack-mirror'
import type { ImJournal } from '../im-stream/im-stream-follow'
import {
  imEndedTurnItemId,
  imJoinedMessageRefs,
  readImTurnItems
} from '../im-stream/im-stream-turn-watch'
import {
  stableOwnTurnReplyId,
  stableReplyId,
  stableSendUuid,
  type ConversationRow,
  type DingTalkSetup,
  type ReplyRow
} from './dingtalk-domain'
import { dingTalkMessageRef } from './dingtalk-inbox-delivery'
import type { DingTalkLedger } from './dingtalk-ledger'
import type { DingTalkReplies } from './dingtalk-reply-delivery'
import type { DingTalkTurnDeliveries } from './dingtalk-turns'

type TurnStarted = Extract<ConversationEvent, { kind: 'turn-started' }>
type TurnEnded = Extract<ConversationEvent, { kind: 'turn-ended' }>
type ChatTurnEnded = Extract<ChatNews, { kind: 'turn-ended' }>

export type DingTalkTurnEndDeps = {
  ledger: DingTalkLedger
  setup: () => DingTalkSetup | null
  turns: DingTalkTurnDeliveries
  replies: DingTalkReplies
  journal: () => ImJournal | null
  /** The chat a conversation is linked to now. */
  sessionOf: (row: ConversationRow) => string | null
}

const OWN_TURN_LABEL = '（你在 Orca 中发送）'
const NO_TEXT = '（这一轮没有文字回复，详情见 Orca。）'
const FOLDED = '（这条消息和后面的消息一起回答，见下一条回复。）'

function endedWithout(event: TurnEnded): string {
  if (event.stopReason === 'failure') {
    return '（这一轮出错了，没有回复，详情见 Orca。）'
  }
  return event.stopReason === 'cancellation' ? '（这一轮已取消。）' : NO_TEXT
}

/** The owner's words of a turn they typed in Orca; null for any other opener. */
function ownWords(opener: AgentJournalRenderItem | null | undefined): string | null {
  const body = opener?.body
  if (body?.kind !== 'message' || !isPersonsMessage(body) || body.connectorConversation) {
    return null
  }
  const text = body.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text || null
}

export class DingTalkTurnEnds {
  constructor(private readonly deps: DingTalkTurnEndDeps) {}

  started(event: TurnStarted): void {
    const { externalId, source } = event.conversation
    if (source !== 'dingtalk') {
      return
    }
    const { ledger, turns, replies } = this.deps
    const replaced = turns.start(externalId, event.at, event.deliveryId, event.paneKey)
    const snapshot = ledger.snapshot()
    const conversation = snapshot.conversations[externalId]
    if (!conversation) {
      return
    }
    if (replaced !== null) {
      replies.hold(stableReplyId(conversation.externalId, replaced), FOLDED)
    }
    if (turns.answersMessage(snapshot, externalId, event.at)) {
      replies.begin(conversation, event.at)
    }
  }

  async ended(event: TurnEnded): Promise<void> {
    const { externalId, source } = event.conversation
    const { ledger, turns, replies } = this.deps
    if (source !== 'dingtalk') {
      return
    }
    // Before any await, so a turn told started after this end replaces nothing.
    turns.ending(externalId, event.turnId)
    const conversation = ledger.snapshot().conversations[externalId]
    if (!conversation) {
      return
    }
    const replyKey =
      event.turnId === null ? null : stableReplyId(conversation.externalId, event.turnId)
    const joinedKeys =
      event.origin === 'delivery' && replyKey ? await this.joinedKeys(conversation, replyKey) : []
    const attribution = turns.attribute(ledger.snapshot(), {
      kind: 'turn-ended',
      source,
      externalId,
      turnId: event.turnId,
      origin: event.origin,
      lastAssistantMessage: event.lastAssistantMessage,
      joinedKeys
    })
    // Cards of turns this one replaced say where their answer went.
    for (const at of event.turnId === null ? [] : turns.takeReplaced(externalId, event.turnId)) {
      void replies.settle(stableReplyId(conversation.externalId, at), FOLDED, 'done')
    }
    if (attribution.kind !== 'reply') {
      if (replyKey && attribution.reason !== 'already_replied') {
        await replies.settle(
          replyKey,
          endedWithout(event),
          event.stopReason === 'success' ? 'done' : 'failed'
        )
      }
      return
    }
    try {
      // A repeated or concurrent end of the same turn stores no second reply and claims no rows.
      if (!(await ledger.putReply(attribution.reply))) {
        return
      }
      for (const inboxKey of attribution.inboxKeys) {
        const state = ledger.snapshot().inbox[inboxKey]?.state
        if (state === 'delivered') {
          await ledger.transitionInbox(inboxKey, 'delivered', 'attributed')
        } else if (state === 'delivering') {
          turns.answerEarly(inboxKey)
        }
      }
    } finally {
      turns.end(externalId, event.turnId)
    }
    void replies.send(attribution.reply)
  }

  /** Rows whose messages the journal shows joined the turn the reply answers. Without that turn's
   *  record none: a guess could claim a message a newer turn answers. */
  private async joinedKeys(conversation: ConversationRow, replyKey: string): Promise<string[]> {
    const journal = this.deps.journal()
    const sessionId = this.deps.sessionOf(conversation)
    if (!journal || !sessionId) {
      return []
    }
    const items = await readImTurnItems(journal, sessionId, 3).catch(() => null)
    const turnItemId = this.deps.replies.turnItemId(replyKey) ?? (items && imEndedTurnItemId(items))
    if (!items || !turnItemId) {
      return []
    }
    const refs = imJoinedMessageRefs(items, turnItemId)
    return Object.values(this.deps.ledger.snapshot().inbox)
      .filter(
        (row) =>
          row.externalId === conversation.externalId && refs.has(dingTalkMessageRef(row.event))
      )
      .map((row) => row.key)
  }

  /** A chat's turn ended: one the owner typed in Orca, in their own DM, posts there too. */
  async chatTurnEnded(news: ChatTurnEnded): Promise<void> {
    const setup = this.deps.setup()
    const { ledger } = this.deps
    const conversation = Object.values(ledger.snapshot().conversations).find(
      (row) => row.dmOpenId && this.deps.sessionOf(row) === news.sessionId
    )
    const owned = setup?.dms.some(
      (dm) =>
        dm.owner &&
        dm.profile === conversation?.profile &&
        dm.openDingTalkId === conversation.dmOpenId
    )
    if (!conversation || !owned) {
      return
    }
    const turn = await news.readTurn()
    const words = ownWords(turn.opener ?? turn.latestOpener)
    if (!words || !turn.turnItemId) {
      return
    }
    const key = stableOwnTurnReplyId(conversation.externalId, turn.turnItemId)
    const answer = turn.lastAssistantMessage?.trim() || NO_TEXT
    const reply: ReplyRow = {
      key,
      externalId: conversation.externalId,
      profile: conversation.profile,
      groupId: conversation.groupId,
      text: `${OWN_TURN_LABEL}${words}\n\n---\n\n${answer}`,
      uuid: stableSendUuid(key),
      turnId: news.at,
      state: 'queued',
      error: '',
      updatedAt: Date.now(),
      ...(conversation.dmOpenId ? { dmOpenId: conversation.dmOpenId } : {})
    }
    if (await ledger.putReply(reply)) {
      void this.deps.replies.send(reply)
    }
  }
}
