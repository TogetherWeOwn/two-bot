/**
 * TOG-7194: funnel accuracy on seeded data - every reported number against a
 * hand-computed expectation.
 *
 * e2e.funnel-json.test.ts pins that the text and --json renderers agree with
 * each other. Agreement is not accuracy: both could quote the same wrong
 * number. This file seeds a small community whose every funnel number is
 * worked out by hand in the table below, runs the real scripts/funnel.ts
 * --json report over it, and asserts each field against the literal.
 *
 * Fixture (t0 = now - 2 days, GUILD constant below):
 *
 *   events:
 *     3x invite_click            (tracked link, source invite:abc123)
 *     5x member_join             1001, 1002 (invite:abc123), 1003 (unknown),
 *                                1004 (ambiguous:xxx+yyy), 1001 again (rejoin)
 *     2x gate_cleared            1001, 1003
 *     2x first_message           1001, 1002
 *     1x first_voice_session     1001
 *     1x member_leave            1004
 *     2x voice_session_end       1001 known 600s, 1001 unknown-start
 *   members:
 *     1001 active, gate cleared, last seen now (retained D1)
 *     1002 posted once, gate never cleared (stuck), quiet since t0+12h
 *     1003 cleared gate, active at t0+36h, never posted (never-posted line)
 *     1004 left at t0+1d
 *   invite_campaigns: one row (acc-link -> abc123)
 *
 * Hand-computed expectation (window = 7 days, everything above is inside):
 *
 *   clicks 3 | joins 5 (events) | joiners 4 (people: 1001 rejoined)
 *   gateCleared 2 (distinct) | stuckAtGate 1 (1002) | set-asides 0/0
 *   firstMessage 2 | firstVoice 1 | leaves 1
 *   bySource invite:abc123 3, unknown 1, ambiguous:xxx+yyy 1
 *   voice avg 600s over 1 measured, 1 unknown-start excluded
 *   retention D1 2/4 (1001, 1003), D7 0/0, D30 0/0 (cohort too young)
 *   neverPosted 1 (1003) | strandedRaid 0 | totalEvents 16
 *   downtime windows [] | clickSpikes [] (3 clicks < floor of 20)
 *   campaign acc-link: 3 clicks, 3 joins
 *
 * Mutation map (acceptance: one wrong seed value flips red):
 *   drop the rejoin        -> joins 4, bySource invite:abc123 2, campaign joins 2
 *   move 1003's join source-> unknown 0/2, ambiguous/bySource shift
 *   drop a gate_cleared    -> gateCleared 1, gate % 25%, stuckAtGate 2
 *   drop a first_message   -> firstMessage 1, msg % 20%
 *   change 600 to 601      -> avgSessionSeconds 601
 *   drop unknown-start end -> excludedUnknownStarts 0
 *   move 1003 last_active  -> D1 retained 1, neverPosted unchanged (still reds D1)
 *   drop the leave          -> leaves 0, totalEvents 15, 1004 still left in members
 *   any extra/missing event-> totalEvents != 16
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/funnel.ts', import.meta.url).pathname;
const GUILD = '1545644954272137297';

const DAY = 86_400_000;
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

let harness: TestDb;
let dbEnv: Record<string, string>;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  dbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
    // TOG-8738: the funnel report is scoped to one guild and fails fast
    // without it. The fixture seeds GUILD, so this is the server reported on.
    DISCORD_GUILD_ID: GUILD,
  };
});

after(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await harness.reset();
  await harness.db.exec(`DELETE FROM invite_campaigns`);
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

async function seedFixture(): Promise<void> {
  const db = harness.db;
  const t0 = Date.now() - 2 * DAY;

  const event = db.prepare(
    `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let k = 0;
  const key = () => `funnel-accuracy-${++k}`;
  const meta = (v: unknown) => JSON.stringify(v);

  for (let i = 0; i < 3; i++) {
    await event.run('invite_click', null, GUILD, iso(t0 + i * 1000), 'invite:abc123', null, key());
  }
  await event.run('member_join', '1001', GUILD, iso(t0), 'invite:abc123', null, key());
  await event.run('member_join', '1002', GUILD, iso(t0 + 60_000), 'invite:abc123', null, key());
  await event.run('member_join', '1003', GUILD, iso(t0 + 120_000), 'unknown', null, key());
  await event.run('member_join', '1004', GUILD, iso(t0 + 180_000), 'ambiguous:xxx+yyy', null, key());
  // Rejoin: the events/people split the gate rate depends on.
  await event.run('member_join', '1001', GUILD, iso(t0 + 240_000), 'invite:abc123', null, key());
  await event.run('gate_cleared', '1001', GUILD, iso(t0 + 300_000), 'gateway', null, key());
  await event.run('gate_cleared', '1003', GUILD, iso(t0 + 360_000), 'gateway', null, key());
  await event.run('first_message', '1001', GUILD, iso(t0 + HOUR), 'channel:1', null, key());
  await event.run('first_message', '1002', GUILD, iso(t0 + 70 * 60_000), 'channel:1', null, key());
  await event.run('first_voice_session', '1001', GUILD, iso(t0 + 2 * HOUR), 'channel:2', null, key());
  await event.run('member_leave', '1004', GUILD, iso(t0 + DAY), 'unknown', null, key());
  await event.run(
    'voice_session_end',
    '1001',
    GUILD,
    iso(t0 + 3 * HOUR),
    'channel:2',
    meta({ startKnown: true, durationSeconds: 600 }),
    key(),
  );
  await event.run(
    'voice_session_end',
    '1001',
    GUILD,
    iso(t0 + 4 * HOUR),
    'channel:2',
    meta({ startKnown: false, durationSeconds: null }),
    key(),
  );

  const member = db.prepare(
    `INSERT INTO members (guild_id, member_id, joined_at, first_message_at, first_voice_at,
      last_active_at, left_at, gate_cleared_at, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = iso(Date.now());
  await member.run(GUILD, '1001', iso(t0), iso(t0 + HOUR), iso(t0 + 2 * HOUR), now, null, iso(t0 + 300_000), 0);
  await member.run(GUILD, '1002', iso(t0), iso(t0 + 70 * 60_000), null, iso(t0 + 12 * HOUR), null, null, 0);
  await member.run(GUILD, '1003', iso(t0), null, null, iso(t0 + 36 * HOUR), null, iso(t0 + 360_000), 0);
  await member.run(GUILD, '1004', iso(t0), null, null, iso(t0 + 2 * HOUR), iso(t0 + DAY), null, 0);

  await db
    .prepare(
      `INSERT INTO invite_campaigns (slug, label, invite_code, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('acc-link', 'Accuracy listing', 'abc123', iso(t0));
}

interface FunnelReport {
  schema: number;
  windowDays: number;
  funnel: Record<string, number>;
  attribution: { bySource: Array<{ source: string; joins: number }>; ambiguous: number; unknown: number };
  downtime: { windows: unknown[]; unknownInWindow: number };
  campaigns: Array<{ slug: string; clicks: number; joins: number }>;
  clickSpikes: unknown[];
  voice: { firstVoiceSessions: number; avgSessionSeconds: number | null; measuredSessions: number; excludedUnknownStarts: number };
  retention: Array<{ day: number; retained: number; cohort: number }>;
  neverPosted: number;
  strandedRaid: number;
  totalEvents: number;
}

async function jsonReport(): Promise<FunnelReport> {
  await seedFixture();
  const machine = await cli(['--json']);
  assert.equal(machine.code, 0, machine.stdout + machine.stderr);
  let report: FunnelReport | undefined;
  assert.doesNotThrow(() => {
    report = JSON.parse(machine.stdout) as FunnelReport;
  }, 'stdout must be exactly one JSON object');
  return report!;
}

test('--json funnel counts equal the hand-computed expectations', async () => {
  const r = await jsonReport();
  assert.equal(r.schema, 1);
  assert.equal(r.windowDays, 7);

  // Events vs people: 5 join events from 4 joiners (1001 rejoined).
  assert.deepEqual(
    {
      clicks: r.funnel.clicks,
      joins: r.funnel.joins,
      joinsSetAside: r.funnel.joinsSetAside,
      gateCleared: r.funnel.gateCleared,
      joiners: r.funnel.joiners,
      stuckAtGate: r.funnel.stuckAtGate,
      firstMessage: r.funnel.firstMessage,
      firstVoice: r.funnel.firstVoice,
      leaves: r.funnel.leaves,
      leavesSetAside: r.funnel.leavesSetAside,
    },
    {
      clicks: 3,
      joins: 5,
      joinsSetAside: 0,
      gateCleared: 2,
      joiners: 4,
      stuckAtGate: 1,
      firstMessage: 2,
      firstVoice: 1,
      leaves: 1,
      leavesSetAside: 0,
    },
  );

  const bySource = new Map(r.attribution.bySource.map((s) => [s.source, s.joins]));
  assert.deepEqual(Object.fromEntries(bySource), {
    'invite:abc123': 3,
    unknown: 1,
    'ambiguous:xxx+yyy': 1,
  });
  assert.equal(r.attribution.ambiguous, 1);
  assert.equal(r.attribution.unknown, 1);

  // Dense write series: no blind windows, nothing downtime-unknown.
  assert.deepEqual(r.downtime.windows, []);
  assert.equal(r.downtime.unknownInWindow, 0);
  assert.deepEqual(r.clickSpikes, []);

  assert.equal(r.campaigns.length, 1);
  assert.deepEqual(
    { slug: r.campaigns[0].slug, clicks: r.campaigns[0].clicks, joins: r.campaigns[0].joins },
    { slug: 'acc-link', clicks: 3, joins: 3 },
  );

  // Known-start 600s end averaged; unknown-start end counted, never averaged.
  assert.deepEqual(
    {
      first: r.voice.firstVoiceSessions,
      avg: r.voice.avgSessionSeconds,
      measured: r.voice.measuredSessions,
      excluded: r.voice.excludedUnknownStarts,
    },
    { first: 1, avg: 600, measured: 1, excluded: 1 },
  );

  // D1 2/4 (1001 active now, 1003 at +36h); D7/D30 cohorts too young to exist.
  assert.deepEqual(
    r.retention.map((x) => [x.day, x.retained, x.cohort]),
    [
      [1, 2, 4],
      [7, 0, 0],
      [30, 0, 0],
    ],
  );

  assert.equal(r.neverPosted, 1, 'only 1003 is present with no firsts');
  assert.equal(r.strandedRaid, 0);
  assert.equal(r.totalEvents, 16, '3 clicks + 5 joins + 2 gate + 2 msg + 1 voice + 1 leave + 2 ends');
});

test('raid-day tracked-source join is set aside in headline and campaign counts', async () => {
  await seedFixture();
  // One raid-day join attributed to the tracked campaign. 2025-07-06 is a
  // listed member_join anomaly window, so the headline counts set it aside;
  // TOG-8446 pinned the per-campaign subquery counting it anyway, letting
  // campaign joins exceed headline joins inside one report.
  await harness.db
    .prepare(
      `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('member_join', '9001', GUILD, '2025-07-06T20:45:00.000Z', 'invite:abc123', null, 'funnel-accuracy-raid-day');

  // Window wide enough to cover the raid day (default 7 days would not).
  const machine = await cli(['3650', '--json']);
  assert.equal(machine.code, 0, machine.stdout + machine.stderr);
  const r = JSON.parse(machine.stdout) as FunnelReport;

  assert.equal(r.windowDays, 3650);
  // Headline: the 5 real joins counted, the raid-day row set aside.
  assert.equal(r.funnel.joins, 5);
  assert.equal(r.funnel.joinsSetAside, 1);
  // Where-joins-came-from agrees with the headline.
  const bySource = new Map(r.attribution.bySource.map((s) => [s.source, s.joins]));
  assert.equal(bySource.get('invite:abc123'), 3);
  // Campaign table must agree too - pre-fix it counted 4 here.
  assert.equal(r.campaigns.length, 1);
  assert.deepEqual(
    { slug: r.campaigns[0].slug, clicks: r.campaigns[0].clicks, joins: r.campaigns[0].joins },
    { slug: 'acc-link', clicks: 3, joins: 3 },
  );
  assert.equal(r.totalEvents, 17);
});

test('a second guild in the same database does not leak into the report', async () => {
  await seedFixture();
  // TOG-8738: a staging DB with fixtures for two guilds must report only the
  // DISCORD_GUILD_ID guild. Mirror every fixture row under a foreign guild -
  // equal size, so any unscoped query visibly doubles the report.
  const OTHER_GUILD = '999999999999999001';
  const db = harness.db;
  const rows = await db
    .prepare(`SELECT event_type, member_id, occurred_at, source, metadata FROM events`)
    .all<{ event_type: string; member_id: string | null; occurred_at: string; source: string; metadata: string | null }>();
  const idem = db.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE idempotency_key LIKE 'funnel-accuracy-%'`,
  );
  const seededKeys = Number((await idem.get<{ n: number }>())?.n ?? 0);
  const insEvent = db.prepare(
    `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    await insEvent.run(r.event_type, r.member_id, OTHER_GUILD, r.occurred_at, r.source, r.metadata, `funnel-accuracy-other-${i}`);
  }
  const members = await db
    .prepare(`SELECT member_id, joined_at, first_message_at, first_voice_at, last_active_at, left_at, gate_cleared_at, is_bot FROM members`)
    .all<{
      member_id: string; joined_at: string | null; first_message_at: string | null;
      first_voice_at: string | null; last_active_at: string | null; left_at: string | null;
      gate_cleared_at: string | null; is_bot: number;
    }>();
  const insMember = db.prepare(
    `INSERT INTO members (guild_id, member_id, joined_at, first_message_at, first_voice_at,
      last_active_at, left_at, gate_cleared_at, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of members) {
    await insMember.run(
      OTHER_GUILD, m.member_id, m.joined_at, m.first_message_at, m.first_voice_at,
      m.last_active_at, m.left_at, m.gate_cleared_at, m.is_bot,
    );
  }
  assert.equal(seededKeys, 16, 'precondition: the fixture seeds 16 keyed events');

  const machine = await cli(['--json']);
  assert.equal(machine.code, 0, machine.stdout + machine.stderr);
  const r = JSON.parse(machine.stdout) as FunnelReport;

  // Identical hand-computed expectations as the single-guild test above: the
  // foreign guild's mirror rows must not move a single number.
  assert.deepEqual(
    {
      clicks: r.funnel.clicks,
      joins: r.funnel.joins,
      gateCleared: r.funnel.gateCleared,
      joiners: r.funnel.joiners,
      stuckAtGate: r.funnel.stuckAtGate,
      firstMessage: r.funnel.firstMessage,
      firstVoice: r.funnel.firstVoice,
      leaves: r.funnel.leaves,
      neverPosted: r.neverPosted,
      totalEvents: r.totalEvents,
    },
    {
      clicks: 3,
      joins: 5,
      gateCleared: 2,
      joiners: 4,
      stuckAtGate: 1,
      firstMessage: 2,
      firstVoice: 1,
      leaves: 1,
      neverPosted: 1,
      totalEvents: 16,
    },
  );
  assert.deepEqual(
    r.retention.map((x) => [x.day, x.retained, x.cohort]),
    [
      [1, 2, 4],
      [7, 0, 0],
      [30, 0, 0],
    ],
  );
});

test('text report prints the same hand-computed numbers', async () => {
  await seedFixture();
  const text = await cli([]);
  assert.equal(text.code, 0, text.stdout + text.stderr);

  // Headline counts with hand-computed rates pinning the denominators:
  // joins 5 over 3 clicks (167%), gate 2 of 4 joiners (50%), msg 2 of 5 (40%).
  assert.match(text.stdout, /invite clicks\s+3 clicks/);
  assert.match(text.stdout, /joins\s+5 joins\s+167% of clicks/);
  assert.match(text.stdout, /\(>100%: some invites are posted as raw discord\.gg links\)/);
  assert.match(text.stdout, /cleared rules gate\s+2 members\s+50% of joiners/);
  assert.match(text.stdout, /posted first message\s+2 members\s+40% of joins/);
  assert.match(text.stdout, /first voice session\s+1 members\s+20% of joins/);
  assert.match(text.stdout, /^  left\s+1 leaves/m);
  assert.match(text.stdout, /1 members in the server right now, never accepted the rules/);

  // Voice average names the measured session and the excluded unknown start.
  assert.match(text.stdout, /avg voice session\s+10m avg/);
  assert.match(text.stdout, /over 1 measured, 1 unknown-start excluded/);

  // Attribution, retention, campaign and closing lines.
  assert.match(text.stdout, /3 joins  invite:abc123/);
  assert.match(text.stdout, /D1\s+\(1 day\)\s+2 \/ 4\s+retained\s+50%/);
  assert.match(text.stdout, /acc-link\s+3 clicks\s+3 joins/);
  assert.match(text.stdout, /Joined but never posted.*: 1 members/);
  assert.match(text.stdout, /Total events on file: 16 events/);
});
