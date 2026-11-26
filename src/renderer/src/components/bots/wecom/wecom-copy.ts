// What the WeCom dialog and card say about a connection's state, its live replies and a failed call.
import type { Translate } from '@/i18n/use-translate'
import {
  WECOM_ERRORS,
  WECOM_STORAGE_REFUSED,
  type WecomLocalState
} from '../../../../../shared/bots/wecom-local'

/** States where the owner enters the Bot ID and Secret (again): connecting binds the bot anew. */
export function wecomNeedsCredentials(state: WecomLocalState): boolean {
  return ['off', 'auth-failed', 'secret-unreadable', 'expired'].includes(state.status)
}

export function wecomNeedsOwner(state: WecomLocalState): boolean {
  return (
    (state.review ?? 0) > 0 ||
    (state.unconfirmed ?? 0) > 0 ||
    state.streaming !== undefined ||
    state.replyError !== undefined ||
    ['pairing', 'auth-failed', 'replaced', 'secret-unreadable', 'expired'].includes(state.status)
  )
}

export function wecomStatusLine(state: WecomLocalState, t: Translate): string {
  switch (state.status) {
    case 'off':
      return t(
        'bots.wecom.off',
        'Enter the Bot ID and Secret of a WeCom AI bot that uses API mode with a long connection.'
      )
    case 'connecting':
      return t('bots.wecom.connecting', 'Connecting to WeCom…')
    case 'pairing':
      return t(
        'bots.wecom.pairing',
        'Send this code to the bot in a direct message from your own WeCom account. It expires in five minutes.'
      )
    case 'listening':
      return t(
        'bots.wecom.listening',
        'Answering your direct messages to the bot, and @mentions in {{count}} paired groups.',
        {
          count: state.groups ?? 0,
          defaultValue_one:
            'Answering your direct messages to the bot, and @mentions in 1 paired group.'
        }
      )
    case 'auth-failed':
      return t(
        'bots.wecom.authFailed',
        'WeCom refused the Bot ID or Secret. Check that the bot uses API mode with a long connection, then enter them again.'
      )
    case 'replaced':
      return t(
        'bots.wecom.replaced',
        'Another client connected with this Bot ID, so WeCom closed Orca’s connection. Reconnect to take it back.'
      )
    case 'retrying':
      return t('bots.wecom.retrying', 'Lost the connection to WeCom. Retrying…')
    case 'secret-unreadable':
      return t(
        'bots.wecom.secretUnreadable',
        'This computer can no longer read the saved Secret. Enter the Bot ID and Secret again.'
      )
    case 'paused':
      return t(
        'bots.wecom.paused',
        'This bot is paused or bots are off. WeCom messages get a notice until it resumes.'
      )
    case 'expired':
      return t(
        'bots.wecom.expired',
        'The pairing code expired before it reached the bot. Enter the Bot ID and Secret to get a new one.'
      )
  }
}

/** Live progress fell back to a notice and the final answer, and why. */
export function wecomStreamingLine(state: WecomLocalState, t: Translate): string | null {
  switch (state.streaming) {
    case undefined:
      return null
    case 'permission':
      return t(
        'bots.wecom.streamingPermission',
        'Live replies are off: WeCom says the bot lacks permission to update its reply. Orca sends a notice, then the final answer as separate messages.'
      )
    case 'rate_limited':
      return t(
        'bots.wecom.streamingRate',
        'Live replies paused: WeCom limits how often the bot can reply. Orca sends a notice, then the final answer as separate messages.'
      )
    case 'expired':
    case 'failed':
      return t(
        'bots.wecom.streamingFailed',
        'Live replies stopped for the last turn. Orca sends a notice, then the final answer as separate messages.'
      )
  }
}

export function wecomErrorLine(error: unknown, t: Translate): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes(WECOM_STORAGE_REFUSED)) {
    return t(
      'bots.wecom.errorStorage',
      'This computer has no sealed credential storage, so Orca won’t save the Secret here.'
    )
  }
  if (message.includes(WECOM_ERRORS.taken)) {
    return t('bots.wecom.errorTaken', 'This WeCom bot is already connected to another Orca bot.')
  }
  if (message.includes(WECOM_ERRORS.saveFailed)) {
    return t('bots.wecom.errorSave', 'Couldn’t save the Secret. Try again.')
  }
  if (message.includes(WECOM_ERRORS.pairDmFirst)) {
    return t('bots.wecom.errorPairDm', 'Pair your direct message with the bot first.')
  }
  if (message.includes(WECOM_ERRORS.resendUnconfirmed)) {
    return t(
      'bots.wecom.errorResend',
      'WeCom didn’t confirm the resend, so it may or may not show. Check WeCom before resending again.'
    )
  }
  if (message.includes(WECOM_ERRORS.notConnected)) {
    return t(
      'bots.wecom.errorNotConnected',
      'WeCom isn’t connected right now. Try again once it is.'
    )
  }
  if (message.includes(WECOM_ERRORS.unavailable)) {
    return t('bots.wecom.errorUnavailable', 'The bot is paused, deleted or bots are off.')
  }
  return t('bots.wecom.errorHost', 'Couldn’t reach the bot’s computer. Try again.')
}
