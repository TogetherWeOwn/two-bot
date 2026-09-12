import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, ChannelType, Collection, Events, GatewayIntentBits, Partials, PermissionsBitField, type Client } from 'discord.js';
import { createClient, INTENTS, registerHandlers } from '../src/discord/client.ts';
import { moderationAuditEvent, rawMessageAuditEvent } from '../src/audit/discordEvents.ts';
import {
  moderationAuditEntryId,
  moderationAuditReason,
  moderationAuditToken,
} from '../src/audit/moderationIdentity.ts';
import { formatAuditEvent, hasAuditEventIdentity, type OperationalAuditEvent } from '../src/audit/events.ts';
import { makeOperationalAudit } from '../src/audit/service.ts';
import { deliveryNonce, OperationalAuditStore, type StoredOperationalAudit } from '../src/audit/store.ts';
import { openDb } from '../src/store/db.ts';
import type { FunnelHandlers } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';

const GUILD = '1545644954272137297';
const OTHER_GUILD = '326474832151838730';
const MEMBER = '900000000000000001';
const CHANNEL_A = '900000000000000101';
const CHANNEL_B = '900000000000000102';
const MODERATION_SECRET = 'm'.repeat(32);

function deps(events: OperationalAuditEvent[]) {
  return {
    handlers: {
      onJoin: async () => null,
      onGateCleared: async () => null,
      onLeave: async () => ({}),
      onMessage: async () => null,
      onVoiceJoin: async () => null,
      onVoiceLeave: async () => null,
      voiceSessions: { openCount: 0, clear() {} },
    } as unknown as FunnelHandlers,
    invites: {
      diffAndStore: async () => [],
      attribute: () => 'unknown',
      inviterFor: async () => null,
    } as unknown as InviteTracker,
    audit: {
      record: async (event: OperationalAuditEvent) => {
        events.push(event);
        return true;
      },
      retryPending: async () => 0,
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function roles(ids: string[]) {
  return { cache: new Map(ids.map((id) => [id, {}])) };
}

test('gateway requests moderation and partial messages for complete audit delivery', () => {
  assert.ok(INTENTS.includes(GatewayIntentBits.GuildModeration));
  const client = createClient();
  assert.ok(client.options.partials?.includes(Partials.Message));
  client.destroy();
});

test('discord.js drops high-level uncached-channel messages while Raw still produces audit', async () => {
  const client = createClient();
  const internals = client as unknown as {
    guilds: { _add(data: unknown): unknown };
    actions: {
      MessageDelete: { handle(data: unknown): unknown };
      MessageUpdate: { handle(data: unknown): { old?: never; updated?: never } };
    };
  };
  internals.guilds._add({ id: GUILD, unavailable: false });
  const deleted: string[] = [];
  const updated: string[] = [];
  client.on(Events.MessageDelete, (message) => deleted.push(message.id));
  client.on(Events.MessageUpdate, (_oldMessage, newMessage) => updated.push(newMessage.id));
  const deletePacket = { op: 0, t: 'MESSAGE_DELETE', s: 3, d: { id: 'uncached-delete', channel_id: CHANNEL_A, guild_id: GUILD } };
  const updatePacket = { op: 0, t: 'MESSAGE_UPDATE', s: 4, d: { id: 'uncached-edit', channel_id: CHANNEL_A, guild_id: GUILD } };

  internals.actions.MessageDelete.handle(deletePacket.d);
  const edit = internals.actions.MessageUpdate.handle(updatePacket.d);
  if (edit.old && edit.updated) client.emit(Events.MessageUpdate, edit.old, edit.updated);

  assert.deepEqual(deleted, []);
  assert.deepEqual(updated, []);
  assert.equal(rawMessageAuditEvent(deletePacket, 0)?.kind, 'message_delete');
  assert.equal(rawMessageAuditEvent(updatePacket, 0)?.kind, 'message_edit');
  client.destroy();
});

test('raw message dispatch converter handles minimal and timestamp update variants', () => {
  assert.deepEqual(rawMessageAuditEvent({
    op: 0, t: 'MESSAGE_DELETE', s: 12,
    d: { guild_id: GUILD, channel_id: CHANNEL_A, id: 'raw-delete' },
  }, 2, '2026-09-09T00:00:00.000Z'), {
    entryId: `message-delete:${GUILD}:raw-delete`, kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', actorId: null, targetId: null,
    sourceChannelId: CHANNEL_A, messageId: 'raw-delete',
  });
  const minimal = rawMessageAuditEvent({
    op: 0, t: 'MESSAGE_UPDATE', s: 13,
    d: { guild_id: GUILD, channel_id: CHANNEL_A, id: 'raw-edit' },
  }, 2, '2026-09-09T00:00:01.000Z');
  assert.equal(minimal?.entryId, `message-edit:${GUILD}:raw-edit:shard-2:sequence-13`);
  assert.equal(minimal?.occurredAt, '2026-09-09T00:00:01.000Z');
  assert.equal(minimal?.actorId, null);
  const timestamped = rawMessageAuditEvent({
    op: 0, t: 'MESSAGE_UPDATE', s: 14,
    d: {
      guild_id: GUILD, channel_id: CHANNEL_A, id: 'raw-edit',
      author: { id: MEMBER }, edited_timestamp: '2026-09-09T00:00:02.000Z',
    },
  }, 2);
  assert.equal(timestamped?.entryId, `message-edit:${GUILD}:raw-edit:2026-09-09T00:00:02.000Z`);
  assert.equal(timestamped?.actorId, MEMBER);
  assert.equal(timestamped?.targetId, MEMBER);
  assert.equal(rawMessageAuditEvent({ op: 1, t: 'MESSAGE_DELETE', s: 1, d: {} }, 0), null);
});

test('gateway logging covers raw edit/delete, member deltas and voice move without content or nicknames', async () => {
  const events: OperationalAuditEvent[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { ...deps(events), auditGuildId: GUILD });

  bus.emit(Events.Raw, {
    op: 0, t: 'MESSAGE_UPDATE', s: 20,
    d: {
      id: 'message-1', guild_id: GUILD, channel_id: CHANNEL_A,
      author: { id: MEMBER }, edited_timestamp: '2023-11-14T22:13:20.000Z', content: 'new secret',
    },
  }, 0);
  bus.emit(Events.Raw, {
    op: 0, t: 'MESSAGE_DELETE', s: 21,
    d: { id: 'message-2', guild_id: GUILD, channel_id: CHANNEL_A, content: 'deleted secret' },
  }, 0);
  // High-level events may follow Raw, but audit production lives only on Raw.
  bus.emit(
    Events.MessageUpdate,
    { id: 'message-1', guildId: GUILD, channelId: CHANNEL_A, partial: false, author: { id: MEMBER }, content: 'old secret' },
    {
      id: 'message-1', guildId: GUILD, channelId: CHANNEL_A, partial: false,
      author: { id: MEMBER }, editedTimestamp: 1_700_000_000_000,
      editedAt: new Date(1_700_000_000_000), content: 'new secret',
    },
  );
  bus.emit(Events.MessageDelete, {
    id: 'message-2', guildId: GUILD, channelId: CHANNEL_A, partial: false,
    author: { id: MEMBER }, content: 'deleted secret',
  });
  bus.emit(
    Events.GuildMemberUpdate,
    { id: MEMBER, guild: { id: GUILD }, partial: false, nickname: 'before nick', roles: roles([GUILD, 'role-old']) },
    { id: MEMBER, guild: { id: GUILD }, nickname: 'after nick', roles: roles([GUILD, 'role-new']), user: { bot: false } },
  );
  bus.emit(
    Events.VoiceStateUpdate,
    { id: MEMBER, guild: { id: GUILD }, channelId: CHANNEL_A, member: { user: { bot: false } } },
    { id: MEMBER, guild: { id: GUILD }, channelId: CHANNEL_B, member: { user: { bot: false } } },
  );
  await settle();

  assert.deepEqual(events.map((event) => event.kind), [
    'message_edit',
    'message_delete',
    'member_update',
    'voice_move',
  ]);
  assert.deepEqual(events[2].metadata, {
    nicknameChanged: true,
    addedRoleIds: ['role-new'],
    removedRoleIds: ['role-old'],
  });
  assert.equal(events[3].sourceChannelId, CHANNEL_A);
  assert.equal(events[3].destinationChannelId, CHANNEL_B);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /old secret|new secret|deleted secret|before nick|after nick/);
});

test('gateway audit ignores events outside the configured guild', async () => {
  const events: OperationalAuditEvent[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { ...deps(events), auditGuildId: GUILD });

  bus.emit(Events.Raw, {
    op: 0, t: 'MESSAGE_DELETE', s: 1,
    d: { id: 'outside-message', guild_id: OTHER_GUILD, channel_id: CHANNEL_A },
  }, 0);
  bus.emit(Events.Raw, {
    op: 0, t: 'MESSAGE_DELETE', s: 2,
    d: { id: 'dm-message', channel_id: CHANNEL_A },
  }, 0);
  bus.emit(
    Events.GuildMemberUpdate,
    { id: MEMBER, guild: { id: OTHER_GUILD }, partial: false, nickname: null, roles: roles([OTHER_GUILD]) },
    { id: MEMBER, guild: { id: OTHER_GUILD }, nickname: 'changed', roles: roles([OTHER_GUILD]), user: { bot: false } },
  );
  bus.emit(
    Events.VoiceStateUpdate,
    { id: MEMBER, guild: { id: OTHER_GUILD }, channelId: null, member: { user: { bot: false } } },
    { id: MEMBER, guild: { id: OTHER_GUILD }, channelId: CHANNEL_B, member: { user: { bot: false } } },
  );
  bus.emit(Events.GuildAuditLogEntryCreate, {
    id: 'outside-audit',
    action: AuditLogEvent.MemberKick,
    createdTimestamp: 1_700_000_000_000,
    executorId: 'moderator-1',
    targetId: MEMBER,
  }, { id: OTHER_GUILD });
  await settle();

  assert.deepEqual(events, []);
});

test('role-heavy member updates use a bounded occurrence key', async () => {
  const events: OperationalAuditEvent[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, deps(events));
  const oldRoleIds = Array.from({ length: 60 }, (_, index) => `old-role-${index}`);
  const newRoleIds = Array.from({ length: 60 }, (_, index) => `new-role-${index}`);
  bus.emit(
    Events.GuildMemberUpdate,
    { id: MEMBER, guild: { id: GUILD }, partial: false, nickname: null, roles: roles([GUILD, ...oldRoleIds]) },
    { id: MEMBER, guild: { id: GUILD }, nickname: null, roles: roles([GUILD, ...newRoleIds]), user: { bot: false } },
  );
  await settle();

  assert.equal(events.length, 1);
  assert.ok(events[0].entryId.length < 150);
  assert.doesNotMatch(events[0].entryId, /old-role|new-role/);
  assert.deepEqual(events[0].metadata?.addedRoleIds, newRoleIds.sort());
  assert.deepEqual(events[0].metadata?.removedRoleIds, oldRoleIds.sort());
});

test('partial old members are not reported as role or nickname changes', async () => {
  const events: OperationalAuditEvent[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, deps(events));
  bus.emit(
    Events.GuildMemberUpdate,
    { id: MEMBER, guild: { id: GUILD }, partial: true, nickname: null, roles: roles([]) },
    { id: MEMBER, guild: { id: GUILD }, nickname: 'current', roles: roles([GUILD, 'role-new']), user: { bot: false } },
  );
  await settle();
  assert.deepEqual(events, []);
});

test('member and voice occurrence keys preserve identical transitions separated in time', async () => {
  const events: OperationalAuditEvent[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, deps(events));
  const oldMember = { id: MEMBER, guild: { id: GUILD }, partial: false, nickname: 'a', roles: roles([GUILD]) };
  const newMember = { id: MEMBER, guild: { id: GUILD }, nickname: 'b', roles: roles([GUILD]), user: { bot: false } };
  const oldVoice = { id: MEMBER, guild: { id: GUILD }, channelId: CHANNEL_A, member: { user: { bot: false } } };
  const newVoice = { id: MEMBER, guild: { id: GUILD }, channelId: CHANNEL_B, member: { user: { bot: false } } };

  bus.emit(Events.GuildMemberUpdate, oldMember, newMember);
  bus.emit(Events.VoiceStateUpdate, oldVoice, newVoice);
  await new Promise((resolve) => setTimeout(resolve, 5));
  bus.emit(Events.GuildMemberUpdate, oldMember, newMember);
  bus.emit(Events.VoiceStateUpdate, oldVoice, newVoice);
  await settle();

  assert.notEqual(events[0].entryId, events[2].entryId);
  assert.notEqual(events[1].entryId, events[3].entryId);
});

test('durable audit is idempotent by entry id', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const event: OperationalAuditEvent = {
    entryId: 'discord-audit:staging:1',
    kind: 'moderation_action',
    channel: 'moderation',
    guildId: GUILD,
    occurredAt: '2026-09-08T16:00:00.000Z',
    actorId: 'moderator-1',
    targetId: MEMBER,
    action: 'member_kick',
  };

  assert.equal(await store.record(event), true);
  assert.equal(await store.record(event), false);
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM operational_audit_log`).get<{ n: number }>();
  assert.equal(Number(row?.n), 1);
  await db.close();
});

test('correlated moderation gateway entries converge on the service audit identity', async () => {
  const guildId = GUILD;
  const key = 'moderation-key-1';
  const token = moderationAuditToken(guildId, key);
  const reason = moderationAuditReason(
    MODERATION_SECRET,
    guildId,
    key,
    'moderation.slowmode',
    '900000000000000003',
    'human-only reason',
  );
  const event = moderationAuditEvent(
    {
      id: 'audit-correlated',
      action: AuditLogEvent.ChannelUpdate,
      createdTimestamp: 1_700_000_000_000,
      executorId: 'bot',
      targetId: CHANNEL_A,
      reason,
      extra: null,
    } as never,
    guildId,
    'bot',
    MODERATION_SECRET,
  );
  assert.ok(event);
  assert.equal(event.entryId, moderationAuditEntryId(guildId, token));
  assert.equal(event.action, 'moderation.slowmode');
  assert.equal(event.actorId, '900000000000000003');
  assert.equal(event.targetId, null);
  assert.equal(event.sourceChannelId, CHANNEL_A);
  assert.deepEqual(event.metadata, {
    auditLogEntryId: 'audit-correlated',
    count: null,
    origin: 'moderation_service',
    outcome: 'slowmode_updated',
  });
  assert.doesNotMatch(JSON.stringify(event), /human-only reason/);

  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const serviceEvent = {
    ...event,
    occurredAt: '2026-09-08T16:00:00.000Z',
    metadata: { origin: 'moderation_service', outcome: 'slowmode_updated', seconds: 5 },
  };
  assert.equal(await store.record(serviceEvent), true);
  assert.equal(await store.record(event), false);
  assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM operational_audit_log`).get<{ n: number }>())?.n), 1);
  assert.deepEqual((await store.get(event.entryId))?.event.metadata, {
    origin: 'moderation_service', outcome: 'slowmode_updated', seconds: 5,
    auditLogEntryId: 'audit-correlated', count: null,
  });
  assert.equal((await store.get(event.entryId))?.event.occurredAt, serviceEvent.occurredAt);
  await db.close();
});

