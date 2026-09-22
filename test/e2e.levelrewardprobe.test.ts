/**
 * TOG-3481 acceptance for the half a unit test cannot reach: the CLI, and the
 * absence of a write.
 *
 * "It writes nothing" is not assertable by reading the source, because the
 * thing that would break it is a future edit. So the database refuses on our
 * behalf: a BEFORE INSERT OR UPDATE OR DELETE trigger on level_role_rewards
 * raises, which turns any write the probe ever learns to do into a failing
 * test rather than a quiet row. The harness resets with TRUNCATE, which does
 * not fire row triggers (test/helpers/testDb.ts), so the guard can stay
 * installed for the whole file.
 *
 * The trigger covers the table the probe reports on. The table list snapshot
 * covers the rest of the connection - openDb migrates by default, and a probe
 * that quietly created a schema would be writing plenty while leaving
 * level_role_rewards untouched.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { LevelingService } from '../src/leveling/service.ts';
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/levels-import-rewards-probe.ts', import.meta.url).pathname;
const EXPORT = new URL('./fixtures/mee6-export-role-rewards.json', import.meta.url).pathname;
const ROLES = new URL('./fixtures/mee6-guild-roles.json', import.meta.url).pathname;
const BOT_ID = '900000000000000001';
const GUILD = TWO_STAGING_GUILD_ID;

let harness: TestDb;
let dbEnv: Record<string, string>;
let dir: string;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  dbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };
  dir = mkdtempSync(join(tmpdir(), 'two-bot-reward-probe-'));

  await harness.db.exec(`
    CREATE OR REPLACE FUNCTION ${schema}.tog3481_refuse_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'TOG-3481: % wrote to level_role_rewards', current_setting('application_name', true);
    END $$;
    DROP TRIGGER IF EXISTS tog3481_no_writes ON ${schema}.level_role_rewards;
    CREATE TRIGGER tog3481_no_writes
      BEFORE INSERT OR UPDATE OR DELETE ON ${schema}.level_role_rewards
      FOR EACH ROW EXECUTE FUNCTION ${schema}.tog3481_refuse_write();
  `);
});

after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await harness.cleanup();
});

beforeEach(() => harness.reset());

async function cli(args: string[], env: Record<string, string> = dbEnv) {
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env: { ...process.env, ...env } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function probeArgs(overrides: string[] = []): string[] {
  return ['--guild', GUILD, '--file', EXPORT, '--roles', ROLES, '--bot-id', BOT_ID, ...overrides];
}

/** Every row of the table, and every table in the schema. */
async function snapshot() {
  const rows = await harness.db
    .prepare(`SELECT guild_id, level, role_id FROM level_role_rewards ORDER BY guild_id, level`)
    .all();
  const tables = await harness.db
    .prepare(`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`)
    .all<{ tablename: string }>();
  return { rows, tables: tables.map((t) => t.tablename) };
}

/** Insert directly, around the guard, so a fixture can seed what a write cannot. */
async function seedRewards(rewards: Array<{ level: number; roleId: string }>) {
  await harness.db.exec(`ALTER TABLE level_role_rewards DISABLE TRIGGER tog3481_no_writes`);
  try {
    await new LevelingService(harness.db).replaceRoleRewards(GUILD, rewards);
  } finally {
    await harness.db.exec(`ALTER TABLE level_role_rewards ENABLE TRIGGER tog3481_no_writes`);
  }
}

test('the probe reads the fixture, reports mapped vs unmapped, and writes nothing', async () => {
  const before = await snapshot();

  const result = await cli(probeArgs());
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.guildId, GUILD);
  assert.equal(report.counts.rewardsIn, 7);
  assert.equal(report.counts.mapped, 2);
  assert.equal(report.counts.unmapped, 5);
  assert.equal(report.counts.balances, true);
  assert.deepEqual(report.counts.byReason, {
    role_absent: 1,
    role_managed: 1,
    above_bot_role: 1,
    duplicate_level: 1,
    duplicate_role: 1,
  });

  // The card's literal acceptance. The guard above means a write would have
  // failed the run outright; this says the table is also unchanged, and that
  // nothing else in the schema moved either.
  assert.deepEqual(await snapshot(), before);
});

