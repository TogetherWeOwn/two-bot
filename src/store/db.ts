/** Open the Postgres datastore and apply pending migrations. */
import type { Db } from './driver.ts';
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
  if (!spec.trim()) {
    throw new Error('Database URL is required. Set TWO_DATABASE_URL to a postgres:// or postgresql:// URL.');
  }
  if (!isPostgresSpec(spec)) {
    throw new Error('Only Postgres is supported. TWO_DATABASE_URL must use postgres:// or postgresql://.');
  }

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