test('gateway-first correlated moderation keeps gateway identity and gains service metadata', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const entryId = moderationAuditEntryId(GUILD, moderationAuditToken(GUILD, 'gateway-first'));
  const gatewayEvent: OperationalAuditEvent = {
    entryId, kind: 'moderation_action', channel: 'moderation', guildId: GUILD,
    occurredAt: '2026-09-08T16:00:00.000Z', actorId: 'staff', sourceChannelId: CHANNEL_A,
    action: 'moderation.purge',
    metadata: { origin: 'moderation_service', outcome: 'purged', auditLogEntryId: 'audit-first', count: 3 },
  };
  const serviceEvent: OperationalAuditEvent = {
    ...gatewayEvent,
    occurredAt: '2026-09-08T16:00:01.000Z',
    metadata: { origin: 'moderation_service', outcome: 'purged', count: 5, affected: 3 },
  };
  await store.record(gatewayEvent);
  assert.equal(await store.record(serviceEvent), false);
  const stored = await store.get(entryId);
  assert.equal(stored?.event.occurredAt, gatewayEvent.occurredAt);
  assert.deepEqual(stored?.event.metadata, {
    origin: 'moderation_service', outcome: 'purged', auditLogEntryId: 'audit-first', count: 3, affected: 3,
  });
  await db.close();
});

