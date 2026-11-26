import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  parseDingTalkSetup,
  schemas,
  stableDeliveryId,
  stableExternalId,
  stableReplyId,
  type DingTalkInbound,
  type InboxRow,
  type ReplyRow
} from './dingtalk-domain'
import { decideInbound } from './dingtalk-inbound'
import { DingTalkLedger } from './dingtalk-ledger'
import { recoverDingTalkLedger } from './dingtalk-local-recovery'
import { prepareDingTalkMessage } from './dingtalk-media'
import { DINGTALK_REPLY_CHARS, DingTalkReplies, replyTarget } from './dingtalk-reply-delivery'
import { DingTalkTurnDeliveries } from './dingtalk-turns'
import type { DwsRun } from './dws/dingtalk-dws-boundary'

const profile = schemas.Profile.parse('corp:bot-account')
const owner = 'open-owner'
const setup = parseDingTalkSetup({
  enabled: true,
  autoReply: true,
  streaming: false,
  dms: [{ profile, botId: 'bot', openDingTalkId: owner, owner: true }]
})

function dm(senderOpenId: string, conversationId = `dm:${senderOpenId}`): DingTalkInbound {
  return {
    profile,
    source: 'dm',
    groupId: schemas.GroupId.parse('cid-dm'),
    conversationId: schemas.ConversationId.parse(conversationId),
    messageId: schemas.MessageId.parse(`m-${senderOpenId}`),
    senderOpenId,
    senderName: 'Owner',
    content: 'status?',
    createTime: '2026-11-26 10:00:00'
  }
}

describe('DingTalk DM authorization', () => {
  it('takes only the listed person’s own 1:1 messages and replies only while they stay listed', () => {
    expect(decideInbound(setup, dm(owner))).toMatchObject({ kind: 'accept', body: 'status?' })
    expect(decideInbound(setup, dm('open-stranger'))).toEqual({
      kind: 'drop',
      reason: 'unauthorized'
    })
    // The owner's id on a message from any other chat is not their DM.
    expect(decideInbound(setup, dm(owner, 'dm:open-stranger'))).toEqual({
      kind: 'drop',
      reason: 'unauthorized'
    })
    const row = { profile, groupId: schemas.GroupId.parse('cid-dm'), dmOpenId: owner }
    expect(replyTarget(setup, row)).toEqual({ kind: 'dm', openDingTalkId: owner })
    expect(replyTarget({ ...setup, dms: [] }, row)).toBeNull()
    expect(replyTarget({ ...setup, autoReply: false }, row)).toBeNull()
  })
})

describe('DingTalk merged answers', () => {
  it('claims the messages a named turn’s journal shows joined it, and says which it answered', () => {
    const externalId = stableExternalId(profile, schemas.ConversationId.parse(`dm:${owner}`))
    const row = (id: string, body: string, at: number): InboxRow => {
      const messageId = schemas.MessageId.parse(id)
      return {
        key: id,
        event: { ...dm(owner), messageId, createTime: `2026-11-26 10:00:0${at}` },
        externalId,
        body,
        state: 'delivered',
        deliveryId: stableDeliveryId(profile, messageId),
        reason: '',
        updatedAt: 200 + at
      }
    }
    const first = row('m1', 'deploy the staging branch please', 1)
    const joined = row('m2', 'and run the tests', 2)
    const later = row('m3', 'unrelated', 3)
    const turns = new DingTalkTurnDeliveries()
    turns.watch(100)
    turns.start(externalId, 7, first.deliveryId, 'pane-1')
    const result = turns.attribute(
      {
        version: 1,
        inbox: { m1: first, m2: joined, m3: later },
        conversations: {
          [externalId]: {
            externalId,
            profile,
            groupId: first.event.groupId,
            conversationId: first.event.conversationId,
            botId: 'bot',
            sessionId: 's',
            latestMessageId: later.event.messageId,
            updatedAt: 1,
            dmOpenId: owner
          }
        },
        replies: {},
        watermarks: {},
        streams: {}
      },
      {
        kind: 'turn-ended',
        source: 'dingtalk',
        externalId,
        turnId: 7,
        origin: 'delivery',
        lastAssistantMessage: 'Done.',
        joinedKeys: ['m2']
      }
    )
    expect(result.kind === 'reply' && result.inboxKeys).toEqual(['m1', 'm2'])
    expect(result.kind === 'reply' && result.reply.text).toBe(
      '（这条回复合并回答了 2 条消息：「deploy the staging b…」「and run the tests」）\n\nDone.'
    )
    expect(result.kind === 'reply' && result.reply.dmOpenId).toBe(owner)
  })
})

