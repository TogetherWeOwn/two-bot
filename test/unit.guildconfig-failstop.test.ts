import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRestorePlan, type RestoreIdMap, type RestorePlan } from '../src/redesign/guildConfigRestore.ts';
import type { GuildConfigDiscordApi } from '../src/discord/guildConfigApi.ts';

type WriteCall = { method: string; path: string; body: unknown };

function dependencyPlan(): RestorePlan {
  return {
    counts: { roles: 1, channels: 1, overwrites: 1, settings: 1, emojis: 0, operations: 4 },
    knownIds: { roles: { 'source-guild': 'target-guild' }, channels: { 'source-category': 'target-category' }, emojis: {} },
    roleTargets: [{ currentId: null, name: 'Moderator', position: 0 }],
    overwriteRoles: [],
    overwriteTargets: [],
    operations: [
      {
        label: 'create role Moderator',
        method: 'POST',
        path: '/guilds/target-guild/roles',
        body: { name: 'Moderator' },
        captureId: { resource: 'role', sourceId: 'source-role' },
      },
      {
        label: 'create channel general',
        method: 'POST',
        path: '/guilds/target-guild/channels',
        body: {
          name: 'general',
          type: 0,
          parent_id: { restoreReference: 'channel', sourceId: 'source-category' },
          permission_overwrites: [{ id: { restoreReference: 'role', sourceId: 'source-role' }, type: 0, allow: '1', deny: '0' }],
        },
        captureId: { resource: 'channel', sourceId: 'source-channel' },
      },
      {
        label: 'restore channel overwrites general',
        method: 'PATCH',
        path: { channelSourceId: 'source-channel' },
        body: { permission_overwrites: [{ id: { restoreReference: 'role', sourceId: 'source-role' }, type: 0, allow: '2', deny: '0' }] },
      },
      {
        label: 'restore guild settings',
        method: 'PATCH',
        path: '/guilds/target-guild',
        body: { system_channel_id: { restoreReference: 'channel', sourceId: 'source-channel' } },
      },
    ],
  };
}

const expectedCalls: WriteCall[] = [
  { method: 'POST', path: '/guilds/target-guild/roles', body: { name: 'Moderator' } },
  {
    method: 'POST',
    path: '/guilds/target-guild/channels',
    body: {
      name: 'general',
      type: 0,
      parent_id: 'target-category',
      permission_overwrites: [{ id: 'created-role', type: 0, allow: '1', deny: '0' }],
    },
  },
  {
    method: 'PATCH',
    path: '/channels/created-channel',
    body: { permission_overwrites: [{ id: 'created-role', type: 0, allow: '2', deny: '0' }] },
  },
  { method: 'PATCH', path: '/guilds/target-guild', body: { system_channel_id: 'created-channel' } },
];

for (const failureIndex of [0, 2]) {
  test(`restore stops at rejected ${failureIndex === 0 ? 'first' : 'middle'} operation without returning an id map`, async () => {
    const plan = dependencyPlan();
    const before = structuredClone(plan);
    const rejection = new Error('fake write rejected');
    const calls: WriteCall[] = [];
    const api = {
      async write(method: string, path: string, body: unknown) {
        const index = calls.length;
        calls.push({ method, path, body });
        if (index === failureIndex) throw rejection;
        return { id: index === 0 ? 'created-role' : 'created-channel' };
      },
    } as GuildConfigDiscordApi;
    let returnedIds: RestoreIdMap | undefined;

    await assert.rejects(applyRestorePlan(api, plan).then((ids) => { returnedIds = ids; }), (error) => error === rejection);
    // Completed writes remain recorded; fail-stop is not rollback.
    assert.deepEqual(calls, expectedCalls.slice(0, failureIndex + 1));
    assert.equal(returnedIds, undefined);
    assert.deepEqual(plan, before);
  });
}

for (const failureIndex of [0, 1]) {
  for (const response of [null, {}]) {
    const resource = failureIndex === 0 ? 'role' : 'channel';
    test(`restore stops when created ${resource} returns ${response === null ? 'null' : 'no id'} before using its dependency`, async () => {
      const plan = dependencyPlan();
      const before = structuredClone(plan);
      const calls: WriteCall[] = [];
      const api = {
        async write(method: string, path: string, body: unknown) {
          const index = calls.length;
          calls.push({ method, path, body });
          return index === failureIndex ? response : { id: index === 0 ? 'created-role' : 'created-channel' };
        },
      } as GuildConfigDiscordApi;
      let returnedIds: RestoreIdMap | undefined;

      await assert.rejects(applyRestorePlan(api, plan).then((ids) => { returnedIds = ids; }), {
        name: 'Error',
        message: `${plan.operations[failureIndex]!.label} returned no Discord id.`,
      });
      assert.deepEqual(calls, expectedCalls.slice(0, failureIndex + 1));
      assert.equal(returnedIds, undefined);
      assert.deepEqual(plan, before);
    });
  }
}

test('restore captures valid ids, resolves nested role and channel dependencies, and returns the complete map', async () => {
  const plan = dependencyPlan();
  const before = structuredClone(plan);
  const calls: WriteCall[] = [];
  const api = {
    async write(method: string, path: string, body: unknown) {
      const index = calls.length;
      calls.push({ method, path, body });
      return index < 2 ? { id: index === 0 ? 'created-role' : 'created-channel' } : {};
    },
  } as GuildConfigDiscordApi;

  const ids = await applyRestorePlan(api, plan);
  assert.deepEqual(calls, expectedCalls);
  assert.deepEqual(ids, {
    roles: { 'source-guild': 'target-guild', 'source-role': 'created-role' },
    channels: { 'source-category': 'target-category', 'source-channel': 'created-channel' },
    emojis: {},
  });
  assert.deepEqual(plan, before);
});
