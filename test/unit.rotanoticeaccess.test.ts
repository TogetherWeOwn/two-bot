import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Client, PermissionFlagsBits } from 'discord.js';
import { verifyRotaNoticeAccess } from '../src/discord/rotaNoticeAccess.ts';

// All ids below are synthetic fixtures, not real Discord snowflakes.
const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002';
const BOT = '100000000000000003';
const READER_A = '100000000000000004';
const READER_B = '100000000000000005';
const OUTSIDER = '100000000000000006';
const OWNER = '100000000000000007';

const VIEW = PermissionFlagsBits.ViewChannel;
const HISTORY = PermissionFlagsBits.ReadMessageHistory;
const SEND = PermissionFlagsBits.SendMessages;
const FULL_BOT = VIEW | HISTORY | SEND;
const FULL_READER = VIEW | HISTORY;

interface HarnessOpts {
  members?: { id: string; bot: boolean; flags: bigint }[];
  allowed?: string[];
  everyoneView?: boolean;
  countBefore?: number | null;
  countAfter?: number | null;
  dropFromCensus?: string[];
  partialMemberId?: string;
  channelType?: number;
  channelId?: string;
  channelGuildId?: string;
  channelPartial?: boolean;
  channelNull?: boolean;
  guildId?: string;
  guildNull?: boolean;
  guildPartial?: boolean;
  available?: boolean;
  ownerId?: string | null;
  everyoneId?: string;
  clientUser?: { id: string; bot: boolean } | null;
  throwAt?: 'guild' | 'roles' | 'channel' | 'members' | 'botMember' | null;
  botFetchId?: string;
}

function buildHarness(opts: HarnessOpts = {}) {
  const members = opts.members ?? [
    { id: BOT, bot: true, flags: FULL_BOT },
    { id: READER_A, bot: false, flags: FULL_READER },
    { id: READER_B, bot: false, flags: FULL_READER },
    { id: OUTSIDER, bot: false, flags: 0n },
  ];
  const flags = new Map(members.map((m) => [m.id, m.flags]));
  const everyoneView = opts.everyoneView ?? false;

  const channelPermissionsFor = (target: any) => {
    if (!target) return undefined;
    // The @everyone role mock carries no .user; members always do.
    if (!target.user) return { has: (bits: bigint) => (bits & VIEW) === bits && everyoneView };
    const held = flags.get(target.id) ?? 0n;
    return { has: (bits: bigint) => (held & bits) === bits };
  };

  const channel: any = opts.channelNull ? null : {
    id: opts.channelId ?? CHANNEL,
    type: opts.channelType ?? ChannelType.GuildText,
    partial: opts.channelPartial ?? false,
    guild: { id: opts.channelGuildId ?? GUILD },
    permissionsFor: channelPermissionsFor,
  };

  const calls: unknown[] = [];
  const full = new Map<string, any>();
  for (const m of members) {
    if (opts.dropFromCensus?.includes(m.id)) continue;
    full.set(m.id, {
      id: m.id,
      partial: opts.partialMemberId === m.id,
      guild: { id: GUILD },
      user: { id: m.id, bot: m.bot, partial: false },
    });
  }
  const guild: any = opts.guildNull ? null : {
    id: opts.guildId ?? GUILD,
    partial: opts.guildPartial ?? false,
    available: opts.available ?? true,
    ownerId: opts.ownerId === undefined ? READER_A : opts.ownerId,
    approximateMemberCount: opts.countBefore === undefined ? members.length : opts.countBefore,
    roles: {
      everyone: { id: opts.everyoneId ?? GUILD },
      fetch: async () => {
        calls.push('roles');
        if (opts.throwAt === 'roles') throw new Error('roles fetch failed');
        return new Map([[GUILD, { id: opts.everyoneId ?? GUILD, guild: { id: GUILD } }]]);
      },
    },
    channels: {
      fetch: async (...args: unknown[]) => {
        calls.push(['channel', ...args]);
        if (opts.throwAt === 'channel') throw new Error('channel fetch failed');
        return channel;
      },
    },
    members: {
      fetch: async (arg?: any) => {
        calls.push(['members', arg]);
        if (opts.throwAt === 'members' && !arg) throw new Error('members fetch failed');
        if (opts.throwAt === 'botMember' && arg?.user) throw new Error('bot fetch failed');
        if (arg && typeof arg === 'object' && 'user' in arg) {
          const id = opts.botFetchId ?? arg.user;
          const found = members.find((m) => m.id === id);
          if (!found) return null;
          return { id: found.id, partial: false, guild: { id: GUILD }, user: { id: found.id, bot: found.bot } };
        }
        return full;
      },
    },
  };

  let guildCalls = 0;
  const client: any = {
    user: opts.clientUser === undefined ? { id: BOT, bot: true } : opts.clientUser,
    guilds: {
      fetch: async (...args: unknown[]) => {
        calls.push(['guild', ...args]);
        guildCalls += 1;
        if (opts.throwAt === 'guild') throw new Error('guild fetch failed');
        if (guildCalls === 1) return guild;
        const after = opts.countAfter === undefined ? (opts.countBefore === undefined ? members.length : opts.countBefore) : opts.countAfter;
        return guild ? { ...guild, approximateMemberCount: after } : null;
      },
    },
  };

  return {
    client, channel, guild, full, calls,
    input: {
      guildId: GUILD,
      channelId: CHANNEL,
      allowedReaderIds: opts.allowed ?? [READER_A, READER_B],
    },
  };
}

