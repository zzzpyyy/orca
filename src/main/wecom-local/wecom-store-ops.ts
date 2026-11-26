import type { BotsDbWorkerClient } from '../bots/db-worker/bots-db-worker-client'
import type { WecomInbox } from './wecom-inbox'

const OPS = [
  'bindings',
  'reserve',
  'sealSecret',
  'remove',
  'chats',
  'pair',
  'receive',
  'next',
  'body',
  'admitted',
  'owe',
  'answered',
  'settled',
  'settleAnswered',
  'message',
  'owedNotices',
  'chooseFinal',
  'finalToPush',
  'partSending',
  'partSent',
  'partRefused',
  'counts',
  'unconfirmedReplies',
  'resendable',
  'resent',
  'prune',
  'dismiss'
] as const satisfies readonly (keyof WecomInbox)[]
type Op = (typeof OPS)[number]

export const isWecomOp = (op: string): op is Op => OPS.some((allowed) => allowed === op)

export type WecomStore = {
  [K in Op]: (...args: Parameters<WecomInbox[K]>) => Promise<ReturnType<WecomInbox[K]>>
}

export function wecomStore(client: BotsDbWorkerClient, path: string): WecomStore {
  const remote = Object.fromEntries(
    OPS.map((op) => [op, (...args: unknown[]) => client.call('wecom', path, op, args)])
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each operation forwards its own argument tuple and returns that worker method's result.
  return remote as WecomStore
}
