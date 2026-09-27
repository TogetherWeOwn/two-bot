/**
 * TOG-6478 acceptance for scripts/gate-check.ts.
 *
 * unit.growthgate.test.ts pins the pure verdict rule (all six or red, unknown
 * is red); this pins the script that does the looking: seeded rows in, the
 * funnel numbers operators quote out, through the real CLI (`--json`) against
 * a scratch schema. No token, no network, no live guild - the website side is
 * pointed at a closed loopback port so it fails fast and hermetic, and the
 * assertions only touch the funnel checks plus the red verdict that follows.
 *
 * Fixture (one synthetic guild, never live/staging):
 *   seeded staging fixtures(property A) -> 10 attributed joins
 *     (invite:qa-alpha x6, invite:qa-beta x4), 0 unattributed, no WEB-HOMEPAGE
 *   B one join on invite:WEB-HOMEPAGE    -> web-code-row flips fail -> ok
 *   C backfill-only baseline             -> 0 attributed, 3 unattributed
 *     (the ledger §0 shape: history reconstructed from the server log carries
 *     no invite code, so it must never satisfy the attributed-join criterion)
 *   D empty events table                 -> 0/0, "no member_join rows at all"
 *   E backfill gate_cleared (EVENTS.md limit 6): the inactive fixture's
 *     clearing counts toward conversion but must never feed time-to-clear
 *
 * Reproduce by hand (reviewer path): point TWO_DATABASE_URL at a scratch DB
 * with PGOPTIONS="-c search_path=<schema>", seed per the helpers below, run
 * `TWO_GATE_SITE=http://127.0.0.1:1 node scripts/gate-check.ts --json`, and
 * compare the `bot-attributed-join` / `web-code-row` checks with the asserts.
 *
 * REVIEWER: flip the funnel split to see this fail - drop the
 * `source LIKE 'invite:%'` predicate in scripts/gate-check.ts (or count
 * `backfill:` rows as attributed). Case C then reports 3 attributed joins
 * and the gate's hardest criterion passes on history nobody observed.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { EventStore } from '../src/store/eventStore.ts';
import {
  EXPECTED_DISTINCT,
  FIXTURE_MEMBER_IDS,
  TEST_NOW,
  seedFixtures,
} from '../src/staging/fixtures.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/gate-check.ts', import.meta.url).pathname;

// Synthetic guild in the 700... range used by other script fixtures. The
// script has no guild fence; the isolation here is the scratch schema.
const GUILD = '700000000000000002';

// Synthetic member ids in the reserved 9000... block, clear of the staging
// fixture suffixes 01-10 and 90-91 so a future fixture cannot collide.
const BACKFILL_IDS = ['90000000000000071', '90000000000000072', '90000000000000073'];
const WEB_MEMBER = '90000000000000074';

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

interface CliResult {
  code: number;
  output: string;
}

async function cli(args: string[]): Promise<CliResult> {
  try {
    const result = await run('node', [SCRIPT, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        ...dbEnv,
        // Closed loopback port: the website observation fails fast with
        // ECONNREFUSED instead of dialling the real apex (12s timeout) or
        // touching any network. The funnel assertions below do not depend on
        // it; the verdict stays red on the website side by construction.
        TWO_GATE_SITE: 'http://127.0.0.1:1',
        // Never poll a real container from a test, even if the parent env
        // happens to bind panel credentials.
        COOLIFY_URL: '',
        COOLIFY_TOKEN: '',
      },
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

interface GateCheckJson {
  verdict: string;
  scoringLoopRuns: boolean;
  checks: Array<{
    id: string;
    side: string;
    status: string;
    detail: string;
  }>;
}

function parseJson(output: string): GateCheckJson {
  const body = output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
  return JSON.parse(body) as GateCheckJson;
}

function checkOf(json: GateCheckJson, id: string) {
  const c = json.checks.find((x) => x.id === id);
  assert.ok(c, `expected a ${id} check in ${json.checks.map((x) => x.id).join(',')}`);
  return c;
}

/** Raw insert: the script reads the events table only, no projection needed. */
async function insertJoin(memberId: string, occurredAt: string, source: string, key: string) {
  await harness.db
    .prepare(
      `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
       VALUES ('member_join', ?, ?, ?, ?, ?, ?)`,
    )
    .run(memberId, GUILD, occurredAt, source, null, key);
}

test('seeded fixtures report 10 attributed joins and no WEB-HOMEPAGE row', { timeout: 60_000 }, async () => {
  await seedFixtures(harness.db, { guildId: GUILD, now: TEST_NOW });

  const result = await cli(['--json']);
  // Red by construction: the website side points at a closed port, so at most
  // the funnel-adjacent criteria can pass. Red must still exit non-zero so a
  // caller that only checks the status does not read it as success.
  assert.equal(result.code, 1, result.output);
  const json = parseJson(result.output);
  assert.equal(json.verdict, 'red');
  assert.equal(json.scoringLoopRuns, false);

  // qa-alpha x6 (lurker, chatter, fast, inactive, rejoiner-first, quiet) and
  // qa-beta x4 (voicer, stalled, leaver, rejoiner-second): every fixture join
  // carries a real invite code, so all 10 are attributed and none are not.
  const join = checkOf(json, 'bot-attributed-join');
  assert.equal(join.status, 'ok');
  assert.match(join.detail, /10 attributed join\(s\) on file/);

  // Criterion 3 needs the code as its own funnel ROW: bound-but-never-joined
  // is not a row, and no fixture join arrives on WEB-HOMEPAGE.
  const row = checkOf(json, 'web-code-row');
  assert.equal(row.status, 'fail');
  assert.match(row.detail, /WEB-HOMEPAGE has no row in the funnel/);
});

