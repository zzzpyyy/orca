import {
  stableDeliveryId,
  stableExternalId,
  type DingTalkBinding,
  type DingTalkInbound,
  type DingTalkSetup
} from './dingtalk-domain'

export type InboundDecision =
  | {
      kind: 'accept'
      binding: DingTalkBinding
      /** Still carries DingTalk's media tags; the connector fetches and replaces them. */
      body: string
      externalId: ReturnType<typeof stableExternalId>
      deliveryId: ReturnType<typeof stableDeliveryId>
    }
  | {
      kind: 'drop'
      reason: 'unbound_group' | 'unauthorized' | 'self_message' | 'empty' | 'trigger' | 'noise'
    }

/** The setup entry that lets `event` in: its group's binding, or the DM entry naming its sender.
 *  A DM from anyone the setup doesn't name has none, whatever account it reached. */
export function bindingFor(
  setup: DingTalkSetup,
  event: Pick<DingTalkInbound, 'profile' | 'source' | 'groupId' | 'senderOpenId'>
): DingTalkBinding | null {
  if (event.source === 'dm') {
    const dm = setup.dms.find(
      (entry) => entry.profile === event.profile && entry.openDingTalkId === event.senderOpenId
    )
    return dm ? { kind: 'dm', dm } : null
  }
  const group = setup.groups.find(
    (entry) => entry.profile === event.profile && entry.groupId === event.groupId
  )
  return group ? { kind: 'group', group } : null
}

export const bindingBotId = (binding: DingTalkBinding): string =>
  binding.kind === 'dm' ? binding.dm.botId : binding.group.botId

function bodyAfterMention(content: string, names: readonly string[]): string {
  let text = content.trimStart()
  for (const name of names) {
    if (!text.startsWith(`@${name}`)) {
      continue
    }
    text = text.slice(name.length + 1).trimStart()
    if (text.startsWith('(')) {
      const close = text.indexOf(')')
      text = (close === -1 ? text.slice(1) : text.slice(close + 1)).trimStart()
    }
    break
  }
  return text
}

function noise(text: string): boolean {
  const core = [...text]
    .filter((char) => /[\p{L}\p{N}]/u.test(char))
    .join('')
    .toLowerCase()
  return (
    core.length === 0 || new Set(['好', '好的', '收到', 'ok', 'okay', '谢谢', '辛苦']).has(core)
  )
}

export function decideInbound(setup: DingTalkSetup, event: DingTalkInbound): InboundDecision {
  const bound = bindingFor(setup, event)
  if (!bound) {
    return { kind: 'drop', reason: event.source === 'dm' ? 'unauthorized' : 'unbound_group' }
  }
  const ids = {
    externalId: stableExternalId(event.profile, event.conversationId),
    deliveryId: stableDeliveryId(event.profile, event.messageId)
  }
  if (bound.kind === 'dm') {
    // Only that person's own 1:1 chat: never a group message that names them as sender.
    if (event.conversationId !== `dm:${bound.dm.openDingTalkId}`) {
      return { kind: 'drop', reason: 'unauthorized' }
    }
    const body = event.content.trim()
    return body
      ? { kind: 'accept', binding: bound, body, ...ids }
      : { kind: 'drop', reason: 'empty' }
  }
  const binding = bound.group
  if (binding.selfOpenId && binding.selfOpenId === event.senderOpenId) {
    return { kind: 'drop', reason: 'self_message' }
  }
  const text = bodyAfterMention(event.content, binding.selfNames)
  if (binding.mode === 'at' && binding.requirePrefix) {
    if (!text.toLowerCase().startsWith(binding.prefix.toLowerCase())) {
      return { kind: 'drop', reason: 'trigger' }
    }
    const rest = text.slice(binding.prefix.length)
    if (rest && !/^\s/.test(rest)) {
      return { kind: 'drop', reason: 'trigger' }
    }
    const body = rest.trim()
    return body
      ? { kind: 'accept', binding: bound, body, ...ids }
      : { kind: 'drop', reason: 'empty' }
  }
  if (binding.noiseFilter && noise(text)) {
    return { kind: 'drop', reason: 'noise' }
  }
  const body = text.trim()
  return body ? { kind: 'accept', binding: bound, body, ...ids } : { kind: 'drop', reason: 'empty' }
}