test(`the live guild ${LIVE_GUILD_ID} is refused before anything is opened`, async () => {
  // No database in the environment at all: if the fence ran after the
  // connection, this would fail on TWO_DATABASE_URL instead of on the guild,
  // and the refusal would be an accident of ordering.
  const result = await cli(
    ['--guild', LIVE_GUILD_ID, '--file', EXPORT, '--roles', ROLES, '--bot-id', BOT_ID],
    { PGOPTIONS: dbEnv.PGOPTIONS!, TWO_DATABASE_URL: '' },
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, new RegExp(`Refusing live guild ${LIVE_GUILD_ID}`));
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /TWO_DATABASE_URL/);
});

test('a malformed export fails with every problem at once, and opens no database', async () => {
  const before = await snapshot();
  const path = join(dir, 'bad.json');
  writeFileSync(
    path,
    JSON.stringify({
      role_rewards: [
        { rank: 5, role: { id: '900000000000000020' } },
        { rank: 0, role: { id: '900000000000000021' } },
        { rank: 9, role: { id: 'not-a-snowflake' } },
        { rank: 11 },
      ],
    }),
  );

  const result = await cli(['--guild', GUILD, '--file', path, '--roles', ROLES, '--bot-id', BOT_ID]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /invalid level: 0/);
  assert.match(result.stderr, /invalid Discord role id: not-a-snowflake/);
  assert.match(result.stderr, /no role id/);
  assert.equal(result.stdout, '');
  assert.deepEqual(await snapshot(), before);
});

test('the delta against stored rewards is read, reported, and not acted on', async () => {
  // Level 5 currently points at "Level 5 Alt"; the export moves it to "Level 5"
  // and adds level 10. Level 99 is stored and absent from the export, so
  // replaceRoleRewards would delete it - which is exactly what an operator
  // needs told before they run the import, not after.
  await seedRewards([
    { level: 5, roleId: '900000000000000024' },
    { level: 99, roleId: '900000000000000023' },
  ]);
  const before = await snapshot();
  assert.equal(before.rows.length, 2);

  const result = await cli(probeArgs());
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);

  assert.deepEqual(report.delta, {
    added: [{ level: 10, roleId: '900000000000000021' }],
    changed: [{ level: 5, from: '900000000000000024', to: '900000000000000020' }],
    removed: [{ level: 99, roleId: '900000000000000023' }],
    unchanged: [],
  });

  // Reporting a removal must not perform one. Both seeded rows survive.
  assert.deepEqual(await snapshot(), before);
});

test('--require-all-mapped is a usable CI gate: it fails and names the losers', async () => {
  const result = await cli(probeArgs(['--require-all-mapped']));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /5 of 7 reward roles are unmapped/);
  assert.match(result.stderr, /level 15 \(role_absent\)/);
  assert.match(result.stderr, /level 25 \(above_bot_role\)/);
  // The report is still on stdout: a gate that fails without telling you what
  // to fix costs an operator a second run.
  assert.equal(JSON.parse(result.stdout).counts.unmapped, 5);
});

test('--no-db runs the whole probe with no database in the environment', async () => {
  const result = await cli(probeArgs(['--no-db']), {});
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.counts.mapped, 2);
  // No connection means no stored rewards to compare against, and the report
  // says so rather than implying the guild has none.
  assert.equal(report.delta, null);
});

test('--report writes the same JSON to disk for evidence', async () => {
  const out = join(dir, 'report.json');
  const result = await cli(probeArgs(['--report', out]));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(result.stdout));
});

test('the guard itself works, so the no-write assertions above mean something', async () => {
  // A test that proves a write is impossible is worthless if the mechanism is
  // inert. This is the control: the same statement the probe would have to
  // issue, failing.
  await assert.rejects(
    () => new LevelingService(harness.db).replaceRoleRewards(GUILD, [{ level: 1, roleId: '900000000000000020' }]),
    /wrote to level_role_rewards/,
  );
});
