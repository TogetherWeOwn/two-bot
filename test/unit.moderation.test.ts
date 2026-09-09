import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { ActionError } from '../src/internal/errors.ts';
import { assertModerationAllowed } from '../src/moderation/policy.ts';
import { ModerationService } from '../src/moderation/service.ts';
import { ModerationStore } from '../src/moderation/store.ts';
import type { ModerationDiscordClient } from '../src/moderation/discord.ts';
import type { ModerationActionName, ModerationRequest } from '../src/moderation/types.ts';
import { openTestDb } from './helpers/testDb.ts';

const GUILD = '1545644954272137297';
const ACTOR = '900000000000000001';
const TARGET = '900000000000000002';
const OWEN = '900000000000000003';
const STAFF = '900000000000000004';
const CHANNEL = '900000000000000005';
const STAFF_ROLE = '900000000000000006';

function request(action: ModerationActionName): ModerationRequest {
  return {
    action,
    guildId: GUILD,
    actor: {
      userId: ACTOR,
      roleIds: ['900000000000000010'],
      highestRolePosition: 10,
      permissions: ~0n,
    },
    target: {
      userId: TARGET,
      roleIds: [],
      highestRolePosition: 1,
      isBot: false,
      isGuildOwner: false,
    },
    channel: { channelId: CHANNEL, type: 0 },
    reason: 'QA moderation proof',
    durationSeconds: 60,
    count: 5,
    seconds: 10,
  };
}

const policy = { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set([STAFF_ROLE]) };

const REFUSALS: Array<[string, (r: ModerationRequest) => void, string]> = [
  ['missing permission', (r) => { r.actor.permissions = 0n; }, 'actor_missing_permission'],
  ['self target', (r) => { r.target!.userId = ACTOR; }, 'target_self'],
  ['guild owner', (r) => { r.target!.isGuildOwner = true; }, 'target_guild_owner'],
  ['Owen', (r) => { r.target!.userId = OWEN; }, 'target_owen'],
  ['bot', (r) => { r.target!.isBot = true; }, 'target_bot'],
  ['staff role', (r) => { r.target!.roleIds = [STAFF_ROLE]; }, 'target_staff_role'],
  ['actor hierarchy', (r) => { r.target!.highestRolePosition = 10; }, 'actor_hierarchy'],
];

for (const [name, mutate, reason] of REFUSALS) {
  test(`refuses ${name}`, () => {
    const r = request('moderation.ban');
    mutate(r);
    assert.throws(
      () => assertModerationAllowed(r, policy),
      (error: unknown) => error instanceof ActionError && error.code === 'action_not_allowed' && error.logReason === reason,
    );
  });
}

test('checks the permission required by every action family', () => {
  const cases: Array<[ModerationActionName, bigint]> = [
    ['moderation.ban', PermissionFlagsBits.BanMembers],
    ['moderation.tempban', PermissionFlagsBits.BanMembers],
    ['moderation.kick', PermissionFlagsBits.KickMembers],
    ['moderation.timeout', PermissionFlagsBits.ModerateMembers],
    ['moderation.warn', PermissionFlagsBits.ModerateMembers],
    ['moderation.purge', PermissionFlagsBits.ManageMessages],
    ['moderation.slowmode', PermissionFlagsBits.ManageChannels],
    ['moderation.lockdown', PermissionFlagsBits.ManageChannels],
    ['moderation.unlock', PermissionFlagsBits.ManageChannels],
  ];
  for (const [action, permission] of cases) {
    const r = request(action);
    r.actor.permissions = permission;
    assert.doesNotThrow(() => assertModerationAllowed(r, policy), action);
    r.actor.permissions = 0n;
    assert.throws(() => assertModerationAllowed(r, policy), action);
  }
});

