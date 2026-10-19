import { randomUUID } from 'node:crypto'
import { app, shell } from 'electron'

import type {
  BrowserExternalAppRequest,
  BrowserExternalAppResponse
} from '../../shared/browser-external-app'
import { DOC_PREVIEW_SCHEME } from '../../shared/doc-preview-scheme'

export const BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS = 120_000

// Web and browser-internal schemes; every other scheme belongs to an app on the user's computer.
const NEVER_EXTERNAL_APP_PROTOCOLS: ReadonlySet<string> = new Set([
  'about:',
  'blob:',
  'chrome:',
  'data:',
  'devtools:',
  'file:',
  'filesystem:',
  'http:',
  'https:',
  'javascript:',
  'view-source:',
  `${DOC_PREVIEW_SCHEME}:`
])

type PendingLaunch = {
  url: string
  browserPageId: string
  renderer: Electron.WebContents
  timer: ReturnType<typeof setTimeout>
}

const pendingLaunches = new Map<string, PendingLaunch>()

export function toBrowserExternalAppUrl(rawUrl: string | undefined): URL | null {
  if (!rawUrl) {
    return null
  }
  try {
    const url = new URL(rawUrl)
    return NEVER_EXTERNAL_APP_PROTOCOLS.has(url.protocol) ? null : url
  } catch {
    return null
  }
}

function requestingOrigin(requestingUrl: string): string | null {
  try {
    const { origin } = new URL(requestingUrl)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function externalAppName(url: string): string | null {
  // Why: Linux reports a .desktop file id, not a name people recognise.
  if (process.platform === 'linux') {
    return null
  }
  try {
    return app.getApplicationNameForProtocol(url) || null
  } catch {
    return null
  }
}

function dropPendingLaunch(requestId: string): PendingLaunch | null {
  const pending = pendingLaunches.get(requestId)
  if (!pending) {
    return null
  }
  clearTimeout(pending.timer)
  pendingLaunches.delete(requestId)
  return pending
}

function expirePendingLaunch(requestId: string): void {
  const pending = dropPendingLaunch(requestId)
  try {
    if (pending && !pending.renderer.isDestroyed()) {
      // Why: an Open click after expiry would do nothing, so the prompt must not outlive the request.
      pending.renderer.send('browser:external-app-request-closed', { requestId })
    }
  } catch {
    // Renderer may be destroyed between the check and send.
  }
}

/**
 * Asks the window showing the page whether to open the link in its app; Orca launches it only on
 * a yes. Returns false when refused without asking: a web scheme, or no local window (a page
 * streamed from a server must never launch apps on that server).
 */
export function requestBrowserExternalAppLaunch(args: {
  context: { browserPageId: string; renderer: Electron.WebContents } | null
  rawUrl: string | undefined
  requestingUrl: () => string
}): boolean {
  const url = toBrowserExternalAppUrl(args.rawUrl)
  const { context } = args
  if (!url || !context || context.renderer.isDestroyed()) {
    return false
  }
  // Why: one prompt per page, so a page looping a deep link cannot stack dialogs.
  for (const pending of pendingLaunches.values()) {
    if (pending.browserPageId === context.browserPageId) {
      return true
    }
  }
  const requestId = randomUUID()
  const request: BrowserExternalAppRequest = {
    requestId,
    appName: externalAppName(url.href),
    scheme: url.protocol.slice(0, -1),
    origin: requestingOrigin(args.requestingUrl())
  }
  pendingLaunches.set(requestId, {
    url: url.href,
    browserPageId: context.browserPageId,
    renderer: context.renderer,
    timer: setTimeout(() => expirePendingLaunch(requestId), BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS)
  })
  try {
    context.renderer.send('browser:external-app-requested', request)
  } catch {
    dropPendingLaunch(requestId)
    return false
  }
  return true
}

export function respondToBrowserExternalAppRequest(
  sender: Electron.WebContents,
  response: BrowserExternalAppResponse
): boolean {
  if (
    !response ||
    typeof response.requestId !== 'string' ||
    typeof response.open !== 'boolean' ||
    pendingLaunches.get(response.requestId)?.renderer.id !== sender.id
  ) {
    return false
  }
  const pending = dropPendingLaunch(response.requestId)
  if (pending && response.open) {
    shell.openExternal(pending.url).catch((error: unknown) => {
      console.warn('[browser] Could not open link in another app:', error)
    })
  }
  return true
}
