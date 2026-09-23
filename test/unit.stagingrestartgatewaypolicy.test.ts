/**
 * Bounded strict gateway policy checks (TOG-3903 checkpoint).
 *
 * Pure predicate tests only: handcrafted exact-bound fixtures against the
 * real spec constants, plus fail-closed negatives. No network, no token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRestartGatewayPolicy } from '../src/staging/restartGatewayPolicy.ts';
import type { RestartGatewayPolicy } from '../src/staging/restartGatewayStrategy.ts';
import {
  LIVE_BOT_APPLICATION_ID,
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  TWO_STAGING_GUILD_ID,
} from '../src/staging/spec.ts';

const SYN_OWNER = '900000000000000031';
const SYN_OTHER = '900000000000000032';
const UNBOUND = '900000000000000099';
const MOCK_BOT = '900000000000000002';

function user(id: string, bot: boolean, over: Record<string, unknown> = {}) {
  return {
    id,
    username: bot ? 'staging-bot' : `synth-${id.slice(-2)}`,
    discriminator: '0',
    global_name: bot ? 'staging-bot' : `synth-${id.slice(-2)}`,
    avatar: null,
    bot,
    system: false,
    flags: 0,
    ...over,
  };
}

function ready(over: Record<string, unknown> = {}) {
  return {
    v: 10,
    user: user(STAGING_BOT_APPLICATION_ID, true),
    guilds: [{ id: TWO_STAGING_GUILD_ID, unavailable: true }],
    session_id: 'session-1',
    resume_gateway_url: 'wss://gateway.discord.gg',
    shard: [0, 1],
    application: { id: STAGING_BOT_APPLICATION_ID, flags: 0 },
    ...over,
  };
}

function guildMember(id: string, bot: boolean, over: Record<string, unknown> = {}) {
  return {
    user: user(id, bot),
    roles: [],
    joined_at: '2026-09-01T00:00:00.000Z',
    deaf: false,
    mute: false,
    flags: 0,
    pending: false,
    ...over,
  };
}

function guild(over: Record<string, unknown> = {}) {
  return {
    id: TWO_STAGING_GUILD_ID,
    owner_id: SYN_OWNER,
    unavailable: false,
    roles: [],
    channels: [],
    members: [guildMember(STAGING_BOT_APPLICATION_ID, true), guildMember(SYN_OWNER, false)],
    ...over,
  };
}

function memberEvent(id: string, over: Record<string, unknown> = {}) {
  return {
    guild_id: TWO_STAGING_GUILD_ID,
    user: user(id, false),
    roles: [],
    joined_at: '2026-09-01T00:00:00.000Z',
    deaf: false,
    mute: false,
    pending: false,
    flags: 0,
    ...over,
  };
}

function message(id: string, over: Record<string, unknown> = {}) {
  return {
    id: '1545644954272137311',
    channel_id: '1545644954272137333',
    guild_id: TWO_STAGING_GUILD_ID,
    author: user(id, false),
    content: '',
    timestamp: '2026-09-01T00:00:01.000Z',
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
    ...over,
  };
}

const policy = (): RestartGatewayPolicy =>
  createRestartGatewayPolicy(new Set([SYN_OWNER, SYN_OTHER]));

test('factory validates the allowlist before returning', () => {
  for (const bad of [undefined, null, 'x', [], new Set(['not-an-id']), new Set(['']), new Set([123])]) {
    assert.throws(
      () => createRestartGatewayPolicy(bad as unknown as ReadonlySet<string>),
      { message: 'Staging gateway policy requires synthetic actors as Discord user ids.' },
    );
  }
});

test('empty actor set is closed except the bot handshake', () => {
  const closed = createRestartGatewayPolicy(new Set());
  assert.equal(closed('READY', ready()), true);
  assert.equal(closed('GUILD_MEMBER_ADD', memberEvent(SYN_OWNER)), false);
  assert.equal(closed('MESSAGE_CREATE', message(SYN_OWNER)), false);
  assert.equal(closed('GUILD_CREATE', guild()), false);
});

test('positive exact-bound fixtures admit', () => {
  const p = policy();
  assert.equal(p('READY', ready()), true);
  assert.equal(p('GUILD_CREATE', guild()), true);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(SYN_OWNER)), true);
  assert.equal(p('GUILD_MEMBER_UPDATE', memberEvent(SYN_OTHER)), true);
  assert.equal(p('GUILD_MEMBER_REMOVE', { guild_id: TWO_STAGING_GUILD_ID, user: user(SYN_OWNER, false) }), true);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OTHER)), true);
  assert.equal(
    p('MESSAGE_CREATE', message(SYN_OWNER, { member: { roles: [], joined_at: '2026-09-01T00:00:00.000Z', deaf: false, mute: false, flags: 0, user: user(SYN_OWNER, false) } })),
    true,
  );
});

test('predicate returns literal booleans for malformed shapes', () => {
  const p = policy();
  for (const [type, data] of [
    ['READY', null],
    ['READY', {}],
    ['GUILD_CREATE', []],
    ['MESSAGE_CREATE', 'x'],
    ['GUILD_MEMBER_ADD', undefined],
    [42, {}],
  ] as Array<[unknown, unknown]>) {
    assert.equal(p(type as string, data), false);
  }
});

test('unknown events and unknown keys at every nested level refuse', () => {
  const p = policy();
  assert.equal(p('VOICE_STATE_UPDATE', {}), false);
  assert.equal(p('INTERACTION_CREATE', {}), false);
  assert.equal(p('UNKNOWN_EVENT', {}), false);
  assert.equal(p('READY', ready({ extra: 1 })), false);
  assert.equal(p('READY', ready({ user: user(STAGING_BOT_APPLICATION_ID, true, { extra: 1 }) })), false);
  assert.equal(
    p('GUILD_CREATE', guild({ roles: [{ id: '900000000000000041', name: 'r', color: 0, hoist: false, position: 1, permissions: '0', managed: false, mentionable: false, flags: 0, extra: 1 }] })),
    false,
  );
  assert.equal(
    p('GUILD_CREATE', guild({ channels: [{ id: '900000000000000051', type: 0, guild_id: TWO_STAGING_GUILD_ID, name: 'general', position: 0, permission_overwrites: [{ id: TWO_STAGING_GUILD_ID, type: 0, allow: '0', deny: '0', extra: 1 }] }] })),
    false,
  );
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { author: user(SYN_OWNER, false, { extra: 1 }) })), false);
  assert.equal(
    p('MESSAGE_CREATE', message(SYN_OWNER, { member: { roles: [], joined_at: '2026-09-01T00:00:00.000Z', deaf: false, mute: false, flags: 0, extra: 1 } })),
    false,
  );
});

test('wrong bindings, versions and resume URLs refuse', () => {
  const p = policy();
  assert.equal(p('READY', ready({ v: 9 })), false);
  assert.equal(p('READY', ready({ user: user(LIVE_BOT_APPLICATION_ID, true) })), false);
  assert.equal(p('READY', ready({ user: user(MOCK_BOT, true) })), false);
  assert.equal(p('READY', ready({ resume_gateway_url: 'ws://127.0.0.1:9/gw' })), false);
  assert.equal(p('READY', ready({ shard: [0, 2] })), false);
  assert.equal(p('READY', ready({ guilds: [{ id: TWO_STAGING_GUILD_ID, unavailable: true }, { id: TWO_STAGING_GUILD_ID, unavailable: true }] })), false);
  assert.equal(p('GUILD_CREATE', guild({ id: LIVE_GUILD_ID })), false);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(SYN_OWNER, { guild_id: LIVE_GUILD_ID })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { type: 1 })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { content: 'hi' })), false);
});

test('nested unbound actors refuse, including a whole mixed guild', () => {
  const p = policy();
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(UNBOUND)), false);
  assert.equal(p('GUILD_MEMBER_REMOVE', { guild_id: TWO_STAGING_GUILD_ID, user: user(UNBOUND, false) }), false);
  assert.equal(p('MESSAGE_CREATE', message(UNBOUND)), false);
  assert.equal(p('GUILD_CREATE', guild({ owner_id: UNBOUND })), false);
  assert.equal(
    p('GUILD_CREATE', guild({ members: [guildMember(STAGING_BOT_APPLICATION_ID, true), guildMember(UNBOUND, false)] })),
    false,
  );
  assert.equal(
    p('GUILD_CREATE', guild({ channels: [{ id: '900000000000000051', type: 0, guild_id: TWO_STAGING_GUILD_ID, name: 'general', position: 0, permission_overwrites: [{ id: UNBOUND, type: 1, allow: '1024', deny: '0' }] }] })),
    false,
  );
  assert.equal(
    p('MESSAGE_CREATE', message(SYN_OWNER, { member: { roles: [], joined_at: '2026-09-01T00:00:00.000Z', deaf: false, mute: false, flags: 0, user: user(UNBOUND, false) } })),
    false,
  );
  assert.equal(p('GUILD_CREATE', guild({ owner_id: MOCK_BOT })), false);
});

test('unimplemented guild structures and reply paths refuse', () => {
  const p = policy();
  assert.equal(p('GUILD_CREATE', guild({ presences: [{ user: {} }] })), false);
  assert.equal(p('GUILD_CREATE', guild({ voice_states: [{}] })), false);
  assert.equal(p('GUILD_CREATE', guild({ threads: [{}] })), false);
  assert.equal(p('GUILD_CREATE', guild({ emojis: [{}] })), false);
  assert.equal(p('GUILD_CREATE', guild({ guild_scheduled_events: [{}] })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { referenced_message: { id: '1' } })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { mentions: [{ id: SYN_OTHER }] })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { attachments: [{}] })), false);
});

test('inputs are not mutated or projected', () => {
  const p = policy();
  const input = message(SYN_OWNER);
  const snapshot = structuredClone(input);
  assert.equal(p('MESSAGE_CREATE', input), true);
  assert.deepEqual(input, snapshot);
  const g = guild();
  const gsnap = structuredClone(g);
  assert.equal(p('GUILD_CREATE', g), true);
  assert.deepEqual(g, gsnap);
});

test('nested message member user is fully validated as the author', () => {
  const p = policy();
  const base = { roles: [], joined_at: '2026-09-01T00:00:00.000Z', deaf: false, mute: false, flags: 0 };
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { member: { ...base, user: user(SYN_OWNER, false) } })), true);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { member: { ...base, user: user(SYN_OWNER, false, { username: '' }) } })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { member: { ...base, user: user(SYN_OWNER, false, { global_name: 7 }) } })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { member: { ...base, user: user(SYN_OWNER, false, { avatar: 7 }) } })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { member: { ...base, user: user(SYN_OWNER, false, { flags: NaN }) } })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { member: { ...base, user: user(SYN_OWNER, true, { id: STAGING_BOT_APPLICATION_ID }) } })), false);
});

test('role tag bot_id and guild application_id must be the exact staging bot', () => {
  const p = policy();
  const tagged = (botId: string) => ({
    id: '900000000000000041', name: 'r', color: 0, hoist: false, position: 1,
    permissions: '0', managed: false, mentionable: false, flags: 0, tags: { bot_id: botId },
  });
  assert.equal(p('GUILD_CREATE', guild({ roles: [tagged(STAGING_BOT_APPLICATION_ID)] })), true);
  assert.equal(p('GUILD_CREATE', guild({ roles: [tagged(SYN_OWNER)] })), false);
  assert.equal(p('GUILD_CREATE', guild({ application_id: STAGING_BOT_APPLICATION_ID })), true);
  assert.equal(p('GUILD_CREATE', guild({ application_id: MOCK_BOT })), false);
  assert.equal(p('GUILD_CREATE', guild({ application_id: SYN_OWNER })), false);
});

test('non-finite and non-integer numerics refuse everywhere', () => {
  const p = policy();
  for (const flags of [NaN, Infinity, -1, 1.5]) {
    assert.equal(p('GUILD_MEMBER_ADD', memberEvent(SYN_OWNER, { flags })), false, `member flags=${String(flags)}`);
    assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { member: { roles: [], joined_at: '2026-09-01T00:00:00.000Z', deaf: false, mute: false, flags } })), false);
    assert.equal(p('READY', ready({ application: { id: STAGING_BOT_APPLICATION_ID, flags } })), false);
  }
  assert.equal(
    p('GUILD_CREATE', guild({ roles: [{ id: '900000000000000041', name: 'r', color: 0x1000000, hoist: false, position: 1, permissions: '0', managed: false, mentionable: false, flags: 0 }] })),
    false,
  );
  assert.equal(p('GUILD_CREATE', guild({ member_count: NaN })), false);
});

test('timestamps must be canonical ISO instants', () => {
  const p = policy();
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(SYN_OWNER, { joined_at: 'yesterday' })), false);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(SYN_OWNER, { joined_at: '2026-09-01 00:00:00' })), false);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(SYN_OWNER, { joined_at: '2026-13-99T99:99:99.000Z' })), false);
  assert.equal(p('MESSAGE_CREATE', message(SYN_OWNER, { timestamp: 'not-a-time' })), false);
  assert.equal(p('GUILD_CREATE', guild({ members: [guildMember(STAGING_BOT_APPLICATION_ID, true, { joined_at: 'soon' }), guildMember(SYN_OWNER, false)] })), false);
});

test('allowlist rejects staging/live bot and staging/live guild ids', () => {
  for (const bad of [STAGING_BOT_APPLICATION_ID, LIVE_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID, LIVE_GUILD_ID]) {
    assert.throws(
      () => createRestartGatewayPolicy(new Set([bad])),
      { message: 'Staging gateway policy requires synthetic actors as Discord user ids.' },
    );
  }
});

test('mutating the caller set after construction cannot broaden admission', () => {
  const caller = new Set([SYN_OWNER]);
  const p = createRestartGatewayPolicy(caller);
  caller.add(SYN_OTHER);
  caller.add(UNBOUND);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(SYN_OWNER)), true);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(SYN_OTHER)), false);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(UNBOUND)), false);
  caller.delete(SYN_OWNER);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent(SYN_OWNER)), true);
});

test('nonempty roles/channels/overwrites admit so negatives are not vacuous', () => {
  const p = policy();
  const admitted = guild({
    roles: [
      { id: '900000000000000041', name: 'Member', color: 0, hoist: false, position: 1, permissions: '104324673', managed: false, mentionable: false, flags: 0 },
      { id: '900000000000000042', name: 'Bot', color: 3447003, hoist: true, position: 2, permissions: '0', managed: true, mentionable: false, flags: 0, tags: { bot_id: STAGING_BOT_APPLICATION_ID } },
    ],
    channels: [
      { id: '900000000000000051', type: 0, guild_id: TWO_STAGING_GUILD_ID, name: 'general', position: 0, permission_overwrites: [] },
      { id: '900000000000000052', type: 0, guild_id: TWO_STAGING_GUILD_ID, name: 'gated', position: 1, permission_overwrites: [
        { id: TWO_STAGING_GUILD_ID, type: 0, allow: '0', deny: '1024' },
        { id: SYN_OWNER, type: 1, allow: '1024', deny: '0' },
      ] },
    ],
  });
  assert.equal(p('GUILD_CREATE', admitted), true);
});

test('every object in admitted fixtures refuses an added unknown field', () => {
  const p = policy();
  const fixtures: Array<[string, unknown]> = [
    ['READY', ready()],
    ['GUILD_CREATE', guild({
      roles: [{ id: '900000000000000041', name: 'Bot', color: 0, hoist: false,
        position: 1, permissions: '0', managed: true, mentionable: false, flags: 0,
        tags: { bot_id: STAGING_BOT_APPLICATION_ID } }],
      channels: [{ id: '900000000000000051', type: 0, guild_id: TWO_STAGING_GUILD_ID,
        name: 'general', position: 0, permission_overwrites: [
          { id: SYN_OWNER, type: 1, allow: '1024', deny: '0' },
        ] }],
    })],
    ['GUILD_MEMBER_ADD', memberEvent(SYN_OWNER)],
    ['GUILD_MEMBER_UPDATE', memberEvent(SYN_OWNER)],
    ['GUILD_MEMBER_REMOVE', { guild_id: TWO_STAGING_GUILD_ID, user: user(SYN_OWNER, false) }],
    ['MESSAGE_CREATE', message(SYN_OWNER, { member: {
      roles: [], joined_at: '2026-09-01T00:00:00.000Z', deaf: false, mute: false,
      flags: 0, user: user(SYN_OWNER, false),
    } })],
  ];
  let checked = 0;
  for (const [type, fixture] of fixtures) {
    assert.equal(p(type, fixture), true, `${type} positive control`);
    function visit(value: unknown, path: string[]) {
      if (typeof value !== 'object' || value === null) return;
      if (!Array.isArray(value)) {
        const candidate = structuredClone(fixture) as Record<string, unknown>;
        let target = candidate;
        for (const key of path) target = target[key] as Record<string, unknown>;
        target.unknown_actor = { id: UNBOUND };
        assert.equal(p(type, candidate), false, `${type}.${path.join('.')}`);
        checked++;
      }
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
    visit(fixture, []);
  }
  assert.equal(checked, 23, 'must exercise every object in the six positive fixtures');
});

test('canonical snowflake rejects leading zeros and out-of-uint64 range', () => {
  const p = policy();
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent('090000000000000031')), false);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent('000000000000000000')), false);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent('99999999999999999999')), false);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent('18446744073709551616')), false);
  assert.equal(p('GUILD_MEMBER_ADD', memberEvent('18446744073709551615')), false);
  const boundary = createRestartGatewayPolicy(new Set(['18446744073709551615']));
  assert.equal(boundary('GUILD_MEMBER_ADD', memberEvent('18446744073709551615')), true);
  assert.throws(
    () => createRestartGatewayPolicy(new Set(['18446744073709551616'])),
    { message: 'Staging gateway policy requires synthetic actors as Discord user ids.' },
  );
  assert.throws(
    () => createRestartGatewayPolicy(new Set(['090000000000000031'])),
    { message: 'Staging gateway policy requires synthetic actors as Discord user ids.' },
  );
});