test('executes every verb and writes warnings, audits, and scheduled tempban expiry', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const calls: string[] = [];
  const discord: ModerationDiscordClient = {
    async ban(_g, u) { calls.push(`ban:${u}`); },
    async unban(_g, u) { calls.push(`unban:${u}`); },
    async kick(_g, u) { calls.push(`kick:${u}`); },
    async timeout(_g, u) { calls.push(`timeout:${u}`); },
    async purge(_c, count) { calls.push(`purge:${count}`); return count; },
    async setSlowmode(_c, seconds) { calls.push(`slowmode:${seconds}`); },
    async getEveryoneOverwrite() { calls.push('overread'); return { allow: '1024', deny: '8192' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite(_c, _g, ow) { calls.push(`over:${ow.allow}/${ow.deny}`); },
  };
  const store = new ModerationStore(testDb.db, () => Date.parse('2026-09-08T12:00:00.000Z'));
  const service = new ModerationService(discord, store, policy, () => Date.parse('2026-09-08T12:00:00.000Z'));
  const actions: ModerationActionName[] = [
    'moderation.ban', 'moderation.tempban', 'moderation.kick', 'moderation.timeout',
    'moderation.warn', 'moderation.purge', 'moderation.slowmode', 'moderation.lockdown', 'moderation.unlock',
  ];
  for (const [index, action] of actions.entries()) {
    await service.execute({ ...request(action), requestId: `request-${index}`, idempotencyKey: `interaction-${index}` });
  }

  assert.deepEqual(calls, [
    `ban:${TARGET}`, `ban:${TARGET}`, `kick:${TARGET}`, `timeout:${TARGET}`,
    'purge:5', 'slowmode:10',
    // Lockdown preserves the other bits of the @everyone overwrite it read
    // (allow 1024, deny 8192) and adds only the SendMessages deny; unlock
    // restores the recorded prior masks exactly, without a second read
    // (TOG-1659 High 1).
    'overread', `over:1024/${8192n | 2048n}`, 'over:1024/8192',
  ]);
  assert.equal((await testDb.db.prepare('SELECT * FROM moderation_audit').all()).length, 9);
  assert.equal((await testDb.db.prepare('SELECT * FROM moderation_warnings').all()).length, 1);
  assert.equal((await testDb.db.prepare('SELECT * FROM moderation_scheduled_unbans').all()).length, 1);
  const replay = await service.execute({ ...request('moderation.ban'), requestId: 'request-retry', idempotencyKey: 'interaction-0' });
  assert.deepEqual(replay, { outcome: 'banned', replayed: true });
  assert.equal(calls.filter((call) => call === `ban:${TARGET}`).length, 2, 'interaction replay made no new call');
  await testDb.cleanup();
});

test('concurrent executes of one idempotency key make exactly one Discord call (TOG-1659 High 3)', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let bans = 0;
  // Every caller must observe the same gate: the second claim waits until the
  // first has either completed or released. A gate that resolves before the
  // Discord call starts would let both through.
  const discord: ModerationDiscordClient = {
    async ban() { bans++; },
    async unban() {}, async kick() {}, async timeout() {},
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite() {},
  };
  const store = new ModerationStore(testDb.db);
  const service = new ModerationService(discord, store, policy);
  const attempts = await Promise.allSettled([
    service.execute({ ...request('moderation.ban'), requestId: 'r-a', idempotencyKey: 'key-1' }),
    service.execute({ ...request('moderation.ban'), requestId: 'r-b', idempotencyKey: 'key-1' }),
  ]);
  assert.equal(bans, 1, `one ban, got ${bans}`);
  const rejected = attempts.filter((a) => a.status === 'rejected');
  const replayed = attempts.filter((a) => a.status === 'fulfilled' && a.value.replayed === true);
  assert.equal(rejected.length + replayed.length, 1, 'the loser is refused or receives the completed replay');
  if (rejected[0]) {
    assert.ok(rejected[0].reason instanceof ActionError);
    assert.equal(rejected[0].reason.code, 'in_progress');
  }
  await testDb.cleanup();
});

test('an uncertain Discord failure keeps the claim and cannot repeat a destructive action', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let callsMade = 0;
  const discord: ModerationDiscordClient = {
    async ban() { callsMade++; throw new ActionError('discord_unavailable', 'boom', { logReason: 'test' }); },
    async unban() {}, async kick() {}, async timeout() {},
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite() {},
  };
  const store = new ModerationStore(testDb.db);
  const service = new ModerationService(discord, store, policy);
  await assert.rejects(
    () => service.execute({ ...request('moderation.ban'), requestId: 'r-1', idempotencyKey: 'key-x' }),
    (error: unknown) => error instanceof ActionError && error.code === 'discord_unavailable',
  );
  await assert.rejects(
    () => service.execute({ ...request('moderation.ban'), requestId: 'r-2', idempotencyKey: 'key-x' }),
    (error: unknown) => error instanceof ActionError && error.code === 'in_progress',
  );
  assert.equal(callsMade, 1, 'an uncertain result is not retried');
  await testDb.cleanup();
});