test('unrelated duplicate audit metadata remains immutable', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const original: OperationalAuditEvent = {
    entryId: 'immutable-duplicate', kind: 'moderation_action', channel: 'moderation', guildId: GUILD,
    occurredAt: '2026-09-08T16:00:00.000Z', action: 'member_kick', metadata: { auditLogEntryId: 'original' },
  };
  await store.record(original);
  await store.record({
    ...original, action: 'moderation.kick', metadata: { origin: 'moderation_service', outcome: 'kicked', auditLogEntryId: 'forged' },
  });
  assert.deepEqual((await store.get(original.entryId))?.event.metadata, original.metadata);
  await db.close();
});

test('another integration cannot forge a moderation service correlation marker', () => {
  const event = moderationAuditEvent(
    {
      id: 'audit-forged',
      action: AuditLogEvent.MemberKick,
      createdTimestamp: 1_700_000_000_000,
      executorId: 'other-integration',
      targetId: MEMBER,
      reason: moderationAuditReason(MODERATION_SECRET, GUILD, 'forged', 'moderation.ban', MEMBER, 'forged'),
      extra: null,
    } as never,
    GUILD,
    'our-bot',
    MODERATION_SECRET,
  );
  assert.ok(event);
  assert.equal(event.entryId, `discord-audit:${GUILD}:audit-forged`);
  assert.equal(event.action, 'member_kick');
  assert.deepEqual(event.metadata, { auditLogEntryId: 'audit-forged', count: null });
});

test('a same-bot writer outside ModerationService cannot forge a correlation marker without the secret', () => {
  // TOG-2223 #8: raid-remove.ts / kick.ts share the bot's Discord token with
  // ModerationService but never see moderationAuditSecret. Hand-crafting a
  // syntactically valid marker (a real 32-hex token/action/actor, but with an
  // all-zero MAC an attacker without the secret would guess) must not
  // converge on the reviewed service identity, even though the executor is
  // literally this bot.
  const forgedReason = `[two-audit:v1:${'a'.repeat(32)}:moderation.ban:${MEMBER}:${'0'.repeat(16)}] forged by raid-remove --reason`;
  const event = moderationAuditEvent(
    {
      id: 'audit-same-bot-forged',
      action: AuditLogEvent.MemberBanAdd,
      createdTimestamp: 1_700_000_000_000,
      executorId: 'our-bot',
      targetId: MEMBER,
      reason: forgedReason,
      extra: null,
    } as never,
    GUILD,
    'our-bot',
    MODERATION_SECRET,
  );
  assert.ok(event);
  assert.equal(event.entryId, `discord-audit:${GUILD}:audit-same-bot-forged`);
  assert.equal(event.actorId, 'our-bot');
  assert.deepEqual(event.metadata, { auditLogEntryId: 'audit-same-bot-forged', count: null });
});

test('a null moderationAuditSecret refuses to trust even a validly-signed marker', () => {
  // If the secret was never provisioned, the gateway listener is handed
  // `null` too (src/index.ts) - the two must agree, or a marker minted before
  // a secret rotation removed it would still be trusted after the rotation.
  const reason = moderationAuditReason(MODERATION_SECRET, GUILD, 'rotated-away', 'moderation.ban', MEMBER, 'reason');
  const event = moderationAuditEvent(
    {
      id: 'audit-secret-rotated',
      action: AuditLogEvent.MemberBanAdd,
      createdTimestamp: 1_700_000_000_000,
      executorId: 'our-bot',
      targetId: MEMBER,
      reason,
      extra: null,
    } as never,
    GUILD,
    'our-bot',
    null,
  );
  assert.ok(event);
  assert.deepEqual(event.metadata, { auditLogEntryId: 'audit-secret-rotated', count: null });
});

test('Discord moderation entries discard free-text reasons', () => {
  const event = moderationAuditEvent(
    {
      id: 'audit-1',
      action: AuditLogEvent.MessageDelete,
      createdTimestamp: 1_700_000_000_000,
      executorId: 'moderator-1',
      targetId: MEMBER,
      reason: 'member name and copied message text',
      extra: { channel: { id: CHANNEL_A }, count: 3 },
    } as never,
    GUILD,
    undefined,
    MODERATION_SECRET,
  );

  assert.ok(event);
  assert.equal(event.action, 'message_delete');
  assert.equal(event.actorId, 'moderator-1');
  assert.equal(event.targetId, MEMBER);
  assert.equal(event.sourceChannelId, CHANNEL_A);
  assert.equal('reason' in event, false);
  assert.deepEqual(event.metadata, { auditLogEntryId: 'audit-1', count: 3 });
});

test('mirror text suppresses raw message content and carries a delimited event marker', () => {
  const text = formatAuditEvent({
    entryId: 'one',
    kind: 'message_delete',
    channel: 'audit',
    guildId: GUILD,
    occurredAt: '2026-09-08T16:00:00.000Z',
    targetId: MEMBER,
    sourceChannelId: CHANNEL_A,
    messageId: 'message-2',
  });
  assert.match(text, /audit-event:one;/);
  assert.match(text, new RegExp(MEMBER));
  assert.match(text, /message-2/);
  assert.doesNotMatch(text, /content|username|nickname|reason/);
});

test('marker identity accepts only the exact leading formatAuditEvent field', () => {
  assert.equal(hasAuditEventIdentity(formatAuditEvent({
    entryId: 'one', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-08T16:00:00.000Z', targetId: MEMBER,
  }), 'one'), true);
  assert.equal(hasAuditEventIdentity('audit-event:other; · metadata=`audit-event:one; · `', 'one'), false);
  assert.equal(hasAuditEventIdentity('prefix audit-event:one; · **message delete**', 'one'), false);
  assert.equal(hasAuditEventIdentity('audit-event:one; metadata only', 'one'), false);
});

test('role-heavy member updates truncate metadata at complete role ids with an exact omitted count', () => {
  const roleIds = Array.from({ length: 60 }, (_, index) => String(9_000_000_000_000_000n + BigInt(index)));
  const text = formatAuditEvent({
    entryId: 'member-update:bounded',
    kind: 'member_update',
    channel: 'audit',
    guildId: GUILD,
    occurredAt: '2026-09-09T07:00:00.000Z',
    targetId: MEMBER,
    metadata: { nicknameChanged: true, addedRoleIds: roleIds, removedRoleIds: roleIds },
  });
  assert.ok(text.length <= 2_000);
  assert.match(text, /^audit-event:member-update:bounded;/);

  for (const key of ['addedRoleIds', 'removedRoleIds']) {
    const value = text.match(new RegExp(key + '=`([^`]*)`'))?.[1];
    assert.ok(value);
    const match = value.match(/^(.*) \(\+(\d+) omitted\)$/);
    assert.ok(match);
    const emitted = match[1].split(',');
    assert.ok(emitted.length > 0);
    assert.ok(emitted.every((roleId) => /^\d{16}$/.test(roleId)));
    assert.ok(emitted.every((roleId) => roleIds.includes(roleId)));
    assert.equal(Number(match[2]), roleIds.length - emitted.length);
  }
});

test('audit-sink message tampering is stored but never remirrored', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let sent = 0;
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Collection() },
    client: { user: { id: 'bot' } },
    send: async () => { sent++; return { id: '900000000000000001' }; },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });
  const recorded = await sink.record({
    entryId: 'tamper-delete',
    kind: 'message_delete',
    channel: 'audit',
    guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z',
    sourceChannelId: CHANNEL_A,
    messageId: 'audit-message',
  });
  assert.equal(recorded, true);
  assert.equal(sent, 0);
  const row = await store.get('tamper-delete');
  assert.equal(row?.deliveryState, 'none');
  await db.close();
});

