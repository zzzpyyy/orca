// What a DingTalk reply card and its messages say around the agent's answer, in Chinese since
// DingTalk's users read it. The answer itself is never rewritten.
import { IM_STEP_MARK } from '../im-stream/im-stream-progress'
import type { ImReplyCopy } from '../im-stream/im-stream-reply'

const THINKING = '思考中…'

export const DINGTALK_REPLY_COPY: ImReplyCopy = {
  placeholder: THINKING,
  notice: '已收到，正在处理，完成后在这里回复。',
  progress: {
    waiting: THINKING,
    // A card has no thinking block: a short tail, gone once the answer starts.
    thinking: (text) => `💭 ${text}`,
    thinkingChars: 120,
    thinkingUntilAnswer: true,
    answerChars: 1_200,
    earlierSteps: (count) => `…前 ${count} 步已完成`,
    step: (step) =>
      `${IM_STEP_MARK[step.state]} ${step.name}${step.detail ? ` · ${step.detail}` : ''}`,
    working: '处理中…'
  },
  part: (part, total) => ({ before: part > 1 ? `（续 ${part}/${total}）\n` : '', after: '' })
}