/** dws's `+messages-send`, taking `network.allowed` sends and failing the rest; records each part. */
function fakeDws(taken: { uuid: string; text: string }[], network: { allowed: number }) {
  return {
    exec: async (_profile: unknown, args: readonly string[]): Promise<DwsRun> => {
      if (network.allowed <= 0) {
        return { code: 2, stdout: '', stderr: 'network down', notStarted: false, timedOut: false }
      }
      network.allowed -= 1
      const uuid = args[args.indexOf('--uuid') + 1]!
      // dws takes a resend under the same uuid as the same message.
      if (!taken.some((entry) => entry.uuid === uuid)) {
        taken.push({ uuid, text: args[args.indexOf('--markdown') + 1]! })
      }
      return { code: 0, stdout: '{"ok":true}', stderr: '', notStarted: false, timedOut: false }
    }
  }
}

describe('DingTalk reply delivery', () => {
  it('posts a long answer’s every part once across a failed send and a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dingtalk-replies-')), 'ledger.json')
    const externalId = stableExternalId(profile, schemas.ConversationId.parse(`dm:${owner}`))
    const key = stableReplyId(externalId, 7)
    const answer = Array.from({ length: 12 }, (_, i) => `段落 ${i} ${'x'.repeat(700)}`).join('\n\n')
    const reply: ReplyRow = {
      key,
      externalId,
      profile,
      groupId: schemas.GroupId.parse('cid-dm'),
      text: answer,
      uuid: 'unused',
      turnId: 7,
      state: 'queued',
      error: '',
      updatedAt: 1_700_000_000_000,
      dmOpenId: owner
    }
    const taken: { uuid: string; text: string }[] = []
    const network = { allowed: 1 }
    const replies = (ledger: DingTalkLedger) =>
      new DingTalkReplies({
        ledger,
        dws: fakeDws(taken, network),
        setup: () => setup,
        journal: () => null,
        sessionOf: () => null,
        onDegraded: () => {},
        delay: async () => {}
      })
    const first = new DingTalkLedger(path)
    await first.load()
    await first.putReply(reply)
    // The network drops after the first part: every retry fails and the reply is marked failed.
    await replies(first).send(reply)
    expect(first.snapshot().replies[key]?.state).toBe('failed')
    expect(taken).toHaveLength(1)
    // Restarted with the network back: recovery posts only the parts not yet taken.
    network.allowed = Number.POSITIVE_INFINITY
    const second = new DingTalkLedger(path)
    await second.load()
    const resent = replies(second)
    await recoverDingTalkLedger(second, (row) => resent.send(row))
    await vi.waitFor(() => expect(second.snapshot().replies[key]?.state).toBe('sent'))
    expect(taken.length).toBeGreaterThan(1)
    expect(taken.every((part) => part.text.length <= DINGTALK_REPLY_CHARS)).toBe(true)
    expect(taken.map((part) => part.text.replace(/^（续 \d+\/\d+）\n/, '')).join('')).toBe(answer)
  })
})

describe('DingTalk received media', () => {
  it('reads only files dws wrote inside its own folder, and names what it could not read', async () => {
    const stored: string[] = []
    const outside = join(mkdtempSync(join(tmpdir(), 'dingtalk-outside-')), 'secret.txt')
    writeFileSync(outside, 'not for the agent')
    const prepared = await prepareDingTalkMessage(
      {
        fetch: async (_profile, _messageId, dir) => {
          await mkdir(join(dir, 'files'), { recursive: true })
          writeFileSync(join(dir, 'files', 'report.pdf'), '%PDF-1.4')
          return { paths: ['files/report.pdf', outside, '../escape.txt'], failures: [] }
        },
        store: async (name) => {
          stored.push(name)
          return `/attachments/${name}`
        }
      },
      { profile, messageId: schemas.MessageId.parse('m-media') },
      'see this [文件] report.pdf file_id=abc\n[语音消息](mediaId=v1)'
    )
    expect(stored).toEqual(['report.pdf'])
    expect(prepared.body).toContain('see this')
    expect(prepared.body).toContain('/attachments/report.pdf')
    expect(prepared.unread).toEqual(['语音消息'])
  })
})
