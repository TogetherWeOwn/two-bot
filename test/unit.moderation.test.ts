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
    async setLockdown(_c, _g, locked) { calls.push(locked ? 'lockdown' : 'unlock'); },
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
    'purge:5', 'slowmode:10', 'lockdown', 'unlock',
  ]);
  assert.equal((await testDb.db.prepare('SELECT * FROM moderation_audit').all()).length, 9);
  assert.equal((await testDb.db.prepare('SELECT * FROM moderation_warnings').all()).length, 1);
  assert.equal((await testDb.db.prepare('SELECT * FROM moderation_scheduled_unbans').all()).length, 1);
  await assert.rejects(
    () => service.execute({ ...request('moderation.ban'), requestId: 'request-retry', idempotencyKey: 'interaction-0' }),
    (error: unknown) => error instanceof ActionError && error.code === 'replayed',
  );
  assert.equal(calls.filter((call) => call === `ban:${TARGET}`).length, 2, 'interaction replay made no new call');
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
