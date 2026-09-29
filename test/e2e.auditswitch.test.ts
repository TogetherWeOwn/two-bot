/**
 * TOG-6493 slice: the audit kill switch operated end to end through the real CLI.
 *
 * WHY THIS EXISTS. scripts/audit-switch.ts is the emergency kill switch for the
 * audit mirror (TOG-3187): --halt stops every mirror send, --resume lets held
 * rows deliver again, --status shows the switch and what it holds. The unit half
 * (test/unit.auditcollectreport.test.ts) pins only the offline refusals; an argv
 * typo, a wrong env var read, or a swallowed exit code in the live path would
 * all stay green. This file drives the real script on a scratch schema (never
 * prod TWO_DATABASE_URL): disengaged status on a fresh schema, halt engages, a
 * second halt changes nothing, seeded pending rows are reported honestly, and
 * resume disengages without dropping evidence.
 *
 * Fixture (one scratch schema, never live/staging):
 *   migrations, then `node scripts/audit-switch.ts` with
 *   TWO_DATABASE_URL=<TEST_PG_URL>?options=-c+search_path=<schema> (the
 *   TOG-6492 URL-options trick from test/e2e.campaigns.test.ts: URL options win
 *   over inherited PGOPTIONS, so the child cannot land anywhere but this file's
 *   schema). Two seeded operational_audit_log rows with a mirror channel
 *   (delivery_state pending) plus one row with no mirror (state none) prove the
 *   pending count is read, not hardcoded.
 *
 * Reproduce by hand (reviewer path): point TWO_TEST_DATABASE_URL at a scratch
 * DB, take the openTestDb schema S for this file, seed two pending mirror rows
 * via OperationalAuditStore.record, then run
 *   TWO_DATABASE_URL=<url>?options=-c+search_path=S node scripts/audit-switch.ts --status
 *   TWO_DATABASE_URL=... node scripts/audit-switch.ts --halt --by <who>
 *   TWO_DATABASE_URL=... node scripts/audit-switch.ts --status
 *   TWO_DATABASE_URL=... node scripts/audit-switch.ts --resume
 * and compare the state/pending/rows lines with the asserts below.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';
import { OperationalAuditStore } from '../src/audit/store.ts';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/audit-switch.ts', import.meta.url));

// Synthetic guild in the 700... range used by other script fixtures. The
// switch has no guild fence; the isolation here is the scratch schema. 004 is
// free (000-003 and 009 are taken by sibling fixtures).
const GUILD = '700000000000000004';
// Synthetic actor ids in the reserved 9000... block, clear of the gatecheck
// 71-74 block so a future fixture cannot collide (per-file schemas anyway).
const ACTOR_A = '90000000000000081';
const ACTOR_B = '90000000000000082';
const MIRROR = '90000000000000085';
const BY = 'e2e-auditswitch-probe';

let harness: TestDb;
let store: OperationalAuditStore;
/** Routes the child CLI at this file's scratch schema, and nowhere else. */
let cliEnv: NodeJS.ProcessEnv;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const url = new URL(TEST_PG_URL);
  // URL options win over inherited PGOPTIONS, including URLs with their own
  // options - the TOG-6492 trick. The CLI child reads TWO_DATABASE_URL, so
  // this is the one value that decides which schema it writes to.
  url.searchParams.set('options', `-c search_path=${harness.schema}`);
  cliEnv = { TWO_DATABASE_URL: url.toString() };
  store = new OperationalAuditStore(harness.db);
});

after(async () => {
  // Guarded: if `before` failed halfway (no database), the cleanup must not
  // throw a second error that masks the real one.
  if (typeof harness !== 'undefined' && harness) await harness.cleanup();
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
    const result = await run(process.execPath, [SCRIPT, ...args], {
      cwd: REPO,
      env: { ...process.env, ...cliEnv },
      timeout: 60_000,
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/** Two mirror-bound rows (pending) plus one mirrorless row (none). */
async function seedPending() {
  const at = '2026-09-01T10:00:00.000Z';
  assert.equal(
    await store.record(
      { entryId: 'tog6493-a', kind: 'message_edit', channel: 'audit', guildId: GUILD, occurredAt: at, actorId: ACTOR_A },
      MIRROR,
    ),
    true,
  );
  assert.equal(
    await store.record(
      { entryId: 'tog6493-b', kind: 'message_delete', channel: 'audit', guildId: GUILD, occurredAt: at, actorId: ACTOR_B },
      MIRROR,
    ),
    true,
  );
  assert.equal(
    await store.record(
      { entryId: 'tog6493-c', kind: 'voice_join', channel: 'voice', guildId: GUILD, occurredAt: at, actorId: ACTOR_A },
      null,
    ),
    true,
  );
}

test('status on a fresh schema reports disengaged with zero pending rows', { timeout: 60_000 }, async () => {
  assert.equal(await store.isDeliveryHalted(), false);

  const result = await cli(['--status']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /state:\s+disengaged/);
  assert.match(result.output, /pending:\s+0 row\(s\) awaiting the delivery sweep/);
  assert.match(result.output, /rows:\s+none/);
});

test('halt engages the switch and a second halt changes nothing', { timeout: 60_000 }, async () => {
  const first = await cli(['--halt', '--by', BY]);
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, new RegExp(`KILL SWITCH ENGAGED by ${BY}`));
  assert.equal(await store.isDeliveryHalted(), true, 'the predicate the bot reads before every send');

  const status = await cli(['--status']);
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /state:\s+ENGAGED/);
  assert.match(status.output, new RegExp(`by ${BY}`));

  const second = await cli(['--halt', '--by', BY]);
  assert.equal(second.code, 0, second.output);
  assert.match(second.output, /kill switch was already engaged; nothing changed/);
  assert.equal(await store.isDeliveryHalted(), true);
});

test('seeded pending rows are reported honestly and resume keeps the evidence', { timeout: 60_000 }, async () => {
  await seedPending();

  const halt = await cli(['--halt', '--by', BY]);
  assert.equal(halt.code, 0, halt.output);

  const held = await cli(['--status']);
  assert.equal(held.code, 0, held.output);
  assert.match(held.output, /state:\s+ENGAGED/);
  assert.match(held.output, /pending:\s+2 row\(s\) held for delivery \(durable rows untouched\)/);
  // The rows line counts mirror-bound delivery rows only (the script's
  // WHERE mirror_channel_id IS NOT NULL): the mirrorless evidence row must
  // not inflate it.
  assert.match(held.output, /rows:\s+pending=2/);
  const mirrorless = await harness.db
    .prepare(`SELECT COUNT(*) AS n FROM operational_audit_log WHERE mirror_channel_id IS NULL`)
    .get<{ n: number | string }>();
  assert.equal(Number(mirrorless!.n), 1, 'the mirrorless row is evidence, held in the table but not a delivery row');

  const resume = await cli(['--resume']);
  assert.equal(resume.code, 0, resume.output);
  assert.match(resume.output, /KILL SWITCH DISENGAGED/);
  assert.equal(await store.isDeliveryHalted(), false);

  const after = await cli(['--status']);
  assert.equal(after.code, 0, after.output);
  assert.match(after.output, /state:\s+disengaged/);
  // Halting only stops sends; resuming must not drop the held rows.
  assert.match(after.output, /pending:\s+2 row\(s\) awaiting the delivery sweep/);
});
