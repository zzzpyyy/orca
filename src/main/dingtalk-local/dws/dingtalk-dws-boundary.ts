import { createInterface } from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import * as z from 'zod'
import { redactString } from '../../../shared/observability/redactor'
import {
  schemas,
  type DingTalkGroupId,
  type DingTalkMessageId,
  type DingTalkProfile
} from '../dingtalk-domain'

const Event = z.object({
  type: z.enum([
    'user_im_message_receive_at',
    'user_im_message_receive_group',
    'user_im_message_receive_o2o'
  ]),
  message_id: z.string().optional(),
  event_id: z.string().optional(),
  conversation_id: z.string().min(1),
  sender: z.string().default('未知'),
  sender_open_dingtalk_id: z.string().min(1),
  content: z.string().default(''),
  create_time: z.unknown().optional()
})

export type DwsEvent = {
  source: 'at' | 'group' | 'dm'
  profile: DingTalkProfile
  groupId: DingTalkGroupId
  conversationId: string
  messageId: DingTalkMessageId
  senderOpenId: string
  senderName: string
  content: string
  createTime: string
}

export type DwsSource =
  | { kind: 'at' }
  | { kind: 'group'; groupId: DingTalkGroupId }
  /** 1:1 messages between the profile's account and this one person. */
  | { kind: 'dm'; openDingTalkId: string }

export type DwsSendOutcome =
  | { kind: 'sent'; taskId: string }
  | { kind: 'not-started'; error: string }
  | { kind: 'uncertain'; error: string }

export type DwsConsumer = { stop: () => Promise<void> }

export type DwsRun = {
  code: number | null
  stdout: string
  stderr: string
  notStarted: boolean
  timedOut: boolean
}

export class DwsBoundary {
  private readonly children = new Set<ChildProcessWithoutNullStreams>()
  /** Why the newest consumer stopped, by its source, until it reads again; for the status. */
  readonly consumerErrors = new Map<string, string>()
  constructor(
    private readonly path: () => string,
    private readonly timeoutMs = 60_000
  ) {}

  private env(): NodeJS.ProcessEnv {
    const extra = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
    const current = (process.env.PATH ?? '').split(delimiter)
    return { ...process.env, PATH: [...new Set([...current, ...extra])].join(delimiter) }
  }

