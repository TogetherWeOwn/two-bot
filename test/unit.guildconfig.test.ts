import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalSnapshot,
  configHash,
  driftAgainstAcceptedSpec,
  type GuildConfigSnapshot,
} from '../src/redesign/guildConfig.ts';
import { CATEGORIES, MODERATOR_ROLE, OWNER_ROLE, SERVER_DESCRIPTION, TOPICS, desiredEveryoneOverwrite } from '../src/redesign/clean-slate.ts';
import { applyRestorePlan, planRestore, snapshotsEqual } from '../src/redesign/guildConfigRestore.ts';
import type { GuildConfigDiscordApi } from '../src/discord/guildConfigApi.ts';

const GUILD = '1545644954272137297';
const APP = '1469137636663758888';
const id = (n: number) => String(900000000000000000n + BigInt(n));

function acceptedSnapshot(): GuildConfigSnapshot {
  const roles = [
    { id: GUILD, name: '@everyone', managed: false, color: 0, hoist: false, permissions: '0', mentionable: false, position: 0 },
    { id: id(1), ...OWNER_ROLE, managed: false, position: 10 },
    { id: id(2), ...MODERATOR_ROLE, managed: false, position: 9 },
    { id: APP, name: 'Owen QA Test', managed: true, color: 0, hoist: true, permissions: String(1n << 3n), mentionable: false, position: 11 },
  ];
  const channels: GuildConfigSnapshot['channels'] = [];
  let next = 20;
  CATEGORIES.forEach((category, categoryPosition) => {
    const categoryId = id(next++);
    channels.push({ id: categoryId, name: category.name, type: 4, parent_id: null, position: categoryPosition, permission_overwrites: [] });
    category.channels.forEach((name, position) => {
      channels.push({
        id: id(next++),
        name,
        type: name === 'Lobby' || name === 'Squad' ? 2 : 0,
        parent_id: categoryId,
        position,
        ...(name in TOPICS ? { topic: TOPICS[name as keyof typeof TOPICS] } : {}),
        permission_overwrites: [desiredEveryoneOverwrite(GUILD, name)],
      });
    });
  });
  return {
    version: 1,
    generatedAt: '2026-09-08T00:00:00.000Z',
    applicationId: APP,
    guildId: GUILD,
    guild: { id: GUILD, name: 'TWO Staging', description: SERVER_DESCRIPTION, verification_level: 2, system_channel_flags: 0 },
    roles,
    channels,
    emojis: [{ id: id(90), name: 'two', roles: [], require_colons: true, managed: false, animated: false, available: true, image: 'data:image/png;base64,dHdv' }],
  };
}

test('accepted spec drift report is empty and hashes ignore generation time and array order', () => {
  const snapshot = acceptedSnapshot();
  const report = driftAgainstAcceptedSpec(snapshot);
  assert.equal(report.counts.drift, 0);
  const reordered = structuredClone(snapshot);
  reordered.generatedAt = '2026-09-09T00:00:00.000Z';
  reordered.roles.reverse();
  reordered.channels.reverse();
  assert.equal(configHash(canonicalSnapshot(reordered)), configHash(canonicalSnapshot(snapshot)));
});

test('drift report names missing roles, channel topics, overwrites, settings and missing channels', () => {
  const snapshot = acceptedSnapshot();
  snapshot.guild.description = 'drifted';
  snapshot.roles = snapshot.roles.filter((role) => role.name !== 'Moderator');
  const general = snapshot.channels.find((channel) => channel.name === 'general')!;
  general.topic = 'wrong';
  general.permission_overwrites = [];
  snapshot.channels = snapshot.channels.filter((channel) => channel.name !== 'Squad');
  const paths = driftAgainstAcceptedSpec(snapshot).drift.map((item) => item.path);
  assert.ok(paths.includes('guild.description'));
  assert.ok(paths.includes('roles.Moderator'));
  assert.ok(paths.some((path) => path.endsWith('general.topic')));
  assert.ok(paths.some((path) => path.endsWith('general.everyoneOverwrite')));
  assert.ok(paths.some((path) => path.endsWith('.Squad')));
});

test('restore plan covers roles, channels, overwrites, guild settings and emoji without deletes', () => {
  const source = acceptedSnapshot();
  const current = acceptedSnapshot();
  current.guild.description = 'wrong';
  current.roles.find((role) => role.name === 'Owner')!.color = 0;
  current.roles = current.roles.filter((role) => role.name !== 'Moderator');
  current.channels.find((channel) => channel.name === 'general')!.permission_overwrites = [];
  current.channels = current.channels.filter((channel) => channel.name !== 'Squad');
  current.emojis = [];
  const plan = planRestore(source, current);
  assert.ok(plan.counts.roles >= 2);
  assert.ok(plan.counts.channels >= 1);
  assert.ok(plan.counts.overwrites >= 1);
  assert.equal(plan.counts.settings, 1);
  assert.equal(plan.counts.emojis, 1);
  assert.ok(plan.operations.every((operation) => operation.method !== ('DELETE' as never)));
});

