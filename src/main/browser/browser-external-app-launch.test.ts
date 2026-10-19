import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getApplicationNameForProtocol: vi.fn((_url: string) => 'Okta Verify'),
  openExternal: vi.fn((_url: string) => Promise.resolve())
}))

vi.mock('electron', () => ({
  app: { getApplicationNameForProtocol: mocks.getApplicationNameForProtocol },
  shell: { openExternal: mocks.openExternal }
}))

import type { BrowserExternalAppRequest } from '../../shared/browser-external-app'
import {
  BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS,
  requestBrowserExternalAppLaunch,
  respondToBrowserExternalAppRequest
} from './browser-external-app-launch'

const OKTA_URL = 'com-okta-authenticator:/deviceChallenge?challengeRequest=abc'

function mockRenderer(id: number): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launcher only reads id, isDestroyed and send.
  return { id, isDestroyed: () => false, send: vi.fn() } as unknown as Electron.WebContents
}

function ask(renderer: Electron.WebContents, rawUrl = OKTA_URL, browserPageId = 'page-1') {
  return requestBrowserExternalAppLaunch({
    context: { browserPageId, renderer },
    rawUrl,
    requestingUrl: () => 'https://acme.okta.com/signin'
  })
}

function sentRequests(renderer: Electron.WebContents): BrowserExternalAppRequest[] {
  return vi
    .mocked(renderer.send)
    .mock.calls.filter(([channel]) => channel === 'browser:external-app-requested')
    .map(([, request]) => request)
}

describe('browser external app launch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.openExternal.mockClear()
  })

  afterEach(() => {
    // Expire anything a test left open so the next test's page is not throttled.
    vi.advanceTimersByTime(BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS)
    vi.useRealTimers()
  })

  it('asks the window showing the page and opens the app only after a yes', () => {
    const renderer = mockRenderer(10)

    expect(ask(renderer)).toBe(true)
    const [request] = sentRequests(renderer)
    expect(vi.mocked(renderer.send).mock.calls[0][0]).toBe('browser:external-app-requested')
    expect(request).toEqual({
      requestId: expect.any(String),
      appName: process.platform === 'linux' ? null : 'Okta Verify',
      scheme: 'com-okta-authenticator',
      origin: 'https://acme.okta.com'
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()

    expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: request.requestId, open: true })
    ).toBe(true)
    expect(mocks.openExternal).toHaveBeenCalledWith(OKTA_URL)

    expect(ask(renderer, 'zoommtg://zoom.us/join?confno=1')).toBe(true)
    const [, declined] = sentRequests(renderer)
    respondToBrowserExternalAppRequest(renderer, { requestId: declined.requestId, open: false })
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://example.com/',
    'http://localhost:3000/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'blob:https://example.com/id',
    'about:blank',
    'orca-preview://doc/index.html',
    'not a url'
  ])('refuses %s without asking', (rawUrl) => {
    const renderer = mockRenderer(20)
    expect(ask(renderer, rawUrl)).toBe(false)
    expect(renderer.send).not.toHaveBeenCalled()
  })

  it('refuses a page with no window on this computer', () => {
    expect(
      requestBrowserExternalAppLaunch({ context: null, rawUrl: OKTA_URL, requestingUrl: () => '' })
    ).toBe(false)
  })

  it('keeps one prompt per page and accepts each answer once, from its own window', () => {
    const renderer = mockRenderer(30)
    const otherWindow = mockRenderer(31)

    ask(renderer)
    // A page looping a deep link gets no second dialog while the first is open.
    expect(ask(renderer)).toBe(true)
    ask(renderer, OKTA_URL, 'page-2')
    const [first, otherPage] = sentRequests(renderer)
    expect(sentRequests(renderer)).toHaveLength(2)

    expect(
      respondToBrowserExternalAppRequest(otherWindow, { requestId: first.requestId, open: true })
    ).toBe(false)
    expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: first.requestId, open: true })
    ).toBe(true)
    expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: first.requestId, open: true })
    ).toBe(false)
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS)
    // An expired request closes its prompt, so no dead Open button is left on screen.
    expect(renderer.send).toHaveBeenCalledWith('browser:external-app-request-closed', {
      requestId: otherPage.requestId
    })
    expect(
      respondToBrowserExternalAppRequest(renderer, { requestId: otherPage.requestId, open: true })
    ).toBe(false)
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
    // An expired prompt no longer holds the page.
    ask(renderer, OKTA_URL, 'page-2')
    expect(sentRequests(renderer)).toHaveLength(3)
  })
})
