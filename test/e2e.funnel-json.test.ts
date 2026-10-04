/**
 * TOG-5691: `npm run funnel -- --json` prints one JSON object whose counts
 * equal the human-readable report on the same fixtures.
 *
 * The failure this pins: a machine-readable flag computed from its own
 * queries drifts from the text report (or rots into invalid JSON), and the
 * dashboard stopgap starts quoting numbers no human can reproduce from the
 * report. Both renderers read one collected report object, so this test only
 * has to catch a future split - one run of each renderer over one fixture.
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
  // invite_campaigns is seed-shaped config, not test data, so the shared
  // truncate list leaves it alone - clear this file's row explicitly.
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

/**
 * One small community, two days ago, exercising every line both renderers
 * print: clicks, joins with an attribution spread (tracked invite, unknown,
 * ambiguous), gate clearings, first message, first voice, a leave, a tracked
 * campaign, and a retention cohort old enough for D1 but not D7.
 */
async function seedFixture(): Promise<void> {
  const db = harness.db;
  const t0 = Date.now() - 2 * DAY;

  const event = db.prepare(
    `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let k = 0;
  const key = () => `funnel-json-${++k}`;
  // 3 clicks on the tracked link.
  for (let i = 0; i < 3; i++) {
    await event.run('invite_click', null, GUILD, iso(t0 + i * 1000), 'invite:abc123', key());
  }
  // 4 joins: two on the tracked invite, one unattributable, one ambiguous.
  await event.run('member_join', '1001', GUILD, iso(t0), 'invite:abc123', key());
  await event.run('member_join', '1002', GUILD, iso(t0 + 60_000), 'invite:abc123', key());
  await event.run('member_join', '1003', GUILD, iso(t0 + 120_000), 'unknown', key());
  await event.run('member_join', '1004', GUILD, iso(t0 + 180_000), 'ambiguous:xxx+yyy', key());
  // The gate lets two of the four through.
  await event.run('gate_cleared', '1001', GUILD, iso(t0 + 240_000), 'gate', key());
  await event.run('gate_cleared', '1003', GUILD, iso(t0 + 300_000), 'gate', key());
  // Activation: A posts and voices, B posts only, D leaves.
  await event.run('first_message', '1001', GUILD, iso(t0 + 3600_000), 'channel:1', key());
  await event.run('first_message', '1002', GUILD, iso(t0 + 3700_000), 'channel:1', key());
  await event.run('first_voice_session', '1001', GUILD, iso(t0 + 7200_000), 'channel:2', key());
  await event.run('member_leave', '1004', GUILD, iso(t0 + DAY), 'unknown', key());

  const member = db.prepare(
    `INSERT INTO members (guild_id, member_id, joined_at, first_message_at, first_voice_at,
      last_active_at, left_at, gate_cleared_at, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // A: fully active, still around. C: cleared the gate, active later, never
  // posted - the never-posted line. D: left. B: posted once, quiet since.
  await member.run(GUILD, '1001', iso(t0), iso(t0 + 3600_000), iso(t0 + 7200_000), iso(Date.now()), null, iso(t0 + 240_000), 0);
  await member.run(GUILD, '1002', iso(t0), iso(t0 + 3700_000), null, iso(t0 + 12 * 3600_000), null, null, 0);
  await member.run(GUILD, '1003', iso(t0), null, null, iso(t0 + 36 * 3600_000), null, iso(t0 + 300_000), 0);
  await member.run(GUILD, '1004', iso(t0), null, null, iso(t0 + 2 * 3600_000), iso(t0 + DAY), null, 0);

  await db
    .prepare(
      `INSERT INTO invite_campaigns (slug, label, invite_code, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('test-link', 'Test listing', 'abc123', iso(t0));
}

function num(re: RegExp, text: string, label: string): number {
  const m = text.match(re);
  assert.ok(m, `text report should print ${label}`);
  return Number(m[1]);
}

test('--json parses and its counts equal the text output on fixtures', async () => {
  await seedFixture();

  const text = await cli([]);
  assert.equal(text.code, 0, text.stdout + text.stderr);

  const machine = await cli(['--json']);
  assert.equal(machine.code, 0, machine.stdout + machine.stderr);
  let report: Record<string, unknown>;
  assert.doesNotThrow(() => {
    report = JSON.parse(machine.stdout);
  }, 'stdout must be exactly one JSON object');
  const r = report! as {
    schema: number;
    windowDays: number;
    funnel: Record<string, number>;
    attribution: { bySource: Array<{ source: string; joins: number }>; ambiguous: number; unknown: number };
    campaigns: Array<{ slug: string; clicks: number; joins: number }>;
    voice: { firstVoiceSessions: number };
    retention: Array<{ day: number; retained: number; cohort: number }>;
    neverPosted: number;
    totalEvents: number;
  };
  assert.equal(r.schema, 1, 'schema version pins the dashboard stopgap contract');
  assert.equal(r.windowDays, 7);

  // Headline funnel counts, each read out of the text report independently.
  assert.equal(r.funnel.clicks, num(/invite clicks\s+(\d+)/, text.stdout, 'clicks'));
  assert.equal(r.funnel.joins, num(/joins\s+(\d+)\s+/, text.stdout, 'joins'));
  assert.equal(r.funnel.gateCleared, num(/cleared rules gate\s+(\d+)/, text.stdout, 'gate clearings'));
  assert.equal(r.funnel.firstMessage, num(/posted first message\s+(\d+)/, text.stdout, 'first messages'));
  assert.equal(r.funnel.firstVoice, num(/first voice session\s+(\d+)/, text.stdout, 'first voice'));
  assert.equal(r.funnel.leaves, num(/^  left\s+(\d+) leaves/m, text.stdout, 'leaves'));

  // The fixture's known values, so a passing test means the right numbers and
  // not two renderers agreeing on a wrong one.
  assert.deepEqual(
    { clicks: r.funnel.clicks, joins: r.funnel.joins, gate: r.funnel.gateCleared, msg: r.funnel.firstMessage, voice: r.funnel.firstVoice, leaves: r.funnel.leaves },
    { clicks: 3, joins: 4, gate: 2, msg: 2, voice: 1, leaves: 1 },
  );

  // Attribution split: per-source table plus the two honest-failure buckets.
  const bySource = new Map(r.attribution.bySource.map((s) => [s.source, s.joins]));
  assert.equal(bySource.get('invite:abc123'), 2);
  assert.equal(bySource.get('unknown'), 1);
  assert.equal(bySource.get('ambiguous:xxx+yyy'), 1);
  assert.equal(r.attribution.ambiguous, 1);
  assert.equal(r.attribution.unknown, 1);
  for (const [source, n] of bySource) {
    assert.ok(
      text.stdout.includes(source),
      `text report should name source ${source}`,
    );
    void n;
  }

  // Tracked campaign with the clicks and joins the text line prints.
  assert.equal(r.campaigns.length, 1);
  assert.equal(r.campaigns[0].slug, 'test-link');
  const camp = text.stdout.match(/test-link\s+(\d+) clicks\s+(\d+) joins/);
  assert.ok(camp, 'text report should print the tracked campaign line');
  assert.equal(r.campaigns[0].clicks, Number(camp[1]));
  assert.equal(r.campaigns[0].joins, Number(camp[2]));
  assert.deepEqual([r.campaigns[0].clicks, r.campaigns[0].joins], [3, 2]);

  // Voice stats ride on the first-voice count, not a second query.
  assert.equal(r.voice.firstVoiceSessions, r.funnel.firstVoice);

  // Retention: all four joined 2 days ago - inside D1's cohort, too recent
  // for D7/D30. A (2d active) and C (36h) retained; B (12h) and D (2h) not.
  const d1 = r.retention.find((x) => x.day === 1)!;
  assert.ok(d1, 'retention should carry D1');
  const textD1 = text.stdout.match(/D1\s+\(1 day\)\s+(\d+)\s+\/\s+(\d+)/);
  assert.ok(textD1, 'text report should print the D1 line');
  assert.equal(d1.retained, Number(textD1[1]));
  assert.equal(d1.cohort, Number(textD1[2]));
  assert.deepEqual([d1.retained, d1.cohort], [2, 4]);

  // Never-posted and the event total close out the report.
  assert.equal(r.neverPosted, num(/never posted.*: (\d+)/, text.stdout, 'never-posted'));
  assert.equal(r.neverPosted, 1, 'only C is present with no firsts');
  assert.equal(r.totalEvents, num(/Total events on file: (\d+)/, text.stdout, 'event total'));
});
