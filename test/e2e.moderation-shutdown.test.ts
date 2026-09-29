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
  OUTSTANDING_ID_LIMIT,
  enforceModerationShutdownPreflight,
  evaluateModerationShutdown,
  readOutstandingModerationState,
} from '../src/moderation/shutdownPreflight.ts';
import { MODERATION_ACTIONS } from '../src/moderation/types.ts';
import { loadModerationConfig } from '../src/moderation/config.ts';
import { loadInternalActionsConfig } from '../src/internal/config.ts';
import { assertAllowed, runAction, type ActionContext } from '../src/internal/actions.ts';
import type { ActionDiscord } from '../src/internal/discordActions.ts';
import { ActionError } from '../src/internal/errors.ts';
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

// --- truncated means rows were actually cut, not merely full ------------------
//
// TOG-8459: length >= LIMIT misreported a complete 500-row list as truncated.
// The counts are exact (COUNT(*)); only count > list means a cut.

function fakeStore(unbans: number, locks: number) {
  const makeUnbans = (n: number) =>
    Array.from({ length: Math.min(n, OUTSTANDING_ID_LIMIT) }, (_, i) => ({
      requestId: `req-${i}`,
      guildId: GUILD,
      userId: USER,
      state: 'pending',
      executeAt: inFuture(60),
      reason: 'r',
    }));
  const makeLocks = (n: number) =>
    Array.from({ length: Math.min(n, OUTSTANDING_ID_LIMIT) }, (_, i) => ({
      channelId: `${CHANNEL}-${i}`,
      guildId: GUILD,
      reason: 'r',
      lockedAt: inFuture(60),
    }));
  return {
    countOutstandingUnbans: async () => unbans,
    listOutstandingUnbans: async () => makeUnbans(unbans),
    countActiveLockdowns: async () => locks,
    listActiveLockdowns: async () => makeLocks(locks),
  };
}

test('exactly OUTSTANDING_ID_LIMIT rows with a complete list is not truncated', async () => {
  const state = await readOutstandingModerationState(fakeStore(OUTSTANDING_ID_LIMIT, 0));
  assert.equal(state.pendingUnbans.length, OUTSTANDING_ID_LIMIT);
  assert.equal(state.truncated, false);
});

