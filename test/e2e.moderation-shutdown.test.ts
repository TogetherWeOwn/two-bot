/**
 * TOG-3190: the moderation shutdown preflight, proved by execution.
 *
 * The acceptance is four cases, and the third is the one that matters most: a
 * preflight that always refuses passes every "it refused" test while being
 * completely broken, and would wedge the bot permanently off. So `clear` is
 * asserted as its own outcome, reached by actually draining the backlog through
 * the real release paths (`claimDueUnbans`/`completeUnban`, `clearLockdown`)
 * rather than by deleting rows behind the code's back.
 *
 * State is seeded through ModerationStore's own writers for the same reason:
 * a reader tested against hand-written SQL only proves the reader agrees with
 * the test author.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MODERATION_DISABLE_OVERRIDE_ENV,
  MODERATION_DISABLE_OVERRIDE_REASON_ENV,
  ModerationShutdownRefusal,
  enforceModerationShutdownPreflight,
  evaluateModerationShutdown,
} from '../src/moderation/shutdownPreflight.ts';
import { ModerationStore } from '../src/moderation/store.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const GUILD = '1545644954272137297';
const USER = '900000000000000002';
const CHANNEL = '900000000000000005';

let harness: TestDb;
let store: ModerationStore;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  store = new ModerationStore(harness.db);
});
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.cleanup(); });

/** Captures what the preflight logged, so the stranded set can be asserted. */
function recorder() {
  const lines: Array<{ level: 'info' | 'error'; msg: string; fields: Record<string, unknown> }> = [];
  return {
    lines,
    log: {
      info: (msg: string, fields?: Record<string, unknown>) => { lines.push({ level: 'info', msg, fields: fields ?? {} }); },
      error: (msg: string, fields?: Record<string, unknown>) => { lines.push({ level: 'error', msg, fields: fields ?? {} }); },
    },
  };
}

