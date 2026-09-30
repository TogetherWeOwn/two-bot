/**
 * TOG-9993: `scripts/voice-reconcile.ts` (`npm run voice:reconcile`) idempotency
 * proof on fixtures.
 *
 * The gap this closes (round-5 gap list C8): the sweep had pairing tests and a
 * read-only test over a fake, but nothing proved a second run over the same
 * rows changes nothing. A future write path (backfill inserts, "mark reviewed"
 * flags) or unstable output (timestamps of now, unordered rows) would stay
 * green while every re-run drifted.
 *
 * So this seeds one small guild exercising every reconcile path, runs the real
 * script twice as a subprocess against a seeded Postgres schema (same shape as
 * `test/e2e.voicesessions-cli.test.ts`), and asserts end to end:
 *
 *   output stability: both runs exit 0 and print byte-identical reports -
 *     3 resolved (restart-gap, server-leave, metadata-recompute),
 *     4 flagged (still-open, superseded + still-open, no-start-on-file),
 *     1 complete counted, never listed.
 *   store stability: the `events` table is identical before the first run and
 *     after the second - the sweep has no write path to get wrong, twice.
 *
 * Fixtures/scratch DB only. No live Discord, no live guild writes.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/voice-reconcile.ts', import.meta.url).pathname;
const GUILD = '9993-voice-reconcile-idem';

let harness: TestDb;
let dbEnv: Record<string, string>;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  dbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };
});

after(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env: { ...process.env, ...dbEnv } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/**
 * One small guild exercising every reconcile path, on fixed timestamps so the
 * report is deterministic across runs:
 *
 *   m1  restart loss: start + unknown-start end -> resolved restart-gap, 3600s.
 *   m2  pre-TOG-6122 server leave: start + member_leave, no end ->
 *       resolved server-leave, 600s.
 *   m3  bad end row: known-start end with null duration but a valid
 *       startedAt -> resolved metadata-recompute, 1800s.
 *   m4  lone start -> flagged still-open.
 *   m5  two starts, no end -> first superseded, second still-open.
 *   m6  unknown-start end with no start anywhere -> flagged no-start-on-file.
 *   m7  start + clean known end -> complete (counted, never listed).
 */
async function seedFixture(): Promise<void> {
  const db = harness.db;
  const insert = db.prepare(
    `INSERT INTO events (event_type, member_id, guild_id, occurred_at, recorded_at, source, metadata, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let k = 0;
  const key = () => `voice-reconcile-idem-9993-${++k}`;
  const rec = '2026-09-20T19:00:00.000Z';
  const endMeta = (startKnown: boolean, startedAt: string | null, durationSeconds: number | null) =>
    JSON.stringify({ startKnown, startedAt, durationSeconds });

  await insert.run('voice_session_start', 'm1', GUILD, '2026-09-20T10:00:00.000Z', rec, 'channel:vc', null, key());
  await insert.run(
    'voice_session_end',
    'm1',
    GUILD,
    '2026-09-20T11:00:00.000Z',
    rec,
    'channel:vc',
    endMeta(false, null, null),
    key(),
  );

  await insert.run('voice_session_start', 'm2', GUILD, '2026-09-20T12:00:00.000Z', rec, 'channel:vc', null, key());
  await insert.run('member_leave', 'm2', GUILD, '2026-09-20T12:10:00.000Z', rec, 'unknown', null, key());

  await insert.run(
    'voice_session_end',
    'm3',
    GUILD,
    '2026-09-20T13:30:00.000Z',
    rec,
    'channel:vc',
    endMeta(true, '2026-09-20T13:00:00.000Z', null),
    key(),
  );

  await insert.run('voice_session_start', 'm4', GUILD, '2026-09-20T14:00:00.000Z', rec, 'channel:vc', null, key());

  await insert.run('voice_session_start', 'm5', GUILD, '2026-09-20T15:00:00.000Z', rec, 'channel:ch-a', null, key());
  await insert.run('voice_session_start', 'm5', GUILD, '2026-09-20T16:00:00.000Z', rec, 'channel:ch-b', null, key());

  await insert.run(
    'voice_session_end',
    'm6',
    GUILD,
    '2026-09-20T17:00:00.000Z',
    rec,
    'channel:vc',
    endMeta(false, null, null),
    key(),
  );

  await insert.run('voice_session_start', 'm7', GUILD, '2026-09-20T18:00:00.000Z', rec, 'channel:vc', null, key());
  await insert.run(
    'voice_session_end',
    'm7',
    GUILD,
    '2026-09-20T18:30:00.000Z',
    rec,
    'channel:vc',
    endMeta(true, '2026-09-20T18:00:00.000Z', 1800),
    key(),
  );
}

type Snapshot = Array<{
  event_type: string;
  member_id: string | null;
  guild_id: string;
  occurred_at: string;
  source: string;
  metadata: string | null;
}>;

async function snapshotEvents(): Promise<Snapshot> {
  return harness.db
    .prepare(
      `SELECT event_type, member_id, guild_id, occurred_at, source, metadata FROM events ORDER BY id`,
    )
    .all<Snapshot[number]>();
}

test(
  'double live run prints byte-identical reports resolving every open half',
  { timeout: 120_000 },
  async () => {
    await seedFixture();

    const first = await cli([]);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const second = await cli([]);
    assert.equal(second.code, 0, second.stdout + second.stderr);

    // Idempotent output: the second run over the same rows reads back the
    // same report, byte for byte - no run-time timestamps, no row-order
    // drift for a future write path to hide behind.
    assert.equal(second.stdout, first.stdout, 'second run output must equal the first');

    // The fixture's known values, so a passing test means the right report
    // and not two runs agreeing on a wrong one.
    assert.match(first.stdout, /Resolved with a duration \(3\):/);
    assert.match(first.stdout, /restart-gap/);
    assert.match(first.stdout, /server-leave/);
    assert.match(first.stdout, /metadata-recompute/);
    assert.match(first.stdout, /Unresolvable with a reason \(4\):/);
    assert.match(first.stdout, /reason=still-open/);
    assert.match(first.stdout, /reason=superseded/);
    assert.match(first.stdout, /reason=no-start-on-file/);
    assert.match(first.stdout, /1 complete session\(s\) with clean durations \(not listed\)/);
  },
);

test(
  'double live run writes nothing: the events table is unchanged',
  { timeout: 120_000 },
  async () => {
    await seedFixture();
    const beforeRows = await snapshotEvents();
    assert.equal(beforeRows.length, 11, 'the fixture seeds exactly 11 event rows');

    assert.equal((await cli([])).code, 0);
    const betweenRows = await snapshotEvents();
    assert.deepEqual(betweenRows, beforeRows, 'the first run must not write');

    assert.equal((await cli([])).code, 0);
    assert.deepEqual(await snapshotEvents(), beforeRows, 'the second run must not write either');
  },
);
