import { useEffect } from 'react'
import type { BrowserExternalAppRequest } from '../../../../shared/browser-external-app'
import {
  useConfirmationDialog,
  type ConfirmationDialogContextValue
} from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'

function confirmExternalApp(
  confirm: ConfirmationDialogContextValue,
  { appName, scheme, origin }: BrowserExternalAppRequest,
  signal: AbortSignal
): Promise<boolean> {
  return confirm({
    signal,
    title: appName
      ? translate('auto.components.browserPane.externalApp.title', 'Open {{app}}?', {
          app: appName
        })
      : translate(
          'auto.components.browserPane.externalApp.schemeTitle',
          'Open this {{scheme}} link?',
          {
            scheme
          }
        ),
    description: origin
      ? translate(
          'auto.components.browserPane.externalApp.description',
          '{{origin}} wants to open another application.',
          { origin }
        )
      : translate(
          'auto.components.browserPane.externalApp.anonymousDescription',
          'A page in the browser wants to open another application.'
        ),
    descriptionClassName: 'break-all',
    confirmLabel: appName
      ? translate('auto.components.browserPane.externalApp.confirm', 'Open {{app}}', {
          app: appName
        })
      : translate('auto.components.browserPane.externalApp.confirmLink', 'Open link'),
    cancelLabel: translate('auto.components.browserPane.externalApp.cancel', 'Cancel')
  })
}

export function subscribeBrowserExternalAppConfirmation(
  confirm: ConfirmationDialogContextValue
): () => void {
  if (typeof window.api.browser?.onExternalAppRequest !== 'function') {
    return () => {}
  }
  const prompts = new Map<string, AbortController>()
  const unsubscribeClosed = window.api.browser.onExternalAppRequestClosed(({ requestId }) =>
    prompts.get(requestId)?.abort()
  )
  const unsubscribeRequests = window.api.browser.onExternalAppRequest((request) => {
    const prompt = new AbortController()
    prompts.set(request.requestId, prompt)
    void confirmExternalApp(confirm, request, prompt.signal).then((open) => {
      prompts.delete(request.requestId)
      if (!prompt.signal.aborted) {
        void window.api.browser.respondExternalApp({ requestId: request.requestId, open })
      }
    })
  })
  return () => {
    unsubscribeRequests()
    unsubscribeClosed()
  }
}

export function BrowserExternalAppConfirmation(): null {
  const confirm = useConfirmationDialog()
  useEffect(() => subscribeBrowserExternalAppConfirmation(confirm), [confirm])
  return null
}
