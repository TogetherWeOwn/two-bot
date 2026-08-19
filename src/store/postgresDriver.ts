/**
 * Postgres driver.
 *
 * Why we are here: more than one process now writes to the funnel log - the
 * bot and the website. SQLite gives us one writer and a lock error for the
 * second. See docs/STACK.md.
 *
 * Pooling: one pool per process. The bot is not throughput-bound - it writes a
 * handful of rows per member event - so the pool is small on purpose. A big
 * pool on a small Postgres just moves the queue from the app to the database.
 */
import pg from 'pg';
import { toPgPlaceholders, type Db, type RunResult, type Statement } from './driver.ts';
import { log } from '../core/log.ts';

/**
 * Return BIGINT and NUMERIC as JavaScript numbers rather than strings.
 *
 * node-postgres hands back bigint as a string because a 64-bit integer does
 * not always fit in a double. Ours are COUNT(*) results and a row id sequence;
 * both are far below 2^53. Without this, `countByType()` returns "3" and every
 * assert.equal against a number fails - a genuinely nasty way to find out.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

/** Postgres error code for unique_violation. */
export const UNIQUE_VIOLATION = '23505';

interface Queryable {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

class PgDb implements Db {
  readonly kind = 'postgres' as const;
  private q: Queryable;
  private pool: pg.Pool | null;

  /** `pool` is null for the transaction-scoped handle: it must not be closed. */
  constructor(q: Queryable, pool: pg.Pool | null) {
    this.q = q;
    this.pool = pool;
  }

  prepare(sql: string): Statement {
    const text = toPgPlaceholders(sql);
    const q = this.q;
    return {
      async get<T>(...params: unknown[]): Promise<T | undefined> {
        const r = await q.query(text, params);
        return r.rows[0] as T | undefined;
      },
      async all<T>(...params: unknown[]): Promise<T[]> {
        const r = await q.query(text, params);
        return r.rows as T[];
      },
      async run(...params: unknown[]): Promise<RunResult> {
        const r = await q.query(text, params);
        return { changes: r.rowCount ?? 0 };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.q.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Already inside one (nested call): reuse the same connection, no second BEGIN.
    if (!this.pool) return fn(this);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(new PgDb(client, null));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection is already gone */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

export interface PgOptions {
  connectionString: string;
  /** Max pooled connections. Keep it small; see the note at the top. */
  max?: number;
  /** Fail fast rather than hang the bot on a dead database. */
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  /**
   * Put everything in this schema instead of `public`, creating it if needed.
   *
   * Only the tests use it: `node --test` runs each file in its own process, in
   * parallel, and they would otherwise truncate each other's tables. A schema
   * per test file makes them independent against one real Postgres.
   */
  schema?: string;
  applicationName?: string;
}

/** Schema names are interpolated, not bound, so be strict about them. */
function assertSafeSchema(name: string): void {
  if (!/^[a-z_][a-z0-9_]{0,48}$/.test(name)) {
    throw new Error(`unsafe schema name: ${name}`);
  }
}

export async function openPostgres(opts: PgOptions): Promise<Db> {
  if (opts.schema) {
    assertSafeSchema(opts.schema);
    const setup = new pg.Client({ connectionString: opts.connectionString });
    await setup.connect();
    try {
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${opts.schema}`);
    } finally {
      await setup.end();
    }
  }

  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 5,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    // A runaway query should die, not pin a connection until the bot restarts.
    statement_timeout: opts.statementTimeoutMillis ?? 15_000,
    application_name: opts.applicationName ?? 'two-bot',
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });

  // An idle pooled client dropped by the server (restart, failover) emits
  // 'error' on the pool. Without a listener that is an unhandled exception and
  // takes the bot down. The pool discards the bad client on its own; we just
  // need to not die.
  pool.on('error', (err) => {
    log.error('pg_pool_client_error', { err: String(err) });
  });

  // Fail loudly at boot rather than on the first member join.
  const probe = await pool.connect();
  probe.release();

  return new PgDb(pool, pool);
}
