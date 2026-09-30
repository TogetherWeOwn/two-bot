import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuildConfigDiscordApi } from '../src/discord/guildConfigApi.ts';
import { canonicalSnapshot, configHash, type GuildConfigSnapshot } from '../src/redesign/guildConfig.ts';
import { applyRestorePlan, planRestore, snapshotsEqual } from '../src/redesign/guildConfigRestore.ts';

const GUILD = '900000000000000001';
const APP = '900000000000000002';
const BOT_ROLE = '900000000000000003';
const MANAGE_ROLES = 1n << 28n;

function fixture(everyonePermissions = '0', botPermissions = MANAGE_ROLES): GuildConfigSnapshot {
  return {
    version: 1,
    generatedAt: '2026-09-30T00:00:00.000Z',
    applicationId: APP,
    guildId: GUILD,
    guild: { id: GUILD, name: 'Restore fixture', owner_id: '900000000000000004' },
    roles: [
      { id: GUILD, name: '@everyone', managed: false, color: 0, hoist: false, permissions: everyonePermissions, mentionable: false, position: 0 },
      { id: BOT_ROLE, name: 'Bot', managed: true, color: 0, hoist: false, permissions: String(botPermissions), mentionable: false, position: 1 },
    ],
    channels: [],
    emojis: [],
  };
}

type Call = { method: string; path: string; body?: unknown };

function memoryApi(current: GuildConfigSnapshot, heldRoleIds = [BOT_ROLE]) {
  const calls: Call[] = [];
  const api = new GuildConfigDiscordApi({
    apiBase: 'http://127.0.0.1/api/v10',
    token: 'synthetic-fixture-token',
    guildId: GUILD,
    applicationId: APP,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname.replace('/api/v10', '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      let response: unknown;
      if (method === 'GET' && path === `/guilds/${GUILD}`) response = current.guild;
      else if (method === 'GET' && path === `/guilds/${GUILD}/roles`) response = current.roles;
      else if (method === 'GET' && path === `/guilds/${GUILD}/channels`) response = current.channels;
      else if (method === 'GET' && path === `/guilds/${GUILD}/emojis`) response = current.emojis;
      else if (method === 'GET' && path === `/guilds/${GUILD}/members/${APP}`) response = { roles: heldRoleIds };
      else if (method === 'PATCH' && path === `/guilds/${GUILD}/roles/${GUILD}`) {
        assert.deepEqual(Object.keys(body), ['permissions']);
        current.roles.find((role) => role.id === GUILD)!.permissions = body.permissions;
        response = current.roles.find((role) => role.id === GUILD);
      } else throw new Error(`Unexpected fixture request: ${method} ${path}`);
      return Response.json(response);
    },
  });
  return { api, calls };
}

for (const [desired, actual] of [['0', '8'], ['1024', '0']]) {
  test(`everyone-only drift ${actual} -> ${desired} patches permissions and closes the canonical hash`, async () => {
    const source = fixture(desired);
    const current = fixture(actual);
    const sourceBefore = structuredClone(source);
    const currentBefore = structuredClone(current);
    const plan = planRestore(source, current);
    assert.equal(snapshotsEqual(source, current), false);
    assert.deepEqual(plan.counts, { roles: 1, channels: 0, overwrites: 0, settings: 0, emojis: 0, operations: 1 });
    assert.deepEqual(plan.operations, [{
      label: 'restore @everyone permissions',
      method: 'PATCH',
      path: `/guilds/${GUILD}/roles/${GUILD}`,
      body: { permissions: desired },
    }]);
    assert.equal(plan.knownIds.roles[GUILD], GUILD);
    assert.deepEqual(source, sourceBefore);
    assert.deepEqual(current, currentBefore);

    const { api, calls } = memoryApi(current);
    const ids = await applyRestorePlan(api, plan);
    assert.deepEqual(calls, [{ method: 'PATCH', path: `/guilds/${GUILD}/roles/${GUILD}`, body: { permissions: desired } }]);
    assert.equal(ids.roles[GUILD], GUILD);
    assert.deepEqual(canonicalSnapshot(current), canonicalSnapshot(source));
    assert.equal(configHash(canonicalSnapshot(current)), configHash(canonicalSnapshot(source)));
    assert.equal(snapshotsEqual(source, current), true);
    assert.equal(planRestore(source, current).counts.operations, 0);
    assert.deepEqual(current.roles.find((role) => role.id === BOT_ROLE), currentBefore.roles.find((role) => role.id === BOT_ROLE));
  });
}

