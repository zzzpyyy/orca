// Who the WeCom connector answers, against a local MOCK of WeCom's long connection (not WeCom) and a
// real inbox file: only the owner who sent the DM code, and only in chats they paired.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotsDbWorkerClient } from '../bots/db-worker/bots-db-worker-client'
import { closeBotsDbStores, handleBotsDbRequest } from '../bots/db-worker/bots-db-worker-entry'
import { inProcessWorker } from '../worker-threads/in-process-worker.test-fixture'
import { admitWecomArrival } from './wecom-arrivals'
import type { WecomArrival } from './wecom-inbox-rows'
import { readWecomCallback } from './wecom-message'
import { MockWecomServer } from './wecom-mock-server.test-fixture'
import { WecomPairing } from './wecom-pairing'
import { WecomSocket } from './wecom-socket'
import { wecomStore } from './wecom-store-ops'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const NOW = 1_800_000_000_000
let sequence = 0
function arrival(from: string, text: string, group?: string): WecomArrival {
  const read = readWecomCallback(`synthetic-req-${sequence}`, {
    msgid: `m${sequence++}`,
    chattype: group ? 'group' : 'single',
    ...(group ? { chatid: group } : {}),
    from: { userid: from },
    msgtype: 'text',
    text: { content: group ? `@Orca bot ${text}` : text }
  })
  if (!read) {
    throw new Error('Expected the callback to read')
  }
  return read
}

describe('WeCom admission (mock WeCom server)', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  beforeEach(() => {
    // Only Date, which the pairing code's expiry reads: the socket's timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(async () => {
    vi.useRealTimers()
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  it('pairs the first DM that sends the code, then keeps only its owner’s messages in paired chats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-admission-'))
    const client = new BotsDbWorkerClient(inProcessWorker(handleBotsDbRequest).factory)
    const server = await MockWecomServer.start()
    const controller = new AbortController()
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => server.stop(),
      () => {
        client.dispose()
        closeBotsDbStores()
      },
      () => controller.abort()
    )
    const store = wecomStore(client, join(dir, 'wecom.sqlite'))
    const binding = await store.reserve('scope', 'bot-1', 'synthetic-bot-id')
    const socket = new WecomSocket(server.url, () => undefined)
    await socket.open('synthetic-bot-id', 'synthetic-secret', controller.signal)
    const pairing = new WecomPairing(() => undefined)
    cleanups.push(() => pairing.clear())
    const deps = { store, binding, pairing, botTakes: true }
    const admit = (message: WecomArrival) => admitWecomArrival(deps, socket, message, NOW)

    pairing.begin('dm')
    const code = pairing.shown!.code
    expect(await admit(arrival('synthetic-stranger', 'hello'))).toEqual({ kind: 'ignored' })
    // The code in a group, or after it expired, pairs nobody.
    expect(await admit(arrival('synthetic-owner', code, 'synthetic-group'))).toEqual({
      kind: 'ignored'
    })
    expect(
      await admitWecomArrival(deps, socket, arrival('synthetic-owner', code), NOW + 6 * 60_000)
    ).toEqual({ kind: 'ignored' })
    expect(await admit(arrival('synthetic-owner', code))).toEqual({
      kind: 'paired',
      chat: 'single'
    })
    // Single use: someone else replaying the code is not answered.
    expect(await admit(arrival('synthetic-stranger', code))).toEqual({ kind: 'ignored' })

    pairing.begin('group')
    const groupCode = pairing.shown!.code
    expect(await admit(arrival('synthetic-stranger', groupCode, 'synthetic-group'))).toEqual({
      kind: 'ignored'
    })
    expect(await admit(arrival('synthetic-owner', groupCode, 'synthetic-group'))).toEqual({
      kind: 'paired',
      chat: 'group'
    })

    const kept = { kind: 'kept', fresh: true, ahead: 0, notice: null }
    expect(await admit(arrival('synthetic-owner', 'synthetic DM question'))).toEqual(kept)
    expect(await admit(arrival('synthetic-owner', 'question', 'synthetic-group'))).toEqual(kept)
    expect(await admit(arrival('synthetic-stranger', 'question', 'synthetic-group'))).toEqual({
      kind: 'ignored'
    })
    expect(await admit(arrival('synthetic-owner', 'question', 'synthetic-other-group'))).toEqual({
      kind: 'ignored'
    })
    expect((await store.chats(binding.account)).map((chat) => chat.kind)).toEqual([
      'single',
      'group'
    ])
    // Only the two pairings were answered; nobody else's message got a reply.
    expect(server.sent('aibot_respond_msg')).toHaveLength(2)
  })
})
