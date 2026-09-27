/**
 * TOG-5692: `scripts/dashboard.ts` acceptance test on fixtures.
 *
 * The failure this pins: the dashboard CLI drifts from what docs/DASHBOARD.md
 * promises - a documented panel goes missing, shows a wrong number, or renders
 * a confident zero where the doc says the page must say nothing - and nothing
 * fails because `test/unit.dashboard.test.ts` only calls `buildDashboard()`
 * directly, never the script with its flags, env wiring and HTML output.
 *
 * So this runs the real script as a subprocess against a seeded Postgres
 * schema (same shape as `test/e2e.funnel-json.test.ts`) and asserts every
 * documented panel end to end:
 *
 *   --json: this-week/last-week joins, weekly rows with net and set-aside,
 *     all-time sources with attribution flags, active7d/30d, the member
 *     headline (funnel source), overall D1/D7/D30, gate conversion, channel
 *     states in snapshot order, the anomaly list, and the honest caveats.
 *   HTML file: all six documented sections with the real numbers, the weekly
 *     and channel tables, the set-aside list, and the self-contained
 *     guarantee (no script/link/img/iframe, no outbound URL).
 *   console: the summary line after `--out` matches the JSON headlines.
 *   empty database: honest zero-states (null retention, `none` member
 *     source, guidance text) rather than invented numbers.
 *   missing TWO_DATABASE_URL: exit 1 with guidance, not a stack trace.
 *
 * Fixture times are relative to the run, and avoid every window in the real
 * ANOMALIES list, so `setAside` is 0 on every fixture week while the page
 * still lists the real windows under "Days that are set aside".
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { weekStart } from '../src/analytics/dashboard.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/dashboard.ts', import.meta.url).pathname;
const GUILD = '5692-dashboard-cli';

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
  };
});

after(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

interface CliEnv {
  TWO_DATA_DIR: string;
  /** Set for the missing-URL case only; otherwise the harness URL is used. */
  unsetDbUrl?: boolean;
}

async function cli(
  args: string[],
  env: CliEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...dbEnv, TWO_DATA_DIR: env.TWO_DATA_DIR };
  if (env.unsetDbUrl) delete childEnv.TWO_DATABASE_URL;
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env: childEnv });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function scratchDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dash-cli-'));
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * One small community exercising every documented panel:
 *
 *   m1  joined ~1h ago on Invite promo1, cleared the gate, posted. This
 *       week's join and the attributed-source proof.
 *   m2  joined 40d ago on Invite promo1, cleared, active now. Old-cohort
 *       retention and the second attributed join.
 *   m3  joined 40d ago via the backfill import, never cleared, still here,
 *       active now. The stuck-at-the-gate member and the unattributed bucket.
 *   m4  joined 40d ago source unknown, left 5d ago. Stayed counting and the
 *       unknown bucket. Its day-1 mark predates its leave, so it stayed AND
 *       was active at D1, but is gone by D7/D30.
 *
 * Returns the timestamps the assertions derive their expectations from, so a
 * Monday-midnight boundary never makes the test lie about which week m1 is in.
 */