test('everyone no-drift control is a no-op, including apply', async () => {
  const source = fixture();
  const current = fixture();
  const { api, calls } = memoryApi(current);
  const plan = planRestore(source, current);
  assert.equal(snapshotsEqual(source, current), true);
  assert.equal(plan.counts.roles, 0);
  assert.deepEqual(plan.operations, []);
  await applyRestorePlan(api, plan);
  assert.deepEqual(calls, []);
});

test('everyone identity is the guild ID; unsupported field drift never enters its PATCH or position batch', () => {
  const source = fixture();
  const current = fixture('8');
  Object.assign(current.roles[0]!, { name: 'different', color: 123, hoist: true, mentionable: true, position: 9 });
  const plan = planRestore(source, current);
  assert.deepEqual(plan.operations, [{
    label: 'restore @everyone permissions',
    method: 'PATCH',
    path: `/guilds/${GUILD}/roles/${GUILD}`,
    body: { permissions: '0' },
  }]);
  current.roles[0]!.permissions = '0';
  assert.deepEqual(planRestore(source, current).operations, []);
});

test('missing everyone roles are never recreated or matched by name', () => {
  for (const missing of ['source', 'current']) {
    const source = fixture();
    const current = fixture('8');
    (missing === 'source' ? source : current).roles.shift();
    assert.deepEqual(planRestore(source, current).operations, []);
  }
});

test('everyone permission revocation is the last write after other restore operations', () => {
  const source = fixture();
  const current = fixture('8');
  current.guild.name = 'drifted';
  const plan = planRestore(source, current);
  assert.deepEqual(plan.operations.map((operation) => operation.label), [
    'restore guild settings',
    'restore @everyone permissions',
  ]);
});

test('everyone-only preflight refuses missing Manage Roles before any write', async () => {
  const source = fixture('0', 0n);
  const current = fixture('1024', 0n);
  const { api, calls } = memoryApi(current);
  const before = await api.capture();
  const plan = planRestore(source, before);
  assert.equal(plan.counts.roles, 1);
  await assert.rejects(async () => {
    await api.assertRestorePermissions(before, plan);
    await applyRestorePlan(api, plan);
  }, /Restore permission preflight failed: missing Manage Roles/);
  assert.ok(calls.some((call) => call.path === `/guilds/${GUILD}/roles`));
  assert.ok(calls.some((call) => call.path === `/guilds/${GUILD}/members/${APP}`));
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.equal(api.writes, 0);
  assert.equal(current.roles[0]!.permissions, '1024');
});

test('everyone-only preflight accepts existing Manage Roles without Administrator or other management bits', async () => {
  const source = fixture();
  const current = fixture('1024');
  const botBefore = structuredClone(current.roles[1]);
  const { api, calls } = memoryApi(current);
  const before = await api.capture();
  const plan = planRestore(source, before);
  assert.equal(plan.counts.roles, 1);
  await api.assertRestorePermissions(before, plan);
  await applyRestorePlan(api, plan);
  const after = await api.capture();
  assert.deepEqual(calls.filter((call) => call.method !== 'GET'), [
    { method: 'PATCH', path: `/guilds/${GUILD}/roles/${GUILD}`, body: { permissions: '0' } },
  ]);
  assert.equal(api.writes, 1);
  assert.equal(snapshotsEqual(source, after), true);
  assert.deepEqual(current.roles[1], botBefore);
});
