/** Why a WeCom connection is not answering, or what it waits on, as the setup dialog words it. */
export type WecomLocalStatus =
  | 'off'
  | 'connecting'
  | 'pairing'
  | 'listening'
  /** WeCom refused the Bot ID and Secret, or the bot is not in API mode with a long connection. */
  | 'auth-failed'
  /** Another client subscribed with this Bot ID, so WeCom closed this connection. */
  | 'replaced'
  | 'retrying'
  /** The saved Secret no longer opens on this host (keychain reset or moved profile). */
  | 'secret-unreadable'
  | 'paused'
  | 'expired'

/** Why live progress stopped and the turn fell back to a notice plus the final answer. */
export type WecomStreamProblem = 'permission' | 'rate_limited' | 'expired' | 'failed'

/** The setup dialog's view of one bot's WeCom connection. The Secret never leaves the bot's host. */
export type WecomLocalState = {
  status: WecomLocalStatus
  /** The Bot ID's last characters, enough to tell two bots apart. */
  botHint?: string
  pairingText?: string
  pairingFor?: 'dm' | 'group'
  groups?: number
  /** The newest turn's live progress problem, while it lasts. */
  streaming?: WecomStreamProblem
  /** Replies WeCom may or may not have shown, by message: Orca never sends one twice on its own. */
  unconfirmed?: number
  /** The newest of them that still have their text, for the owner to resend. */
  unconfirmedReplies?: { mid: string; preview: string }[]
  /** Messages Orca could not hand to the bot's chat. */
  review?: number
  /** A reply WeCom refused, kept to try again; its error code, never its text. */
  replyError?: number
  /** The chat the owner's messages go to, for Open conversation. */
  sessionId?: string
}

/** Why this host can't save a WeCom Secret: Orca stores it only where the OS keychain seals it. */
export const WECOM_STORAGE_REFUSED = 'WeCom Secret storage is not sealed on this host'

/** Why a setup call failed, as its error message, for the dialog to word. */
export const WECOM_ERRORS = {
  taken: 'wecom_bot_taken',
  unavailable: 'wecom_bot_unavailable',
  saveFailed: 'wecom_secret_not_saved',
  unreadable: 'wecom_bindings_unreadable',
  notConnected: 'wecom_not_connected',
  pairDmFirst: 'wecom_pair_dm_first',
  /** WeCom didn't confirm a part of the owner's resend: it may show, or not. */
  resendUnconfirmed: 'wecom_resend_unconfirmed'
} as const
