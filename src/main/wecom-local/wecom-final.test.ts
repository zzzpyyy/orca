// The final answer against a local MOCK of WeCom's long connection (not WeCom), with the inbox on a
// real file behind the bots DB worker's client: no part reaches WeCom twice, across a crash, a lost
// answer, and WeCom refusing the stream; a part whose outcome is unknown is counted unconfirmed.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { BotsDbWorkerClient } from '../bots/db-worker/bots-db-worker-client'
import { closeBotsDbStores, handleBotsDbRequest } from '../bots/db-worker/bots-db-worker-entry'
import { inProcessWorker } from '../worker-threads/in-process-worker.test-fixture'
import type { WecomBinding } from './wecom-binding'
import { WECOM_COPY } from './wecom-copy'
import { finalChosen, sendWecomFinal, wecomFinalParts } from './wecom-final'
import type { WecomArrival, WecomMessageRow } from './wecom-inbox-rows'
import { readWecomCallback } from './wecom-message'
import { MockWecomServer, type MockWecomFrame } from './wecom-mock-server.test-fixture'
import { WecomReplyStreams } from './wecom-reply-streams'
import { resendWecomReply } from './wecom-resend'
import { WecomSocket } from './wecom-socket'
import { wecomStore, type WecomStore } from './wecom-store-ops'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const OWNER = 'synthetic-owner'
const NOW = 1_800_000_000_000
// Two parts: WeCom takes 20,480 bytes a message and each CJK character is three.
const LONG_ANSWER = '答'.repeat(9000)

const Pushed = z.object({ markdown: z.object({ content: z.string() }) })
const content = (frame: MockWecomFrame): string | undefined =>
  Pushed.safeParse(frame.body).data?.markdown.content

function finishing(frame: MockWecomFrame): boolean {
  return frame.cmd === 'aibot_respond_msg' && JSON.stringify(frame.body).includes('"finish":true')
}

