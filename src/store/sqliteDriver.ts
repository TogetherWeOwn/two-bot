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
  raw
    .prepare(`INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`)
    .run('0001_initial', new Date().toISOString());
  return new SqliteDb(raw);
}
