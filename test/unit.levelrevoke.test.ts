/**
 * Revoker for the runtime level-role grant (TOG-4963).
 *
 * `applyLevelRoles` (src/leveling/discord.ts) had no named revoker: every
 * staging level-up grant was unrevokable by construction. `removeLevelRoles`
 * is that revoker. These tests use a fake service port and a fake member, so
 * they run without Postgres or Discord.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, type GuildMember } from 'discord.js';
import { applyLevelRoles, removeLevelRoles } from '../src/leveling/discord.ts';
import type { LevelingService, LevelRoleReward } from '../src/leveling/service.ts';
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const REWARDS: LevelRoleReward[] = [
  { level: 5, roleId: '500000000000000001' },
  { level: 10, roleId: '500000000000000002' },
  { level: 20, roleId: '500000000000000003' },
];

function fakeService(rewards: LevelRoleReward[] = REWARDS): LevelingService {
  return { roleRewards: async () => rewards } as unknown as LevelingService;
}

interface FakeRoleState {
  added: string[][];
  removed: string[][];
  throwOnAdd?: Error;
  throwOnRemove?: Error;
}

function fakeMember(opts: {
  guildId?: string;
  held?: string[];
  roleStates?: Record<string, { managed?: boolean; editable?: boolean }>;
  botCanManage?: boolean;
  state?: FakeRoleState;
} = {}): { member: GuildMember; state: FakeRoleState } {
  const state: FakeRoleState = opts.state ?? { added: [], removed: [] };
  const held = new Set(opts.held ?? []);
  const roleStates = opts.roleStates ?? {};
  const guildRoles = new Collection<string, { id: string; managed: boolean; editable: boolean }>();
  for (const reward of REWARDS) {
    const override = roleStates[reward.roleId] ?? {};
    guildRoles.set(reward.roleId, {
      id: reward.roleId,
      managed: override.managed ?? false,
      editable: override.editable ?? true,
    });
  }
  const member = {
    id: '600000000000000001',
    roles: {
      cache: new Collection([...held].map((id: string) => [id, { id }] as [string, { id: string }])),
      add: async (roleIds: string[]) => {
        if (state.throwOnAdd) throw state.throwOnAdd;
        state.added.push([...roleIds]);
        for (const id of roleIds) held.add(id);
      },
      remove: async (roleIds: string[]) => {
        if (state.throwOnRemove) throw state.throwOnRemove;
        state.removed.push([...roleIds]);
        for (const id of roleIds) held.delete(id);
      },
    },
    guild: {
      id: opts.guildId ?? TWO_STAGING_GUILD_ID,
      roles: { cache: guildRoles },
      members: {
        me: opts.botCanManage === false
          ? { permissions: new PermissionsBitField(0n) }
          : { permissions: new PermissionsBitField(['ManageRoles']) },
      },
    },
  } as unknown as GuildMember;
  return { member, state };
}

test('grant then revoke round-trips: revoke removes only unearned held roles', async () => {
  const service = fakeService();
  const { member, state } = fakeMember({ held: [...REWARDS.map((r) => r.roleId)] });
  await applyLevelRoles(member, service, 10);
  await removeLevelRoles(member, service, 10);
  assert.deepEqual(state.removed, [['500000000000000003']]);
});

test('revoke is a no-op when the member holds nothing unearned', async () => {
  const service = fakeService();
  const { member, state } = fakeMember({ held: ['500000000000000001'] });
  await removeLevelRoles(member, service, 10);
  assert.deepEqual(state.removed, []);
});

test('revoke is a no-op when no rewards are configured', async () => {
  const service = fakeService([]);
  const { member, state } = fakeMember({ held: ['500000000000000001'] });
  await removeLevelRoles(member, service, 1);
  assert.deepEqual(state.removed, []);
});

test('revoke refuses the live guild before any DB read or Discord write', async () => {
  let reads = 0;
  const service = {
    roleRewards: async () => { reads += 1; return REWARDS; },
  } as unknown as LevelingService;
  const { member, state } = fakeMember({ guildId: LIVE_GUILD_ID, held: [REWARDS[2].roleId] });
  await assert.rejects(() => removeLevelRoles(member, service, 10), /live guild/);
  assert.equal(reads, 0);
  assert.deepEqual(state.removed, []);
});

test('revoke refuses a non-staging guild before any DB read or Discord write', async () => {
  let reads = 0;
  const service = {
    roleRewards: async () => { reads += 1; return REWARDS; },
  } as unknown as LevelingService;
  const { member, state } = fakeMember({ guildId: '999999999999999999', held: [REWARDS[2].roleId] });
  await assert.rejects(() => removeLevelRoles(member, service, 10), /not the staging guild/);
  assert.equal(reads, 0);
  assert.deepEqual(state.removed, []);
});

test('revoke refuses the whole batch when the bot lacks Manage Roles', async () => {
  const service = fakeService();
  const { member, state } = fakeMember({
    held: [REWARDS[1].roleId, REWARDS[2].roleId],
    botCanManage: false,
  });
  await removeLevelRoles(member, service, 1);
  assert.deepEqual(state.removed, []);
});

test('revoke refuses the whole batch when any target is above the bot', async () => {
  const service = fakeService();
  const { member, state } = fakeMember({
    held: [REWARDS[1].roleId, REWARDS[2].roleId],
    roleStates: { '500000000000000003': { editable: false } },
  });
  await removeLevelRoles(member, service, 1);
  assert.deepEqual(state.removed, []);
});

test('revoke refuses the whole batch when a target role is missing from cache', async () => {
  const service = fakeService([...REWARDS, { level: 30, roleId: '500000000000000004' }]);
  const { member, state } = fakeMember({ held: [REWARDS[2].roleId, '500000000000000004'] });
  await removeLevelRoles(member, service, 10);
  assert.deepEqual(state.removed, []);
});

test('revoke logs and survives a Discord write failure', async () => {
  const service = fakeService();
  const { member, state } = fakeMember({ held: [REWARDS[2].roleId] });
  state.throwOnRemove = new Error('Discord 50013: Missing Permissions');
  await removeLevelRoles(member, service, 10);
  assert.deepEqual(state.removed, []);
});

test('grant failure mode is unchanged: grant still logs and survives', async () => {
  const service = fakeService();
  const { member, state } = fakeMember();
  state.throwOnAdd = new Error('Discord 50013: Missing Permissions');
  await applyLevelRoles(member, service, 10);
  assert.deepEqual(state.added, []);
});
