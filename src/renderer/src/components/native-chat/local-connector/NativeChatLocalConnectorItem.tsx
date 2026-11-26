// The composer under-row's note for a chat linked to a local connector (WeCom): the connector answers
// only what the owner sends there, so what they type here stays in Orca (Slack's mirror is Slack's).
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  CONNECTOR_SOURCE_NAMES,
  isLocalConnectorSource,
  type LocalConnectorSource
} from '../../../../../shared/connectors/external-conversation-link'
import { CONNECTOR_SOURCE_ICONS } from '../NativeChatConnectorAskerTag'

const FOOTER_TEXT =
  'min-w-0 overflow-x-clip text-ellipsis text-2xs whitespace-nowrap [text-box:trim-both_cap_alphabetic]'

export function NativeChatLocalConnectorItem({
  sessionId
}: {
  sessionId: string | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  // A bot's home folder workspace holds its conversation links; a session id names one chat.
  const source = useAppStore((state): LocalConnectorSource | null => {
    if (sessionId === undefined) {
      return null
    }
    for (const workspace of selectFolderWorkspaces(state)) {
      for (const link of workspace.externalConversations ?? []) {
        if (link.sessionId === sessionId && isLocalConnectorSource(link.source)) {
          return link.source
        }
      }
    }
    return null
  })
  if (!source) {
    return null
  }
  const Icon = CONNECTOR_SOURCE_ICONS[source]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="flex h-5.5 min-w-0 max-w-64 shrink items-center gap-1 rounded-md px-1.5 text-chat-foreground-faint outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          {Icon ? <Icon className="size-3 shrink-0 opacity-60 grayscale" /> : null}
          <span className={FOOTER_TEXT}>
            {t('components.native-chat.localConnector.only', 'Only in Orca')}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-64">
        {t(
          'components.native-chat.localConnector.tooltip',
          'Your {{source}} chat gets replies to what you send there. What you type here stays in Orca.',
          { source: CONNECTOR_SOURCE_NAMES[source] }
        )}
      </TooltipContent>
    </Tooltip>
  )
}
