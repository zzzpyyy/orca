import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDingTalkSetup, writeDingTalkSetup, type DingTalkSetup } from './dingtalk-domain'
import { removeDingTalkBot, saveDingTalkBot } from './dingtalk-local-setup'
import type { DwsRun } from './dws/dingtalk-dws-boundary'

const profile = 'corp:account'

function connectorAt(configPath: string): Parameters<typeof saveDingTalkBot>[0] {
  let setup: DingTalkSetup | null = null
  const profiles: DwsRun = {
    code: 0,
    stdout: JSON.stringify({ profiles: [{ profile, userName: 'Zhang San' }] }),
    stderr: '',
    notStarted: false,
    timedOut: false
  }
  return {
    status: () => ({ configPath }),
    setup: () => setup,
    saveSetup: async (next) => {
      await writeDingTalkSetup(configPath, next)
      setup = next
    },
    dws: { exec: async () => profiles }
  }
}

describe('DingTalk setup saved from a bot’s Connectors page', () => {
  it('replaces only that bot’s entries and keeps what only the file sets', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dingtalk-setup-')), 'dingtalk-local.json')
    writeFileSync(
      path,
      JSON.stringify({
        enabled: true,
        dwsPath: '/opt/dws/bin/dws',
        groups: [
          { profile, groupId: 'cid-a', botId: 'a', selfOpenId: 'open-self', noiseFilter: false },
          { profile, groupId: 'cid-b', botId: 'b' },
          { profile, groupId: 'cid-gone', botId: 'deleted-bot' }
        ],
        dms: [{ profile, botId: 'b', openDingTalkId: 'open-b', owner: true }]
      })
    )
    const connector = connectorAt(path)
    const group = {
      profile,
      name: 'Team',
      mode: 'at',
      prefix: '/tsbot',
      requirePrefix: true
    } as const
    await saveDingTalkBot(connector, ['a', 'b'], {
      botId: 'a',
      autoReply: true,
      streaming: true,
      dms: [{ profile, openDingTalkId: 'open-a', name: 'Owner', owner: true }],
      groups: [
        { ...group, groupId: 'cid-a' },
        { ...group, groupId: 'cid-new' }
      ]
    })
    const saved = await readDingTalkSetup(path)
    expect(saved.dwsPath).toBe('/opt/dws/bin/dws')
    expect(saved.groups.map((entry) => [entry.botId, entry.groupId])).toEqual([
      ['b', 'cid-b'],
      ['a', 'cid-a'],
      ['a', 'cid-new']
    ])
    expect(saved.groups[1]).toMatchObject({ selfOpenId: 'open-self', noiseFilter: false })
    expect(saved.groups[2]?.selfNames).toEqual(['Zhang San'])
    expect(saved.dms.map((dm) => dm.openDingTalkId)).toEqual(['open-b', 'open-a'])

    await removeDingTalkBot(connector, ['a', 'b'], 'b')
    const left = await readDingTalkSetup(path)
    expect(left.enabled).toBe(true)
    expect([...left.groups, ...left.dms].every((entry) => entry.botId === 'a')).toBe(true)
  })

  it('refuses to write over a setup file it cannot read', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dingtalk-setup-')), 'dingtalk-local.json')
    writeFileSync(path, '{ "groups": [ broken')
    await expect(
      saveDingTalkBot(connectorAt(path), ['a'], {
        botId: 'a',
        autoReply: true,
        streaming: true,
        dms: [],
        groups: []
      })
    ).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{ "groups": [ broken')
  })
})