test('validation fails before the claim, so a corrected request can reuse its key', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let callsMade = 0;
  const discord: ModerationDiscordClient = {
    async ban() { callsMade++; }, async unban() {}, async kick() {}, async timeout() {},
    async purge(_c, count) { callsMade++; return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; }, async deleteEveryoneOverwrite() {}, async putEveryoneOverwrite() {},
  };
  const service = new ModerationService(discord, new ModerationStore(testDb.db), policy);
  await assert.rejects(() => service.execute({
    ...request('moderation.purge'), count: 101, requestId: 'bad', idempotencyKey: 'same-key',
  }), (error: unknown) => error instanceof ActionError && error.code === 'malformed');
  await service.execute({ ...request('moderation.purge'), count: 2, requestId: 'good', idempotencyKey: 'same-key' });
  assert.equal(callsMade, 1);
  await testDb.cleanup();
});

test('stale moderation claims are never taken over automatically', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let clock = Date.parse('2026-09-08T12:00:00.000Z');
  const store = new ModerationStore(testDb.db, () => clock);
  assert.deepEqual(await store.claim('g', 'key-stale', 'moderation.ban', 'hash'), { state: 'claimed' });
  clock += 24 * 60 * 60 * 1000;
  assert.deepEqual(await store.claim('g', 'key-stale', 'moderation.ban', 'hash'), { state: 'in_flight' });
  await testDb.cleanup();
});

test('a completed inner moderation action returns its stored result for outer recovery', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let bans = 0;
  const discord: ModerationDiscordClient = {
    async ban() { bans++; }, async unban() {}, async kick() {}, async timeout() {},
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; }, async deleteEveryoneOverwrite() {}, async putEveryoneOverwrite() {},
  };
  const service = new ModerationService(discord, new ModerationStore(testDb.db), policy);
  const first = await service.execute({ ...request('moderation.ban'), requestId: 'inner-1', idempotencyKey: 'inner-key' });
  const replay = await service.execute({ ...request('moderation.ban'), requestId: 'inner-2', idempotencyKey: 'inner-key' });
  assert.equal(first.outcome, 'banned');
  assert.deepEqual(replay, { outcome: 'banned', replayed: true });
  assert.equal(bans, 1);
  await testDb.cleanup();
});

test('a key reused for different content is named as a mismatch, never silently replayed', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const discord: ModerationDiscordClient = {
    async ban() {}, async unban() {}, async kick() {}, async timeout() {},
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite() {},
  };
  const store = new ModerationStore(testDb.db);
  const service = new ModerationService(discord, store, policy);
  await service.execute({ ...request('moderation.ban'), requestId: 'r-1', idempotencyKey: 'key-m' });
  const other = request('moderation.ban');
  other.reason = 'a different reason';
  await assert.rejects(
    () => service.execute({ ...other, requestId: 'r-2', idempotencyKey: 'key-m' }),
    (error: unknown) => error instanceof ActionError && error.code === 'malformed'
      && error.logReason === 'moderation_idempotency_key_reused',
  );
  await testDb.cleanup();
});

test('tempban persists the unban job before the ban; a crash after the ban still expires (TOG-1659 High 2)', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const order: string[] = [];
  const discord: ModerationDiscordClient = {
    async ban() {
      order.push('ban');
      // Crash of the whole process right here: nothing after the Discord
      // mutation runs - no audit row, no idempotency completion.
      throw new Error('process died after Discord accepted the ban');
    },
    async unban() { order.push('unban'); }, async kick() {}, async timeout() {},
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite() {},
  };
  const store = new ModerationStore(testDb.db);
  const service = new ModerationService(discord, store, policy);
  await assert.rejects(() => service.execute({
    ...request('moderation.tempban'), requestId: 'r-tb', idempotencyKey: 'key-tb',
  }));
  // The job exists even though the request failed after the ban.
  const jobs = await testDb.db
    .prepare(`SELECT guild_id, user_id, state FROM moderation_scheduled_unbans`)
    .all();
  assert.equal(jobs.length, 1, 'the expiry job outlived the failed request');
  await testDb.cleanup();
});

test('a second tempban of the same user moves the one pending job, not a second one', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const discord: ModerationDiscordClient = {
    async ban() {}, async unban() {}, async kick() {}, async timeout() {},
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite() {},
  };
  const store = new ModerationStore(testDb.db);
  const service = new ModerationService(discord, store, policy);
  await service.execute({ ...request('moderation.tempban'), requestId: 'r-t1', idempotencyKey: 'k-t1' });
  const second = request('moderation.tempban');
  second.durationSeconds = 3600;
  await service.execute({ ...second, requestId: 'r-t2', idempotencyKey: 'k-t2' });
  const rows = await testDb.db
    .prepare(`SELECT state, execute_at FROM moderation_scheduled_unbans ORDER BY created_at`)
    .all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.state), ['superseded', 'pending']);
  await testDb.cleanup();
});

