/**
 * TOG-6477 acceptance for scripts/dedupe-events.ts.
 *
 * unit.dedupe.test.ts covers the pure collapse rule; this covers the script
 * that mutates the append-only events log: seeded duplicate-prone rows in,
 * idempotent dedupe run, no over-deletion, and --dry-run writing nothing.
 *
 * Fixture (one synthetic guild, never live/staging):
 *   A join duplicate, seconds apart, different loggers  -> collapse to earliest
 *   B genuine rejoin, months apart                      -> both kept
 *   C same logger twice, seconds apart                 -> both kept
 *   D leave duplicate, seconds apart, different loggers -> collapse to earliest
 *   E two members, same second                         -> both kept
 *   F join + leave at the same instant                 -> both kept (separate types)
 *   G invite_click pair                                 -> untouched (out of scope)
 *
 * Seeded: 9 joins + 3 leaves + 2 clicks. After: 8 joins + 2 leaves + 2 clicks.
 *
 * Reproduce by hand (reviewer path): point TWO_DATABASE_URL at a scratch DB,
 * seed per seedFixture() below, run `node scripts/dedupe-events.ts --dry-run`
 * then `node scripts/dedupe-events.ts`, and compare the sha256 digest of
 * `SELECT id, event_type, member_id, guild_id, occurred_at, source FROM events
 *  ORDER BY id` before and after the second run - identical.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/dedupe-events.ts', import.meta.url).pathname;

// Synthetic guild id in the 700... range used by other fixtures. The script
// has no guild fence; the isolation here is the scratch schema, not the id.
const GUILD = '700000000000000001';

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

async function cli(args: string[]) {
  try {
    const result = await run('node', [SCRIPT, ...args], {
      cwd: REPO,
      env: { ...process.env, ...dbEnv },
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

async function seedFixture() {
  const rows: Array<[string, string, string, string, string, string | null, string]> = [
    // A: duplicate join, two loggers seconds apart.
    ['member_join', '900000000000000101', GUILD, '2025-07-06T21:20:57.662Z', 'backfill:log:join-leave-log', null, 'tog6477-a1'],
    ['member_join', '900000000000000101', GUILD, '2025-07-06T21:23:10.604Z', 'backfill:log:member-join', null, 'tog6477-a2'],
    // B: genuine rejoin months later, same logger.
    ['member_join', '900000000000000102', GUILD, '2024-01-01T10:00:00.000Z', 'backfill:log:member-join', null, 'tog6477-b1'],
    ['member_join', '900000000000000102', GUILD, '2024-06-01T10:00:00.000Z', 'backfill:log:member-join', null, 'tog6477-b2'],
    // C: one logger reporting twice is two reports, not a duplicate.
    ['member_join', '900000000000000103', GUILD, '2024-01-01T10:00:00.000Z', 'backfill:log:member-join', null, 'tog6477-c1'],
    ['member_join', '900000000000000103', GUILD, '2024-01-01T10:00:04.000Z', 'backfill:log:member-join', null, 'tog6477-c2'],
    // D: duplicate leave, two loggers seconds apart.
    ['member_leave', '900000000000000104', GUILD, '2025-07-06T21:20:57.662Z', 'backfill:log:join-leave-log', null, 'tog6477-d1'],
    ['member_leave', '900000000000000104', GUILD, '2025-07-06T21:21:02.662Z', 'backfill:log:member-leave', null, 'tog6477-d2'],
    // E: different people on the same second never merge.
    ['member_join', '900000000000000105', GUILD, '2025-07-06T21:20:57.000Z', 'backfill:log:a', null, 'tog6477-e1'],
    ['member_join', '900000000000000106', GUILD, '2025-07-06T21:20:57.000Z', 'backfill:log:b', null, 'tog6477-e2'],
    // F: a join and a leave at the same instant are different events.
    ['member_join', '900000000000000107', GUILD, '2025-07-06T21:20:57.000Z', 'backfill:log:a', null, 'tog6477-f1'],
    ['member_leave', '900000000000000107', GUILD, '2025-07-06T21:20:57.000Z', 'backfill:log:b', null, 'tog6477-f2'],
    // G: out of the script's scope; must survive untouched.
    ['invite_click', '900000000000000108', GUILD, '2025-07-06T21:20:57.000Z', 'backfill:log:a', null, 'tog6477-g1'],
    ['invite_click', '900000000000000108', GUILD, '2025-07-06T21:20:59.000Z', 'backfill:log:b', null, 'tog6477-g2'],
  ];
  const stmt = harness.db.prepare(
    `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) await stmt.run(...r);
}

async function digest(): Promise<string> {
  const rows = await harness.db
    .prepare(
      `SELECT id, event_type, member_id, guild_id, occurred_at, source FROM events ORDER BY id`,
    )
    .all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function countByType(): Promise<Map<string, number>> {
  const rows = await harness.db
    .prepare(`SELECT event_type, COUNT(*) AS n FROM events GROUP BY event_type`)
    .all<{ event_type: string; n: number }>();
  return new Map(rows.map((r) => [r.event_type, Number(r.n)]));
}

test('dry run reports the duplicates and writes nothing', { timeout: 60_000 }, async () => {
  await seedFixture();
  const beforeDigest = await digest();
  const beforeCounts = await countByType();
  assert.equal(beforeCounts.get('member_join'), 9);
  assert.equal(beforeCounts.get('member_leave'), 3);

  const result = await cli(['--dry-run']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /DRY RUN/);
  assert.match(result.output, /duplicate rows/);

  assert.equal(await digest(), beforeDigest, 'dry run must not write');
  assert.deepEqual(await countByType(), beforeCounts);
});

test('real run deletes exactly the copies, keeps the earliest, and is idempotent', { timeout: 120_000 }, async () => {
  await seedFixture();

  const first = await cli([]);
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, /member_join/);
  assert.match(first.output, /member_leave/);

  const counts = await countByType();
  assert.equal(counts.get('member_join'), 8, 'exactly one duplicate join removed');
  assert.equal(counts.get('member_leave'), 2, 'exactly one duplicate leave removed');
  assert.equal(counts.get('invite_click'), 2, 'out-of-scope rows untouched');

  // No over-deletion: the survivors are the earliest of each duplicate pair,
  // and every must-keep row is still present.
  const keptA = await harness.db
    .prepare(`SELECT occurred_at FROM events WHERE idempotency_key LIKE 'tog6477-a%' ORDER BY id`)
    .all<{ occurred_at: string }>();
  assert.deepEqual(
    keptA.map((r) => r.occurred_at),
    ['2025-07-06T21:20:57.662Z'],
  );
  const keptD = await harness.db
    .prepare(`SELECT occurred_at FROM events WHERE idempotency_key LIKE 'tog6477-d%' ORDER BY id`)
    .all<{ occurred_at: string }>();
  assert.deepEqual(
    keptD.map((r) => r.occurred_at),
    ['2025-07-06T21:20:57.662Z'],
  );
  for (const prefix of ['tog6477-b', 'tog6477-c', 'tog6477-e', 'tog6477-f', 'tog6477-g']) {
    const n = Number(
      (await harness.db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE idempotency_key LIKE '${prefix}%'`)
        .get<{ n: number }>())?.n,
    );
    assert.equal(n, 2, `${prefix} rows must all survive`);
  }

  // Idempotence: a second run deletes nothing and the digest is identical.
  const digestAfterFirst = await digest();
  const second = await cli([]);
  assert.equal(second.code, 0, second.output);
  assert.match(second.output, /deleted 0 rows/);
  assert.equal(await digest(), digestAfterFirst, 're-run on fixture yields an identical digest');
});