test('a WEB-HOMEPAGE join flips the code-row criterion without touching attribution', { timeout: 60_000 }, async () => {
  await seedFixtures(harness.db, { guildId: GUILD, now: TEST_NOW });
  await insertJoin(WEB_MEMBER, '2026-08-10T12:00:00.000Z', 'invite:WEB-HOMEPAGE', 'tog6478-web-1');

  const result = await cli(['--json']);
  assert.equal(result.code, 1, result.output);
  const json = parseJson(result.output);

  const join = checkOf(json, 'bot-attributed-join');
  assert.equal(join.status, 'ok');
  assert.match(join.detail, /11 attributed join\(s\) on file/);

  const row = checkOf(json, 'web-code-row');
  assert.equal(row.status, 'ok');
  assert.match(row.detail, /WEB-HOMEPAGE appears in the funnel report as its own row/);
});

test('a backfill-only baseline counts 0 attributed with 3 unattributed on file', { timeout: 60_000 }, async () => {
  // The ledger §0 shape: history reconstructed from the server's own log
  // records THAT somebody joined but never HOW, so it carries no invite code.
  await insertJoin(BACKFILL_IDS[0]!, '2026-05-01T10:00:00.000Z', 'backfill:member_list', 'tog6478-c1');
  await insertJoin(BACKFILL_IDS[1]!, '2026-05-02T10:00:00.000Z', 'backfill:member_list', 'tog6478-c2');
  await insertJoin(BACKFILL_IDS[2]!, '2026-05-03T10:00:00.000Z', 'backfill:member_list', 'tog6478-c3');

  const result = await cli(['--json']);
  assert.equal(result.code, 1, result.output);
  const json = parseJson(result.output);

  // The whole check: backfill rows are counted in the detail but excluded
  // from the attributed number, so the criterion fails on history alone.
  const join = checkOf(json, 'bot-attributed-join');
  assert.equal(join.status, 'fail');
  assert.match(join.detail, /0 joins carry an invite code/);
  assert.match(join.detail, /3 join\(s\) on file, none carrying an invite code/);

  const row = checkOf(json, 'web-code-row');
  assert.equal(row.status, 'fail');
});

test('an empty events table says so instead of reporting zero joins', { timeout: 60_000 }, async () => {
  const result = await cli(['--json']);
  assert.equal(result.code, 1, result.output);
  const json = parseJson(result.output);

  // "0 attributed out of 3 backfill rows" and "0 attributed out of nothing"
  // are different findings; only the second one means nobody looked yet.
  const join = checkOf(json, 'bot-attributed-join');
  assert.equal(join.status, 'fail');
  assert.match(join.detail, /the events table holds no member_join rows at all/);
});

test('backfill clearings count toward conversion but never toward time-to-clear', async () => {
  await seedFixtures(harness.db, { guildId: GUILD, now: TEST_NOW });
  const store = new EventStore(harness.db);

  // Counting (EVENTS.md limit 6, first half): the inactive fixture's clearing
  // comes off a roster read with the join time as a placeholder, and it still
  // establishes the binary - that member is through the gate.
  assert.equal(
    await store.countMembersWith('gate_cleared'),
    EXPECTED_DISTINCT.gate_cleared,
    'gate conversion must keep including backfilled clearings',
  );

  // Timing (second half): that same row's occurred_at is the join time, so
  // feeding it to time-to-clear arithmetic would print a member clearing in
  // 0s. It must read as nothing to measure.
  assert.equal(
    await store.timeToGateClearSeconds(GUILD, FIXTURE_MEMBER_IDS.inactive),
    null,
    'a backfilled clearing must never feed time-to-clear arithmetic',
  );

  // The control: a live clearing with a known delta measures exactly that.
  assert.equal(
    await store.timeToGateClearSeconds(GUILD, FIXTURE_MEMBER_IDS.chatter),
    4,
    'a live clearing keeps its measured delta',
  );
});

test('gate-check.ts reads the funnel with the invite:% / backfill split', () => {
  // Guards the wiring the acceptance above is only meaningful on: the script
  // must keep counting attributed joins by the invite: prefix (which is what
  // excludes backfill: rows) rather than re-implementing the split inline in
  // a way the fixture never exercises.
  const script = readFileSync(new URL('../scripts/gate-check.ts', import.meta.url), 'utf8');
  assert.match(script, /source LIKE 'invite:%'/);
  assert.match(script, /backfill:/);
});
