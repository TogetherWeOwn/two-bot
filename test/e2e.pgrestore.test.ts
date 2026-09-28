/**
 * TOG-6491 acceptance for scripts/pg-restore.ts (`npm run restore:pg`).
 *
 * e2e.backup covers the dump/restore round trip through the library; this
 * covers the script that can wipe a database: seeded rows in, the real CLI as
 * a subprocess, refusals first. A restore pointed at the wrong database is a
 * data-loss event, so the target is TWO_RESTORE_URL - deliberately not
 * TWO_DATABASE_URL - plus a --force flag, and every refusal below asserts
 * both the non-zero exit and the byte-identical row counts (zero writes).
 *
 * Fixture (one synthetic guild, never live/staging):
 *   3 member_join rows + 1 invite_snapshots row, dumped in-process to a
 *   canned .ndjson.gz, target truncated, restored through the script.
 *
 * Isolation is the scratch schema (openTestDb + PGOPTIONS search_path, the
 * same routing e2e.dedupeevents and e2e.gatecheck use), never a live guild.
 *
 * Reproduce by hand (reviewer path): point TWO_TEST_DATABASE_URL at a scratch
 * Postgres, seed per seedFixture() below and dump it, then run
 * `node scripts/pg-restore.ts <dump> --force` with TWO_RESTORE_URL unset
 * (refusal naming TWO_RESTORE_URL), with only TWO_DATABASE_URL set (same
 * refusal - no fallback), and with TWO_RESTORE_URL set plus PGOPTIONS
 * pointing at the schema (RESTORE VERIFIED, rows back).
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EventStore } from '../src/store/eventStore.ts';
import { dump, DUMP_TABLES } from '../src/store/dump.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/pg-restore.ts', import.meta.url).pathname;

// Synthetic guild in the 700... range used by other script fixtures (001 is
// dedupeevents/webcontract, 002 is gatecheck). The script has no guild fence;
// the isolation here is the scratch schema, not the id.
const GUILD = '700000000000000003';

let harness: TestDb;
let dir: string;
/** Routes the child script's pg driver at this file's scratch schema. */
let dbEnv: Record<string, string>;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  dbEnv = {
    TWO_TEST_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };
  dir = mkdtempSync(join(tmpdir(), 'two-pg-restore-'));
});

after(async () => {
  await harness.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await harness.reset();
});

interface CliResult {
  code: number;
  output: string;
}

async function cli(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<CliResult> {
  try {
    const result = await run('node', [SCRIPT, ...args], {
      cwd: REPO,
      env: { ...process.env, ...dbEnv, ...extraEnv },
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/** Child env with no restore target at all: TWO_RESTORE_URL deleted even if
 * the parent CI env happens to carry one, so the refusal is proved, not
 * inherited. */
function noTargetEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { TWO_RESTORE_URL: undefined, ...extra };
}

async function seedFixture(): Promise<void> {
  const store = new EventStore(harness.db);
  for (let i = 0; i < 3; i++) {
    await store.record({
      guildId: GUILD,
      memberId: `9000000000000008${i + 1}`,
      eventType: 'member_join',
      occurredAt: `2026-08-0${i + 1}T10:00:00.000Z`,
      source: 'invite:qa-restore',
    });
  }
  await harness.db
    .prepare(
      `INSERT INTO invite_snapshots (guild_id, code, uses, inviter_id, channel_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(GUILD, 'qa-restore', 7, 'owner', 'c1', '2026-08-09T00:00:00.000Z');
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of DUMP_TABLES) {
    const r = await harness.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get<{ n: number }>();
    out[t] = Number(r?.n ?? 0);
  }
  return out;
}

let dumpSequence = 0;

/** Seed, dump in-process, wipe - the canned backup the CLI tests restore.
 * Returns the seeded event rows so the positive test can prove the restore
 * brought back the same rows, not merely the same count. */
async function cannedDump(): Promise<{
  file: string;
  before: Record<string, number>;
  seeded: Array<Record<string, unknown>>;
}> {
  await seedFixture();
  const before = await counts();
  assert.equal(before.events, 3);
  const seeded = await harness.db
    .prepare(`SELECT id, event_type, occurred_at, idempotency_key FROM events ORDER BY id`)
    .all<Record<string, unknown>>();
  const file = join(dir, `canned-${++dumpSequence}.ndjson.gz`);
  await dump(harness.db, file);
  await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
  assert.equal((await counts()).events, 0);
  return { file, before, seeded };
}

test('refuses without --force: names the flag, writes nothing', { timeout: 60_000 }, async () => {
  const { file } = await cannedDump();
  const before = await counts();
  const result = await cli([file], noTargetEnv());
  assert.notEqual(result.code, 0, `expected refusal, got exit 0: ${result.output}`);
  assert.match(result.output, /wipes the target\. Pass --force/);
  assert.deepEqual(await counts(), before, 'a refused run must not have truncated anything');
});

test('refuses with --force but no target: names TWO_RESTORE_URL, writes nothing', { timeout: 60_000 }, async () => {
  const { file } = await cannedDump();
  const before = await counts();
  const result = await cli([file, '--force'], noTargetEnv());
  assert.notEqual(result.code, 0, `expected refusal, got exit 0: ${result.output}`);
  assert.match(result.output, /TWO_RESTORE_URL must be set/);
  assert.deepEqual(await counts(), before, 'a refused run must not have truncated anything');
});

test('refuses when only TWO_DATABASE_URL is set: no fallback to the live variable', { timeout: 60_000 }, async () => {
  // This is the data-loss guard the card exists for: the variable already in
  // everyone's shell must never become a restore target by accident.
  const { file } = await cannedDump();
  const before = await counts();
  const result = await cli(
    [file, '--force'],
    noTargetEnv({ TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL! }),
  );
  assert.notEqual(result.code, 0, `expected refusal, got exit 0: ${result.output}`);
  assert.match(result.output, /deliberately not TWO_DATABASE_URL/);
  assert.deepEqual(await counts(), before, 'a refused run must not have truncated anything');
});

test('--dry-run validates the file with no target and writes nothing', { timeout: 60_000 }, async () => {
  const { file } = await cannedDump();
  const before = await counts();
  const result = await cli([file, '--dry-run'], noTargetEnv());
  assert.equal(result.code, 0, `dry run failed: ${result.output}`);
  assert.match(result.output, /DRY RUN VERIFIED/);
  assert.deepEqual(await counts(), before, 'a dry run must not write');
});

test('with target + --force restores the canned dump: RESTORE VERIFIED, rows back', { timeout: 120_000 }, async () => {
  const { file, before, seeded } = await cannedDump();

  const result = await cli(
    [file, '--force'],
    { TWO_RESTORE_URL: process.env.TWO_TEST_DATABASE_URL! },
  );
  assert.equal(result.code, 0, `restore failed: ${result.output}`);
  assert.match(result.output, /RESTORE VERIFIED/);
  assert.deepEqual(await counts(), before, 'restored counts must match the dump manifest');
  const after = await harness.db
    .prepare(`SELECT id, event_type, occurred_at, idempotency_key FROM events ORDER BY id`)
    .all();
  assert.deepEqual(after, seeded, 'same rows, same ids, same order - not merely the same count');
  const snapshot = await harness.db
    .prepare(`SELECT code, uses FROM invite_snapshots WHERE guild_id = ?`)
    .get(GUILD);
  assert.deepEqual({ ...snapshot }, { code: 'qa-restore', uses: 7 });
});
