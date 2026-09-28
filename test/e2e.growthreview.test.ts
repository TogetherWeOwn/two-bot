/**
 * Growth-review CLI acceptance on an isolated Postgres schema, not live guilds.
 * Run: TWO_TEST_DATABASE_URL=<scratch DB> node --test test/e2e.growthreview.test.ts
 * Each case seeds the database and effort file, then invokes `npm run review`.
 *
 * At the fixed review date all nine joins have matured: DISBOARD produces three
 * AM30 on 8h; DISCADIA produces zero on 4h over four weeks. The golden pins the
 * scores, kill citation, scale winner, allocation warnings and paid-ask boundary.
 * The gate stays red; these outputs are scaffolding, never actual growth findings.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Assessment } from '../src/growth/portfolio.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/growth-review-golden.json', import.meta.url), 'utf8'),
) as Golden;
const GUILD = '700000000000000003';
const REVIEWED_AT = '2026-10-26T00:00:00.000Z';
// Test-only preload: no production clock override or wall-clock-dependent cohorts.
const CLOCK = `data:text/javascript,${encodeURIComponent(`Date.now = () => ${Date.parse(REVIEWED_AT)};`)}`;
const WEEKS = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
const DAY = 86_400_000;

let harness: TestDb | undefined;
let scratch: string;
let effortFile: string;
let cliEnv: NodeJS.ProcessEnv;

before(async () => {
  harness = await openTestDb(`growthreview_${process.pid}`);
  scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'growth-review-'));
  effortFile = join(scratch, 'effort.json');
  const url = new URL(process.env.TWO_TEST_DATABASE_URL!);
  // URL options win over inherited PGOPTIONS, including URLs with their own options.
  url.searchParams.set('options', `-c search_path=${harness.schema}`);
  cliEnv = {
    PATH: process.env.PATH,
    HOME: scratch,
    TWO_DATABASE_URL: url.toString(),
    TWO_EFFORT_FILE: effortFile,
    NODE_OPTIONS: `--import=${CLOCK}`,
  };
});

after(async () => {
  try {
    await harness?.cleanup();
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
});

function effort() {
  return {
    weeks: WEEKS.flatMap((weekStart) => [
      { channelId: 'LIST-DISCADIA', weekStart, agentHours: 1, cashPence: 0 },
      { channelId: 'LIST-DISBOARD-A', weekStart, agentHours: 2, cashPence: 0 },
    ]),
  };
}

beforeEach(async () => {
  await harness!.reset();
  writeFileSync(effortFile, JSON.stringify(effort()));
  // This campaign table is not part of the shared harness's truncate list.
  await harness!.db.exec('DELETE FROM invite_campaigns');
  for (const [slug, code] of [['list-disboard-a', 'qa-disboard-a'], ['list-discadia', 'qa-discadia']]) {
    await harness!.db.prepare(
      'INSERT INTO invite_campaigns (slug, invite_code, label, created_at) VALUES (?, ?, ?, ?)',
    ).run(slug, code, `QA ${slug}`, '2026-08-01T00:00:00.000Z');
  }
  for (let i = 0; i < 9; i++) {
    const producer = i < 3;
    const week = producer ? i : [0, 1, 1, 2, 2, 3][i - 3]!;
    const joinedAt = `${WEEKS[week]}T12:00:00.000Z`;
    const memberId = String(90000000000000081n + BigInt(i));
    const source = producer ? 'invite:qa-disboard-a' : 'invite:qa-discadia';
    await harness!.db.prepare(
      `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
       VALUES ('member_join', ?, ?, ?, ?, ?, ?)`,
    ).run(memberId, GUILD, joinedAt, source, '{"attribution_exact":true}', `growth-review-${i}`);
    await harness!.db.prepare(
      `INSERT INTO members (guild_id, member_id, joined_at, join_source, first_voice_at, last_active_at, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, FALSE)`,
    ).run(
      GUILD, memberId, joinedAt, source,
      producer ? new Date(Date.parse(joinedAt) + DAY).toISOString() : null,
      producer ? new Date(Date.parse(joinedAt) + 20 * DAY).toISOString() : null,
    );
  }
});

async function cli(args: string[]) {
  try {
    const result = await run('npm', ['run', 'review', '--', ...args], {
      cwd: REPO, env: cliEnv, timeout: 30_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    // Spawn errors and timeouts are infrastructure failures, not gate refusals.
    if (typeof err.code !== 'number' || err.killed) throw error;
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

interface ReviewJson {
  reviewedAt: string;
  windowWeeks: number;
  gate: string;
  scoringLoopRuns: boolean;
  findingsAreValid: boolean;
  effortProblem: string | null;
  assessments: Assessment[];
  ranking: { ordered: Assessment[]; scale: Assessment | null; blockers: unknown[] };
  allocation: { findings: string[] };
  paid: { earned: boolean; qualifying: string[]; detail: string };
}

interface Golden {
  _comment: string;
  windowWeeks: number;
  gate: string;
  scoringLoopRuns: boolean;
  findingsAreValid: boolean;
  effortProblem: string | null;
  verdicts: Record<string, string>;
  reasons: Record<string, string>;
  scores: Record<string, Assessment['cost'] & { costIsHard: boolean }>;
  scale: string;
  rankBlockers: unknown[];
  allocationFindings: string[];
  paidEarned: boolean;
  paidQualifying: string[];
  paidDetail: string;
}

function parseJson(stdout: string): ReviewJson {
  // npm writes a script banner before the JSON. stderr is kept separate.
  return JSON.parse(stdout.slice(stdout.indexOf('{'))) as ReviewJson;
}

function assessmentOf(json: ReviewJson, channelId: string) {
  const assessment = json.assessments.find((a) => a.channelId === channelId);
  assert.ok(assessment, `expected a ${channelId} assessment`);
  return assessment;
}

test('the fixture pins the golden score table and kill/scale citations', { timeout: 60_000 }, async () => {
  const result = await cli(['--force', '--json', '--weeks', '8']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const json = parseJson(result.stdout);
  assert.equal(json.reviewedAt, REVIEWED_AT);
  assert.equal(json.windowWeeks, GOLDEN.windowWeeks);
  assert.equal(json.gate, GOLDEN.gate);
  assert.equal(json.scoringLoopRuns, GOLDEN.scoringLoopRuns);
  assert.equal(json.findingsAreValid, GOLDEN.findingsAreValid);
  assert.equal(json.effortProblem, GOLDEN.effortProblem);
  assert.equal(json.assessments.length, Object.keys(GOLDEN.verdicts).length);
  assert.deepEqual(Object.fromEntries(json.assessments.map((a) => [a.channelId, a.verdict])), GOLDEN.verdicts);
  for (const [channelId, reason] of Object.entries(GOLDEN.reasons)) {
    assert.equal(assessmentOf(json, channelId).reason, reason, `${channelId} reason drifted`);
  }
  for (const [channelId, score] of Object.entries(GOLDEN.scores)) {
    const assessment = assessmentOf(json, channelId);
    assert.deepEqual({ ...assessment.cost, costIsHard: assessment.costIsHard }, score);
  }
  assert.equal(json.ranking.scale?.channelId, GOLDEN.scale);
  assert.deepEqual(json.ranking.ordered.map((a) => a.channelId), [GOLDEN.scale]);
  assert.deepEqual(json.ranking.blockers, GOLDEN.rankBlockers);
  assert.deepEqual(json.allocation.findings, GOLDEN.allocationFindings);
  assert.equal(json.paid.earned, GOLDEN.paidEarned);
  assert.deepEqual(json.paid.qualifying, GOLDEN.paidQualifying);
  assert.equal(json.paid.detail, GOLDEN.paidDetail);
});

test('without --force the red gate refuses the human-readable review', { timeout: 60_000 }, async () => {
  const result = await cli(['--weeks', '8']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /TWO weekly growth review - NOT RUN/);
  assert.match(result.stdout, /growth gate is RED/);
  assert.doesNotMatch(result.stdout, /Why each verdict|Step 2\/3: the scale decision/);
});

test('--force labels the human-readable kill and scale as NOT A FINDING', { timeout: 60_000 }, async () => {
  const result = await cli(['--force', '--weeks', '8']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /NOT A FINDING\. The gate is red/);
  assert.ok(result.stdout.includes(GOLDEN.reasons['LIST-DISCADIA']!));
  assert.match(result.stdout, /LIST-DISBOARD-A has the best cost-per-AM30/);
  assert.match(result.stdout, /2\.7 agent-hours per AM30, on 3 AM30/);
  assert.match(result.stdout, /DOUBLE EFFORT next cycle/);
});

test('removing sustained effort from the fixture withholds the kill', { timeout: 60_000 }, async () => {
  const neglected = effort();
  for (const week of neglected.weeks) {
    if (week.channelId === 'LIST-DISCADIA') week.agentHours = 0;
  }
  writeFileSync(effortFile, JSON.stringify(neglected));
  const result = await cli(['--force', '--json', '--weeks', '8']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const discadia = assessmentOf(parseJson(result.stdout), 'LIST-DISCADIA');
  assert.equal(discadia.verdict, 'HOLD');
  assert.match(discadia.reason, /0\.0 agent-hours over 4 weeks is below the 2-hour bar/);
});
