/**
 * Open the datastore.
 *
 * One entry point, two drivers. Which one you get is decided by the spec
 * string, so nothing above this line has to know:
 *
 *   'postgres://...' / 'postgresql://'  -> Postgres (migrations run on open)
 *   ':memory:'                          -> ephemeral SQLite
 *   any other string                    -> SQLite file at that path
 *
 * The SQLite branch is scheduled for deletion (TWO-18) once Postgres has held
 * up in staging. Do not build anything new on it.
 */
import type { Db } from './driver.ts';
import { openSqlite } from './sqliteDriver.ts';
import { openPostgres } from './postgresDriver.ts';
import { migrate } from './migrate.ts';

export type { Db, Statement, RunResult } from './driver.ts';

export function isPostgresSpec(spec: string): boolean {
  return spec.startsWith('postgres://') || spec.startsWith('postgresql://');
}

export interface OpenOptions {
  /** Skip migrations. Only the migration runner's own tests want this. */
  skipMigrations?: boolean;
  poolMax?: number;
  /** Postgres schema to use instead of `public`. Tests only - see postgresDriver.ts. */
  schema?: string;
  applicationName?: string;
}

/** Safe to call repeatedly. Creates the schema if it is not there yet. */
export async function openDb(spec: string, opts: OpenOptions = {}): Promise<Db> {
  if (!isPostgresSpec(spec)) return openSqlite(spec);

  const db = await openPostgres({
    connectionString: spec,
    max: opts.poolMax,
    schema: opts.schema,
    applicationName: opts.applicationName,
  });
  if (!opts.skipMigrations) {
    try {
      await migrate(db);
    } catch (err) {
      await db.close();
      throw err;
    }
  }
  return db;
}
