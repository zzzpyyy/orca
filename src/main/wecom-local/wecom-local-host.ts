// Every WeCom binding on this host: restored at start, created when the owner enters a Bot ID and
// Secret in Orca, and dropped with its bot. The Secret is sealed before it is stored and read back
// only to open the connection; it is never returned, logged or sent anywhere else.
import { access, open } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { WECOM_ERRORS, type WecomLocalState } from '../../shared/bots/wecom-local'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import type { WecomBinding } from './wecom-binding'
import { WecomConnection } from './wecom-connection'
import { resendWecomReply } from './wecom-resend'
import {
  openWecomSecret,
  sealWecomSecret,
  wecomSealRefusal,
  WecomStorageRefused
} from './wecom-secret'
import { WECOM_WS_URL, wecomSocketUrl } from './wecom-socket'
import { wecomStore, type WecomStore } from './wecom-store-ops'

export class WecomLocalHost {
  private readonly store: WecomStore
  private readonly active = new Map<string, WecomConnection>()
  private readonly changing = new Map<string, Promise<void>>()
  private readonly resending = new Set<string>()
  private readonly opening: Promise<void>
  private readonly file: string
  private readonly scope: string
  private readonly url = wecomSocketUrl(process.env.ORCA_WECOM_WS_URL)
  private readonly unwatch: () => void
  private stopping = false
  private restoreFailed = false

  constructor(
    private readonly runtime: OrcaRuntimeService,
    root: string,
    profile: string
  ) {
    this.file = join(root, 'wecom-local.sqlite')
    this.scope = relative(root, profile).split(sep).join('/')
    this.store = wecomStore(runtime.botsDb, this.file)
    this.opening = this.restore().catch(() => {
      this.restoreFailed = true
    })
    this.unwatch = runtime.onBotsWritten(() => {
      for (const [bot, connection] of this.active) {
        if (!runtime.bots.list().some((entry) => entry.id === bot)) {
          void this.remove(bot).catch(() =>
            console.warn('[wecom] Could not remove the deleted bot’s WeCom binding')
          )
        } else {
          connection.wake()
        }
      }
    })
  }

  async state(bot: string): Promise<WecomLocalState> {
    await this.opening
    if (this.restoreFailed) {
      throw new Error(WECOM_ERRORS.unreadable)
    }
    const connection = this.active.get(bot)
    if (!connection) {
      return { status: 'off' }
    }
    const [state, replies] = await Promise.all([
      connection.state(),
      this.store.unconfirmedReplies(connection.binding.account)
    ])
    return replies.length > 0 ? { ...state, unconfirmedReplies: replies } : state
  }

  /** Sends an unconfirmed reply again because the owner asked; see resendWecomReply. */
  async resend(bot: string, mid: string): Promise<void> {
    await this.opening
    const connection = this.active.get(bot)
    if (!connection) {
      throw new Error(WECOM_ERRORS.notConnected)
    }
    const key = JSON.stringify([connection.binding.account, mid])
    // A second click while the first is out would show the reply twice.
    if (this.resending.has(key)) {
      return
    }
    this.resending.add(key)
    try {
      await resendWecomReply(this.store, connection.binding.account, mid, connection.push)
    } finally {
      this.resending.delete(key)
      this.changed(bot)
    }
  }

  /** Binds the bot to a WeCom bot and starts pairing; a bot already bound is bound anew. */
  async connect(bot: string, botKey: string, secret: string): Promise<void> {
    await this.opening
    if (wecomSealRefusal() !== null) {
      throw new WecomStorageRefused()
    }
    if (this.restoreFailed || this.stopping || !this.botTakesMessages(bot)) {
      throw new Error(WECOM_ERRORS.unavailable)
    }
    await this.serial(bot, async () => {
      await this.retire(bot)
      let binding: WecomBinding
      try {
        // Protect the inbox before SQLite opens it or creates its journal.
        await (await open(this.file, 'a', 0o600)).close()
        binding = await this.store.reserve(this.scope, bot, botKey)
      } catch {
        throw new Error(WECOM_ERRORS.taken)
      }
      try {
        await this.store.sealSecret(binding.account, await sealWecomSecret(binding.account, secret))
      } catch (error) {
        await this.store.remove(this.scope, bot, binding.account)
        throw error instanceof WecomStorageRefused ? error : new Error(WECOM_ERRORS.saveFailed)
      }
      if (this.stopping || !this.runtime.bots.list().some((entry) => entry.id === bot)) {
        await this.store.remove(this.scope, bot, binding.account)
        throw new Error(WECOM_ERRORS.unavailable)
      }
      this.launch(binding, secret, true)
    })
    this.changed(bot)
  }

