/**
 * SQLite driver. TEMPORARY - this file is deleted once the Postgres path has
 * run in staging for a week (TWO-18). It exists only so we can roll back
 * without a deploy.
 *
 * It is synchronous underneath; the async wrapper is there purely to satisfy
 * the shared Db interface.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, RunResult, Statement } from './driver.ts';

const here = dirname(fileURLToPath(import.meta.url));

class SqliteDb implements Db {
  readonly kind = 'sqlite' as const;
  private raw: DatabaseSync;
  /** Nested transaction() calls must not emit a second BEGIN. */
  private depth: number;

  constructor(raw: DatabaseSync, depth = 0) {
    this.raw = raw;
    this.depth = depth;
  }

  prepare(sql: string): Statement {
    const raw = this.raw;
    return {
      async get<T>(...params: unknown[]): Promise<T | undefined> {
        return raw.prepare(sql).get(...(params as never[])) as T | undefined;
      },
      async all<T>(...params: unknown[]): Promise<T[]> {
        return raw.prepare(sql).all(...(params as never[])) as T[];
      },
      async run(...params: unknown[]): Promise<RunResult> {
        const info = raw.prepare(sql).run(...(params as never[]));
        return { changes: Number(info.changes) };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(this);
    const inner = new SqliteDb(this.raw, 1);
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = await fn(inner);
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* already unwound */
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}

/**
 * Add a nullable column to an existing database if it is not already there.
 *
 * `schema.sql` is all CREATE TABLE IF NOT EXISTS, which is a no-op against a
 * database that already has the table - so a column added to that file reaches
 * new databases and silently misses every existing one, including the live
 * `data/two.db`. Postgres has real migrations for this; the SQLite path
 * deliberately does not (migrations/README.md: not worth a second dialect for a
 * driver being deleted in TWO-70). This is the minimum that keeps the two
 * dialects agreeing until then.
 *
 * Additive and nullable only. Anything needing a default, a backfill or a
 * rewrite is a real migration and does not belong here.
 */
function ensureColumn(raw: DatabaseSync, table: string, column: string, type: string): void {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function reconcilePendingUnbans(raw: DatabaseSync): void {
  const duplicates = raw.prepare(
    `SELECT guild_id, user_id
       FROM moderation_scheduled_unbans
      WHERE state = 'pending'
      GROUP BY guild_id, user_id
     HAVING COUNT(*) > 1`,
  ).all() as Array<{ guild_id: string; user_id: string }>;
  const pending = raw.prepare(
    `SELECT request_id FROM moderation_scheduled_unbans
      WHERE guild_id = ? AND user_id = ? AND state = 'pending'
      ORDER BY execute_at DESC, created_at DESC, request_id DESC`,
  );
  const supersede = raw.prepare(
    `UPDATE moderation_scheduled_unbans
        SET state = 'superseded', completed_at = COALESCE(completed_at, ?)
      WHERE request_id = ?`,
  );
  const now = new Date().toISOString();
  for (const pair of duplicates) {
    const rows = pending.all(pair.guild_id, pair.user_id) as Array<{ request_id: string }>;
    for (const row of rows.slice(1)) supersede.run(now, row.request_id);
  }
}

/** Open a SQLite database. `:memory:` gives an ephemeral one. */
export async function openSqlite(path: string): Promise<Db> {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  // WAL lets a reader and a writer coexist, but two writers still collide, and
  // the default behaviour is to fail the statement instantly with
  // SQLITE_BUSY. That is how a backfill run dies half way through when the bot
  // happens to write a join at the same moment. Wait instead: these are short
  // transactions, so waiting costs milliseconds and losing the run costs
  // several minutes of re-scanning Discord.
  raw.exec('PRAGMA busy_timeout = 15000;');
  let schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  const pendingIndex = `CREATE UNIQUE INDEX IF NOT EXISTS uq_moderation_pending_unban
  ON moderation_scheduled_unbans (guild_id, user_id) WHERE state = 'pending';`;
  // Old databases may contain duplicates that were legal before 0011. Defer
  // this one index until the rows are reconciled below; all other bootstrap SQL
  // remains unchanged.
  schema = schema.replace(pendingIndex, '');
  raw.exec(schema);
  // Mirrors migrations/0008_members_third_message_at.sql (TWO-95).
  ensureColumn(raw, 'members', 'third_message_at', 'TEXT');
  // Existing SQLite databases already have the 0010 table, so schema.sql's
  // CREATE TABLE IF NOT EXISTS cannot add the 0011/0012 claim columns.
  ensureColumn(raw, 'moderation_scheduled_unbans', 'claimed_at', 'TEXT');
  ensureColumn(raw, 'moderation_scheduled_unbans', 'claim_token', 'TEXT');
  ensureColumn(raw, 'moderation_lockdowns', 'prior_exists', 'INTEGER NOT NULL DEFAULT 1');
  reconcilePendingUnbans(raw);
  raw.exec(pendingIndex);
  // schema.sql is the whole schema, so every migration whose tables it already
  // contains is recorded as applied. Adding a migration means adding its
  // tables above and its id here, or a database that is later moved to
  // Postgres will try to apply it a second time.
  const stamp = raw.prepare(`INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`);
  for (const id of [
    '0001_initial',
    '0002_internal_actions',
    '0008_members_third_message_at',
    '0010_leveling',
    '0010_moderation',
    '0011_moderation_durability',
    '0012_moderation_recovery',
  ]) {
    stamp.run(id, new Date().toISOString());
  }
  return new SqliteDb(raw);
}
