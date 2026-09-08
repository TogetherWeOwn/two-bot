import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Events, GatewayIntentBits, type Client } from 'discord.js';
import { INTENTS, registerHandlers } from '../src/discord/client.ts';
import { moderationAuditEvent } from '../src/audit/discordEvents.ts';
import { formatAuditEvent, type OperationalAuditEvent } from '../src/audit/events.ts';
import { makeOperationalAudit } from '../src/audit/service.ts';
import { OperationalAuditStore } from '../src/audit/store.ts';
import { openDb } from '../src/store/db.ts';
import type { FunnelHandlers } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';

const GUILD = '1545644954272137297';
const OTHER_GUILD = '326474832151838730';
const MEMBER = '900000000000000001';
const CHANNEL_A = '900000000000000101';
const CHANNEL_B = '900000000000000102';

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
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function roles(ids: string[]) {
  return { cache: new Map(ids.map((id) => [id, {}])) };
}

test('gateway requests the moderation intent required by GuildAuditLogEntryCreate', () => {
  assert.ok(INTENTS.includes(GatewayIntentBits.GuildModeration));
});

test('gateway logging covers edit/delete, member deltas and voice move without content or nicknames', async () => {
  const events: OperationalAuditEvent[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, deps(events));

  bus.emit(
    Events.MessageUpdate,
    { id: 'message-1', guildId: GUILD, channelId: CHANNEL_A, partial: false, author: { id: MEMBER }, content: 'old secret' },
    {
      id: 'message-1',
      guildId: GUILD,
      channelId: CHANNEL_A,
      partial: false,
      author: { id: MEMBER },
      editedTimestamp: 1_700_000_000_000,
      editedAt: new Date(1_700_000_000_000),
      content: 'new secret',
    },
  );
  bus.emit(Events.MessageDelete, {
    id: 'message-2',
    guildId: GUILD,
    channelId: CHANNEL_A,
    partial: false,
    author: { id: MEMBER },
    content: 'deleted secret',
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

test('member and voice replay keys are stable for identical transitions', async () => {
  const events: OperationalAuditEvent[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, deps(events));
  const oldMember = { id: MEMBER, guild: { id: GUILD }, partial: false, nickname: 'a', roles: roles([GUILD]) };
  const newMember = { id: MEMBER, guild: { id: GUILD }, nickname: 'b', roles: roles([GUILD]), user: { bot: false } };
  const oldVoice = { id: MEMBER, guild: { id: GUILD }, channelId: CHANNEL_A, member: { user: { bot: false } } };
  const newVoice = { id: MEMBER, guild: { id: GUILD }, channelId: CHANNEL_B, member: { user: { bot: false } } };
  bus.emit(Events.GuildMemberUpdate, oldMember, newMember);
  bus.emit(Events.GuildMemberUpdate, oldMember, newMember);
  bus.emit(Events.VoiceStateUpdate, oldVoice, newVoice);
  bus.emit(Events.VoiceStateUpdate, oldVoice, newVoice);
  await settle();
  assert.equal(events[0].entryId, events[1].entryId);
  assert.equal(events[2].entryId, events[3].entryId);
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
  );

  assert.ok(event);
  assert.equal(event.action, 'message_delete');
  assert.equal(event.actorId, 'moderator-1');
  assert.equal(event.targetId, MEMBER);
  assert.equal(event.sourceChannelId, CHANNEL_A);
  assert.equal('reason' in event, false);
  assert.deepEqual(event.metadata, { auditLogEntryId: 'audit-1', count: 3 });
});

test('mirror text suppresses raw message content and keeps stable ids', () => {
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
  assert.match(text, new RegExp(MEMBER));
  assert.match(text, /message-2/);
  assert.doesNotMatch(text, /content|username|nickname|reason/);
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
    send: async () => { sent++; },
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