  async pairGroup(bot: string): Promise<void> {
    await this.opening
    const connection = this.active.get(bot)
    if (!connection) {
      throw new Error(WECOM_ERRORS.notConnected)
    }
    if (!connection.pairGroup()) {
      throw new Error(WECOM_ERRORS.pairDmFirst)
    }
  }

  /** Opens the connection again with the saved Secret, after a refusal or a takeover. */
  async reconnect(bot: string): Promise<void> {
    await this.opening
    await this.serial(bot, async () => {
      const connection = this.active.get(bot)
      if (!connection || this.stopping) {
        return
      }
      await connection.stop()
      const saved = (await this.store.bindings(this.scope)).find(
        (entry) => entry.account === connection.binding.account
      )
      if (!saved || this.active.get(bot) !== connection) {
        return
      }
      const { secret, ...binding } = saved
      this.launch(binding, openWecomSecret(binding.account, secret), false)
    })
    this.changed(bot)
  }

  async dismiss(bot: string): Promise<void> {
    await this.opening
    await this.active.get(bot)?.dismiss()
  }

  async remove(bot: string): Promise<void> {
    await this.opening
    await this.serial(bot, () => this.retire(bot))
    this.changed(bot)
  }

  repliesFilled(): void {
    for (const connection of this.active.values()) {
      connection.wake()
    }
  }

  rewatch(): void {
    if (this.stopping) {
      return
    }
    for (const connection of this.active.values()) {
      connection.watch()
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return
    }
    this.stopping = true
    this.unwatch()
    await Promise.allSettled(
      [...this.active.values()]
        .map((connection) => connection.stop())
        .concat([...this.changing.values()], this.opening)
    )
    this.active.clear()
  }

  private async restore(): Promise<void> {
    try {
      await access(this.file)
    } catch (error) {
      if (errnoCodeOrUnknown(error) === 'ENOENT') {
        return
      }
      throw error
    }
    for (const saved of await this.store.bindings(this.scope)) {
      if (this.stopping) {
        return
      }
      const { secret, ...binding } = saved
      if (this.runtime.bots.list().some((bot) => bot.id === binding.bot)) {
        this.launch(binding, openWecomSecret(binding.account, secret), false)
      } else {
        await this.store.remove(this.scope, binding.bot, binding.account)
      }
    }
    await this.prune()
  }

  private launch(binding: WecomBinding, secret: string | null, pair: boolean): void {
    const connection = new WecomConnection({
      runtime: this.runtime,
      store: this.store,
      binding,
      secret,
      url: this.url,
      loopback: this.url !== WECOM_WS_URL
    })
    this.active.set(binding.bot, connection)
    connection.start(pair)
  }

  private async retire(bot: string): Promise<void> {
    const connection = this.active.get(bot)
    if (!connection) {
      return
    }
    await connection.stop()
    await this.store.remove(this.scope, bot, connection.binding.account)
    if (this.active.get(bot) === connection) {
      this.active.delete(bot)
    }
  }

  /** One change at a time per bot, so a connect never races its own removal. */
  private async serial(bot: string, change: () => Promise<void>): Promise<void> {
    const previous = this.changing.get(bot) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(change)
    this.changing.set(bot, next)
    try {
      await next
    } finally {
      if (this.changing.get(bot) === next) {
        this.changing.delete(bot)
      }
    }
  }

  private botTakesMessages(bot: string): boolean {
    return (
      this.runtime.bots.enabled() &&
      this.runtime.bots.list().some((entry) => entry.id === bot && !entry.paused)
    )
  }

  private async prune(): Promise<void> {
    try {
      await access(this.file)
      await this.store.prune(Date.now())
    } catch {
      // Nothing to prune yet; arriving messages prune again.
    }
  }

  private changed(bot: string): void {
    this.runtime.notifyBotsChanged({ botIds: [bot], kinds: ['settings'] })
  }
}
