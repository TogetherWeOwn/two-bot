import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalSnapshot,
  configHash,
  driftAgainstAcceptedSpec,
  type GuildConfigSnapshot,
} from '../src/redesign/guildConfig.ts';
import { CATEGORIES, MODERATOR_ROLE, OWNER_ROLE, SERVER_DESCRIPTION, TOPICS, desiredEveryoneOverwrite } from '../src/redesign/clean-slate.ts';
import { planRestore } from '../src/redesign/guildConfigRestore.ts';

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
    emojis: [{ id: id(90), name: 'two', roles: [], require_colons: true, managed: false, animated: false, available: true }],
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
  assert.ok(plan.counts.channels >= 2);
  assert.ok(plan.counts.overwrites >= 1);
  assert.equal(plan.counts.settings, 1);
  assert.equal(plan.counts.emojis, 1);
  assert.ok(plan.operations.every((operation) => operation.method !== ('DELETE' as never)));
});

test('restore refuses a snapshot for another guild and ambiguous targets', () => {
  const source = acceptedSnapshot();
  const current = acceptedSnapshot();
  assert.throws(() => planRestore({ ...source, guildId: id(999) }, current), /does not match target guild/);
  const general = current.channels.find((channel) => channel.name === 'general')!;
  current.channels.push({ ...general, id: id(999) });
  assert.throws(() => planRestore(source, current), /restore is ambiguous/);
});