test('delivered audit mirrors are checked exactly and checkpointed when intact', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const entryId = 'delivered-intact';
  const messageId = '900000000000000501';
  const event: OperationalAuditEvent = {
    entryId, kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };
  await store.record(event, CHANNEL_A);
  const claim = await store.claim(entryId);
  await store.markDelivered(entryId, claim!.deliveryClaimToken!, messageId);
  const fetches: unknown[] = [];
  const channel = auditChannel(async (options) => {
    fetches.push(options);
    return { id: messageId, author: { id: 'bot' }, content: formatAuditEvent(event), editedTimestamp: null };
  });
  const sink = makeOperationalAudit(auditClient(channel), {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });

  assert.equal(await sink.retryPending(), 0);
  assert.deepEqual(fetches, [{ message: messageId, force: true, cache: false }]);
  assert.ok((await store.get(entryId))?.mirrorCheckedAt);
  assert.equal((await store.get(entryId))?.deliveryState, 'delivered');
  await db.close();
});

test('delivered reconciliation needs ViewChannel but not SendMessages', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const event: OperationalAuditEvent = {
    entryId: 'delivered-read-only', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };
  await store.record(event, CHANNEL_A);
  const claim = await store.claim(event.entryId);
  await store.markDelivered(event.entryId, claim!.deliveryClaimToken!, 'mirror-read-only');
  const channel = {
    ...auditChannel(async () => ({
      id: 'mirror-read-only', author: { id: 'bot' }, content: formatAuditEvent(event), editedTimestamp: null,
    })),
    permissionsFor: () => ({
      has: (permission?: bigint) =>
        permission === PermissionsBitField.Flags.ViewChannel
        || permission === PermissionsBitField.Flags.ReadMessageHistory,
    }),
  };
  const sink = makeOperationalAudit(auditClient(channel), {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });

  assert.equal(await sink.retryPending(), 0);
  assert.ok((await store.get(event.entryId))?.mirrorCheckedAt);
  assert.equal((await store.get(event.entryId))?.deliveryState, 'delivered');
  await db.close();
});

test('reconciliation quarantines instead of checkpointing forever when ReadMessageHistory is revoked', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const event: OperationalAuditEvent = {
    entryId: 'delivered-no-history', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };
  await store.record(event, CHANNEL_A);
  const claim = await store.claim(event.entryId);
  await store.markDelivered(event.entryId, claim!.deliveryClaimToken!, 'mirror-no-history');
  let fetched = false;
  const channel = {
    ...auditChannel(async () => { fetched = true; return {}; }),
    permissionsFor: () => ({
      has: (permission?: bigint) => permission === PermissionsBitField.Flags.ViewChannel,
    }),
  };
  const sink = makeOperationalAudit(auditClient(channel), {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });

  assert.equal(await sink.retryPending(), 0);
  assert.equal(fetched, false);
  const row = await store.get(event.entryId);
  assert.equal(row?.deliveryState, 'quarantined');
  assert.equal(row?.deliveryLastError, 'mirror_channel_permission_revoked');
});

test('reconciliation quarantines a permanent 403 fetch rejection instead of checkpointing it as transient', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const event: OperationalAuditEvent = {
    entryId: 'delivered-forbidden', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };
  await store.record(event, CHANNEL_A);
  const claim = await store.claim(event.entryId);
  await store.markDelivered(event.entryId, claim!.deliveryClaimToken!, 'mirror-forbidden');
  const channel = auditChannel(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); });
  const sink = makeOperationalAudit(auditClient(channel), {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });

  assert.equal(await sink.retryPending(), 0);
  const row = await store.get(event.entryId);
  assert.equal(row?.deliveryState, 'quarantined');
  assert.equal(row?.deliveryLastError, 'mirror_fetch_rejected_403');
});