test('ordering drift is reported and restored with batched role and channel position writes', async () => {
  const source = acceptedSnapshot();
  const current = acceptedSnapshot();
  const owner = current.roles.find((role) => role.name === 'Owner')!;
  const moderator = current.roles.find((role) => role.name === 'Moderator')!;
  [owner.position, moderator.position] = [moderator.position, owner.position];

  const categories = current.channels.filter((channel) => channel.type === 4).sort((a, b) => a.position - b.position);
  [categories[0]!.position, categories[1]!.position] = [categories[1]!.position, categories[0]!.position];
  const child = current.channels.find((channel) => channel.name === 'general')!;
  const sibling = current.channels.find((channel) => channel.name === 'looking-to-play')!;
  [child.position, sibling.position] = [sibling.position, child.position];

  const driftPaths = driftAgainstAcceptedSpec(current).drift.map((item) => item.path);
  assert.ok(driftPaths.includes('roles.positions'));
  assert.ok(driftPaths.includes(`channels.${categories[0]!.name}.position`));
  assert.ok(driftPaths.includes('channels.💬 COMMUNITY.general.position'));

  const plan = planRestore(source, current);
  assert.equal(snapshotsEqual(source, current), false);
  const rolePositions = plan.operations.find((operation) => operation.label === 'restore role positions')!;
  const channelPositions = plan.operations.find((operation) => operation.label === 'restore channel positions')!;
  assert.equal(rolePositions.path, `/guilds/${GUILD}/roles`);
  assert.equal(channelPositions.path, `/guilds/${GUILD}/channels`);

  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const api = {
    async write(method: string, path: string, body: unknown) {
      calls.push({ method, path, body });
      return [];
    },
  } as GuildConfigDiscordApi;
  await applyRestorePlan(api, plan);
  owner.position = source.roles.find((role) => role.name === 'Owner')!.position;
  moderator.position = source.roles.find((role) => role.name === 'Moderator')!.position;
  for (const position of calls[1]!.body as Array<{ id: string; position: number; parent_id?: string | null }>) {
    const channel = current.channels.find((item) => item.id === position.id)!;
    channel.position = position.position;
    if ('parent_id' in position) channel.parent_id = position.parent_id ?? null;
  }
  assert.deepEqual(canonicalSnapshot(current), canonicalSnapshot(source));
  assert.equal(snapshotsEqual(source, current), true);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    `PATCH /guilds/${GUILD}/roles`,
    `PATCH /guilds/${GUILD}/channels`,
  ]);
  assert.deepEqual((calls[0]!.body as Array<{ id: string; position: number }>).map(({ id: roleId, position }) => ({ roleId, position })), [
    { roleId: moderator.id, position: source.roles.find((role) => role.name === 'Moderator')!.position },
    { roleId: owner.id, position: source.roles.find((role) => role.name === 'Owner')!.position },
  ]);
  assert.ok((calls[1]!.body as Array<{ id: string; position: number; parent_id: string | null }>).some((position) => position.id === child.id && position.position === 0 && position.parent_id === child.parent_id));
});

test('restore applies roles, categories, channels and overwrites in dependency order with returned ids', async () => {
  const source = acceptedSnapshot();
  const current = acceptedSnapshot();
  const moderator = source.roles.find((role) => role.name === 'Moderator')!;
  current.roles = current.roles.filter((role) => role.name !== 'Moderator');
  const sourceChannel = source.channels.find((channel) => channel.name === 'Squad')!;
  const sourceCategory = source.channels.find((channel) => channel.id === sourceChannel.parent_id)!;
  sourceChannel.permission_overwrites.push({ id: moderator.id, type: 0, allow: '1', deny: '0' });
  current.channels = current.channels.filter((channel) => channel.id !== sourceCategory.id && channel.parent_id !== sourceCategory.id);

  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const returned = [id(901), id(902), id(903), id(904)];
  const api = {
    async write(method: string, path: string, body: unknown) {
      calls.push({ method, path, body });
      return method === 'POST' && (path.endsWith('/roles') || path.endsWith('/channels')) ? { id: returned.shift() } : {};
    },
  } as GuildConfigDiscordApi;

  await applyRestorePlan(api, planRestore(source, current));
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    `POST /guilds/${GUILD}/roles`,
    `PATCH /guilds/${GUILD}/roles`,
    `POST /guilds/${GUILD}/channels`,
    `POST /guilds/${GUILD}/channels`,
    `POST /guilds/${GUILD}/channels`,
    `PATCH /guilds/${GUILD}/channels`,
    `PATCH /channels/${id(903)}`,
    `PATCH /channels/${id(904)}`,
  ]);
  assert.equal((calls[3]!.body as { parent_id: string }).parent_id, id(902));
  assert.equal((calls[4]!.body as { parent_id: string }).parent_id, id(902));
  assert.deepEqual((calls[7]!.body as { permission_overwrites: Array<{ id: string }> }).permission_overwrites.map((overwrite) => overwrite.id), [GUILD, id(901)]);
});

