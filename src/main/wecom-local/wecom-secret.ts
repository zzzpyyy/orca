// The WeCom bot's Secret at rest: sealed by this host's OS keychain for one binding, and refused
// where nothing seals it. The plain value lives only in memory, for the connection that uses it.
import { getSecretStore, hasSecretStore } from '../../shared/secure-storage/secret-store'
import { sealedStorageRefusal } from '../orca-profiles/cloud-session/profile-cloud-session-sealing'
import { WECOM_STORAGE_REFUSED } from '../../shared/bots/wecom-local'

const PREFIX = 'sealed:'

export class WecomStorageRefused extends Error {
  constructor() {
    super(WECOM_STORAGE_REFUSED)
    this.name = 'WecomStorageRefused'
  }
}

/** Null when a Secret can be sealed here; a host-key store (orcad) seals too. */
export function wecomSealRefusal(): string | null {
  return hasSecretStore() ? sealedStorageRefusal(getSecretStore()) : 'no credential store'
}

/** Bound to its binding, so a sealed value copied to another binding's row does not open there. */
export async function sealWecomSecret(account: string, secret: string): Promise<string> {
  if (wecomSealRefusal() !== null) {
    throw new WecomStorageRefused()
  }
  const store = getSecretStore()
  const plain = JSON.stringify({ account, secret })
  const sealed = store.encryptStringAsync
    ? await store.encryptStringAsync(plain)
    : store.encryptString(plain)
  return `${PREFIX}${sealed.toString('base64')}`
}

export function openWecomSecret(account: string, sealed: string): string | null {
  if (!sealed.startsWith(PREFIX) || !hasSecretStore()) {
    return null
  }
  try {
    const store = getSecretStore()
    if (!store.isEncryptionAvailable()) {
      return null
    }
    const opened: unknown = JSON.parse(
      store.decryptString(Buffer.from(sealed.slice(PREFIX.length), 'base64'))
    )
    if (
      opened &&
      typeof opened === 'object' &&
      'account' in opened &&
      'secret' in opened &&
      opened.account === account &&
      typeof opened.secret === 'string' &&
      opened.secret
    ) {
      return opened.secret
    }
  } catch {
    // Unreadable here: the owner enters the Secret again.
  }
  return null
}