test('deleted delivered mirror records deterministic evidence and quarantines without recursion', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const event: OperationalAuditEvent = {
    entryId: 'delivered-deleted', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };
  await store.record(event, CHANNEL_A);
  const claim = await store.claim(event.entryId);
  await store.markDelivered(event.entryId, claim!.deliveryClaimToken!, 'mirror-delete');
  const channel = auditChannel(async () => { throw Object.assign(new Error('secret Discord text'), { status: 404 }); });
  const sink = makeOperationalAudit(auditClient(channel), {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });

  assert.equal(await sink.retryPending(), 0);
  const original = await store.get(event.entryId);
  assert.equal(original?.deliveryState, 'quarantined');
  assert.equal(original?.deliveryLastError, 'mirror_deleted');
  const evidence = await db.prepare(
    `SELECT event_kind, delivery_state, source_channel_id, message_id, metadata_json
       FROM operational_audit_log WHERE entry_id <> ?`,
  ).all<Record<string, unknown>>(event.entryId);
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence.map((row) => ({ ...row })), [{
    event_kind: 'message_delete', delivery_state: 'none', source_channel_id: CHANNEL_A,
    message_id: 'mirror-delete', metadata_json: JSON.stringify({ auditMirrorEntryId: event.entryId }),
  }]);
  assert.equal(await sink.retryPending(), 0);
  assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM operational_audit_log`).get<{ n: number }>())?.n), 2);
  await db.close();
});

test('edited delivered mirror records evidence even when restored before the next pass', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const event: OperationalAuditEvent = {
    entryId: 'delivered-edited', kind: 'message_edit', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };
  await store.record(event, CHANNEL_A);
  const claim = await store.claim(event.entryId);
  await store.markDelivered(event.entryId, claim!.deliveryClaimToken!, 'mirror-edit');
  const editedAt = Date.parse('2026-09-09T00:00:01.000Z');
  const channel = auditChannel(async () => ({
    id: 'mirror-edit', author: { id: 'bot' }, content: formatAuditEvent(event), editedTimestamp: editedAt,
  }));
  const sink = makeOperationalAudit(auditClient(channel), {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });

  await sink.retryPending();
  assert.equal((await store.get(event.entryId))?.deliveryLastError, 'mirror_edited');
  const evidence = await db.prepare(
    `SELECT entry_id, event_kind, occurred_at, delivery_state FROM operational_audit_log WHERE entry_id <> ?`,
  ).all<Record<string, unknown>>(event.entryId);
  assert.deepEqual(evidence.map((row) => ({ ...row })), [{
    entry_id: `message-edit:${GUILD}:mirror-edit:2026-09-09T00:00:01.000Z`,
    event_kind: 'message_edit',
    occurred_at: '2026-09-09T00:00:01.000Z',
    delivery_state: 'none',
  }]);
  await db.close();
});

test('transient delivered mirror failures are bounded, fair, checkpointed and redacted', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  for (let index = 0; index < 12; index++) {
    const entryId = `delivered-${String(index).padStart(2, '0')}`;
    await store.record({
      entryId, kind: 'message_delete', channel: 'audit', guildId: GUILD,
      occurredAt: `2026-09-09T00:00:${String(index).padStart(2, '0')}.000Z`, sourceChannelId: CHANNEL_B,
    }, CHANNEL_A);
    const claim = await store.claim(entryId);
    await store.markDelivered(entryId, claim!.deliveryClaimToken!, `mirror-${index}`);
  }
  const fetched: string[] = [];
  const sentinel = 'SENTINEL_MIRROR_FETCH_SECRET';
  const channel = auditChannel(async ({ message }: { message: string }) => {
    fetched.push(message);
    throw Object.assign(new Error(sentinel), { status: 503 });
  });
  const sink = makeOperationalAudit(auditClient(channel), {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });
  let stderr = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    assert.equal(await sink.retryPending(), 0);
    assert.deepEqual(fetched, Array.from({ length: 10 }, (_, index) => `mirror-${index}`));
    assert.equal(await sink.retryPending(), 0);
    await db.prepare(`UPDATE operational_audit_log SET mirror_checked_at = ? WHERE delivery_state = 'delivered'`).run(
      '2000-01-01T00:00:00.000Z',
    );
    assert.equal(await sink.retryPending(), 0);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.deepEqual(fetched.slice(10), [
    'mirror-10', 'mirror-11', 'mirror-0', 'mirror-1', 'mirror-2', 'mirror-3',
    'mirror-4', 'mirror-5', 'mirror-6', 'mirror-7', 'mirror-8', 'mirror-9',
  ]);
  assert.doesNotMatch(stderr, new RegExp(sentinel));
  assert.equal((await store.get('delivered-00'))?.deliveryState, 'delivered');
  assert.ok((await store.get('delivered-11'))?.mirrorCheckedAt);
  await db.close();
});

test('tamper evidence failure rolls back quarantine and leaves the delivered row retryable', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  await store.record({
    entryId: 'atomic-tamper', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  }, CHANNEL_A);
  const claim = await store.claim('atomic-tamper');
  await store.markDelivered('atomic-tamper', claim!.deliveryClaimToken!, 'atomic-mirror');

  await assert.rejects(store.quarantineDeliveredMirrorWithEvidence(
    'atomic-tamper', 'atomic-mirror', null, '2026-09-09T01:00:00.000Z', 'mirror_deleted', {
      entryId: `message-delete:${GUILD}:atomic-mirror`, kind: 'message_delete', channel: 'audit',
      guildId: GUILD, occurredAt: '2026-09-09T01:00:00.000Z', sourceChannelId: CHANNEL_A,
      messageId: 'atomic-mirror', metadata: { auditMirrorEntryId: 'atomic-tamper' },
    }, async () => { throw new Error('injected evidence write failure'); },
  ), /injected evidence write failure/);
  assert.equal((await store.get('atomic-tamper'))?.deliveryState, 'delivered');
  assert.equal((await store.get('atomic-tamper'))?.mirrorCheckedAt, null);
  assert.equal(await store.get(`message-delete:${GUILD}:atomic-mirror`), null);
  assert.deepEqual((await store.selectDeliveredForReconciliation()).map((row) => row.event.entryId), ['atomic-tamper']);
  assert.equal(await store.quarantineDeliveredMirrorWithEvidence(
    'atomic-tamper', 'atomic-mirror', null, '2026-09-09T01:00:01.000Z', 'mirror_deleted', {
      entryId: `message-delete:${GUILD}:atomic-mirror`, kind: 'message_delete', channel: 'audit',
      guildId: GUILD, occurredAt: '2026-09-09T01:00:01.000Z', sourceChannelId: CHANNEL_A,
      messageId: 'atomic-mirror', metadata: { auditMirrorEntryId: 'atomic-tamper' },
    },
  ), true);
  assert.equal((await store.get('atomic-tamper'))?.deliveryState, 'quarantined');
  assert.ok(await store.get(`message-delete:${GUILD}:atomic-mirror`));
  await db.close();
});

test('stale delivered mirror CAS cannot quarantine a newer checkpoint', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  await store.record({
    entryId: 'stale-mirror-cas', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  }, CHANNEL_A);
  const claim = await store.claim('stale-mirror-cas');
  await store.markDelivered('stale-mirror-cas', claim!.deliveryClaimToken!, 'mirror-cas');
  const selected = (await store.selectDeliveredForReconciliation(1))[0];
  assert.equal(await store.checkpointMirrorCheck('stale-mirror-cas', 'mirror-cas', null, '2026-09-09T01:00:00.000Z'), true);
  assert.equal(await store.quarantineDeliveredMirrorWithEvidence(
    'stale-mirror-cas', 'mirror-cas', selected.mirrorCheckedAt,
    '2026-09-09T01:00:01.000Z', 'mirror_deleted', {
      entryId: `message-delete:${GUILD}:mirror-cas`, kind: 'message_delete', channel: 'audit',
      guildId: GUILD, occurredAt: '2026-09-09T01:00:01.000Z', sourceChannelId: CHANNEL_A,
      messageId: 'mirror-cas', metadata: { auditMirrorEntryId: 'stale-mirror-cas' },
    },
  ), false);
  assert.equal((await store.get('stale-mirror-cas'))?.deliveryState, 'delivered');
  await db.close();
});

function auditChannel(fetch: (options: any) => Promise<any>): {
  id: string;
  guild: { id: string; members: { me: { id: string } } };
  isTextBased: () => boolean;
  isDMBased: () => boolean;
  permissionsFor: () => { has: (permission: bigint) => boolean };
  messages: { fetch: (options: any) => Promise<any> };
  client: { user: { id: string } };
  send: () => Promise<{ id: string }>;
} {
  return {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch },
    client: { user: { id: 'bot' } },
    send: async () => ({ id: 'unused' }),
  };
}

function auditClient(channel: ReturnType<typeof auditChannel>): Client {
  return { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
}

test('failed audit delivery is retryable without duplicating the durable row', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let attempts = 0;
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Collection() },
    client: { user: { id: 'bot' } },
    send: async () => {
      attempts++;
      return { id: '900000000000000001' };
    },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });
  const event: OperationalAuditEvent = {
    entryId: 'retry-me',
    kind: 'message_delete',
    channel: 'audit',
    guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z',
    sourceChannelId: CHANNEL_B,
    messageId: 'message-2',
  };
  const realSaveDeliverySearchBefore = store.prepareDeliverySend.bind(store);
  let boundaryWrites = 0;
  store.prepareDeliverySend = async (entryId, claimToken, before) => {
    boundaryWrites++;
    if (boundaryWrites === 1) throw new Error('transient database failure before send');
    await realSaveDeliverySearchBefore(entryId, claimToken, before);
  };
  assert.equal(await sink.record(event), true);
  assert.equal((await store.get(event.entryId))?.deliveryState, 'pending');
  assert.equal(await sink.record(event), false);
  assert.equal(attempts, 1);
  const row = await store.get(event.entryId);
  assert.equal(row?.deliveryState, 'delivered');
  assert.equal(row?.deliveryAttempts, 2);
  assert.equal(row?.deliveryNonce, deliveryNonce(event.entryId));
  assert.ok((row?.deliveryNonce.length ?? 26) <= 25);
  assert.equal(row?.mirrorMessageId, '900000000000000001');
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM operational_audit_log`).get<{ n: number }>();
  assert.equal(Number(count?.n), 1);
  await db.close();
});

test('pre-send delivery quarantines instead of retrying forever when ReadMessageHistory is revoked', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let sent = false;
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({
      has: (permission?: bigint) => permission === PermissionsBitField.Flags.ViewChannel,
    }),
    messages: { fetch: async () => new Collection() },
    client: { user: { id: 'bot' } },
    send: async () => {
      sent = true;
      return { id: '900000000000000001' };
    },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });
  const event: OperationalAuditEvent = {
    entryId: 'predelivery-no-history', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };

  assert.equal(await sink.record(event), true);
  assert.equal(sent, false);
  const row = await store.get(event.entryId);
  assert.equal(row?.deliveryState, 'quarantined');
  assert.equal(row?.deliveryLastError, 'mirror_channel_permission_revoked');
  await db.close();
});

test('pre-send delivery quarantines a definite 4xx from the pre-send scan instead of retrying forever', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let sent = false;
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } },
    client: { user: { id: 'bot' } },
    send: async () => {
      sent = true;
      return { id: '900000000000000001' };
    },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });
  const event: OperationalAuditEvent = {
    entryId: 'predelivery-forbidden-scan', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };

  assert.equal(await sink.record(event), true);
  assert.equal(sent, false);
  const row = await store.get(event.entryId);
  assert.equal(row?.deliveryState, 'quarantined');
  assert.equal(row?.deliveryLastError, 'discord_fetch_rejected_403');
  await db.close();
});