test('restore preserves same-guild managed role ids in channel overwrites', async () => {
  const source = acceptedSnapshot();
  const current = acceptedSnapshot();
  const general = source.channels.find((channel) => channel.name === 'general')!;
  const currentGeneral = current.channels.find((channel) => channel.name === 'general')!;
  general.permission_overwrites.push({ id: APP, type: 0, allow: '1', deny: '0' });
  currentGeneral.permission_overwrites = currentGeneral.permission_overwrites.filter((overwrite) => overwrite.id !== APP);

  const calls: Array<{ path: string; body: unknown }> = [];
  const api = {
    async write(_method: string, path: string, body: unknown) {
      calls.push({ path, body });
      return {};
    },
  } as GuildConfigDiscordApi;

  await applyRestorePlan(api, planRestore(source, current));
  const restore = calls.find((call) => call.path === `/channels/${currentGeneral.id}`)!;
  assert.deepEqual((restore.body as { permission_overwrites: Array<{ id: string }> }).permission_overwrites.map((overwrite) => overwrite.id), [GUILD, APP]);
});

test('restore applies category overwrites to existing and newly created categories', async () => {
  const source = acceptedSnapshot();
  const current = acceptedSnapshot();
  const categories = source.channels.filter((channel) => channel.type === 4);
  const existingSource = categories[0]!;
  const createdSource = categories[1]!;
  existingSource.permission_overwrites = [{ id: APP, type: 0, allow: '1', deny: '0' }];
  createdSource.permission_overwrites = [{ id: GUILD, type: 0, allow: '0', deny: '2' }];
  const existingCurrent = current.channels.find((channel) => channel.type === 4 && channel.name === existingSource.name)!;
  existingCurrent.permission_overwrites = [];
  current.channels = current.channels.filter((channel) => channel.id !== createdSource.id && channel.parent_id !== createdSource.id);

  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const createdCategoryId = id(905);
  let createdChannel = 905;
  const api = {
    async write(method: string, path: string, body: unknown) {
      calls.push({ method, path, body });
      return method === 'POST' && path.endsWith('/channels') ? { id: id(createdChannel++) } : {};
    },
  } as GuildConfigDiscordApi;

  await applyRestorePlan(api, planRestore(source, current));
  const categoryPatches = calls.filter((call) => call.method === 'PATCH' && 'permission_overwrites' in (call.body as Record<string, unknown>) && (call.path === `/channels/${existingCurrent.id}` || call.path === `/channels/${createdCategoryId}`));
  assert.deepEqual(categoryPatches.map((call) => call.path), [`/channels/${existingCurrent.id}`, `/channels/${createdCategoryId}`]);
  assert.deepEqual((categoryPatches[0]!.body as { permission_overwrites: Array<{ id: string }> }).permission_overwrites.map((overwrite) => overwrite.id), [APP]);
  assert.deepEqual((categoryPatches[1]!.body as { permission_overwrites: Array<{ id: string }> }).permission_overwrites.map((overwrite) => overwrite.id), [GUILD]);
});

test('restore sends emoji image data and refuses a non-restorable snapshot emoji', async () => {
  const source = acceptedSnapshot();
  const current = acceptedSnapshot();
  current.emojis = [];
  const calls: Array<{ path: string; body: unknown }> = [];
  const api = {
    async write(_method: string, path: string, body: unknown) {
      calls.push({ path, body });
      return { id: id(904) };
    },
  } as GuildConfigDiscordApi;

  await applyRestorePlan(api, planRestore(source, current));
  assert.equal(calls.at(-1)!.path, `/guilds/${GUILD}/emojis`);
  assert.equal((calls.at(-1)!.body as { image: string }).image, 'data:image/png;base64,dHdv');

  delete source.emojis[0]!.image;
  assert.throws(() => planRestore(source, current), /has no restorable image data URI/);
});

test('restore refuses a snapshot for another guild and ambiguous targets', () => {
  const source = acceptedSnapshot();
  const current = acceptedSnapshot();
  assert.throws(() => planRestore({ ...source, guildId: id(999) }, current), /does not match target guild/);
  const general = current.channels.find((channel) => channel.name === 'general')!;
  current.channels.push({ ...general, id: id(999) });
  assert.throws(() => planRestore(source, current), /restore is ambiguous/);
});