test('an extended tempban revokes an old running unban claim', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const discord: ModerationDiscordClient = {
    async ban() {}, async unban() {}, async kick() {}, async timeout() {},
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; }, async deleteEveryoneOverwrite() {}, async putEveryoneOverwrite() {},
  };
  let t = Date.parse('2026-09-08T12:00:00.000Z');
  const store = new ModerationStore(testDb.db, () => t);
  const service = new ModerationService(discord, store, policy, () => t);
  await service.execute({ ...request('moderation.tempban'), requestId: 'old', idempotencyKey: 'old-key' });
  t += 120_000;
  const [oldClaim] = await store.claimDueUnbans();
  const extension = request('moderation.tempban');
  extension.durationSeconds = 3600;
  await service.execute({ ...extension, requestId: 'new', idempotencyKey: 'new-key' });
  assert.equal(await store.ownsUnbanClaim(oldClaim.requestId, oldClaim.claimToken), false);
  const rows = await testDb.db.prepare(`SELECT request_id, state FROM moderation_scheduled_unbans ORDER BY request_id`).all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { request_id: 'new', state: 'pending' },
    { request_id: 'old', state: 'superseded' },
  ]);
  await testDb.cleanup();
});

test('runDueUnbans claims atomically: two sweeps never process the same job (TOG-1659 High 4)', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let unbans = 0;
  const discord: ModerationDiscordClient = {
    async ban() {}, async kick() {}, async timeout() {},
    async unban() { unbans++; },
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite() {},
  };
  let t = Date.parse('2026-09-08T12:00:00.000Z');
  const store = new ModerationStore(testDb.db, () => t);
  const service = new ModerationService(discord, store, policy, () => t);
  await service.execute({ ...request('moderation.tempban'), requestId: 'r-u1', idempotencyKey: 'k-u1' });
  t += 120_000; // past expiry
  const [a, b] = await Promise.all([service.runDueUnbans(), service.runDueUnbans()]);
  assert.equal(unbans, 1, `one unban, got ${unbans}`);
  assert.equal(a + b, 1, 'exactly one sweep reports the job');
  await testDb.cleanup();
});

test('a failed unban is requeued and retried by the next sweep', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let attempts = 0;
  const discord: ModerationDiscordClient = {
    async ban() {}, async kick() {}, async timeout() {},
    async unban() { attempts++; if (attempts === 1) throw new ActionError('discord_rejected', 'boom', { logReason: 'test' }); },
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite() {},
  };
  let t = Date.parse('2026-09-08T12:00:00.000Z');
  const store = new ModerationStore(testDb.db, () => t);
  const service = new ModerationService(discord, store, policy, () => t);
  await service.execute({ ...request('moderation.tempban'), requestId: 'r-f1', idempotencyKey: 'k-f1' });
  t += 120_000;
  await assert.rejects(() => service.runDueUnbans());
  const requeued = await testDb.db
    .prepare(`SELECT state FROM moderation_scheduled_unbans WHERE request_id = 'r-f1'`)
    .get();
  assert.equal(requeued?.state, 'pending', 'the failed job went back to pending');
  await service.runDueUnbans();
  assert.equal(attempts, 2, 'the next sweep retried it');
  await testDb.cleanup();
});

test('a failed job does not strand later jobs in the same claimed batch', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const attempts: string[] = [];
  const discord: ModerationDiscordClient = {
    async ban() {}, async kick() {}, async timeout() {},
    async unban(_g, userId) {
      attempts.push(userId);
      if (userId === TARGET) throw new ActionError('discord_rejected', 'known refusal', { logReason: 'test' });
    },
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; }, async deleteEveryoneOverwrite() {}, async putEveryoneOverwrite() {},
  };
  let t = Date.parse('2026-09-08T12:00:00.000Z');
  const store = new ModerationStore(testDb.db, () => t);
  const service = new ModerationService(discord, store, policy, () => t);
  await store.scheduleUnban(GUILD, TARGET, new Date(t).toISOString(), 'first', 'batch-1');
  await store.scheduleUnban(GUILD, STAFF, new Date(t).toISOString(), 'second', 'batch-2');
  await assert.rejects(() => service.runDueUnbans());
  assert.deepEqual(attempts, [TARGET, STAFF]);
  const states = await testDb.db.prepare(`SELECT request_id, state FROM moderation_scheduled_unbans ORDER BY request_id`).all();
  assert.deepEqual(states.map((row) => ({ ...row })), [
    { request_id: 'batch-1', state: 'pending' },
    { request_id: 'batch-2', state: 'done' },
  ]);
  await testDb.cleanup();
});

