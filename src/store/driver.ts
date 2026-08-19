/**
 * The narrow database surface the rest of the bot is allowed to touch.
 *
 * Two implementations: sqliteDriver.ts (the original, on its way out) and
 * postgresDriver.ts (the real one). Keeping the shape identical to the old
 * `node:sqlite` API - prepare().get/all/run - is deliberate: the Postgres move
 * is a driver swap, and the diff at every call site should be one `await` and
 * nothing else.
 *
 * The one unavoidable difference is that everything is async. No Postgres
 * client for Node is synchronous, so `record()` cannot stay sync. See
 * docs/STACK.md.
 */

export interface RunResult {
  /** Rows actually written. Used only where the caller cares. */
  changes: number;
}

export interface Statement {
  get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<RunResult>;
}

export interface Db {
  readonly kind: 'sqlite' | 'postgres';

  /**
   * Prepare a statement. SQL is written once, in SQLite's `?` placeholder
   * style; the Postgres driver rewrites those to `$1..$n`. Every statement
   * used by the bot must be valid in both dialects until the SQLite path is
   * deleted - in practice that means `ON CONFLICT ... DO NOTHING` and
   * `RETURNING`, both of which the two engines share.
   */
  prepare(sql: string): Statement;

  /** Run raw SQL with no parameters. Migrations and test setup only. */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a transaction, on ONE connection.
   *
   * The `tx` handle passed in is the only thing that is inside the
   * transaction - statements prepared off the outer Db go to a different
   * pooled connection and will not see the uncommitted rows. Always use the
   * argument, never the closure.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/**
 * Rewrite `?` placeholders to Postgres `$1..$n`, leaving anything inside a
 * single-quoted literal alone.
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let inLiteral = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      // '' inside a literal is an escaped quote, not a terminator.
      if (inLiteral && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inLiteral = !inLiteral;
      out += c;
      continue;
    }
    if (c === '?' && !inLiteral) {
      out += `$${++n}`;
      continue;
    }
    out += c;
  }
  return out;
}
