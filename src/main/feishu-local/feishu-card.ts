// The Feishu card a DM's reply streams into (JSON 2.0): the turn's thinking and steps in a panel,
// open while it runs and folded once it ends, and the answer below. Process text is plain_text, so
// nothing a command or a thought holds renders as markdown.
import { IM_STEP_MARK, imProgress, imTail } from '../im-stream/im-stream-progress'
import { EMPTY_IM_TURN_VIEW, type ImTurnView } from '../im-stream/im-stream-turn-view'
import { clampUtf8TextPrefix } from '../../shared/text/utf8-byte-limits'

/** Answer bytes per card or continuation: within Feishu's documented 30 KB card content, with room
 *  for the process panel. */
export const FEISHU_ANSWER_BYTES = 20 * 1024

export type FeishuProcess = Pick<ImTurnView, 'thinking' | 'steps'>
export type FeishuCard = { schema: '2.0'; config: unknown; body: { elements: unknown[] } }

function plain(content: string, grey = false) {
  return {
    tag: 'div',
    text: { tag: 'plain_text', content, ...(grey ? { text_color: 'grey' } : {}) }
  }
}

function processPanel(process: FeishuProcess | null, running: boolean): unknown[] {
  // A final card's process is its thinking and steps alone; the view masked both already.
  const {
    thinking,
    steps: shown,
    earlierSteps
  } = process
    ? imProgress({ ...EMPTY_IM_TURN_VIEW, ...process })
    : { thinking: '', steps: [], earlierSteps: 0 }
  const steps = process?.steps ?? []
  const lines = shown.map((step) => `${IM_STEP_MARK[step.state]} ${step.summary}`)
  if (earlierSteps > 0) {
    lines.unshift(`… ${earlierSteps} earlier steps`)
  }
  if (!thinking && lines.length === 0) {
    return []
  }
  const count = steps.length === 1 ? '1 step' : `${steps.length} steps`
  return [
    {
      tag: 'collapsible_panel',
      expanded: running,
      header: {
        title: { tag: 'plain_text', content: running ? `Working · ${count}` : `Process · ${count}` }
      },
      elements: [
        ...(thinking ? [plain(`💭 ${thinking}`, true)] : []),
        ...(lines.length > 0 ? [plain(lines.join('\n'))] : [])
      ]
    }
  ]
}

function answerElement(text: string) {
  // A card's markdown image must name an image the bot uploaded; any other fails the whole card.
  return text.includes('![') || /<img\b/i.test(text)
    ? plain(text)
    : { tag: 'markdown', content: text }
}

function alsoLine(also: readonly string[]): unknown[] {
  return also.length > 0
    ? [plain(`Also answers: ${also.map((each) => `“${each}”`).join(' · ')}`, true)]
    : []
}

function card(summary: string, elements: unknown[]): FeishuCard {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: imTail(summary, 60) } },
    body: { elements }
  }
}

/** What a reply shows before its turn has anything to show. */
export function feishuStartCard(): FeishuCard {
  return card('Working in Orca…', [plain('Received in Orca. Working on it…', true)])
}

/** The reply while its turn runs: the process open, the answer so far, cut to one card. */
export function feishuLiveCard(view: ImTurnView, also: readonly string[]): FeishuCard {
  const answer = view.answer.trim()
  const shown =
    Buffer.byteLength(answer) <= FEISHU_ANSWER_BYTES
      ? answer
      : `${clampUtf8TextPrefix(answer, FEISHU_ANSWER_BYTES - 64)}\n\n…`
  const step = view.steps.findLast((each) => each.state === 'running')
  return card(step ? `Working · ${step.summary}` : 'Working in Orca…', [
    ...processPanel(view, true),
    shown ? answerElement(shown) : plain('Working on it in Orca…', true),
    ...alsoLine(also)
  ])
}

/** The reply once its turn ended: the process folded, the answer's first part (the rest follows
 *  in replies to the same message). */
export function feishuFinalCard(
  answer: string,
  process: FeishuProcess | null,
  also: readonly string[]
): FeishuCard {
  return card(answer.trim() || 'Done in Orca', [
    ...processPanel(process, false),
    answer.trim() ? answerElement(answer) : plain('Done in Orca.', true),
    ...alsoLine(also)
  ])
}

/** A follow-up's reply: its words went into another message's turn, which answers both. */
export function feishuJoinedCard(head: string | null): FeishuCard {
  const into = head ? `“${head}”` : 'your earlier message'
  return card('Answered together in Orca', [
    plain(`Orca read this together with ${into} and answers both in the reply to it.`, true)
  ])
}