test('post-send acknowledgement retries reconcile beyond 500 newer Discord messages', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const sends: Array<{ nonce?: string | number; enforceNonce?: boolean }> = [];
  const preSendMessageId = '900000000000000000';
  const acceptedMessageId = (BigInt(preSendMessageId) + 1n).toString();
  const searchBefore = acceptedMessageId;
  let existingMessage: { id: string; author: { id: string }; content: string } | null = null;
  const preSendMessage = { id: preSendMessageId, author: { id: 'other' }, content: 'pre-send' };
  const newerMessages = Array.from({ length: 550 }, (_, index) => ({
    id: (BigInt(acceptedMessageId) + 550n - BigInt(index)).toString(),
    author: { id: 'other' },
    content: `newer-${index}`,
  }));
  const fetchedBefore: Array<string | undefined> = [];
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async ({ limit = 50, before }: { limit?: number; before?: string }) => {
        fetchedBefore.push(before);
        const history = existingMessage
          ? [...newerMessages, existingMessage, preSendMessage]
          : [preSendMessage];
        const page = history
          .filter((message) => !before || BigInt(message.id) < BigInt(before))
          .slice(0, limit);
        return new Collection(page.map((message) => [message.id, message]));
      },
    },
    client: { user: { id: 'bot' } },
    send: async (body: { nonce?: string | number; enforceNonce?: boolean; content?: string }) => {
      sends.push(body);
      existingMessage = { id: acceptedMessageId, author: { id: 'bot' }, content: body.content ?? '' };
      return { id: acceptedMessageId };
    },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });
  const event: OperationalAuditEvent = {
    entryId: 'ack-window',
    kind: 'message_delete',
    channel: 'audit',
    guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z',
    sourceChannelId: CHANNEL_B,
    messageId: 'message-2',
  };

  const realMarkDelivered = store.markDelivered.bind(store);
  let acknowledgements = 0;
  store.markDelivered = async (entryId, claimToken, messageId) => {
    acknowledgements++;
    if (acknowledgements === 1) throw new Error('database disconnected after Discord accepted the post');
    await realMarkDelivered(entryId, claimToken, messageId);
  };

  assert.equal(await sink.record(event), true);
  const ambiguous = await store.get(event.entryId);
  assert.equal(ambiguous?.deliveryState, 'delivering');
  assert.equal(ambiguous?.deliveryAttempts, 1);
  assert.equal(ambiguous?.deliverySearchBefore, searchBefore);
  assert.equal(await sink.retryPending(), 0);
  await store.markAcknowledgementFailed(event.entryId, ambiguous!.deliveryClaimToken!, -1);
  assert.equal(await sink.retryPending(), 1);

  assert.equal(sends.length, 1);
  assert.deepEqual(sends.map((body) => body.nonce), [deliveryNonce(event.entryId)]);
  assert.deepEqual(sends.map((body) => body.enforceNonce), [true]);
  assert.ok(fetchedBefore.length > 6);
  assert.ok(fetchedBefore.includes((BigInt(acceptedMessageId) + 51n).toString()));
  const row = await store.get(event.entryId);
  assert.equal(row?.deliveryState, 'delivered');
  assert.equal(row?.mirrorMessageId, acceptedMessageId);
  await db.close();
});

test('acknowledgement failure replaces send authorization with a finite reconciliation lease', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const event: OperationalAuditEvent = {
    entryId: 'finite-reconciliation-lease', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };
  await store.record(event, CHANNEL_A);
  const claim = await store.claim(event.entryId);
  assert.ok(claim?.deliveryClaimToken);
  await store.prepareDeliverySend(event.entryId, claim.deliveryClaimToken, '1');
  await store.markAcknowledgementFailed(event.entryId, claim.deliveryClaimToken, -1);

  const retry = await store.claim(event.entryId);
  assert.ok(retry?.deliveryClaimToken);
  assert.notEqual(retry.deliveryClaimToken, claim.deliveryClaimToken);
  assert.equal(retry.deliverySearchBefore, '1');
  assert.equal(retry.deliveryAttempts, 1);
  assert.equal(retry.deliveryLastError, 'delivery_ack_failed');
  await db.close();
});

test('stale audit delivery claims cannot mutate replacement ownership', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const event: OperationalAuditEvent = {
    entryId: 'stale-claim', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };
  await store.record(event, CHANNEL_A);

  const first = await store.claim(event.entryId, 1);
  assert.ok(first?.deliveryClaimToken);
  await db.prepare(`UPDATE operational_audit_log SET delivery_lease_until = ? WHERE entry_id = ?`).run(
    '2000-01-01T00:00:00.000Z', event.entryId,
  );
  const replacement = await store.claim(event.entryId);
  assert.ok(replacement?.deliveryClaimToken);
  assert.notEqual(first.deliveryClaimToken, replacement.deliveryClaimToken);

  await assert.rejects(
    store.prepareDeliverySend(event.entryId, first.deliveryClaimToken, '10'),
    /audit_delivery_send_not_prepared/,
  );
  await assert.rejects(
    store.extendDeliveryLease(event.entryId, first.deliveryClaimToken),
    /audit_delivery_lease_not_extended/,
  );
  await assert.rejects(
    store.markDelivered(event.entryId, first.deliveryClaimToken, '20'),
    /audit_delivery_ack_not_persisted/,
  );
  await assert.rejects(
    store.markAcknowledgementFailed(event.entryId, first.deliveryClaimToken),
    /audit_delivery_ack_failure_not_persisted/,
  );
  await assert.rejects(
    store.markDeliveryFailed(event.entryId, first.deliveryClaimToken, 'stale'),
    /audit_delivery_failure_not_persisted/,
  );

  const claimed = await store.get(event.entryId);
  assert.equal(claimed?.deliveryState, 'delivering');
  assert.equal(claimed?.deliveryClaimToken, replacement.deliveryClaimToken);
  assert.equal(claimed?.deliveryAttempts, 0);
  assert.equal(claimed?.deliverySearchBefore, null);
  await store.markDeliveryFailed(event.entryId, replacement.deliveryClaimToken, 'replacement_done');
  const pending = await store.get(event.entryId);
  assert.equal(pending?.deliveryState, 'pending');
  assert.equal(pending?.deliveryClaimToken, null);
  assert.equal(pending?.deliveryLastError, 'replacement_done');
  await db.close();
});

test('a crash after send preparation remains reclaimable for marker reconciliation', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  await store.record({
    entryId: 'crash-before-send', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  }, CHANNEL_A);
  const claim = await store.claim('crash-before-send');
  assert.ok(claim?.deliveryClaimToken);
  await store.prepareDeliverySend('crash-before-send', claim.deliveryClaimToken, '1', -1);

  const retry = await store.claim('crash-before-send');
  assert.ok(retry?.deliveryClaimToken);
  assert.notEqual(retry.deliveryClaimToken, claim.deliveryClaimToken);
  assert.equal(retry.deliverySearchBefore, '1');
  await db.close();
});

test('a replacement claim before send authorization blocks the stale worker', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let sends = 0;
  let replacementToken: string | null = null;
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Collection() },
    client: { user: { id: 'bot' } },
    send: async () => { sends++; return { id: '1' }; },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });
  const realPrepare = store.prepareDeliverySend.bind(store);
  store.prepareDeliverySend = async (entryId, claimToken, before, leaseMs) => {
    await db.prepare(
      `UPDATE operational_audit_log
          SET delivery_search_before = NULL, delivery_lease_until = ?
        WHERE entry_id = ?`,
    ).run('2000-01-01T00:00:00.000Z', entryId);
    replacementToken = (await store.claim(entryId))?.deliveryClaimToken ?? null;
    await realPrepare(entryId, claimToken, before, leaseMs);
  };

  await sink.record({
    entryId: 'reclaimed-before-authorization', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  });
  assert.ok(replacementToken);
  assert.equal(sends, 0);
  const row = await store.get('reclaimed-before-authorization');
  assert.equal(row?.deliveryState, 'delivering');
  assert.equal(row?.deliveryClaimToken, replacementToken);
  await db.close();
});