describe('WeCom final answer (mock WeCom server)', () => {
  let dir: string
  let server: MockWecomServer
  let controller: AbortController
  const clients: BotsDbWorkerClient[] = []

  const openStore = (): { store: WecomStore; crash: () => void } => {
    const client = new BotsDbWorkerClient(inProcessWorker(handleBotsDbRequest).factory)
    clients.push(client)
    return {
      store: wecomStore(client, join(dir, 'wecom.sqlite')),
      // The process dies: the worker and its database close with nothing more written.
      crash: () => {
        client.dispose()
        closeBotsDbStores()
      }
    }
  }

  const connect = async (): Promise<WecomSocket> => {
    const socket = new WecomSocket(server.url, () => undefined)
    await socket.open('synthetic-bot-id', 'synthetic-secret', controller.signal)
    return socket
  }

  const admitted = async (
    store: WecomStore
  ): Promise<{ binding: WecomBinding; arrival: WecomArrival }> => {
    const binding = await store.reserve('scope', 'bot-1', 'synthetic-bot-id')
    await store.pair(binding.account, OWNER, { chat: OWNER, kind: 'single' }, 1)
    const arrival = readWecomCallback('synthetic-req', {
      msgid: 'm1',
      chattype: 'single',
      from: { userid: OWNER },
      msgtype: 'text',
      text: { content: 'synthetic test question' }
    })
    if (!arrival) {
      throw new Error('Expected the callback to read')
    }
    await store.receive(binding.account, arrival, NOW, null)
    await store.admitted(binding.account, arrival.mid, null)
    return { binding, arrival }
  }

  const chosen = (row: WecomMessageRow | null): Parameters<typeof sendWecomFinal>[2] => {
    if (!finalChosen(row)) {
      throw new Error('Expected a chosen final answer')
    }
    return row
  }

  beforeEach(async () => {
    // Only Date: the sockets' timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    dir = mkdtempSync(join(tmpdir(), 'wecom-final-'))
    server = await MockWecomServer.start()
    controller = new AbortController()
  })

  afterEach(async () => {
    controller.abort()
    for (const client of clients.splice(0)) {
      client.dispose()
    }
    closeBotsDbStores()
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('never resends a pushed part a crash left unknown, and sends the rest once', async () => {
    const first = openStore()
    const { binding } = await admitted(first.store)
    const { account } = binding
    await first.store.chooseFinal(account, 'm1', 'push', LONG_ANSWER)
    // Part 1 was written down as going out, then the process died before WeCom answered.
    await first.store.partSending(account, 'm1', 1)
    first.crash()

    const second = openStore()
    const socket = await connect()
    const streams = new WecomReplyStreams(
      account,
      () => socket,
      () => undefined
    )
    const row = chosen(await second.store.message(account, 'm1'))
    expect(await sendWecomFinal(second.store, account, row, streams.port)).toEqual({ kind: 'done' })

    const parts = wecomFinalParts(LONG_ANSWER)
    expect(parts).toHaveLength(2)
    expect(server.sent('aibot_send_msg').map(content)).toEqual([parts[1]])
    expect(await second.store.counts(account)).toEqual({ review: 0, unconfirmed: 1 })
  })

  it('counts a push WeCom never answered as unconfirmed and sends only the rest after reconnecting', async () => {
    const { store } = openStore()
    const { binding } = await admitted(store)
    const { account } = binding
    await store.chooseFinal(account, 'm1', 'push', LONG_ANSWER)
    server.answer = (frame) => (frame.cmd === 'aibot_send_msg' ? 'silent' : 0)
    let socket = await connect()
    const streams = new WecomReplyStreams(
      account,
      () => socket,
      () => undefined
    )

    const sending = sendWecomFinal(
      store,
      account,
      chosen(await store.message(account, 'm1')),
      streams.port
    )
    await server.until((frame) => frame.cmd === 'aibot_send_msg')
    server.dropConnection()
    expect(await sending).toEqual({ kind: 'retry' })

    server.answer = () => 0
    socket = await connect()
    const again = chosen(await store.message(account, 'm1'))
    expect(await sendWecomFinal(store, account, again, streams.port)).toEqual({ kind: 'done' })

    expect(server.sent('aibot_send_msg').map(content)).toEqual(wecomFinalParts(LONG_ANSWER))
    expect(await store.counts(account)).toEqual({ review: 0, unconfirmed: 1 })
  })

  it('keeps an unconfirmed reply for the owner to resend once, without holding the chat', async () => {
    const { store } = openStore()
    const { binding } = await admitted(store)
    const { account } = binding
    await store.chooseFinal(account, 'm1', 'push', 'synthetic test answer')
    server.answer = (frame) => (frame.cmd === 'aibot_send_msg' ? 'silent' : 0)
    let socket = await connect()
    const streams = new WecomReplyStreams(
      account,
      () => socket,
      () => undefined
    )
    const sending = sendWecomFinal(
      store,
      account,
      chosen(await store.message(account, 'm1')),
      streams.port
    )
    await server.until((frame) => frame.cmd === 'aibot_send_msg')
    server.dropConnection()
    await sending
    server.answer = () => 0
    socket = await connect()
    const again = chosen(await store.message(account, 'm1'))
    expect(await sendWecomFinal(store, account, again, streams.port)).toEqual({ kind: 'done' })
    await store.answered(account, 'm1')

    const later = readWecomCallback('synthetic-req-2', {
      msgid: 'm2',
      chattype: 'single',
      from: { userid: OWNER },
      msgtype: 'text',
      text: { content: 'synthetic later question' }
    })
    await store.receive(account, later!, NOW, null)
    expect((await store.next(account))?.mid).toBe('m2')
    expect(await store.unconfirmedReplies(account)).toEqual([
      { mid: 'm1', preview: 'synthetic test question' }
    ])

    const push = (chat: string, text: string): Promise<void> => streams.push(chat, text)
    await resendWecomReply(store, account, 'm1', push)
    await resendWecomReply(store, account, 'm1', push)
    expect(server.sent('aibot_send_msg').map(content)).toEqual([
      'synthetic test answer',
      `${WECOM_COPY.resent}\n\nsynthetic test answer`
    ])
    expect(await store.unconfirmedReplies(account)).toEqual([])
    expect(await store.counts(account)).toEqual({ review: 0, unconfirmed: 0 })
  })

  it('pushes the answer once when WeCom refuses the stream’s last frame', async () => {
    const { store } = openStore()
    const { binding, arrival } = await admitted(store)
    const { account } = binding
    server.answer = (frame) => (finishing(frame) ? 846608 : 0)
    const socket = await connect()
    const streams = new WecomReplyStreams(
      account,
      () => socket,
      () => undefined
    )
    streams.open(socket, arrival, NOW, 0, true)
    await server.until((frame) => frame.cmd === 'aibot_respond_msg')

    const row = await store.message(account, 'm1')
    const via = await streams.prepare(row!)
    expect(via).toBe('stream')
    const final = chosen(await store.chooseFinal(account, 'm1', via, 'synthetic test answer'))
    expect(await sendWecomFinal(store, account, final, streams.port)).toEqual({ kind: 'done' })
    streams.finished('m1')

    expect(server.frames.filter(finishing)).toHaveLength(1)
    expect(server.sent('aibot_send_msg').map(content)).toEqual(['synthetic test answer'])
  })

  it('stops live progress on a permission refusal, says so, and still answers once', async () => {
    const { store } = openStore()
    const { binding, arrival } = await admitted(store)
    const { account } = binding
    server.answer = (frame) => (frame.cmd === 'aibot_respond_msg' ? 60011 : 0)
    const socket = await connect()
    const problems: string[] = []
    const streams = new WecomReplyStreams(
      account,
      () => socket,
      (problem) => problems.push(problem)
    )
    streams.open(socket, arrival, NOW, 0, true)
    await server.until((frame) => frame.cmd === 'aibot_send_msg')

    const via = await streams.prepare((await store.message(account, 'm1'))!)
    expect(via).toBe('push')
    const final = chosen(await store.chooseFinal(account, 'm1', via, 'synthetic test answer'))
    await streams.release('m1')
    expect(await sendWecomFinal(store, account, final, streams.port)).toEqual({ kind: 'done' })
    streams.finished('m1')

    expect(problems).toEqual(['permission'])
    expect(server.sent('aibot_respond_msg')).toHaveLength(1)
    expect(server.sent('aibot_send_msg').map(content)).toEqual([
      WECOM_COPY.progressNotice,
      'synthetic test answer'
    ])
  })
})
