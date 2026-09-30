/**
 * TOG-9985 (round 5, gap A2/C8): failure-case coverage for
 * `scripts/moderation-disable-preflight.ts`.
 *
 * The library underneath is proved by `test/e2e.moderation-shutdown.test.ts`;
 * this file executes the real script as a subprocess and pins every one of
 * its exits: 0 clear, 1 refused in each partial shape, 2 could-not-tell. A
 * script that always exits 0 would pass a "clear" test while waving every
 * disable through, and a read failure that reported "nothing outstanding"
 * would do the same - so the refused and could-not-tell paths are the point,
 * and each one must carry a named, actionable error rather than a bare code.
 *
 * State is seeded through ModerationStore's own writers and the script is
 * pointed at this file's schema with PGOPTIONS, the same trick
 * `test/e2e.leveling-scripts.test.ts` uses: the script takes no schema
 * option, so the search_path is the only steering wheel.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ModerationStore } from '../src/moderation/store.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/moderation-disable-preflight.ts', import.meta.url).pathname;

const GUILD = '1545644954272137297';
const USER = '900000000000000002';
const USER_TWO = '900000000000000003';
const CHANNEL = '900000000000000005';

let harness: TestDb;
let store: ModerationStore;
let schema = '';

before(async () => {
  harness = await openTestDb(import.meta.filename);
  store = new ModerationStore(harness.db);
  schema = (await harness.db.prepare('SELECT current_schema() AS s').get<{ s: string }>())!.s;
});
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.cleanup(); });

async function runScript(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  try {
    const result = await run(process.execPath, [SCRIPT, ...args], { cwd: REPO, env });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/** The script reads TWO_DATABASE_URL; PGOPTIONS steers it into this file's schema. */
function scriptEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function asJson(output: string): Record<string, unknown> {
  return JSON.parse(output.slice(output.indexOf('{'))) as Record<string, unknown>;
}

function inFuture(): string {
  return new Date(Date.now() + 3600 * 1000).toISOString();
}

async function seedPendingUnban(requestId: string, userId = USER): Promise<void> {
  await store.scheduleUnban(GUILD, userId, inFuture(), 'tempban for preflight probe', requestId);
}

async function seedRunningUnban(requestId: string, userId: string): Promise<void> {
  await store.stageUnban(GUILD, userId, inFuture(), 'tempban for preflight probe', requestId);
  await harness.db.prepare(
    'UPDATE moderation_scheduled_unbans SET state = \'running\', claimed_at = ?, claim_token = ? WHERE request_id = ?',
  ).run(new Date().toISOString(), 'probe-claim-token', requestId);
}

async function seedLockdown(): Promise<void> {
  await store.recordLockdown({
    channelId: CHANNEL,
    guildId: GUILD,
    priorAllow: '0',
    priorDeny: '0',
    priorExists: true,
    reason: 'raid containment probe',
  });
}

// --- exit 2: could not tell -------------------------------------------------

test('a missing TWO_DATABASE_URL exits 2 and names the variable', async () => {
  const result = await runScript([], scriptEnv({ TWO_DATABASE_URL: undefined, PGOPTIONS: undefined }));

  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /TWO_DATABASE_URL is required/);
  assert.doesNotMatch(result.output, /CLEAR/);
  assert.doesNotMatch(result.output, /REFUSED/);
});

test('an unreachable database exits 2 naming the open failure, never clear or refused', async () => {
  const result = await runScript(
    [],
    scriptEnv({ TWO_DATABASE_URL: 'postgres://127.0.0.1:1/must-not-connect' }),
  );

  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /could not open the database/);
  // ECONNREFUSED carries "REFUSED" as a substring, so pin the script's own
  // verdict lines instead of a bare word.
  assert.doesNotMatch(result.output, /preflight: CLEAR/);
  assert.doesNotMatch(result.output, /preflight: REFUSED/);
});

test('a non-postgres URL exits 2 naming the postgres requirement', async () => {
  const result = await runScript([], scriptEnv({ TWO_DATABASE_URL: 'sqlite:///not-a-postgres-url' }));

  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /could not open the database/);
  assert.match(result.output, /postgres/i);
});

