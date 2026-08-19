/**
 * One fixture, two drivers.
 *
 * The point of TWO-18 is that the existing suite passes against Postgres
 * without its assertions changing. So the tests do not name a driver: they ask
 * for a database and get whichever one the run is pointed at.
 *
 *   npm test                        # SQLite, no services needed
 *   TWO_TEST_DATABASE_URL=... npm test   # the same tests, against Postgres
 *
 * Isolation on Postgres: `node --test` runs each file in its own process, in
 * parallel, so every file gets a private schema named after itself and drops
 * it on the way out. Within a file the tests share the schema and truncate
 * between fixtures, which is fine because a file's tests run in order.
 */
import { basename } from 'node:path';
import { openDb, isPostgresSpec, type Db } from '../../src/store/db.ts';

export const TEST_PG_URL = process.env.TWO_TEST_DATABASE_URL ?? '';
export const usingPostgres = isPostgresSpec(TEST_PG_URL);

/** A stable, legal schema name derived from the test file that asked for it. */
function schemaFor(label: string): string {
  const clean = basename(label)
    .replace(/\.test\.ts$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .slice(0, 40);
  return `test_${clean || 'anon'}`;
}

const TABLES = ['events', 'members', 'invite_snapshots'];

export interface TestDb {
  db: Db;
  /** Empty every table, leaving the schema in place. */
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * @param label usually `import.meta.filename` - only used to name the schema.
 */
export async function openTestDb(label: string): Promise<TestDb> {
  if (!usingPostgres) {
    const db = await openDb(':memory:');
    return {
      db,
      async reset() {
        for (const t of TABLES) await db.exec(`DELETE FROM ${t}`);
        // Restart the rowid counter so event ids look the same as a fresh
        // database - `recent()` and any id assertion depend on it.
        await db.exec(`DELETE FROM sqlite_sequence WHERE name = 'events'`);
      },
      async cleanup() {
        await db.close();
      },
    };
  }

  const schema = schemaFor(label);
  // Start from a clean slate even if a previous run died mid-test.
  const bootstrap = await openDb(TEST_PG_URL, { skipMigrations: true });
  await bootstrap.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await bootstrap.close();

  const db = await openDb(TEST_PG_URL, { schema, applicationName: `two-bot-test:${schema}` });

  return {
    db,
    async reset() {
      await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
    },
    async cleanup() {
      await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.close();
    },
  };
}