test('an empty-channel acknowledgement retry does not trust the host clock', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const sends: string[] = [];
  let acceptedMessage: { id: string; author: { id: string }; content: string } | null = null;
  const acceptedMessageId = '1';
  const newerMessages = Array.from({ length: 550 }, (_, index) => ({
    id: String(551 - index), author: { id: 'other' }, content: `newer-${index}`,
  }));
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async ({ limit = 50, before }: { limit?: number; before?: string }) => {
        const history = acceptedMessage ? [...newerMessages, acceptedMessage] : [];
        const page = history.filter((message) => !before || BigInt(message.id) < BigInt(before)).slice(0, limit);
        return new Collection(page.map((message) => [message.id, message]));
      },
    },
    client: { user: { id: 'bot' } },
    send: async (body: { content?: string }) => {
      sends.push(body.content ?? '');
      acceptedMessage = { id: acceptedMessageId, author: { id: 'bot' }, content: body.content ?? '' };
      return { id: acceptedMessageId };
    },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });
  const realMarkDelivered = store.markDelivered.bind(store);
  let acknowledgements = 0;
  store.markDelivered = async (entryId, claimToken, messageId) => {
    acknowledgements++;
    if (acknowledgements === 1) throw new Error('database disconnected after Discord accepted the post');
    await realMarkDelivered(entryId, claimToken, messageId);
  };

  await sink.record({
    entryId: 'empty-channel', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  });
  assert.equal((await store.get('empty-channel'))?.deliverySearchBefore, '0');
  await db.prepare(`UPDATE operational_audit_log SET delivery_lease_until = ? WHERE entry_id = ?`).run(
    '2000-01-01T00:00:00.000Z', 'empty-channel',
  );
  assert.equal(await sink.retryPending(), 1);
  assert.equal(sends.length, 1);
  assert.equal((await store.get('empty-channel'))?.deliveryState, 'delivered');
  assert.equal((await store.get('empty-channel'))?.mirrorMessageId, acceptedMessageId);
  await db.close();
});

test('a failed pre-send recovery-bound write prevents the Discord send', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let sends = 0;
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async () => {
        const message = { id: '900000000000000000', author: { id: 'other' }, content: 'existing' };
        return new Collection([[message.id, message]]);
      },
    },
    client: { user: { id: 'bot' } },
    send: async () => { sends++; return { id: '900000000000000001' }; },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });
  store.prepareDeliverySend = async () => {
    throw new Error('database disconnected before Discord send');
  };

  await sink.record({
    entryId: 'pre-send-boundary', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  });

  assert.equal(sends, 0);
  const row = await store.get('pre-send-boundary');
  assert.equal(row?.deliveryState, 'pending');
  assert.equal(row?.deliveryAttempts, 1);
  assert.equal(row?.deliverySearchBefore, null);
  await db.close();
});

test('a transient recovery scan failure retains its boundary and never duplicates an accepted mirror', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const preSendMessageId = '900000000000000000';
  const acceptedMessageId = (BigInt(preSendMessageId) + 1n).toString();
  let sends = 0;
  let failRecoveryFetch = true;
  let acceptedMessage: { id: string; author: { id: string }; content: string } | null = null;
  const preSendMessage = { id: preSendMessageId, author: { id: 'other' }, content: 'pre-send' };
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async ({ limit = 50 }: { limit?: number }) => {
        if (acceptedMessage && failRecoveryFetch && limit === 100) {
          failRecoveryFetch = false;
          throw new Error('transient Discord history failure');
        }
        const history = acceptedMessage ? [acceptedMessage, preSendMessage] : [preSendMessage];
        return new Collection(history.slice(0, limit).map((message) => [message.id, message]));
      },
    },
    client: { user: { id: 'bot' } },
    send: async (body: { content?: string }) => {
      sends++;
      acceptedMessage = { id: acceptedMessageId, author: { id: 'bot' }, content: body.content ?? '' };
      return { id: acceptedMessageId };
    },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });
  const realMarkDelivered = store.markDelivered.bind(store);
  let acknowledgements = 0;
  store.markDelivered = async (entryId, claimToken, messageId) => {
    acknowledgements++;
    if (acknowledgements === 1) throw new Error('database disconnected after Discord accepted the post');
    await realMarkDelivered(entryId, claimToken, messageId);
  };

  await sink.record({
    entryId: 'recovery-fetch-failure', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  });
  await db.prepare(`UPDATE operational_audit_log SET delivery_lease_until = ? WHERE entry_id = ?`).run(
    '2000-01-01T00:00:00.000Z', 'recovery-fetch-failure',
  );

  assert.equal(await sink.retryPending(), 1);
  const pending = await store.get('recovery-fetch-failure');
  assert.equal(pending?.deliveryState, 'pending');
  assert.equal(pending?.deliverySearchBefore, acceptedMessageId);
  assert.equal(sends, 1);

  assert.equal(await sink.retryPending(), 1);
  const delivered = await store.get('recovery-fetch-failure');
  assert.equal(delivered?.deliveryState, 'delivered');
  assert.equal(delivered?.mirrorMessageId, acceptedMessageId);
  assert.equal(sends, 1);
  await db.close();
});

test('a definite 403 send rejection clears its boundary and retries after recovery', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let sends = 0;
  const messageId = '900000000000000601';
  const channel = {
    ...auditChannel(async () => new Collection()),
    send: async () => {
      sends++;
      if (sends === 1) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { id: messageId };
    },
  };
  const sink = makeOperationalAudit(auditClient(channel), {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });

  await sink.record({
    entryId: 'definite-403', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  });
  const rejected = await store.get('definite-403');
  assert.equal(rejected?.deliveryState, 'pending');
  assert.equal(rejected?.deliverySearchBefore, null);
  assert.equal(rejected?.deliveryLastError, 'discord_send_rejected_403');
  assert.equal(await sink.retryPending(), 1);
  assert.equal(sends, 2);
  assert.equal((await store.get('definite-403'))?.deliveryState, 'delivered');
  await db.close();
});

test('a generic post-send failure retains its recovery bound for marker reconciliation', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const preSendMessageId = '900000000000000000';
  let sends = 0;
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async () => {
        const message = { id: preSendMessageId, author: { id: 'other' }, content: 'existing' };
        return new Collection([[message.id, message]]);
      },
    },
    client: { user: { id: 'bot' } },
    send: async () => { sends++; throw new Error('Discord response lost after request started'); },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });

  await sink.record({
    entryId: 'post-send-rejection', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  });

  assert.equal(sends, 1);
  const row = await store.get('post-send-rejection');
  assert.equal(row?.deliveryState, 'delivering');
  assert.equal(row?.deliveryAttempts, 1);
  assert.equal(row?.deliveryLastError, 'delivery_ack_failed');
  assert.equal(row?.deliverySearchBefore, (BigInt(preSendMessageId) + 1n).toString());
  assert.equal(await sink.retryPending(), 0);
  await store.markAcknowledgementFailed('post-send-rejection', row!.deliveryClaimToken!, -1);
  assert.equal(await sink.retryPending(), 1);
  assert.equal(sends, 1);
  assert.equal((await store.get('post-send-rejection'))?.deliveryState, 'quarantined');
  assert.equal((await store.get('post-send-rejection'))?.deliveryLastError, 'discord_marker_missing');
  await db.close();
});

test('marker reconciliation requires the marker as the leading identity field', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let sends = 0;
  const messages = [
    {
      id: '900000000000000100',
      author: { id: 'bot' },
      content: 'audit-event:abc2; · metadata=`audit-event:abc;`',
    },
    {
      id: '900000000000000099',
      author: { id: 'bot' },
      content: 'audit-event:other; · metadata=`audit-event:abc; · **message delete**`',
    },
  ];
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async ({ limit }: { limit?: number }) =>
        new Collection((limit === 1 ? messages.slice(0, 1) : messages).map((message) => [message.id, message])),
    },
    client: { user: { id: 'bot' } },
    send: async () => { sends++; return { id: '900000000000000200' }; },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });

  await sink.record({
    entryId: 'abc', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  });
  assert.equal(sends, 1);
  assert.equal((await store.get('abc'))?.mirrorMessageId, '900000000000000200');
  await db.close();
});


