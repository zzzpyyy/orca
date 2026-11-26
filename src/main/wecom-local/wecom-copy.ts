// What the owner reads in WeCom: Orca's own words around the agent's answer, in Chinese since
// WeCom's users read it. The agent's answer itself is never rewritten.
import type { ImPartLabel } from '../im-stream/im-stream-chunks'
import type { ImProgressFormat } from '../im-stream/im-stream-live'
import type { JournalConnectorReplyOutcome } from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorRefusal } from '../external-conversations/external-conversation-types'
import type { ConnectorFailure } from '../../shared/connectors/connector-failure-contract'
import type { WecomMedia } from './wecom-inbox-rows'

const MEDIA_FAILED: Record<Extract<WecomMedia, { state: 'failed' }>['why'], string> = {
  expired: '下载链接已过期',
  too_large: '文件太大',
  unreadable: '无法读取'
}

const OUTCOME: Record<JournalConnectorReplyOutcome, string> = {
  answered: '✅ 已完成，没有文字回答。',
  quiet: '✅ 已完成，没有文字回答。',
  no_answer: '⚠️ 已结束，但没有写出回答。需要的话请再问一次。',
  interrupted: '⚠️ Agent 在回答前停止了。请重新发送以重试。',
  failed: '⚠️ Agent 在回答前停止了。请重新发送以重试。',
  cancelled: '⏹️ 已在 Orca 中停止。',
  withdrawn: '⏹️ 已在 Orca 中停止。',
  cleared: '⚠️ 回答前，这个对话在 Orca 中被清空了。请再问一次。',
  not_found: '⚠️ Orca 找不到这条请求了。请再问一次。',
  unattributed: '✅ 已完成，和之前的消息一起回答了。'
}

export const WECOM_COPY = {
  received: '⏳ 已收到，正在处理…',
  queued: (ahead: number) => `⏳ 已收到，排队中（前面还有 ${ahead} 条）`,
  stillWorking: '⏳ 仍在处理，完成后会另发完整回答。',
  answerBelow: '⬇️ 完整回答见下一条消息。',
  progressNotice: '⏳ 已收到，正在处理。完成后会发完整回答。',
  paired: '✅ 已与 Orca 配对。之后你在这里发的消息会交给 Orca 的 bot 处理。',
  groupPaired: '✅ 这个群已加入 Orca。之后你在这里 @ 机器人的消息会交给 Orca 的 bot 处理。',
  paused: '⏸️ Orca 里的这个 bot 已暂停或关闭，这条消息没有处理。恢复后请重新发送。',
  unsupported: (kind: string) =>
    `⚠️ 暂不支持「${kind}」类型的消息，Orca 没有处理它。请改发文字、图片或文件。`,
  refused: (reason: ConnectorRefusal) =>
    `⚠️ Orca 没能把这条消息交给 bot（${reason}）。请在 Orca 中查看后重新发送。`,
  unconfirmedDelivery: '⚠️ Orca 没能确认这条消息已交给 bot。请在 Orca 中查看后重新发送。',
  merged: (preview: string) => `↪️ 这条消息已并入另一条消息的回答（「${preview}」）。`,
  mergedWith: (previews: readonly string[]) =>
    `（本回答同时回复了：${previews.map((preview) => `「${preview}」`).join('')}）`,
  mediaFailed: (whys: readonly Extract<WecomMedia, { state: 'failed' }>['why'][]) =>
    `⚠️ 有 ${whys.length} 个附件没能读取（${[...new Set(whys)].map((why) => MEDIA_FAILED[why]).join('、')}），Orca 没有看到它们。`,
  mediaLeftOut: (count: number) => `⚠️ 这条消息的附件太多，后 ${count} 个没有交给 Orca。`,
  restInOrca: '…回答太长，其余内容请在 Orca 中查看。',
  resent: '🔁 重新发送（之前这条回答可能没送达）：',
  outcome: (outcome: JournalConnectorReplyOutcome, toolsRan: boolean | undefined) =>
    outcome === 'no_answer' && toolsRan
      ? `${OUTCOME.no_answer}可能已经执行了一些操作，重试前请先确认。`
      : OUTCOME[outcome],
  /** A failed turn by its cause, since only some causes go away on a resend. */
  failed: (failure: ConnectorFailure): string => {
    const agent = failure.agentName ?? 'Agent'
    switch (failure.category) {
      case 'signed_out':
        return `⚠️ ${agent} 在运行 Orca 的电脑上没有登录，没能回答。请在 Orca 中登录后重新发送。`
      case 'usage_limit': {
        const at = resetTime(failure)
        return `⚠️ ${agent} 的用量已达上限${at ? `，预计 ${at} 恢复` : ''}。恢复后请重新发送。`
      }
      case 'not_set_up':
        return `⚠️ ${agent} 在运行 Orca 的电脑上还没有设置好，没能回答。请在 Orca 中查看。`
      case 'folder_missing':
        return '⚠️ 这个 bot 的工作文件夹找不到了，没能回答。请在 Orca 中查看。'
      case 'unconfirmed':
        return '⚠️ Orca 重启后没能确认这次回答的结果。请在 Orca 中查看。'
      case 'agent_error':
        return `⚠️ ${agent} 出错了，没能回答。原因请在 Orca 中查看；重新发送通常会遇到同样的错误。`
    }
  }
}

function resetTime({ usageLimit, timeZone }: ConnectorFailure): string | null {
  if (usageLimit?.resetsAt === undefined) {
    return null
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      ...(timeZone ? { timeZone } : {}),
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(usageLimit.resetsAt)
  } catch {
    return null
  }
}

/** WeCom shows `<think>` as a collapsible thinking block; an inner closing tag would end it early. */
export const WECOM_PROGRESS: ImProgressFormat = {
  thinking: (text) => `<think>${text.replaceAll('</think>', '</ think>')}</think>`,
  waiting: '⏳ 正在处理…',
  earlierSteps: (count) => `…还有 ${count} 个更早的步骤`
}

export const WECOM_PART_LABEL: ImPartLabel = (part, total) => ({
  before: part > 1 ? `（${part}/${total}）\n` : '',
  after: part < total ? `\n\n（${part}/${total}，未完待续）` : ''
})