test('one row over the cap is truncated', async () => {
  const state = await readOutstandingModerationState(fakeStore(OUTSTANDING_ID_LIMIT + 1, 0));
  assert.equal(state.pendingUnbans.length, OUTSTANDING_ID_LIMIT);
  assert.equal(state.truncated, true);
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

// --- the kill switch disables every moderation verb (TOG-5702) ----------------
//
// The preflight above answers "may I turn it off"; these cases answer "is it
// off". `TWO_MODERATION` unset must leave no moderation path live: no slash
// command, no internal verb, no automod sanction, no unban sweep. Each case
// fails if any verb remains reachable under the kill-switch fixture.

const INTERNAL_KEYS = 'web-test:0123456789abcdef0123456789abcdef';

/** A Discord client that records every call, so "no verb ran" is provable. */
function idleDiscord(): { client: ActionDiscord; calls: string[] } {
  const calls: string[] = [];
  const client: ActionDiscord = {
    async memberRoles() { calls.push('memberRoles'); return []; },
    async addRole(_g, _u, r) { calls.push(`addRole:${r}`); },
    async addMember(_g, u, _t) { calls.push(`addMember:${u}`); return 'added'; },
    async postMessage(c, _content) { calls.push(`postMessage:${c}`); return 'msg-1'; },
    async createEvent(_g, i) { calls.push(`createEvent:${i.name}`); return 'evt-1'; },
    async updateEvent(_g, id, i) { calls.push(`updateEvent:${id}:${i.name}`); },
    async cancelEvent(_g, id) { calls.push(`cancelEvent:${id}`); },
    async readEvent(_g, id) {
      calls.push(`readEvent:${id}`);
      return {
        eventId: id, name: '', startsAt: new Date(0).toISOString(), location: null,
        status: 'SCHEDULED', observedAt: new Date().toISOString(),
      };
    },
  };
  return { client, calls };
}

/**
 * The kill-switch fixture, built the way src/index.ts builds it: the website
 * key may carry `TWO_INTERNAL_ALLOW_MODERATION=1`, but `TWO_MODERATION` is
 * unset, so the co-gate keeps every verb out of the enabled set and the
 * moderation dependency stays unwired (null).
 */
function disabledCtx(discord: ActionDiscord): ActionContext {
  const cfg = loadInternalActionsConfig({
    TWO_INTERNAL_ACTIONS: '1',
    TWO_INTERNAL_KEYS: INTERNAL_KEYS,
    TWO_INTERNAL_ALLOW_MODERATION: '1',
  } as NodeJS.ProcessEnv)!;
  return {
    guildId: GUILD,
    discord,
    roleKeys: new Map(),
    channelKeys: new Map(),
    enabled: cfg.enabled,
    store: null,
    settings: null,
    idempotencyKey: 'kill-switch-fixture',
    moderation: null,
  };
}

test('the kill switch starts at the config: no TWO_MODERATION means disabled', () => {
  assert.equal(loadModerationConfig({} as NodeJS.ProcessEnv).enabled, false);
});

test('the kill switch keeps every moderation verb out of the internal allowlist', () => {
  // Fails if either half of the co-gate is dropped: website allow-flag alone
  // must not enable a single verb.
  const cfg = loadInternalActionsConfig({
    TWO_INTERNAL_ACTIONS: '1',
    TWO_INTERNAL_KEYS: INTERNAL_KEYS,
    TWO_INTERNAL_ALLOW_MODERATION: '1',
  } as NodeJS.ProcessEnv)!;
  for (const action of MODERATION_ACTIONS) {
    assert.equal(cfg.enabled.has(action), false, `${action} must not be enabled without TWO_MODERATION=1`);
  }
});

test('control: both flags on enables all nine verbs in the allowlist', () => {
  // Without this, the refusal above could pass vacuously - a fixture that can
  // never enable the verbs cannot prove the gate disabled them.
  const cfg = loadInternalActionsConfig({
    TWO_INTERNAL_ACTIONS: '1',
    TWO_INTERNAL_KEYS: INTERNAL_KEYS,
    TWO_INTERNAL_ALLOW_MODERATION: '1',
    TWO_MODERATION: '1',
  } as NodeJS.ProcessEnv)!;
  for (const action of MODERATION_ACTIONS) {
    assert.equal(cfg.enabled.has(action), true, `${action} must be enabled when both flags are set`);
  }
});

test('every moderation verb is refused under the kill switch and Discord stays idle', async () => {
  // Two layers, because each catches a different way to leave a verb live:
  // the allowlist gate (what server.ts checks first) and the unwired-service
  // refusal inside runAction (what holds if the gate is ever bypassed).
  const { client, calls } = idleDiscord();
  const ctx = disabledCtx(client);
  for (const action of MODERATION_ACTIONS) {
    assert.throws(
      () => assertAllowed(action, ctx),
      (e: unknown) => e instanceof ActionError && e.code === 'action_not_allowed' && e.logReason === 'action_disabled',
      `${action} must be refused as disabled under the kill switch`,
    );
    const err = await runAction(action, {}, ctx).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof ActionError, `${action} must throw, got ${String(err)}`);
    assert.equal(err.code, 'action_not_allowed');
    assert.equal(err.logReason, 'moderation_not_configured');
  }
  assert.deepEqual(calls, [], 'a refused verb must not cause any Discord call');
});

test('src/index.ts leaves no moderation path live when the slice is off', async () => {
  // Static, because booting index.ts needs a Discord token, a gateway and a
  // guild. Seven predicates, one per wiring site: dropping any single gate
  // leaves one verb family live while the other six stay off, which is exactly
  // the partial disable this card exists to catch.
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const moderationResolver = !stagingRestartArmed && cfg\.guildId && moderationCfg\.enabled/);
  assert.match(source, /const moderationService = moderationResolver/);
  assert.match(source, /TWO_AUTOMOD=1 requires TWO_MODERATION=1/);
  assert.match(source, /cfg\.guildId && moderationResolver && moderationService\) \{/);
  assert.match(source, /registerModerationHandler\(client, \{/);
  assert.match(source, /moderationResolver && moderationService \? MODERATION_COMMAND_DATA : \[\]/);
  assert.match(source, /moderation: moderationResolver && moderationService/);
  assert.match(source, /const moderationSweep = !stagingRestartArmed && moderationService/);
});