async function seedFixture(nowMs: number): Promise<{
  joinAt: string;
  d40: string;
  d5: string;
  collectedAt: string;
}> {
  const db = harness.db;
  const joinAt = iso(nowMs - 3600_000);
  const d40 = iso(nowMs - 40 * DAY);
  const d5 = iso(nowMs - 5 * DAY);
  const d35 = iso(nowMs - 35 * DAY);
  const nowIso = iso(nowMs);

  const event = db.prepare(
    `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let k = 0;
  const key = () => `dash-cli-${++k}`;
  await event.run('member_join', 'm1', GUILD, joinAt, 'invite:promo1', key());
  await event.run('member_join', 'm2', GUILD, d40, 'invite:promo1', key());
  await event.run('member_join', 'm3', GUILD, d40, 'backfill:log:member-join', key());
  await event.run('member_join', 'm4', GUILD, d40, 'unknown', key());
  // Two live clearings set the watched-since; the backfill one is the roster
  // read that makes m3's missing clearing mean "stuck" rather than unknown.
  await event.run('gate_cleared', 'm1', GUILD, iso(nowMs - 55 * 60_000), 'gate', key());
  await event.run('gate_cleared', 'm2', GUILD, iso(nowMs - 40 * DAY + 3600_000), 'gate', key());
  await event.run('gate_cleared', 'm2', GUILD, iso(nowMs - 39 * DAY), 'backfill:roster', key());
  await event.run('first_message', 'm1', GUILD, iso(nowMs - 30 * 60_000), 'channel:c-alive', key());
  await event.run('first_message', 'm2', GUILD, iso(nowMs - 39 * DAY), 'channel:c-alive', key());
  await event.run('member_leave', 'm4', GUILD, d5, 'unknown', key());

  const member = db.prepare(
    `INSERT INTO members (guild_id, member_id, joined_at, join_source, gate_cleared_at,
      first_message_at, first_voice_at, last_active_at, left_at, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await member.run(GUILD, 'm1', joinAt, 'invite:promo1', iso(nowMs - 55 * 60_000), iso(nowMs - 30 * 60_000), null, nowIso, null, 0);
  await member.run(GUILD, 'm2', d40, 'invite:promo1', iso(nowMs - 40 * DAY + 3600_000), iso(nowMs - 39 * DAY), null, nowIso, null, 0);
  await member.run(GUILD, 'm3', d40, 'backfill:log:member-join', null, null, null, nowIso, null, 0);
  await member.run(GUILD, 'm4', d40, 'unknown', null, null, null, d35, d5, 0);

  return { joinAt, d40, d5, collectedAt: nowIso };
}

/** Snapshot with one alive, one quiet and one silent channel. Flat and nested
 *  (`audit`) shapes both appear, so the CLI's flattening is covered too. */
async function writeSnapshot(dir: string, collectedAt: string): Promise<void> {
  await writeFile(
    join(dir, 'server-audit-2026-09-27.json'),
    JSON.stringify({
      collected_at: collectedAt,
      channels: [
        {
          id: 'c-alive',
          name: 'general',
          parent_name: 'TWO',
          human_msgs_30d: 12,
          human_msgs_90d: 40,
          unique_humans_30d: 4,
          last_message_at: collectedAt,
          days_silent: 0,
        },
        {
          id: 'c-quiet',
          name: 'old-room',
          parent_name: 'TWO',
          audit: {
            channel_id: 'c-quiet',
            name: 'old-room',
            category: 'TWO',
            human_msgs_30d: 0,
            human_msgs_90d: 9,
            unique_humans_30d: 2,
            last_message_at: '2026-08-18T00:00:00.000Z',
            days_silent: 45,
          },
        },
        {
          id: 'c-silent',
          name: 'ghost',
          parent_name: 'TWO',
          human_msgs_30d: 0,
          human_msgs_90d: 0,
          unique_humans_30d: 0,
          last_message_at: '2025-01-01T00:00:00.000Z',
          days_silent: 400,
        },
      ],
    }),
    'utf8',
  );
}

interface DashboardJson {
  generatedAt: string;
  guildId: string | null;
  thisWeek: { start: string; joins: number; leaves: number; net: number };
  lastWeek: { start: string; joins: number; leaves: number; net: number };
  active7d: number;
  active30d: number;
  humansInServer: number;
  raidAccountsStillCounted: number;
  realHumans: number;
  memberCountSource: string;
  memberCountAsOf: string | null;
  joinedNeverSpoke: number;
  weeks: Array<{
    weekStart: string;
    joins: number;
    setAside: number;
    leaves: number;
    net: number;
    bySource: Array<{ source: string; label: string; unattributed: boolean; joins: number }>;
  }>;
  cohorts: Array<{
    weekStart: string;
    size: number;
    d1: { eligible: number; stayed: number; active: number } | null;
    d7: { eligible: number; stayed: number; active: number } | null;
    d30: { eligible: number; stayed: number; active: number } | null;
    gate: {
      observed: number;
      cleared: number;
      stuck: number;
      leftAtTheGate: number;
      unknowable: number;
    } | null;
  }>;
  retentionOverall: {
    d1: { eligible: number; stayed: number; active: number } | null;
    d7: { eligible: number; stayed: number; active: number } | null;
    d30: { eligible: number; stayed: number; active: number } | null;
  };
  gateOverall: {
    observed: number;
    cleared: number;
    stuck: number;
    leftAtTheGate: number;
    unknowable: number;
  } | null;
  sourcesAllTime: Array<{ source: string; label: string; unattributed: boolean; joins: number }>;
  channels: Array<{
    channelId: string;
    name: string;
    state: string;
    events30d: number;
    humanMsgs30d: number | null;
    humanMsgs90d: number | null;
  }>;
  channelSnapshotAt: string | null;
  caveats: string[];
  anomalies: Array<{ start: string; label: string; status: string }>;
}

async function jsonRun(dataDir: string): Promise<DashboardJson> {
  const out = await cli(['--json'], { TWO_DATA_DIR: dataDir });
  assert.equal(out.code, 0, out.stdout + out.stderr);
  let data: DashboardJson;
  assert.doesNotThrow(() => {
    data = JSON.parse(out.stdout);
  }, 'stdout must be exactly one JSON object');
  return data!;
}

test('--json reports every documented panel with the fixture numbers', async () => {
  const t0 = Date.now();
  const dir = await scratchDataDir();
  const { joinAt, d40, d5, collectedAt } = await seedFixture(t0);
  await writeSnapshot(dir, collectedAt);

  const d = await jsonRun(dir);
  assert.ok(!Number.isNaN(Date.parse(d.generatedAt)), 'generatedAt is a real timestamp');
  assert.equal(d.guildId, GUILD);

  // Joined this week: m1 joined an hour ago, which is this week unless the run
  // straddles Monday midnight - the expectation says which, not just "1".
  const m1ThisWeek = weekStart(joinAt) === weekStart(iso(t0));
  assert.equal(d.thisWeek.joins, m1ThisWeek ? 1 : 0);
  assert.equal(d.lastWeek.joins, m1ThisWeek ? 0 : 1);
  assert.equal(d.thisWeek.joins + d.lastWeek.joins, 1);

  // Weekly rows: the 40-day-old joins land together, the leave 5 days ago in
  // its own week, nothing set aside anywhere.
  const oldWeek = d.weeks.find((w) => w.weekStart === weekStart(d40))!;
  assert.ok(oldWeek, 'the week of the old joins is in range');
  assert.equal(oldWeek.joins, 3);
  assert.equal(oldWeek.setAside, 0);
  assert.equal(oldWeek.leaves, 0);
  assert.equal(oldWeek.net, 3);
  const leaveWeek = d.weeks.find((w) => w.weekStart === weekStart(d5))!;
  assert.ok(leaveWeek, 'the week of the leave is in range');
  assert.equal(leaveWeek.leaves, 1);
  for (const w of d.weeks) assert.equal(w.setAside, 0, `week ${w.weekStart} sets nothing aside`);

  // Where they came from: two attributed to the invite, one imported-history
  // bucket, one unknown - biggest first.
  assert.deepEqual(d.sourcesAllTime, [
    { label: 'Invite promo1', unattributed: false, joins: 2, source: 'invite:promo1' },
    {
      label: 'Before tracking (imported history)',
      unattributed: true,
      joins: 1,
      source: 'backfill:log:member-join',
    },
    { label: 'Unknown', unattributed: true, joins: 1, source: 'unknown' },
  ]);

  // Still here and active: m1/m2/m3 present and recently active; m4 left.
  // Only m3 never posted or spoke.
  assert.equal(d.active7d, 3);
  assert.equal(d.active30d, 3);
  assert.equal(d.joinedNeverSpoke, 1);
  assert.equal(d.humansInServer, 3);
  assert.equal(d.raidAccountsStillCounted, 0);
  assert.equal(d.realHumans, 3);
  assert.equal(d.memberCountSource, 'funnel');
  assert.equal(d.memberCountAsOf, null);

  // Retention: m1 is too new for any column; m2/m3/m4 form the old cohort.
  // m4 left 5 days after joining, so it stayed and was active at D1 only.
  assert.deepEqual(d.retentionOverall.d1, { eligible: 3, stayed: 3, active: 3 });
  assert.deepEqual(d.retentionOverall.d7, { eligible: 3, stayed: 3, active: 2 });
  assert.deepEqual(d.retentionOverall.d30, { eligible: 3, stayed: 3, active: 2 });
  const oldCohort = d.cohorts.find((c) => c.weekStart === weekStart(d40))!;
  assert.equal(oldCohort.size, 3);
  assert.deepEqual(oldCohort.d1, { eligible: 3, stayed: 3, active: 3 });
  assert.deepEqual(oldCohort.gate, { observed: 2, cleared: 1, stuck: 1, leftAtTheGate: 0, unknowable: 1 });
  const newCohort = d.cohorts.find((c) => c.weekStart === weekStart(joinAt))!;
  assert.equal(newCohort.size, 1);
  assert.equal(newCohort.d1, null, 'a days-old cohort has no D1 yet, not 0%');
  assert.deepEqual(newCohort.gate, { observed: 1, cleared: 1, stuck: 0, leftAtTheGate: 0, unknowable: 0 });

  // The gate: two cleared, m3 stuck at the door, m4 unknowable.
  assert.deepEqual(d.gateOverall, {
    observed: 3,
    cleared: 2,
    stuck: 1,
    leftAtTheGate: 0,
    unknowable: 1,
  });

  // Channels: alive / quiet / silent in snapshot order, with the funnel event
  // m1's first message landed on general.
  assert.equal(d.channelSnapshotAt, collectedAt);
  assert.deepEqual(
    d.channels.map((c) => [c.name, c.state]),
    [
      ['general', 'alive'],
      ['old-room', 'quiet'],
      ['ghost', 'silent'],
    ],
  );
  assert.equal(d.channels[0].events30d, 1, "m1's first message counts as life on general");

  // Days set aside: no fixture week hits a window, but the real windows are
  // listed rather than silently dropped.
  assert.ok(d.anomalies.length > 0, 'known windows are reported, not hidden');
  for (const a of d.anomalies) {
    assert.ok(a.start && a.label && (a.status === 'confirmed' || a.status === 'unconfirmed'));
  }

  // Caveats: the partial-history note is always there; the gate notes fire
  // because one member is unknowable and one is stuck right now.
  assert.ok(d.caveats.some((c) => c.includes('Activity history is partial')));
  assert.ok(d.caveats.some((c) => c.includes('before we started watching the gate')));
  assert.ok(d.caveats.some((c) => c.includes('are in the server right now')));
  assert.ok(
    !d.caveats.some((c) => c.includes('No join has an invite source yet')),
    'attributed joins silence the no-source caveat',
  );
});

test('the HTML file carries every documented section with the real numbers', async () => {
  const t0 = Date.now();
  const dir = await scratchDataDir();
  const { collectedAt } = await seedFixture(t0);
  await writeSnapshot(dir, collectedAt);

  const d = await jsonRun(dir);
  const outPath = join(dir, 'dashboard.html');
  const wrote = await cli(['--out', outPath], { TWO_DATA_DIR: dir });
  assert.equal(wrote.code, 0, wrote.stdout + wrote.stderr);
  assert.ok(wrote.stdout.includes(`wrote ${outPath}`));
  const html = await readFile(outPath, 'utf8');

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('TWO growth dashboard'));
  // The six documented sections, in the doc's own words.
  for (const section of [
    'The three questions',
    'How many joined, and when',
    'Where they came from',
    'How many are still here',
    'Which channels are alive',
    'What these numbers do not tell you',
  ]) {
    assert.ok(html.includes(section), `section missing: ${section}`);
  }

  // Real numbers, not a template: headline joins, the invite source, the
  // channels with life in them with their states, the set-aside list. The
  // silent channel is counted, not tabulated: the table lists alive+quiet
  // only, and the note names how many are silent.
  assert.ok(html.includes('Invite promo1'));
  assert.ok(html.includes('general'));
  assert.ok(html.includes('old-room'));
  assert.ok(html.includes('alive'));
  assert.ok(html.includes('quiet'));
  assert.ok(html.includes('Silent'));
  assert.ok(html.includes('silent for 90 days or more'));
  assert.ok(html.includes('Days that are set aside'));
  assert.ok(html.includes(collectedAt.slice(0, 10)), 'the snapshot date is on the page');

  // Self-contained: mailable, no outbound requests.
  assert.equal(/<(script|link|img|iframe)\b/i.test(html), false);
  assert.equal(/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, '')), false);

  // The console summary after the write matches the JSON headlines.
  const summary = `joined this week ${d.thisWeek.joins} joins · active last 7 days ${d.active7d} members · real members ${d.realHumans} members`;
  assert.ok(wrote.stdout.includes(summary), `console summary should read: ${summary}`);
});

