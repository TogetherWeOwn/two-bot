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
import { webSchemaFor } from '../../src/store/webContract.ts';

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

/**
 * Emptied between fixtures.
 *
 * `rank_ladder` and `web_contract_meta` are NOT here: they are seed rows from
 * migration 0002, not test data, and `web_v1.rank_counts` left-joins from the
 * ladder to guarantee all five ranks always come back. Truncating it would make
 * that guarantee silently untestable.
 */
const TABLES = [
  'events',
  'members',
  'invite_snapshots',
  'guild_counters',
  'rank_snapshots',
  'member_ranks',
  'scheduled_events',
  // TOG-469's internal instrument. Truncated like any other test data - it is
  // emphatically NOT part of the web contract, and no view reads it.
  'presence_probe',
  'counter_snapshots',
  'member_exclusions',
  'xp_awards',
  'xp_cooldowns',
  'level_role_rewards',
  'level_import_runs',
  'member_levels',
  // TOG-1642 moderation state. Same treatment as any other test data: the
  // moderation suites and the backup round trip seed these directly, and a
  // leftover row from one fixture would collide with the next one's PKs.
  'moderation_warnings',
  'moderation_scheduled_unbans',
  'moderation_audit',
  'moderation_lockdowns',
  'moderation_idempotency',
  'containment_events',
  'containment_incidents',
  'join_risk_flags',
  'ticket_transcripts',
  'tickets',
  'automod_violations',
  'automod_processed_messages',
];

/**
 * The SQLite path bootstraps from src/store/schema.sql, which the migrations do
 * not touch - so it only has the original three. Everything migration 0002 adds
 * is Postgres-only, like the views that read it.
 */
const SQLITE_TABLES = [
  'events',
  'members',
  'invite_snapshots',
  'xp_awards',
  'xp_cooldowns',
  'level_role_rewards',
  'level_import_runs',
  'member_levels',
  'moderation_warnings',
  'moderation_scheduled_unbans',
  'moderation_audit',
  'moderation_lockdowns',
  'moderation_idempotency',
  'containment_events',
  'containment_incidents',
  'join_risk_flags',
  'ticket_transcripts',
  'tickets',
  'automod_violations',
  'automod_processed_messages',
];

export interface TestDb {
  db: Db;
  /** Schema holding the bot's tables. `main` on SQLite, `test_*` on Postgres. */
  schema?: string;
  /** Schema the contract views go in, when there are any. Postgres only. */
  webSchema?: string;
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
        for (const t of SQLITE_TABLES) await db.exec(`DELETE FROM ${t}`);
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
  // The contract views get their own schema per test file too, or parallel
  // files would CREATE OR REPLACE each other's views mid-run and every one of
  // them would end up reading one file's tables. See src/store/webContract.ts.
  const webSchema = webSchemaFor(schema);

  // Start from a clean slate even if a previous run died mid-test.
  const bootstrap = await openDb(TEST_PG_URL, { skipMigrations: true });
  await bootstrap.exec(`DROP SCHEMA IF EXISTS ${webSchema} CASCADE`);
  await bootstrap.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await bootstrap.close();

  const db = await openDb(TEST_PG_URL, { schema, applicationName: `two-bot-test:${schema}` });

  return {
    db,
    schema,
    webSchema,
    async reset() {
      await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    },
    async cleanup() {
      // Views first: they depend on the tables, and CASCADE on the bot schema
      // would drop them without the schema itself, leaving an empty husk behind
      // for the next run to trip over.
      await db.exec(`DROP SCHEMA IF EXISTS ${webSchema} CASCADE`);
      await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.close();
    },
  };
}
