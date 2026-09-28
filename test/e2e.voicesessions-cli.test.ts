/**
 * TOG-6481: `scripts/voice-sessions.ts` (`npm run voice`) acceptance test on fixtures.
 *
 * The gap this closes: as of the 2026-09-27 scan no test file referenced the
 * script at all. `test/unit.voiceduration.test.ts` and
 * `test/unit.voiceblindwindow.test.ts` pin the shared helpers in
 * `src/core/voiceSessions.ts`, but nothing pinned the script itself - its SQL,
 * its `DISCORD_GUILD_ID` / `TWO_DATABASE_URL` wiring, or the numbers it prints.
 * A query that forgot `startKnown` (or an average that included the unknown
 * starts) would stay green.
 *
 * So this runs the real script as a subprocess against a seeded Postgres
 * schema (same shape as `test/e2e.funnel-json.test.ts`) and asserts end to end:
 *
 *   paired sessions: two known-start joins with matching ends average to
 *     (600 + 1800) / 2 = 1200s, printed as `20m over 2 measured session(s)`.
 *   orphan starts: a start row with no end at all still counts as a session
 *     (4 starts -> `4 sessions`), while contributing no duration.
 *   startKnown:false exclusion: two unknown-start ends - one with no duration,
 *     one carrying a number (unproven, still excluded) - are counted in the
 *     `2 unknown-start session(s) excluded` tally and attributed to the blind
 *     window, never averaged.
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
const SCRIPT = new URL('../scripts/voice-sessions.ts', import.meta.url).pathname;
const GUILD = '6481-voice-cli';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

let harness: TestDb;
let dbEnv: Record<string, string>;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  dbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
    DISCORD_GUILD_ID: GUILD,
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
 * One small guild exercising every line under test:
 *
 *   m1  two starts with two known ends (600s, 1800s). The paired sessions.
 *   m2  one start, one end with startKnown:false and no duration - already in
 *       voice when the bot came back.
 *   m3  one start with NO end at all. The orphan start: still a session.
 *   m4  one end with startKnown:false but a numeric duration attached. The
 *       number is unproven (we never saw the start) so it stays out of the mean.
 *   hb  heartbeat-only rows (first_message: not voice, so they only extend the
 *       write series) at T-30..T-28 and T-18. The 8h gap between T-28 and T-20
 *       is the one blind window; both unknown ends fall at or after its start,
 *       so the reconcile attributes both to it.
 */
async function seedFixture(t0: number): Promise<{ windowStart: string; windowEnd: string }> {
  const db = harness.db;
  const T = (h: number) => t0 - h * HOUR;
  const insert = db.prepare(
    `INSERT INTO events (event_type, member_id, guild_id, occurred_at, recorded_at, source, metadata, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let k = 0;
  const key = () => `voice-cli-6481-${++k}`;
  const endMeta = (startKnown: boolean, startedAt: string | null, durationSeconds: number | null) =>
    JSON.stringify({ startKnown, startedAt, durationSeconds });

  for (const h of [30, 29, 28, 18]) {
    await insert.run('first_message', 'hb', GUILD, iso(T(h)), iso(T(h)), 'channel:general', null, key());
  }

  const m1s1 = T(25);
  const m1s2 = T(23);
  await insert.run('voice_session_start', 'm1', GUILD, iso(m1s1), iso(T(20)), 'channel:vc', null, key());
  await insert.run('voice_session_start', 'm1', GUILD, iso(m1s2), iso(T(20)), 'channel:vc', null, key());
  await insert.run(
    'voice_session_end',
    'm1',
    GUILD,
    iso(m1s1 + 600_000),
    iso(T(20)),
    'channel:vc',
    endMeta(true, iso(m1s1), 600),
    key(),
  );
  await insert.run(
    'voice_session_end',
    'm1',
    GUILD,
    iso(m1s2 + 1_800_000),
    iso(T(19)),
    'channel:vc',
    endMeta(true, iso(m1s2), 1800),
    key(),
  );

  await insert.run('voice_session_start', 'm2', GUILD, iso(T(22)), iso(T(20)), 'channel:vc', null, key());
  await insert.run(
    'voice_session_end',
    'm2',
    GUILD,
    iso(T(21.5)),
    iso(T(20)),
    'channel:vc',
    endMeta(false, null, null),
    key(),
  );

  await insert.run('voice_session_start', 'm3', GUILD, iso(T(21)), iso(T(20)), 'channel:vc', null, key());

  await insert.run(
    'voice_session_end',
    'm4',
    GUILD,
    iso(T(19)),
    iso(T(19)),
    'channel:vc',
    endMeta(false, null, 3600),
    key(),
  );

  return { windowStart: iso(T(28)), windowEnd: iso(T(20)) };
}

test('paired and orphan starts count as sessions; unknown starts never enter the average', async () => {
  await seedFixture(Date.now());
  const out = await cli([]);
  assert.equal(out.code, 0, out.stdout + out.stderr);

  // 4 start rows (m1 x2, m2, m3) across 3 members. m3's orphan start - no end
  // row at all - still counts: the script counts starts, it does not pair them.
  assert.match(out.stdout, /4\s+sessions/);
  assert.match(out.stdout, /3\s+distinct members/);
  assert.match(out.stdout, /2\s+came once and not again/);
  assert.match(out.stdout, /1\s+came 2-3 times/);

  // (600 + 1800) / 2 = 1200s = 20m over the 2 measured sessions. The two
  // unknown-start ends (one null, one WITH a number) are excluded by flag, and
  // the tally says so. A naive mean over all four ends would be 1350s.
  assert.ok(
    out.stdout.includes('20m over 2 measured session(s); 2 unknown-start session(s) excluded, counted below.'),
    'average line should cover known-start sessions only',
  );

  // The write series has real history for this guild, so the windows come from
  // heartbeats, not from the coarser starts fallback.
  assert.ok(!out.stdout.includes('windows derived from session starts'), 'no starts-fallback note');
});

test('the blind window is named with its unknown-start count', async () => {
  const { windowStart, windowEnd } = await seedFixture(Date.now());
  const out = await cli([]);
  assert.equal(out.code, 0, out.stdout + out.stderr);

  // One 8h window (T-28 -> T-20), both unknown ends at or after its start.
  // A count, never an average.
  assert.ok(
    out.stdout.includes(
      `Blind window ${windowStart} -> ${windowEnd} (8.0h gap): 2 session(s) with unknown start (counted, never averaged)`,
    ),
    'reconcile line should name the window with its count',
  );
});