test('an empty database renders honest zero-states, not zeros', async () => {
  const dir = await scratchDataDir();

  const d = await jsonRun(dir);
  assert.equal(d.thisWeek.joins, 0);
  assert.equal(d.memberCountSource, 'none');
  assert.equal(d.realHumans, 0);
  assert.equal(d.retentionOverall.d1, null);
  assert.equal(d.retentionOverall.d7, null);
  assert.equal(d.retentionOverall.d30, null);
  assert.equal(d.gateOverall, null);
  assert.deepEqual(d.channels, []);
  assert.equal(d.channelSnapshotAt, null);

  const outPath = join(dir, 'dashboard.html');
  const wrote = await cli(['--out', outPath], { TWO_DATA_DIR: dir });
  assert.equal(wrote.code, 0, wrote.stdout + wrote.stderr);
  const html = await readFile(outPath, 'utf8');
  assert.ok(html.includes('The three questions'));
  assert.ok(html.includes('No joins on record.'));
  assert.ok(html.includes('No channel activity data.'));
  assert.ok(html.includes('not measured yet'));
  assert.ok(
    wrote.stdout.includes('no members on record - run npm run backfill'),
    'the console names the next command instead of printing bare zeros',
  );
});

test('a missing TWO_DATABASE_URL exits 1 with guidance', async () => {
  const dir = await scratchDataDir();
  const out = await cli(['--json'], { TWO_DATA_DIR: dir, unsetDbUrl: true });
  assert.equal(out.code, 1);
  assert.match(out.stderr + out.stdout, /TWO_DATABASE_URL is not set/);
});
