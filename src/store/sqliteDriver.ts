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

/** Mirrors migrations/0011_leveling_xp_ceiling.sql for existing SQLite files. */
function ensureLevelingXpCeiling(raw: DatabaseSync): void {
  const id = '0011_leveling_xp_ceiling';
  const applied = raw.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(id);
  if (applied) return;

  raw.exec('BEGIN IMMEDIATE');
  try {
    // Another opener may have completed the rebuild while this connection
    // waited for the write lock. Recheck inside the transaction.
    if (raw.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(id)) {
      raw.exec('COMMIT');
      return;
    }
    const importRunSequence = Number(
      (raw.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'level_import_runs'`).get() as
        | { seq: number }
        | undefined)?.seq ?? 0,
    );
    raw.exec(`
      CREATE TABLE member_levels_with_xp_ceiling (
        guild_id    TEXT    NOT NULL,
        member_id   TEXT    NOT NULL,
        xp          INTEGER NOT NULL CHECK (xp BETWEEN 0 AND 9007199254740991),
        message_xp  INTEGER NOT NULL DEFAULT 0 CHECK (message_xp BETWEEN 0 AND 9007199254740991),
        voice_xp    INTEGER NOT NULL DEFAULT 0 CHECK (voice_xp BETWEEN 0 AND 9007199254740991),
        imported_xp INTEGER NOT NULL DEFAULT 0 CHECK (imported_xp BETWEEN 0 AND 9007199254740991),
        updated_at  TEXT    NOT NULL,
        PRIMARY KEY (guild_id, member_id),
        CHECK (xp = message_xp + voice_xp + imported_xp)
      );
      INSERT INTO member_levels_with_xp_ceiling
        (guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at)
      SELECT guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at
        FROM member_levels;
      DROP TABLE member_levels;
      ALTER TABLE member_levels_with_xp_ceiling RENAME TO member_levels;
      CREATE INDEX idx_member_levels_rank
        ON member_levels (guild_id, xp DESC, member_id ASC);

      CREATE TABLE level_import_runs_with_xp_ceiling (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT    NOT NULL,
        source            TEXT    NOT NULL CHECK (source = 'mee6'),
        source_rows       INTEGER NOT NULL,
        unique_members    INTEGER NOT NULL,
        inserted          INTEGER NOT NULL,
        updated           INTEGER NOT NULL,
        unchanged         INTEGER NOT NULL,
        duplicate_rows    INTEGER NOT NULL,
        total_imported_xp INTEGER NOT NULL CHECK (total_imported_xp BETWEEN 0 AND 9007199254740991),
        imported_at       TEXT    NOT NULL
      );
      INSERT INTO level_import_runs_with_xp_ceiling
        (id, guild_id, source, source_rows, unique_members, inserted, updated,
         unchanged, duplicate_rows, total_imported_xp, imported_at)
      SELECT id, guild_id, source, source_rows, unique_members, inserted, updated,
             unchanged, duplicate_rows, total_imported_xp, imported_at
        FROM level_import_runs;
      DROP TABLE level_import_runs;
      ALTER TABLE level_import_runs_with_xp_ceiling RENAME TO level_import_runs;
    `);
    if (importRunSequence > 0) {
      raw.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'level_import_runs'`).run(
        importRunSequence,
      );
    }
    raw.prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`).run(
      id,
      new Date().toISOString(),
    );
    raw.exec('COMMIT');
  } catch (err) {
    try {
      raw.exec('ROLLBACK');
    } catch {
      /* already unwound */
    }
    throw err;
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
  raw.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  // Mirrors migrations/0008_members_third_message_at.sql (TWO-95).
  ensureColumn(raw, 'members', 'third_message_at', 'TEXT');
  ensureLevelingXpCeiling(raw);
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
    '0011_leveling_xp_ceiling',
  ]) {
    stamp.run(id, new Date().toISOString());
  }
  return new SqliteDb(raw);
}
