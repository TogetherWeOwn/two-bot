/**
 * TOG-7709 acceptance for scripts/web-views.ts (`npm run web:views`): the
 * exact contracted columns of all nine `web_v1` views.
 *
 * WHY THIS EXISTS. test/e2e.webcontract.test.ts asserts view existence via
 * WEB_CONTRACT_VIEWS (the code asserting against itself) and exact columns
 * only for `members`. A column drifting in any other view breaks two-web
 * silently. This test pins every view's column set as a hardcoded fixture, so
 * the fixture disagrees with the code when the code drifts.
 *
 * Fixture (one scratch schema, never live/staging):
 *   migrations, then the REAL npm entry `npm run web:views` with
 *   TWO_DATABASE_URL + PGOPTIONS="-c search_path=<schema>" (the TOG-6492
 *   trick from test/e2e.webrole.test.ts) -> 9 views in <schema>_web_v1, all
 *   reported ok. information_schema.columns for the web schema must
 *   deep-equal the hardcoded EXPECTED_COLUMNS below.
 *   `npm run web:views -- --status` exits 0 and changes nothing.
 *
 * Fixture source: sql/web_v1.sql + docs/WEBSITE_CONTRACT.md SS2. Sorted.
 * Hardcoded on purpose: deriving this from WEB_CONTRACT_VIEWS would be the
 * code asserting against itself again.
 *
 * REVIEWER (to see this fail): drop one contracted column from sql/web_v1.sql
 * (e.g. `detail` from member_milestones) - the column test fails naming the
 * view+column. Delete a whole view definition instead and `npm run web:views`
 * against a scratch schema reports that view MISSING.
 *
 * Reproduce by hand: point TWO_DATABASE_URL at a scratch DB with
 * PGOPTIONS="-c search_path=<schema>", run migrate + web:views, then compare
 * `SELECT table_name, column_name FROM information_schema.columns
 *  WHERE table_schema = '<schema>_web_v1'` against EXPECTED_COLUMNS below.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;

/**
 * The contracted columns, sorted. Source: sql/web_v1.sql +
 * docs/WEBSITE_CONTRACT.md SS2. next_event inherits upcoming_events via
 * SELECT ue.*, so the two lists are identical by construction - and this
 * fixture would catch it if they ever stopped being so.
 */
const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  contract_meta: ['contract_version', 'guild_id'],
  live_counts: ['counts_updated_at', 'human_member_count', 'online_count', 'online_updated_at'],
  rank_counts: ['holders_count', 'member_count', 'rank_key', 'rank_label', 'rank_order', 'snapshot_at'],
  members: ['is_current_member', 'joined_at', 'member_id', 'rank_key', 'tenure_days'],
  member_milestones: ['detail', 'member_id', 'milestone', 'occurred_at'],
  upcoming_events: ['channel_id', 'description', 'event_id', 'name', 'starts_at'],
  next_event: ['channel_id', 'description', 'event_id', 'name', 'starts_at'],
  funnel_daily: ['day', 'first_messages', 'first_voice_sessions', 'joins', 'leaves', 'net_change'],
  funnel_by_source: ['day', 'joins', 'source'],
};
const VIEW_NAMES = Object.keys(EXPECTED_COLUMNS).sort();

let harness: TestDb;
/** Routes the child npm entry's pg driver at this file's scratch schema. */
let dbEnv: Record<string, string>;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  dbEnv = {
    TWO_DATABASE_URL: TEST_PG_URL,
    PGOPTIONS: `-c search_path=${harness.schema}`,
  };
});

after(async () => {
  // Guarded: if `before` failed halfway (no database), the cleanup must not
  // throw a second error that masks the real one.
  if (typeof harness !== 'undefined' && harness) await harness.cleanup();
});

interface CliResult {
  code: number;
  output: string;
}

async function npmWebViews(args: string[] = []): Promise<CliResult> {
  try {
    const result = await run('npm', ['run', 'web:views', ...(args.length > 0 ? ['--', ...args] : [])], {
      cwd: REPO,
      env: { ...process.env, ...dbEnv },
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

function assertAllViewsOk(output: string): void {
  for (const v of VIEW_NAMES) {
    assert.match(
      output,
      new RegExp(`ok\\s+${harness.webSchema}\\.${v}\\b`),
      `${v} was not reported ok:\n${output}`,
    );
  }
  assert.doesNotMatch(output, /MISSING|EXTRA/, `contract gaps reported:\n${output}`);
}

async function readColumns(): Promise<Record<string, string[]>> {
  const rows = await harness.db
    .prepare(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ?`)
    .all<{ table_name: string; column_name: string }>(harness.webSchema);
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.table_name] ??= []).push(r.column_name);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

test('npm run web:views applies all nine contract views through the real npm entry', { timeout: 120_000 }, async () => {
  const out = await npmWebViews();
  assert.equal(out.code, 0, `web:views failed:\n${out.output}`);
  assertAllViewsOk(out.output);
});

test('every view exposes exactly its contracted columns', async () => {
  const actual = await readColumns();
  assert.deepEqual(
    Object.keys(actual).sort(),
    VIEW_NAMES,
    `contract view set drifted:\n${JSON.stringify(actual, null, 2)}`,
  );
  for (const view of VIEW_NAMES) {
    // Names the view on drift, so the failure says WHERE two-web breaks.
    assert.deepEqual(
      actual[view] ?? [],
      [...EXPECTED_COLUMNS[view]],
      `${harness.webSchema}.${view}: contracted columns drifted`,
    );
  }
});

test('npm run web:views -- --status exits 0 and changes nothing', { timeout: 120_000 }, async () => {
  const beforeCols = await readColumns();
  const out = await npmWebViews(['--status']);
  assert.equal(out.code, 0, `web:views --status failed:\n${out.output}`);
  assertAllViewsOk(out.output);
  assert.deepEqual(await readColumns(), beforeCols, '--status must change nothing');
});