function inFuture(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function seedPendingUnban(executeAt = inFuture(3600)): Promise<string> {
  const requestId = `req-unban-${executeAt}`;
  await store.scheduleUnban(GUILD, USER, executeAt, 'tempban for raid spam', requestId);
  return requestId;
}

async function seedLockdown(): Promise<void> {
  await store.recordLockdown({
    channelId: CHANNEL,
    guildId: GUILD,
    priorAllow: '0',
    priorDeny: '0',
    priorExists: true,
    reason: 'raid containment',
  });
}

// --- case 1: a pending unban refuses, and names it --------------------------

test('a pending unban refuses the disable and names the member', async () => {
  const requestId = await seedPendingUnban();
  const { log, lines } = recorder();

  const error = await enforceModerationShutdownPreflight({ enabled: false, store, env: {}, log })
    .then(() => null, (e: unknown) => e);

  assert.ok(error instanceof ModerationShutdownRefusal, `expected a refusal, got ${String(error)}`);
  assert.equal(error.outstanding.pendingUnbanCount, 1);
  assert.equal(error.outstanding.activeLockdownCount, 0);

  // "Refused" with no detail sends the operator back to guess. The message has
  // to carry the member, the guild and the job id, or it has not done its job.
  assert.match(error.message, new RegExp(USER));
  assert.match(error.message, new RegExp(GUILD));
  assert.match(error.message, new RegExp(requestId));
  assert.match(error.message, /1 pending unban/);

  const refused = lines.find((l) => l.msg === 'moderation_disable_refused');
  assert.ok(refused, 'the refusal must be logged, not only thrown');
  assert.equal(refused.level, 'error');
  assert.deepEqual(
    (refused.fields.strandedUnbans as Array<{ userId: string }>).map((u) => u.userId),
    [USER],
  );
});

// --- case 2: an active lockdown refuses -------------------------------------

test('an active lockdown refuses the disable and names the channel', async () => {
  await seedLockdown();
  const { log } = recorder();

  const error = await enforceModerationShutdownPreflight({ enabled: false, store, env: {}, log })
    .then(() => null, (e: unknown) => e);

  assert.ok(error instanceof ModerationShutdownRefusal, `expected a refusal, got ${String(error)}`);
  assert.equal(error.outstanding.activeLockdownCount, 1);
  assert.equal(error.outstanding.pendingUnbanCount, 0);
  assert.match(error.message, new RegExp(CHANNEL));
  assert.match(error.message, /1 active lockdown/);
});

// --- case 3: cleared, the disable succeeds ----------------------------------
//
// Mandatory, and the case a broken-but-passing preflight fails. Both kinds of
// outstanding state are seeded first, then released through the same code the
// running bot uses, so "clear" means the real drain path reaches it.

test('draining both kinds of outstanding state lets the disable through', async () => {
  await seedPendingUnban(new Date(Date.now() - 1000).toISOString());
  await seedLockdown();

  const before = await evaluateModerationShutdown({ enabled: false, store, env: {} });
  assert.equal(before.decision, 'refused', 'fixture must actually be outstanding first');
  assert.equal(before.outstanding?.total, 2);

  const claimed = await store.claimDueUnbans();
  assert.equal(claimed.length, 1);
  await store.completeUnban(claimed[0].requestId, claimed[0].claimToken);
  await store.clearLockdown(CHANNEL);

  const { log, lines } = recorder();
  const verdict = await enforceModerationShutdownPreflight({ enabled: false, store, env: {}, log });

  assert.equal(verdict.decision, 'clear');
  assert.equal(verdict.outstanding?.total, 0);
  assert.ok(lines.some((l) => l.msg === 'moderation_disable_preflight_clear'));
  assert.ok(!lines.some((l) => l.msg === 'moderation_disable_refused'));
});

// --- case 4: override proceeds and logs the stranded set --------------------

test('the override proceeds and logs the full stranded set', async () => {
  const requestId = await seedPendingUnban();
  await seedLockdown();
  const { log, lines } = recorder();

  const verdict = await enforceModerationShutdownPreflight({
    enabled: false,
    store,
    env: {
      [MODERATION_DISABLE_OVERRIDE_ENV]: '1',
      [MODERATION_DISABLE_OVERRIDE_REASON_ENV]: 'gateway incident, moderation must stop now',
    },
    log,
  });

  assert.equal(verdict.decision, 'overridden');

  const stranded = lines.find((l) => l.msg === 'moderation_disable_stranded');
  assert.ok(stranded, 'the override must log the stranded set');
  // Error level so it survives a log level turned down to errors only: this is
  // the only record that these members and channels are owed a release.
  assert.equal(stranded.level, 'error');
  assert.equal(stranded.fields.reason, 'gateway incident, moderation must stop now');
  assert.deepEqual(
    stranded.fields.strandedUnbans,
    [{ requestId, guildId: GUILD, userId: USER, state: 'pending', executeAt: verdict.outstanding!.pendingUnbans[0].executeAt }],
  );
  assert.deepEqual(
    (stranded.fields.strandedLockdowns as Array<{ channelId: string }>).map((l) => l.channelId),
    [CHANNEL],
  );
});

test('the override is exactly "1" and nothing else', async () => {
  await seedLockdown();
  for (const value of ['0', 'true', 'yes', '', ' 1']) {
    const verdict = await evaluateModerationShutdown({
      enabled: false,
      store,
      env: { [MODERATION_DISABLE_OVERRIDE_ENV]: value },
    });
    assert.equal(verdict.decision, 'refused', `${JSON.stringify(value)} must not be an override`);
  }
});

// --- which states are outstanding, and which are finished -------------------

test('finished unban jobs do not block a disable', async () => {
  // `done` is the drained case; `cancelled` and `superseded` are jobs that were
  // replaced or withdrawn. None of them owes anybody a release, and counting
  // them would refuse forever on a guild that has ever used tempban.
  for (const state of ['done', 'cancelled', 'superseded']) {
    await harness.reset();
    await store.scheduleUnban(GUILD, USER, inFuture(60), 'r', `req-${state}`);
    await harness.db.prepare(
      'UPDATE moderation_scheduled_unbans SET state = ? WHERE request_id = ?',
    ).run(state, `req-${state}`);

    const verdict = await evaluateModerationShutdown({ enabled: false, store, env: {} });
    assert.equal(verdict.decision, 'clear', `state ${state} must not block the disable`);
  }
});

test('the named set is only the outstanding jobs, not every job ever', async () => {
  // The counts drive the decision, so a list query that forgot the state filter
  // would still refuse for the right reason - and then send the operator to
  // unban three people who were released last week. Mutation-tested: dropping
  // the filter from the list query alone survives every assertion above.
  await store.scheduleUnban(GUILD, USER, inFuture(60), 'still banned', 'req-live');
  await store.scheduleUnban(GUILD, '900000000000000099', inFuture(60), 'already out', 'req-finished');
  await harness.db.prepare(
    "UPDATE moderation_scheduled_unbans SET state = 'done' WHERE request_id = ?",
  ).run('req-finished');

  const verdict = await evaluateModerationShutdown({ enabled: false, store, env: {} });

  assert.equal(verdict.decision, 'refused');
  assert.equal(verdict.outstanding?.pendingUnbanCount, 1);
  assert.deepEqual(verdict.outstanding?.pendingUnbans.map((job) => job.requestId), ['req-live']);
  assert.doesNotMatch(verdict.message, /req-finished/);
  assert.doesNotMatch(verdict.message, /900000000000000099/);
});

test('staged and running unban jobs do block a disable', async () => {
  // `staged` is written BEFORE the Discord ban and `running` is a claim that may
  // have timed out after the ban landed. Either can have a real ban behind it.
  for (const state of ['staged', 'running']) {
    await harness.reset();
    await store.stageUnban(GUILD, USER, inFuture(60), 'r', `req-${state}`);
    if (state === 'running') {
      await harness.db.prepare(
        'UPDATE moderation_scheduled_unbans SET state = ? WHERE request_id = ?',
      ).run(state, `req-${state}`);
    }

    const verdict = await evaluateModerationShutdown({ enabled: false, store, env: {} });
    assert.equal(verdict.decision, 'refused', `state ${state} must block the disable`);
    assert.equal(verdict.outstanding?.pendingUnbanCount, 1);
  }
});

// --- moderation staying on is not a shutdown --------------------------------

test('an enabled moderation slice reads nothing at all', async () => {
  await seedPendingUnban();
  await seedLockdown();
  const exploding = {
    countOutstandingUnbans: async () => { throw new Error('must not read'); },
    listOutstandingUnbans: async () => { throw new Error('must not read'); },
    countActiveLockdowns: async () => { throw new Error('must not read'); },
    listActiveLockdowns: async () => { throw new Error('must not read'); },
  };

  const verdict = await enforceModerationShutdownPreflight({ enabled: true, store: exploding, env: {} });
  assert.equal(verdict.decision, 'enabled');
  assert.equal(verdict.outstanding, null);
});

// --- the boot actually calls it ---------------------------------------------

test('src/index.ts enforces the preflight against the real config', async () => {
  // Static, because booting index.ts needs a Discord token, a gateway and a
  // guild. Two predicates, because each catches a different way to make the
  // gate vacuous: dropping the call, and keeping the call while pinning
  // `enabled` to a literal so it can never observe a disable.
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /await enforceModerationShutdownPreflight\(\{/);
  assert.match(source, /enforceModerationShutdownPreflight\(\{\s*\n\s*enabled: moderationCfg\.enabled,/);
});
