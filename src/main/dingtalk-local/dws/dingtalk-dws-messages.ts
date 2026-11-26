// What the connector sends through dws as the profile's own account: markdown messages, the
// streaming reply card and its edits, and the files a received message carries.
import * as z from 'zod'
import type { DingTalkMessageId, DingTalkProfile } from '../dingtalk-domain'
import {
  dwsFailure,
  jsonChildren,
  jsonString,
  parseJson,
  type DwsBoundary,
  type DwsSendOutcome
} from './dingtalk-dws-boundary'

/** Where a reply goes: the group it came from, or the one person a DM is with. */
export type DwsTarget = { kind: 'group'; groupId: string } | { kind: 'dm'; openDingTalkId: string }

/** dws card flow states: 1 processing, 2 typing, 3 done, 5 error. */
export type DwsCardFlow = 1 | 2 | 3 | 5

type Exec = Pick<DwsBoundary, 'exec'>

const targetArgs = (target: DwsTarget, dmFlag: string): string[] =>
  target.kind === 'group' ? ['--group', target.groupId] : [dmFlag, target.openDingTalkId]

const Answer = z
  .object({
    ok: z.boolean().optional(),
    success: z.boolean().optional(),
    openTaskId: z.string().optional()
  })
  .passthrough()

/** A markdown message; dws takes a resend under the same `uuid` as the same message. */
export async function sendDwsMarkdown(
  dws: Exec,
  profile: DingTalkProfile,
  target: DwsTarget,
  text: string,
  uuid: string
): Promise<DwsSendOutcome> {
  const run = await dws.exec(profile, [
    'chat',
    '+messages-send',
    '--as',
    'user',
    ...targetArgs(target, '--open-dingtalk-id'),
    '--markdown',
    text,
    '--uuid',
    uuid,
    '--yes'
  ])
  if (run.notStarted) {
    return { kind: 'not-started', error: run.stderr }
  }
  if (run.timedOut || run.code !== 0) {
    return {
      kind: 'uncertain',
      error: run.timedOut ? 'dws send timed out' : dwsFailure(run.code, run.stdout, run.stderr)
    }
  }
  const answer = Answer.safeParse(parseJson(run.stdout.trim()))
  if (!answer.success || (!answer.data.ok && !answer.data.success && !answer.data.openTaskId)) {
    return { kind: 'uncertain', error: 'dws did not confirm send' }
  }
  return { kind: 'sent', taskId: answer.data.openTaskId ?? '' }
}

/** The first `bizId` anywhere in dws's answer; its card receipt nests it. */
function bizIdIn(value: unknown, depth = 0): string | null {
  if (depth > 6) {
    return null
  }
  for (const key of ['bizId', 'bizID', 'biz_id']) {
    const id = jsonString(value, key)
    if (id) {
      return id.trim()
    }
  }
  for (const child of jsonChildren(value)) {
    const found = bizIdIn(child, depth + 1)
    if (found) {
      return found
    }
  }
  return null
}

/** Sends the streaming reply card showing `content`; its bizId. Throws with dws's reason. */
export async function openDwsCard(
  dws: Exec,
  profile: DingTalkProfile,
  target: DwsTarget,
  content: string
): Promise<string> {
  const run = await dws.exec(profile, [
    'chat',
    '+messages-send-card',
    ...targetArgs(target, '--receiver-open-dingtalk-id'),
    '--content',
    content,
    '--flow-status',
    '1',
    '--yes'
  ])
  const bizId = run.code === 0 ? bizIdIn(parseJson(run.stdout.trim())) : null
  if (!bizId) {
    throw new Error(
      run.code === 0 ? 'dws sent no card id' : dwsFailure(run.code, run.stdout, run.stderr)
    )
  }
  return bizId
}

/** Replaces the card's content. An edit dws accepted but could not verify counts as made: dws asks
 *  that the same edit not be repeated. */
export async function updateDwsCard(
  dws: Exec,
  profile: DingTalkProfile,
  bizId: string,
  content: string,
  flow: DwsCardFlow
): Promise<void> {
  const run = await dws.exec(profile, [
    'chat',
    '+messages-update-card',
    '--biz-id',
    bizId,
    '--content',
    content,
    '--flow-status',
    String(flow),
    '--yes'
  ])
  if (run.code !== 0) {
    throw new Error(
      run.timedOut ? 'dws card edit timed out' : dwsFailure(run.code, run.stdout, run.stderr)
    )
  }
}

const Downloads = z
  .object({
    resourceDownloads: z
      .object({
        downloads: z
          .array(
            z
              .object({ localPath: z.string().min(1), sizeBytes: z.number().optional() })
              .passthrough()
          )
          .default([]),
        failures: z.array(z.object({ error: z.string().optional() }).passthrough()).default([])
      })
      .passthrough()
  })
  .passthrough()

export type DwsDownloads = { paths: string[]; failures: string[] }

/** Downloads every image and file `messageId` carries into `dir`/files; paths relative to `dir`. */
export async function fetchDwsResources(
  dws: Exec,
  profile: DingTalkProfile,
  messageId: DingTalkMessageId,
  dir: string
): Promise<DwsDownloads> {
  const run = await dws.exec(
    profile,
    [
      'chat',
      '+messages-mget',
      '--msg-ids',
      messageId,
      '--no-reactions',
      '--no-threads',
      '--download-resources',
      '--output-dir',
      './files'
    ],
    { cwd: dir }
  )
  const parsed = Downloads.safeParse(parseJson(run.stdout.trim()))
  if (!parsed.success) {
    return { paths: [], failures: [dwsFailure(run.code, run.stdout, run.stderr)] }
  }
  const { downloads, failures } = parsed.data.resourceDownloads
  return {
    paths: downloads.map((entry) => entry.localPath),
    failures: failures.map((entry) => entry.error ?? 'download failed')
  }
}
