// The WeCom connector's own state on the bot's host: which bot listens as which WeCom bot (its
// Secret only ever sealed), the chats the owner allowed, and each message from arrival until its
// reply settled. Runs in the bots DB worker.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import Database from '../sqlite/sync-database'
import { WecomBinding, WecomChat } from './wecom-binding'
import {
  WECOM_MESSAGE_COLUMNS as MESSAGE_COLUMNS,
  WecomBody,
  WecomMessageRow,
  type WecomArrival
} from './wecom-inbox-rows'

const KEEP_SETTLED_MS = 7 * 24 * 60 * 60_000
const PRUNE_GAP_MS = 24 * 60 * 60_000
const WECOM_UNCONFIRMED_SHOWN = 20

export class WecomInbox {
  private readonly db: Database
  private prunedAt = 0
  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bindings(account TEXT PRIMARY KEY,scope TEXT NOT NULL,bot TEXT NOT NULL,bot_key TEXT NOT NULL UNIQUE,secret TEXT NOT NULL,owner TEXT,paired_at INTEGER,UNIQUE(scope,bot));
      CREATE TABLE IF NOT EXISTS chats(account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,chat TEXT NOT NULL,kind TEXT NOT NULL,added_at INTEGER NOT NULL,PRIMARY KEY(account,chat));
      CREATE TABLE IF NOT EXISTS inbox(account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,mid TEXT NOT NULL,req_id TEXT NOT NULL,chat TEXT NOT NULL,chat_kind TEXT NOT NULL,received_at INTEGER NOT NULL,preview TEXT NOT NULL,body TEXT,notice TEXT,state TEXT NOT NULL DEFAULT 'pending',final_via TEXT,final_text TEXT,parts_sent INTEGER NOT NULL DEFAULT 0,part_sending INTEGER,answered INTEGER NOT NULL DEFAULT 0,unconfirmed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,mid));
      CREATE INDEX IF NOT EXISTS wecom_open_messages ON inbox(account,chat) WHERE state<>'settled';`)
  }

  close(): void {
    this.db.close()
  }

  bindings(scope: string): (WecomBinding & { secret: string })[] {
    return this.db
      .prepare(
        'SELECT account,bot,bot_key AS botKey,secret,owner,paired_at AS pairedAt FROM bindings WHERE scope=?'
      )
      .all(scope)
      .map((row) => WecomBinding.extend({ secret: z.string() }).parse(row))
  }

  /** A new binding; its Secret, sealed by the caller for this account, comes in a second write. */
  reserve(scope: string, bot: string, botKey: string): WecomBinding {
    const binding: WecomBinding = {
      account: `local-wecom/${randomUUID()}`,
      bot,
      botKey,
      owner: null,
      pairedAt: null
    }
    this.db
      .prepare('INSERT INTO bindings(account,scope,bot,bot_key,secret) VALUES(?,?,?,?,?)')
      .run(binding.account, scope, bot, botKey, '')
    return binding
  }

  sealSecret(account: string, sealed: string): void {
    this.db.prepare('UPDATE bindings SET secret=? WHERE account=?').run(sealed, account)
  }

  remove(scope: string, bot: string, account: string): void {
    this.db
      .prepare('DELETE FROM bindings WHERE scope=? AND bot=? AND account=?')
      .run(scope, bot, account)
  }

  chats(account: string): WecomChat[] {
    return this.db
      .prepare('SELECT chat,kind FROM chats WHERE account=? ORDER BY added_at,rowid')
      .all(account)
      .map((row) => WecomChat.parse(row))
  }

  /** The owner's single chat pairs the binding; a group pairs only for that same owner. */
  pair(account: string, from: string, chat: WecomChat, at: number): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const owner = z
        .object({ owner: z.string().nullable() })
        .parse(this.db.prepare('SELECT owner FROM bindings WHERE account=?').get(account)).owner
      let paired = false
      if (chat.kind === 'single' && owner === null && chat.chat === from) {
        this.db
          .prepare('UPDATE bindings SET owner=?,paired_at=? WHERE account=? AND owner IS NULL')
          .run(from, at, account)
        paired = true
      } else if (chat.kind === 'group' && owner === from) {
        paired = true
      }
      if (paired) {
        this.db
          .prepare('INSERT OR IGNORE INTO chats(account,chat,kind,added_at) VALUES(?,?,?,?)')
          .run(account, chat.chat, chat.kind, at)
      }
      this.db.exec('COMMIT')
      return paired
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Once per message id, whatever WeCom repeats; how many of the chat's messages are ahead of it.
   *  One that only `notice` answers (a type Orca can't read) is never delivered. */
  receive(
    account: string,
    arrival: WecomArrival,
    at: number,
    notice: string | null
  ): { fresh: boolean; ahead: number } {
    const { changes } = this.db
      .prepare(
        'INSERT OR IGNORE INTO inbox(account,mid,req_id,chat,chat_kind,received_at,preview,body,state,final_text) VALUES(?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        account,
        arrival.mid,
        arrival.reqId,
        arrival.chat,
        arrival.kind,
        at,
        arrival.preview,
        notice === null ? JSON.stringify(arrival.body) : null,
        notice === null ? 'pending' : 'notice',
        notice
      )
    const ahead = z
      .object({ n: z.number() })
      .parse(
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM inbox WHERE account=? AND chat=? AND (state='pending' OR (state='admitted' AND final_text IS NULL AND answered=0)) AND rowid<(SELECT rowid FROM inbox WHERE account=? AND mid=?)`
          )
          .get(account, arrival.chat, account, arrival.mid)
      ).n
    // Arrivals keep the inbox pruned, at most daily, so an idle app runs no timer for it.
    if (changes > 0 && at - this.prunedAt >= PRUNE_GAP_MS) {
      this.prune(at)
    }
    return { fresh: changes > 0, ahead }
  }

  /** The oldest undelivered message of a chat whose earlier delivered message's turn has ended
   *  (its answer chosen), so each message gets a turn of its own. */
  next(account: string): (WecomMessageRow & { body: WecomBody }) | null {
    const row = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS},body FROM inbox AS m WHERE account=? AND state='pending' AND body IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM inbox AS e WHERE e.account=m.account AND e.chat=m.chat AND e.state='admitted' AND e.final_text IS NULL AND e.answered=0)
         ORDER BY rowid LIMIT 1`
      )
      .get(account)
    if (!row) {
      return null
    }
    const parsed = WecomMessageRow.extend({ body: z.string() }).parse(row)
    return { ...parsed, body: WecomBody.parse(JSON.parse(parsed.body)) }
  }

  body(account: string, mid: string, body: WecomBody): void {
    this.db
      .prepare('UPDATE inbox SET body=? WHERE account=? AND mid=? AND body IS NOT NULL')
      .run(JSON.stringify(body), account, mid)
  }

  /** Delivered (or its outcome unknown, which the seam's receipt settles): its reply is now owed.
   *  `notice` (attachments that could not be read) leads the final answer. */
  admitted(account: string, mid: string, notice: string | null): void {
    this.db
      .prepare(
        "UPDATE inbox SET state='admitted',body=NULL,notice=? WHERE account=? AND mid=? AND state='pending'"
      )
      .run(notice, account, mid)
  }

  /** Not delivered, so no turn answers it: `text` is the reply it is owed. */
  owe(account: string, mid: string, state: 'notice' | 'review', text: string): void {
    this.db
      .prepare(
        "UPDATE inbox SET state=?,body=NULL,final_text=COALESCE(final_text,?) WHERE account=? AND mid=? AND state='pending'"
      )
      .run(state, text, account, mid)
  }

  /** Every part of its reply went out (or was given up as unconfirmed); a notice needs no more.
   *  An unconfirmed reply keeps its text, for the owner to resend. */
  answered(account: string, mid: string): void {
    this.db
      .prepare(
        "UPDATE inbox SET answered=1,final_text=CASE WHEN unconfirmed>0 THEN final_text END,state=CASE state WHEN 'notice' THEN 'settled' ELSE state END WHERE account=? AND mid=?"
      )
      .run(account, mid)
  }

  /** The outbox took the answered row's sent mark. */
  settled(account: string, mid: string): void {
    this.db
      .prepare("UPDATE inbox SET state='settled' WHERE account=? AND mid=? AND state='admitted'")
      .run(account, mid)
  }

  /** Answered rows whose outbox mark an earlier run already wrote. */
  settleAnswered(account: string): void {
    this.db
      .prepare(
        "UPDATE inbox SET state='settled' WHERE account=? AND state='admitted' AND answered=1"
      )
      .run(account)
  }

  message(account: string, mid: string): WecomMessageRow | null {
    const row = this.db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM inbox WHERE account=? AND mid=?`)
      .get(account, mid)
    return row ? WecomMessageRow.parse(row) : null
  }

  /** Notices still owed, oldest first. */
  owedNotices(account: string): WecomMessageRow[] {
    return this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM inbox WHERE account=? AND state IN ('notice','review') AND answered=0 ORDER BY rowid`
      )
      .all(account)
      .map((row) => WecomMessageRow.parse(row))
  }

  /** The final answer and how it goes, chosen once so a restart splits and sends the same parts:
   *  the stream's own last frame, or pushed messages. */
  chooseFinal(
    account: string,
    mid: string,
    via: 'stream' | 'push',
    text: string
  ): WecomMessageRow | null {
    this.db
      .prepare(
        'UPDATE inbox SET final_via=COALESCE(final_via,?),final_text=COALESCE(final_text,?) WHERE account=? AND mid=? AND answered=0'
      )
      .run(via, text, account, mid)
    return this.message(account, mid)
  }

  /** The stream's last frame was refused: every part goes as a pushed message instead. */
  finalToPush(account: string, mid: string): void {
    this.db
      .prepare(
        "UPDATE inbox SET final_via='push' WHERE account=? AND mid=? AND final_via='stream' AND parts_sent=0"
      )
      .run(account, mid)
  }

  /** Written before part `part` goes out, so a restart knows its outcome is unknown. */
  partSending(account: string, mid: string, part: number): void {
    this.db
      .prepare('UPDATE inbox SET part_sending=? WHERE account=? AND mid=? AND parts_sent=?')
      .run(part, account, mid, part - 1)
  }

  partSent(account: string, mid: string, part: number, confirmed: boolean): void {
    this.db
      .prepare(
        'UPDATE inbox SET parts_sent=?,part_sending=NULL,unconfirmed=unconfirmed+? WHERE account=? AND mid=? AND parts_sent=?'
      )
      .run(part, confirmed ? 0 : 1, account, mid, part - 1)
  }

  /** A part WeCom refused outright was never shown: nothing is owed for its attempt. */
  partRefused(account: string, mid: string, part: number): void {
    this.db
      .prepare('UPDATE inbox SET part_sending=NULL WHERE account=? AND mid=? AND part_sending=?')
      .run(account, mid, part)
  }

  counts(account: string): { review: number; unconfirmed: number } {
    return z
      .object({ review: z.number(), unconfirmed: z.number() })
      .parse(
        this.db
          .prepare(
            `SELECT COALESCE(SUM(state='review'),0) AS review,COALESCE(SUM(unconfirmed>0),0) AS unconfirmed FROM inbox WHERE account=?`
          )
          .get(account)
      )
  }

  /** The newest replies WeCom may not have shown, for the owner to look at and resend. */
  unconfirmedReplies(account: string): { mid: string; preview: string }[] {
    return this.db
      .prepare(
        'SELECT mid,preview FROM inbox WHERE account=? AND answered=1 AND unconfirmed>0 AND final_text IS NOT NULL ORDER BY rowid DESC LIMIT ?'
      )
      .all(account, WECOM_UNCONFIRMED_SHOWN)
      .map((row) => z.object({ mid: z.string(), preview: z.string() }).parse(row))
  }

  /** The reply the owner asked to resend, while it is still unconfirmed. */
  resendable(account: string, mid: string): { chat: string; text: string } | null {
    const row = this.db
      .prepare(
        'SELECT chat,final_text AS text FROM inbox WHERE account=? AND mid=? AND answered=1 AND unconfirmed>0 AND final_text IS NOT NULL'
      )
      .get(account, mid)
    return row ? z.object({ chat: z.string(), text: z.string() }).parse(row) : null
  }

  /** WeCom confirmed every part of the owner's resend. */
  resent(account: string, mid: string): void {
    this.db
      .prepare(
        'UPDATE inbox SET unconfirmed=0,final_text=NULL WHERE account=? AND mid=? AND answered=1'
      )
      .run(account, mid)
  }

  /** Settled messages go after a week; one awaiting review stays until the owner clears it. */
  prune(now: number): void {
    this.prunedAt = now
    this.db
      .prepare("DELETE FROM inbox WHERE state='settled' AND received_at<?")
      .run(now - KEEP_SETTLED_MS)
  }

  /** The owner looked: messages awaiting review and unconfirmed replies stop showing in status. */
  dismiss(account: string): void {
    this.db
      .prepare(
        "UPDATE inbox SET unconfirmed=0,final_text=CASE WHEN answered=1 THEN NULL ELSE final_text END,state=CASE WHEN state='review' AND answered=1 THEN 'settled' ELSE state END WHERE account=?"
      )
      .run(account)
  }
}