test('a schema without moderation tables exits 2: could not tell is never clear', async () => {
  // skipMigrations means the script never creates anything: pointed at an
  // empty schema the open succeeds and the read fails, which must stay a 2.
  const result = await runScript([], scriptEnv({ PGOPTIONS: '-c search_path=test_tog9985_no_tables' }));

  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /could not read moderation state/);
  assert.match(result.output, /does not exist/);
  assert.doesNotMatch(result.output, /CLEAR/);
  assert.doesNotMatch(result.output, /REFUSED/);
});

// --- exit 0: clear ----------------------------------------------------------

test('an empty database exits 0 CLEAR', async () => {
  // Control: proves the refusals below come from seeded state, not from a
  // script that refuses everything.
  const result = await runScript([], scriptEnv());

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CLEAR/);
  assert.match(result.output, /0 pending unbans, 0 active lockdowns/);
});

test('--json on an empty database exits 0 with clear:true and zero counts', async () => {
  const result = await runScript(['--json'], scriptEnv());

  assert.equal(result.code, 0, result.output);
  const body = asJson(result.output);
  assert.equal(body.clear, true);
  assert.equal(body.total, 0);
  assert.equal(body.pendingUnbanCount, 0);
  assert.equal(body.activeLockdownCount, 0);
});

// --- exit 1: refused, each partial shape ------------------------------------

test('a pending unban alone refuses with exit 1 and names the member', async () => {
  await seedPendingUnban('req-preflight-partial-unban');
  const result = await runScript([], scriptEnv());

  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /REFUSED/);
  assert.match(result.output, /1 pending unban/);
  assert.match(result.output, new RegExp(USER));
  assert.match(result.output, new RegExp(GUILD));
  assert.match(result.output, /req-preflight-partial-unban/);
  // Partial means partial: no lockdown section when nothing is locked down.
  assert.doesNotMatch(result.output, /active lockdown/);
  // Actionable: the drain path, not just the refusal.
  assert.match(result.output, /Drain it/);
  assert.match(result.output, /TWO_MODERATION_DISABLE_OVERRIDE/);
});

test('an active lockdown alone refuses with exit 1 and names the channel', async () => {
  await seedLockdown();
  const result = await runScript([], scriptEnv());

  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /REFUSED/);
  assert.match(result.output, /1 active lockdown/);
  assert.match(result.output, new RegExp(CHANNEL));
  assert.doesNotMatch(result.output, /pending unban/);
  assert.match(result.output, /Drain it/);
});

test('both kinds outstanding plus a running claim get exit 1 with hand-release SQL', async () => {
  await seedPendingUnban('req-preflight-pending', USER);
  await seedRunningUnban('req-preflight-running', USER_TWO);
  await seedLockdown();
  const result = await runScript([], scriptEnv());

  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /REFUSED/);
  assert.match(result.output, /2 pending unban/);
  assert.match(result.output, /1 active lockdown/);
  assert.match(result.output, /req-preflight-pending/);
  // The running row survives every poller sweep (TOG-1659/TOG-8460): the
  // refusal must say so and print the close-by-request-id exit.
  assert.match(result.output, /\[running\]/);
  assert.match(result.output, /req-preflight-running/);
  assert.match(result.output, /never drain on their own/);
  assert.match(result.output, /moderation_scheduled_unbans SET state = 'done'/);
});

test('--json refusal exits 1 with exact counts and the stranded id lists', async () => {
  await seedPendingUnban('req-preflight-json', USER);
  await seedLockdown();
  const result = await runScript(['--json'], scriptEnv());

  assert.equal(result.code, 1, result.output);
  const body = asJson(result.output);
  assert.equal(body.clear, false);
  assert.equal(body.total, 2);
  assert.equal(body.pendingUnbanCount, 1);
  assert.equal(body.activeLockdownCount, 1);
  assert.equal(body.truncated, false);
  const unbans = body.pendingUnbans as Array<{ requestId: string; userId: string }>;
  const lockdowns = body.activeLockdowns as Array<{ channelId: string }>;
  assert.deepEqual(unbans.map((job) => job.requestId), ['req-preflight-json']);
  assert.deepEqual(unbans.map((job) => job.userId), [USER]);
  assert.deepEqual(lockdowns.map((lock) => lock.channelId), [CHANNEL]);
});