test('an edited ambiguous marker fails closed through a long scan and overlapping retry', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let sends = 0;
  const preSendMessageId = '900000000000000000';
  const acceptedMessageId = (BigInt(preSendMessageId) + 1n).toString();
  const newerMessages = Array.from({ length: 550 }, (_, index) => ({
    id: (BigInt(acceptedMessageId) + 550n - BigInt(index)).toString(),
    author: { id: 'other' },
    content: `newer-${index}`,
  }));
  let acceptedMessage: { id: string; author: { id: string }; content: string } | null = null;
  const preSendMessage = { id: preSendMessageId, author: { id: 'other' }, content: 'pre-send' };
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async ({ limit = 50, before }: { limit?: number; before?: string }) => {
        const history = acceptedMessage
          ? [...newerMessages, acceptedMessage, preSendMessage]
          : [preSendMessage];
        const page = history
          .filter((message) => !before || BigInt(message.id) < BigInt(before))
          .slice(0, limit);
        return new Collection(page.map((message) => [message.id, message]));
      },
    },
    client: { user: { id: 'bot' } },
    send: async (body: { content?: string }) => {
      sends++;
      acceptedMessage = { id: acceptedMessageId, author: { id: 'bot' }, content: body.content ?? '' };
      return { id: acceptedMessageId };
    },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });
  const event: OperationalAuditEvent = {
    entryId: 'edited-marker', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  };
  const realMarkDelivered = store.markDelivered.bind(store);
  let acknowledgements = 0;
  store.markDelivered = async (entryId, claimToken, messageId) => {
    acknowledgements++;
    if (acknowledgements === 1) throw new Error('database disconnected after Discord accepted the post');
    await realMarkDelivered(entryId, claimToken, messageId);
  };

  assert.equal(await sink.record(event), true);
  assert.equal(sends, 1);
  assert.ok(acceptedMessage);
  (acceptedMessage as { content: string }).content =
    `audit-event:other; · metadata=\`audit-event:${event.entryId}; · \``;
  await db.prepare(`UPDATE operational_audit_log SET delivery_lease_until = ? WHERE entry_id = ?`).run(
    '2000-01-01T00:00:00.000Z',
    event.entryId,
  );

  const realExtendLease = store.extendDeliveryLease.bind(store);
  let leaseExtensions = 0;
  let overlappingRetry: Promise<number> | null = null;
  store.extendDeliveryLease = async (entryId, claimToken, leaseMs) => {
    await realExtendLease(entryId, claimToken, leaseMs);
    leaseExtensions++;
    if (leaseExtensions === 2) overlappingRetry = sink.retryPending();
  };

  assert.equal(await sink.retryPending(), 1);
  assert.equal(await overlappingRetry, 0);
  assert.ok(leaseExtensions >= 6);
  assert.equal(sends, 1);
  const row = await store.get(event.entryId);
  assert.equal(row?.deliveryState, 'quarantined');
  assert.equal(row?.deliveryLastError, 'discord_marker_missing');
  assert.equal(row?.deliverySearchBefore, acceptedMessageId);
  assert.equal(row?.deliveryAttempts, 2);
  await db.close();
});

test('quarantined ambiguous rows cannot starve newer pending audit deliveries', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  for (let index = 0; index < 25; index++) {
    const entryId = `poison-${String(index).padStart(2, '0')}`;
    await store.record({
      entryId, kind: 'message_delete', channel: 'audit', guildId: GUILD,
      occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
    }, CHANNEL_A);
    const claim = await store.claim(entryId);
    assert.ok(claim?.deliveryClaimToken);
    await store.prepareDeliverySend(entryId, claim.deliveryClaimToken, '1');
    await store.quarantineDelivery(entryId, claim.deliveryClaimToken, 'discord_marker_missing');
  }
  await store.record({
    entryId: 'fresh', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:01.000Z', sourceChannelId: CHANNEL_B,
  }, CHANNEL_A);

  const claimed = await store.claimPending();
  assert.deepEqual(claimed.map((item) => item.event.entryId), ['fresh']);
  assert.equal((await store.get('poison-00'))?.deliveryState, 'quarantined');
  await db.close();
});

test('retryable failures yield the next sweep to newer unattempted deliveries', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  for (let index = 0; index < 25; index++) {
    await store.record({
      entryId: `retry-${String(index).padStart(2, '0')}`, kind: 'message_delete', channel: 'audit', guildId: GUILD,
      occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
    }, CHANNEL_A);
  }
  await store.record({
    entryId: 'z-fresh-after-retries', kind: 'voice_join', channel: 'voice', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:01.000Z', targetId: MEMBER,
  }, CHANNEL_B);

  const firstSweep = await store.claimPending();
  assert.equal(firstSweep.length, 25);
  assert.ok(firstSweep.every((item) => item.event.entryId.startsWith('retry-')));
  for (const item of firstSweep) {
    await store.markDeliveryFailed(item.event.entryId, item.deliveryClaimToken!, 'channel_unavailable');
  }

  const secondSweep = await store.claimPending();
  assert.equal(secondSweep[0]?.event.entryId, 'z-fresh-after-retries');
  await db.close();
});

test('audit delivery failures redact thrown error text from process logs', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const sentinel = 'SENTINEL_AUDIT_SECRET_DO_NOT_LOG';
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Collection() },
    client: { user: { id: 'bot' } },
    send: async () => { throw new Error(sentinel); },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
    store,
  });
  let stderr = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await sink.record({
      entryId: 'redacted-send-failure',
      kind: 'message_delete',
      channel: 'audit',
      guildId: GUILD,
      occurredAt: '2026-09-09T00:00:00.000Z',
      sourceChannelId: CHANNEL_B,
      messageId: 'message-2',
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.doesNotMatch(stderr, new RegExp(sentinel));
  assert.match(stderr, /discord_post_ambiguous/);
  await db.close();
});





test('audit database write errors redact thrown text from process logs', async () => {
  const sentinel = 'SENTINEL_DB_PASSWORD_FROM_DRIVER';
  const store = {
    async record() { throw new Error(sentinel); },
    async claim() { return null; },
    async claimPending() { return []; },
    async markDeliveryFailed() {},
    async quarantineDelivery() {},
    async prepareDeliverySend() {},
    async markDelivered() {},
    async markAcknowledgementFailed() {},
  } as unknown as OperationalAuditStore;
  const client = { channels: { cache: new Map(), fetch: async () => null } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });
  let stderr = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    assert.equal(await sink.record({
      entryId: 'redacted-store-failure', kind: 'message_delete', channel: 'audit',
      guildId: GUILD, occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
    }), false);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.doesNotMatch(stderr, new RegExp(sentinel));
  assert.match(stderr, /audit_store_write_failed/);
});

test('member erasure removes operational audit rows carrying the member identity', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const memberId = '900000000000000001';
  await store.record({
    entryId: `member-update:${GUILD}:${memberId}:2026-09-09T00:00:00.000Z:digest`,
    kind: 'member_update', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', targetId: memberId,
  });
  await store.record({
    entryId: 'unrelated', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', actorId: '900000000000000002',
  });

  assert.equal(await store.eraseMember(memberId), 1);
  assert.equal(await store.get(`member-update:${GUILD}:${memberId}:2026-09-09T00:00:00.000Z:digest`), null);
  assert.ok(await store.get('unrelated'));
  await db.close();
});

test('delivery nonces are deterministic and fit Discord production bounds', () => {
  const entryId = 'member-update:1545644954272137297:900000000000000001:2026-09-09T07:00:00.000Z:' + 'x'.repeat(120);
  assert.equal(deliveryNonce(entryId), deliveryNonce(entryId));
  assert.match(deliveryNonce(entryId), /^oa_[A-Za-z0-9_-]+$/);
  assert.ok(deliveryNonce(entryId).length <= 25);
  assert.notEqual(deliveryNonce(entryId), deliveryNonce(entryId + ':different'));
});
test('Discord mirror refuses a configured channel from another guild', async () => {
  let sent = 0;
  const channel = {
    id: CHANNEL_A,
    guild: {
      id: OTHER_GUILD,
      members: { me: { id: 'bot' } },
    },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Collection() },
    client: { user: { id: 'bot' } },
    send: async () => { sent++; return { id: '900000000000000001' }; },
  };
  const client = {
    channels: {
      cache: new Map([[CHANNEL_A, channel]]),
      fetch: async () => channel,
    },
  } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD,
    channels: { audit: CHANNEL_A, voice: null, moderation: null },
  });
  await sink.record({
    entryId: 'cross-guild',
    kind: 'message_delete',
    channel: 'audit',
    guildId: GUILD,
    occurredAt: '2026-09-08T16:00:00.000Z',
  });
  assert.equal(sent, 0);
});
