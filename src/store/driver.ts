/**
 * The narrow database surface the rest of the bot is allowed to touch.
 *
 * The prepare().get/all/run shape is deliberate: it keeps database access
 * narrow and makes every call site consistently asynchronous.
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
  /**
   * Prepare a statement. Internal SQL deliberately uses `?` placeholders; the
   * Postgres driver rewrites them to `$1..$n` before sending the query.
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