  consume(
    profile: DingTalkProfile,
    source: DwsSource,
    onEvent: (event: DwsEvent) => void
  ): DwsConsumer {
    const args = [
      '--profile',
      profile,
      'event',
      'consume',
      EVENT_OF[source.kind],
      '--flatten',
      '--format',
      'ndjson',
      '--ephemeral'
    ]
    if (source.kind === 'group') {
      args.push('--group', source.groupId)
    } else if (source.kind === 'dm') {
      args.push('--open-dingtalk-id', source.openDingTalkId)
    }
    const errorKey = `${profile}\u0000${JSON.stringify(source)}`
    let stderr = ''
    let child: ChildProcessWithoutNullStreams | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let failures = 0
    const launch = (): void => {
      if (stopped) {
        return
      }
      try {
        child = spawnProcess({ program: this.path(), args, stdio: 'pipe', env: this.env() })
      } catch (error) {
        this.consumerErrors.set(errorKey, `dws could not start: ${messageOf(error)}`)
        schedule()
        return
      }
      const current = child
      this.children.add(current)
      current.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-2000)
      })
      createInterface({ input: current.stdout }).on('line', (line) => {
        const parsed = Event.safeParse(parseJson(line))
        if (!parsed.success) {
          return
        }
        failures = 0
        this.consumerErrors.delete(errorKey)
        const value = parsed.data
        const messageId = value.message_id ?? value.event_id
        if (!messageId) {
          return
        }
        // A record that fails conversion is dropped; it must not throw into the main process.
        let event: DwsEvent
        try {
          event = {
            source: source.kind,
            profile,
            groupId: schemas.GroupId.parse(value.conversation_id),
            // One person's DM is one conversation, however DingTalk names it.
            conversationId:
              source.kind === 'dm' ? `dm:${source.openDingTalkId}` : value.conversation_id,
            messageId: schemas.MessageId.parse(messageId),
            senderOpenId: value.sender_open_dingtalk_id,
            senderName: value.sender,
            content: value.content,
            createTime: normalizeCreateTime(value.create_time)
          }
        } catch {
          return
        }
        onEvent(event)
      })
      current.once('error', (error) => {
        this.consumerErrors.set(errorKey, `dws could not start: ${messageOf(error)}`)
        schedule()
      })
      current.once('close', (code) => {
        this.children.delete(current)
        if (child === current) {
          child = null
        }
        if (!stopped) {
          this.consumerErrors.set(errorKey, dwsFailure(code, '', stderr))
          schedule()
        }
      })
    }
    const schedule = (): void => {
      if (stopped || retry) {
        return
      }
      const delay = Math.min(1_000 * 2 ** Math.min(failures, 5), 30_000)
      failures += 1
      retry = setTimeout(() => {
        retry = null
        launch()
      }, delay)
      retry.unref?.()
    }
    launch()
    return {
      stop: async () => {
        stopped = true
        this.consumerErrors.delete(errorKey)
        if (retry) {
          clearTimeout(retry)
          retry = null
        }
        const active = child
        if (!active) {
          return
        }
        active.stdin.end()
        await new Promise<void>((resolve) => active.once('close', resolve))
        this.children.delete(active)
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.children].map(async (child) => {
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => child.once('close', () => resolve()))
      })
    )
    this.children.clear()
  }

  /** One dws command as JSON, under `profile` when given; `cwd` for one that writes files there. */
  exec(
    profile: DingTalkProfile | null,
    args: readonly string[],
    options: { cwd?: string } = {}
  ): Promise<DwsRun> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawnProcess({
          program: this.path(),
          args: [...(profile ? ['--profile', profile] : []), ...args, '--format', 'json'],
          stdio: 'pipe',
          env: this.env(),
          ...(options.cwd ? { cwd: options.cwd } : {})
        })
      } catch (error) {
        resolve({
          code: null,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          notStarted: true,
          timedOut: false
        })
        return
      }
      this.children.add(child)
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, this.timeoutMs)
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr = stderr.slice(-8000) + String(chunk)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        this.children.delete(child)
        resolve({
          code: null,
          stdout,
          stderr: error.message,
          notStarted: true,
          timedOut
        })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        this.children.delete(child)
        resolve({ code, stdout, stderr, notStarted: false, timedOut })
      })
    })
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const EVENT_OF: Record<DwsSource['kind'], string> = {
  at: 'user_im_message_receive_at',
  group: 'user_im_message_receive_group',
  dm: 'user_im_message_receive_o2o'
}

/** Why a dws command failed, as its JSON error says or its stderr ends; dws masks tokens itself,
 *  and the known key shapes are masked again before the status shows it. */
export function dwsFailure(code: number | null, stdout: string, stderr: string): string {
  const parsed = z
    .object({ error: z.object({ message: z.string() }).passthrough() })
    .passthrough()
    .safeParse(parseJson(stdout.trim()))
  const text = parsed.success
    ? parsed.data.error.message
    : stderr.trim().split('\n').slice(-3).join(' ') || `dws exited with ${code}`
  return redactString(text).slice(0, 300)
}

export function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** The values one level inside parsed dws JSON, to walk it for a field whose nesting varies. */
export function jsonChildren(value: unknown): unknown[] {
  return typeof value === 'object' && value !== null ? Object.values(value) : []
}

const JsonObject = z.record(z.string(), z.unknown())

/** A string field of a parsed dws JSON object; null when absent, empty or not a string. */
export function jsonString(value: unknown, key: string): string | null {
  const parsed = JsonObject.safeParse(value)
  const field = parsed.success ? parsed.data[key] : undefined
  return typeof field === 'string' && field.trim() ? field : null
}

function normalizeCreateTime(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 19).replace('T', ' ')
  }
  return ''
}
