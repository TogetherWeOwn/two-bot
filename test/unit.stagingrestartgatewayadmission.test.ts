/** Pure, invented wire fixtures only. No genuine handshake or execution claim. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { restartGatewayAdmission as admits } from '../src/staging/restartGatewayAdmission.ts';
import { createRestartGatewayPolicy } from '../src/staging/restartGatewayPolicy.ts';
import { StagingRestartFunnelFirewall } from '../src/staging/restartContainment.ts';
import type { FunnelEvent } from '../src/core/events.ts';
import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const OWNER = '900000000000007101';
const OTHER = '900000000000007102';
const SYN = '900000000000007103';
const CHANNEL = '900000000000007104';
const MEMBER_EVENTS = ['GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE'];
function ready() {
  return {
    v: 10, user: { id: STAGING_BOT_APPLICATION_ID, bot: true },
    application: { id: STAGING_BOT_APPLICATION_ID },
    guilds: [{ id: TWO_STAGING_GUILD_ID, unavailable: true }],
    session_id: 'session-1', resume_gateway_url: 'wss://gateway.discord.gg', shard: [0, 1],
  };
}
function guild() {
  return {
    id: TWO_STAGING_GUILD_ID, owner_id: OWNER,
    roles: [{ id: CHANNEL, permissions: '8' }],
    channels: [{ id: CHANNEL, permission_overwrites: [{ id: OTHER, type: 1, allow: '0', deny: '2048' }] }],
    members: [{ user: { id: OTHER }, roles: [CHANNEL] }],
  };
}
function member(id = OTHER) { return { guild_id: TWO_STAGING_GUILD_ID, user: { id } }; }
function message(id = OTHER) {
  return { guild_id: TWO_STAGING_GUILD_ID, id: '900000000000007105', channel_id: CHANNEL, author: { id } };
}
function fixtures(): Array<[string, Record<string, unknown>]> {
  return [['READY', ready()], ['GUILD_CREATE', guild()],
    ...MEMBER_EVENTS.map((type): [string, Record<string, unknown>] => [type, member()]),
    ['MESSAGE_CREATE', message()]];
}

test('admission retains six bound event types without requiring synthetic owner or actors', () => {
  for (const [type, data] of fixtures()) assert.equal(admits(type, data), true, type);
  for (const id of [OWNER, OTHER, SYN, STAGING_BOT_APPLICATION_ID]) {
    for (const type of MEMBER_EVENTS) assert.equal(admits(type, member(id)), true);
    assert.equal(admits('MESSAGE_CREATE', message(id)), true);
  }
  assert.equal(admits('GUILD_CREATE', { id: TWO_STAGING_GUILD_ID, unavailable: true }), true);
  const { shard: _shard, ...withoutShard } = ready();
  assert.equal(admits('READY', withoutShard), true, 'optional protocol field, not an inferred shard binding');
});

test('wrong guild or bot identity, multiple guilds and inconsistent session declarations refuse', () => {
  for (const id of [LIVE_GUILD_ID, OTHER, '', undefined]) {
    assert.equal(admits('GUILD_CREATE', { ...guild(), id }), false);
    for (const type of MEMBER_EVENTS) assert.equal(admits(type, { ...member(), guild_id: id }), false);
    assert.equal(admits('MESSAGE_CREATE', { ...message(), guild_id: id }), false);
    assert.equal(admits('READY', { ...ready(), guilds: [{ id }] }), false);
  }
  for (const id of [LIVE_BOT_APPLICATION_ID, OTHER, undefined]) {
    assert.equal(admits('READY', { ...ready(), user: { id, bot: true } }), false);
    assert.equal(admits('READY', { ...ready(), application: { id } }), false);
  }
  for (const over of [
    { v: '10' }, { v: 9 }, { user: { id: STAGING_BOT_APPLICATION_ID, bot: false } },
    { guilds: [] }, { guilds: [...ready().guilds, { id: OTHER }] },
    { resume_gateway_url: 'wss://untrusted.invalid' }, { resume_gateway_url: 'ws://127.0.0.1:1/gw' },
    { session_id: '' }, { session_id: 'bad session' }, { session_id: 'x'.repeat(129) },
    { shard: [0, 2] }, { shard: [1, 1] }, { shard: ['0', 1] }, { shard: null }, { shard: [0, 1, 2] },
  ]) assert.equal(admits('READY', { ...ready(), ...over }), false, JSON.stringify(over));
});

test('missing and malformed identity fields fail closed without coercion', () => {
  const badIds = [null, undefined, 123, '', '0', '01'.padEnd(18, '0'), '18446744073709551616', '9'.repeat(21), {}, []];
  for (const id of badIds) {
    assert.equal(admits('GUILD_CREATE', { ...guild(), owner_id: id }), false);
    for (const type of MEMBER_EVENTS) assert.equal(admits(type, { ...member(), user: { id } }), false);
    assert.equal(admits('MESSAGE_CREATE', { ...message(), author: { id } }), false);
    assert.equal(admits('MESSAGE_CREATE', { ...message(), id }), false);
    assert.equal(admits('MESSAGE_CREATE', { ...message(), channel_id: id }), false);
  }
  for (const [type] of fixtures()) {
    for (const data of [undefined, null, [], 'text', 12, {}, true]) assert.equal(admits(type, data), false);
  }
  for (const type of ['VOICE_STATE_UPDATE', 'INTERACTION_CREATE', 'GUILD_MEMBERS_CHUNK', 'GUILD_UPDATE', 'RESUMED', 'UNKNOWN_EVENT', '', 42]) {
    for (const [, data] of fixtures()) assert.equal(admits(type as string, data), false);
  }
});

test('additive vendor keys at every existing object do not become an exact-field admission gate', () => {
  function extend(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(extend);
    if (value && typeof value === 'object') {
      return Object.fromEntries([...Object.entries(value).map(([k, v]) => [k, extend(v)]), ['future_vendor_field', { value: 1 }]]);
    }
    return value;
  }
  for (const [type, data] of fixtures()) assert.equal(admits(type, extend(data)), true, type);
  assert.equal(admits('GUILD_CREATE', {
    ...guild(), presences: [{ user: { id: OTHER } }], threads: [{ id: CHANNEL }], emojis: [{ id: CHANNEL }],
  }), true);
  assert.equal(admits('MESSAGE_CREATE', {
    ...message(), content: 'invented fixture body', mentions: [{ id: OWNER }], attachments: [{ id: CHANNEL }],
  }), true, 'admission is neither field redaction nor persistence permission');
});

test('ownership, roles, permissions, actor ids and vendor fields are never rewritten', () => {
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  for (const [type, data] of fixtures()) {
    const before = structuredClone(data);
    freeze(data);
    assert.equal(admits(type, data), true);
    assert.deepEqual(data, before);
  }
  const strict = createRestartGatewayPolicy(new Set([SYN]));
  assert.equal(strict('GUILD_CREATE', guild()), false, 'strict fixture contract remains separate');
  assert.equal(strict('GUILD_MEMBER_REMOVE', member(OTHER)), false);
});

test('admitted non-synthetic actors still cannot pass the unchanged persistence firewall', async () => {
  const rows: FunnelEvent[] = [];
  const store = { record: async (row: FunnelEvent) => { rows.push(row); return { inserted: true }; } };
  const firewall = new StagingRestartFunnelFirewall(store as never, null, null, new Set([SYN]));
  for (const id of [OWNER, OTHER, SYN]) {
    const data = member(id);
    assert.equal(admits('GUILD_MEMBER_REMOVE', data), true);
    await firewall.onLeave(data.guild_id, data.user.id);
  }
  assert.deepEqual(rows.map((row) => row.memberId), [SYN], 'synthetic positive control, not a dead writer');
});

test('neither admission nor strict fixture predicate is installed by application entrypoints', () => {
  for (const path of ['../src/index.ts', '../src/discord/client.ts']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /restartGatewayAdmission|createRestartGatewayPolicy|restartGatewayStrategy/);
  }
});