test('happy path returns the channel for exactly the allowed readers plus the bot', async () => {
  const { client, input } = buildHarness();
  const result = await verifyRotaNoticeAccess(client, input);
  assert.ok(result);
  assert.equal(result.id, CHANNEL);
});

test('defaults fail closed: empty allowed set, empty guild id, empty channel id', async () => {
  const { client } = buildHarness();
  assert.equal(await verifyRotaNoticeAccess(client, { guildId: '', channelId: CHANNEL, allowedReaderIds: [READER_A] }), null);
  assert.equal(await verifyRotaNoticeAccess(client, { guildId: GUILD, channelId: '', allowedReaderIds: [READER_A] }), null);
  assert.equal(await verifyRotaNoticeAccess(client, { guildId: GUILD, channelId: CHANNEL, allowedReaderIds: [] }), null);
});

test('allowed set containing the bot id fails closed', async () => {
  const { client, input } = buildHarness({ allowed: [READER_A, BOT] });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('null client user and non-bot client user fail closed', async () => {
  const noUser = buildHarness({ clientUser: null });
  assert.equal(await verifyRotaNoticeAccess(noUser.client, noUser.input), null);
  const human = buildHarness({ clientUser: { id: BOT, bot: false } });
  assert.equal(await verifyRotaNoticeAccess(human.client, human.input), null);
});

test('public channel fails closed even when the census is all-allowed', async () => {
  const { client } = buildHarness({
    everyoneView: true,
    members: [
      { id: BOT, bot: true, flags: FULL_BOT },
      { id: READER_A, bot: false, flags: FULL_READER },
    ],
    allowed: [READER_A],
  });
  assert.equal(await verifyRotaNoticeAccess(client, { guildId: GUILD, channelId: CHANNEL, allowedReaderIds: [READER_A] }), null);
});

test('unauthorized role member with effective View fails closed', async () => {
  const { client, input } = buildHarness({
    members: [
      { id: BOT, bot: true, flags: FULL_BOT },
      { id: READER_A, bot: false, flags: FULL_READER },
      { id: READER_B, bot: false, flags: FULL_READER },
      { id: OUTSIDER, bot: false, flags: VIEW },
    ],
  });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('unauthorized admin-shaped member with effective View fails closed', async () => {
  const { client, input } = buildHarness({
    members: [
      { id: BOT, bot: true, flags: FULL_BOT },
      { id: READER_A, bot: false, flags: FULL_READER },
      { id: OUTSIDER, bot: false, flags: FULL_BOT },
    ],
    allowed: [READER_A],
  });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('other bot with effective View fails closed', async () => {
  const { client, input } = buildHarness({
    members: [
      { id: BOT, bot: true, flags: FULL_BOT },
      { id: READER_A, bot: false, flags: FULL_READER },
      { id: OUTSIDER, bot: true, flags: VIEW },
    ],
    allowed: [READER_A],
  });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('owner with effective View outside the allowed set fails closed', async () => {
  const { client, input } = buildHarness({
    members: [
      { id: BOT, bot: true, flags: FULL_BOT },
      { id: READER_A, bot: false, flags: FULL_READER },
      { id: OWNER, bot: false, flags: VIEW },
    ],
    allowed: [READER_A],
  });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('missing channel and partial channel fail closed', async () => {
  const missing = buildHarness({ channelNull: true });
  assert.equal(await verifyRotaNoticeAccess(missing.client, missing.input), null);
  const partial = buildHarness({ channelPartial: true });
  assert.equal(await verifyRotaNoticeAccess(partial.client, partial.input), null);
});

test('stale single-member bot fetch returning the wrong member fails closed', async () => {
  const { client, input } = buildHarness({ botFetchId: READER_A });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('incomplete census fails closed: fetched size below the count', async () => {
  const { client, input } = buildHarness({ dropFromCensus: [OUTSIDER] });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('shifting approximate count across the fetch window fails closed', async () => {
  const { client, input } = buildHarness({ countBefore: 4, countAfter: 5 });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('absent approximate count fails closed', async () => {
  const { client, input } = buildHarness({ countBefore: null, countAfter: null });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('partial member inside the census fails closed', async () => {
  const { client, input } = buildHarness({ partialMemberId: OUTSIDER });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('allowed reader without ReadMessageHistory fails closed', async () => {
  const { client, input } = buildHarness({
    members: [
      { id: BOT, bot: true, flags: FULL_BOT },
      { id: READER_A, bot: false, flags: VIEW },
      { id: READER_B, bot: false, flags: FULL_READER },
      { id: OUTSIDER, bot: false, flags: 0n },
    ],
  });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('allowed reader without View fails closed', async () => {
  const { client, input } = buildHarness({
    members: [
      { id: BOT, bot: true, flags: FULL_BOT },
      { id: READER_A, bot: false, flags: HISTORY },
      { id: READER_B, bot: false, flags: FULL_READER },
      { id: OUTSIDER, bot: false, flags: 0n },
    ],
  });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('allowed reader missing from the census fails closed', async () => {
  const { client, input } = buildHarness({ dropFromCensus: [READER_B] });
  assert.equal(await verifyRotaNoticeAccess(client, input), null);
});

test('bot without Send and bot without ReadMessageHistory fail closed', async () => {
  const noSend = buildHarness({
    members: [
      { id: BOT, bot: true, flags: VIEW | HISTORY },
      { id: READER_A, bot: false, flags: FULL_READER },
    ],
    allowed: [READER_A],
  });
  assert.equal(await verifyRotaNoticeAccess(noSend.client, noSend.input), null);
  const noHistory = buildHarness({
    members: [
      { id: BOT, bot: true, flags: VIEW | SEND },
      { id: READER_A, bot: false, flags: FULL_READER },
    ],
    allowed: [READER_A],
  });
  assert.equal(await verifyRotaNoticeAccess(noHistory.client, noHistory.input), null);
});

test('every fetch failure point fails closed with null and no throw', async () => {
  for (const throwAt of ['guild', 'roles', 'channel', 'members', 'botMember'] as const) {
    const { client, input } = buildHarness({ throwAt });
    assert.equal(await verifyRotaNoticeAccess(client, input), null, `throwAt=${throwAt}`);
  }
});

test('wrong guild, wrong channel id, and wrong channel type fail closed', async () => {
  const guild = buildHarness({ guildId: '100000000000000099' });
  assert.equal(await verifyRotaNoticeAccess(guild.client, guild.input), null);
  const channel = buildHarness({ channelId: '100000000000000099' });
  assert.equal(await verifyRotaNoticeAccess(channel.client, channel.input), null);
  const voice = buildHarness({ channelType: ChannelType.GuildVoice });
  assert.equal(await verifyRotaNoticeAccess(voice.client, voice.input), null);
  const foreign = buildHarness({ channelGuildId: '100000000000000099' });
  assert.equal(await verifyRotaNoticeAccess(foreign.client, foreign.input), null);
});

test('unavailable guild, missing owner, and foreign @everyone role fail closed', async () => {
  const down = buildHarness({ available: false });
  assert.equal(await verifyRotaNoticeAccess(down.client, down.input), null);
  const noOwner = buildHarness({ ownerId: null });
  assert.equal(await verifyRotaNoticeAccess(noOwner.client, noOwner.input), null);
  const foreignEveryone = buildHarness({ everyoneId: '100000000000000099' });
  assert.equal(await verifyRotaNoticeAccess(foreignEveryone.client, foreignEveryone.input), null);
});

test('fresh fetch flags and complete census are used on every call', async () => {
  const x = buildHarness();
  assert.ok(await verifyRotaNoticeAccess(x.client, x.input));
  assert.deepEqual(x.calls, [
    ['guild', { guild: GUILD, force: true, withCounts: true }], 'roles',
    ['channel', CHANNEL, { force: true }], ['members', { user: BOT, force: true }],
    ['members', undefined], ['guild', { guild: GUILD, force: true, withCounts: true }],
  ]);
});

test('unknown effective permissions, malformed identities and foreign members fail closed', async () => {
  for (const id of [GUILD, OUTSIDER]) {
    const x = buildHarness();
    const permissionsFor = x.channel.permissionsFor;
    x.channel.permissionsFor = (target: any) => target.id === id ? null : permissionsFor(target);
    assert.equal(await verifyRotaNoticeAccess(x.client, x.input), null);
  }
  for (const id of ['', ' ', '123', 'not-an-id']) {
    const x = buildHarness(); x.input.allowedReaderIds = [id];
    assert.equal(await verifyRotaNoticeAccess(x.client, x.input), null);
    assert.deepEqual(x.calls, []);
  }
  const foreign = buildHarness(); foreign.full.get(OUTSIDER).guild.id = CHANNEL;
  assert.equal(await verifyRotaNoticeAccess(foreign.client, foreign.input), null);
  const unknownOwner = buildHarness({ ownerId: OWNER });
  assert.equal(await verifyRotaNoticeAccess(unknownOwner.client, unknownOwner.input), null);
});

test('real Discord permission resolution catches role, member, administrator and owner bypasses', async () => {
  const ROLE = '100000000000000008';
  for (const exposure of ['none', 'role', 'member', 'admin', 'owner', 'other-bot']) {
    const client = new Client({ intents: [] });
    const user = (id: string, bot = false) => ({ id, bot, username: 'fixture', discriminator: '0', avatar: null });
    Object.assign(client, { user: (client.users as any)._add(user(BOT, true)) });
    const guild = (client.guilds as any)._add({
      id: GUILD, name: 'fixture', owner_id: exposure === 'owner' ? OUTSIDER : READER_A,
      unavailable: false, approximate_member_count: 4, member_count: 4,
      roles: [
        { id: GUILD, name: '@everyone', permissions: '0' },
        { id: ROLE, name: 'fixture-role', permissions: exposure === 'admin' ? String(PermissionFlagsBits.Administrator) : '0' },
      ],
      members: [BOT, READER_A, READER_B, OUTSIDER].map(id => ({
        user: user(id, id === BOT || (id === OUTSIDER && exposure === 'other-bot')),
        roles: id === OUTSIDER ? [ROLE] : [], joined_at: '2026-09-01T00:00:00Z',
      })),
      channels: [{ id: CHANNEL, type: ChannelType.GuildText, name: 'fixture', permission_overwrites: [
        { id: GUILD, type: 0, allow: '0', deny: String(VIEW) },
        ...[BOT, READER_A, READER_B].map(id => ({ id, type: 1, allow: String(FULL_BOT), deny: '0' })),
        ...(exposure === 'role' ? [{ id: ROLE, type: 0, allow: String(VIEW), deny: '0' }] : []),
        ...(['member', 'other-bot'].includes(exposure) ? [{ id: OUTSIDER, type: 1, allow: String(VIEW), deny: '0' }] : []),
      ] }],
    });
    client.guilds.fetch = async () => guild;
    guild.roles.fetch = async () => guild.roles.cache;
    guild.channels.fetch = async () => guild.channels.cache.get(CHANNEL);
    guild.members.fetch = async (opts?: { user: string }) => opts ? guild.members.cache.get(opts.user) : guild.members.cache;
    const result = await verifyRotaNoticeAccess(client, { guildId: GUILD, channelId: CHANNEL, allowedReaderIds: [READER_A, READER_B] });
    assert.equal(result?.id ?? null, exposure === 'none' ? CHANNEL : null, exposure);
    await client.destroy();
  }
});