test('an uncertain running unban is never taken over automatically', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let t = Date.parse('2026-09-08T12:00:00.000Z');
  const store = new ModerationStore(testDb.db, () => t);
  await store.scheduleUnban(GUILD, TARGET, new Date(t).toISOString(), 'expired', 'r-s1');
  const claimed = await store.claimDueUnbans();
  assert.equal(claimed.length, 1);
  t += 24 * 60 * 60 * 1000;
  assert.deepEqual(await store.claimDueUnbans(), []);
  assert.equal(await store.ownsUnbanClaim(claimed[0].requestId, claimed[0].claimToken), true);
  await testDb.cleanup();
});

test('repeated lockdown preserves the first masks and failed unlock keeps recovery state', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let current = { allow: '1024', deny: '8192' };
  let failRestore = true;
  const writes: string[] = [];
  const discord: ModerationDiscordClient = {
    async ban() {}, async unban() {}, async kick() {}, async timeout() {},
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return current; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite(_c, _g, ow) {
      writes.push(`${ow.allow}/${ow.deny}`);
      if (failRestore && ow.allow === '1024' && ow.deny === '8192') {
        throw new ActionError('discord_unavailable', 'restore failed', { logReason: 'test' });
      }
      current = ow;
    },
  };
  const store = new ModerationStore(testDb.db);
  const service = new ModerationService(discord, store, policy);
  await service.execute({ ...request('moderation.lockdown'), requestId: 'lock-1', idempotencyKey: 'lock-key-1' });
  await service.execute({ ...request('moderation.lockdown'), requestId: 'lock-2', idempotencyKey: 'lock-key-2' });
  await assert.rejects(() => service.execute({
    ...request('moderation.unlock'), requestId: 'unlock-1', idempotencyKey: 'unlock-key-1',
  }));
  assert.deepEqual(await store.getLockdown(CHANNEL), {
    channelId: CHANNEL, guildId: GUILD, priorAllow: '1024', priorDeny: '8192',
    priorExists: true, reason: 'QA moderation proof',
  });
  failRestore = false;
  await service.execute({ ...request('moderation.unlock'), requestId: 'unlock-2', idempotencyKey: 'unlock-key-2' });
  assert.equal(await store.getLockdown(CHANNEL), null);
  assert.equal(current.allow, '1024');
  assert.equal(current.deny, '8192');
  assert.deepEqual(writes.slice(0, 2), [`1024/${8192n | 2048n}`, `1024/${8192n | 2048n}`]);
  await testDb.cleanup();
});

test('unlock with no recorded lockdown clears only the SendMessages deny', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const writes: string[] = [];
  const discord: ModerationDiscordClient = {
    async ban() {}, async unban() {}, async kick() {}, async timeout() {},
    async purge(_c, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '1024', deny: `${8192n | 2048n}` }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite(_c, _g, ow) { writes.push(`${ow.allow}/${ow.deny}`); },
  };
  const store = new ModerationStore(testDb.db);
  const service = new ModerationService(discord, store, policy);
  await service.execute({ ...request('moderation.unlock'), requestId: 'r-ul', idempotencyKey: 'k-ul' });
  // 1024 (ViewChannel) kept in allow; 8192 (ManageMessages-ish deny) kept,
  // 2048 (SendMessages) cleared from deny. Nothing else invented.
  assert.deepEqual(writes, [`1024/8192`]);
  await testDb.cleanup();
});

test('rejects bounded values before any Discord call', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const discord = new Proxy({}, {
    get() { return async () => { throw new Error('Discord must not be called'); }; },
  }) as ModerationDiscordClient;
  const service = new ModerationService(discord, new ModerationStore(testDb.db), policy);
  for (const [action, field, value] of [
    ['moderation.purge', 'count', 101],
    ['moderation.slowmode', 'seconds', 21601],
    ['moderation.timeout', 'durationSeconds', 28 * 24 * 60 * 60 + 1],
  ] as const) {
    await assert.rejects(
      () => service.execute({ ...request(action), [field]: value, requestId: `${action}-bad`, idempotencyKey: `${action}-bad` }),
      (error: unknown) => error instanceof ActionError && error.code === 'malformed',
    );
  }
  await testDb.cleanup();
});
