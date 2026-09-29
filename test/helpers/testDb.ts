/**
 * Postgres test fixture.
 *
 * `node --test` runs each file in its own process, in parallel, so every file
 * gets a private schema named after itself and drops it on the way out. Within
 * a file the tests share the schema and truncate between fixtures, which is fine
 * because a file's tests run in order.
 */
import { basename } from 'node:path';
import { openDb, isPostgresSpec, type Db } from '../../src/store/db.ts';
import { webSchemaFor } from '../../src/store/webContract.ts';

function requiredTestDatabaseUrl(): string {
  const url = process.env.TWO_TEST_DATABASE_URL?.trim() ?? '';
  if (!url) {
    throw new Error(
      'TWO_TEST_DATABASE_URL is required. Set it to an isolated Postgres database before running database tests.',
    );
  }
  if (!isPostgresSpec(url)) {
    throw new Error('TWO_TEST_DATABASE_URL must use postgres:// or postgresql://.');
  }
  return url;
}

export const TEST_PG_URL = requiredTestDatabaseUrl();

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
  'operational_audit_log',
  // TOG-3187 kill switch: a row left engaged by one fixture would silently
  // halt every later audit delivery in the same file's schema.
  'audit_kill_switch',
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
  // TOG-1648 automations.
  'automation_commands',
  'scheduled_messages',
  'sticky_messages',
  'automation_audit_log',
  'community_scorecard_alerts',
  'community_scorecard_runs',
  'community_stream_heartbeats',
  'community_facts',
  'event_rsvps',
  'lfg_signups',
  'lfg_roles',
  'lfg_posts',
  'feed_deliveries',
  'feed_relays',
  'announcements_audit_log',
  'ticket_transcripts',
  'tickets',
  'automod_violations',
  'automod_processed_messages',
  'self_role_audit',
  'self_role_panel_claims',
  // TOG-3101 config store. guild_settings_audit is append-only by trigger, but
  // TRUNCATE does not fire row triggers, which is why the reset still works and
  // a stray UPDATE/DELETE still does not.
  'guild_settings',
  'guild_settings_audit',
  // TOG-3052 temp voice.
  'temp_voice_audit',
  'temp_voice_creates',
  'temp_voice_channels',
  // TOG-9074: invite campaigns and internal-actions state. rank_ladder and
  // web_contract_meta stay out - they are migration seed rows, not test data.
  'invite_campaigns',
  'internal_action_log',
  'internal_discord_events',
  'internal_idempotency',
  'internal_nonces',
];

export interface TestDb {
  db: Db;
  /** Schema holding the bot's tables. */
  schema: string;
  /** Schema holding the contract views. */
  webSchema: string;
  /** Empty every table, leaving the schema in place. */
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * @param label usually `import.meta.filename` - only used to name the schema.
 */
export async function openTestDb(label: string): Promise<TestDb> {
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

let ephemeralSequence = 0;

/**
 * Open a one-test Postgres schema whose `close()` also drops the schema.
 *
 * This keeps focused tests that create a fresh database per case concise while
 * still running every assertion against the shipping Postgres migrations.
 */
export async function openEphemeralTestDb(_legacySpec?: string): Promise<Db> {
  const harness = await openTestDb(`ephemeral_${process.pid}_${++ephemeralSequence}`);
  return {
    prepare: (sql) => harness.db.prepare(sql),
    exec: (sql) => harness.db.exec(sql),
    transaction: (fn) => harness.db.transaction(fn),
    close: () => harness.cleanup(),
  };
}
