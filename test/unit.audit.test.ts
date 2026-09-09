import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, ChannelType, Events, GatewayIntentBits, Partials, type Client } from 'discord.js';
import { createClient, INTENTS, registerHandlers } from '../src/discord/client.ts';
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

test('uncached delete and update gateway actions emit partial messages', async () => {
  const client = createClient();
  const internals = client as unknown as {
    guilds: { _add(data: unknown): unknown };
    channels: { _add(data: unknown): unknown };
    actions: {
      MessageDelete: { handle(data: unknown): unknown };
      MessageUpdate: { handle(data: unknown): { old?: never; updated?: never } };
    };
  };
  internals.guilds._add({ id: GUILD, unavailable: false });
  internals.channels._add({ id: CHANNEL_A, guild_id: GUILD, type: ChannelType.GuildText, name: 'general' });

  const deleted: Array<{ id: string; partial: boolean }> = [];
  const updated: Array<{ oldPartial: boolean; newPartial: boolean }> = [];
  client.on(Events.MessageDelete, (message) => deleted.push({ id: message.id, partial: message.partial }));
  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    updated.push({ oldPartial: oldMessage.partial, newPartial: newMessage.partial });
  });

  internals.actions.MessageDelete.handle({ id: 'uncached-delete', channel_id: CHANNEL_A, guild_id: GUILD });
  const edit = internals.actions.MessageUpdate.handle({
    id: 'uncached-edit',
    channel_id: CHANNEL_A,
    guild_id: GUILD,
    edited_timestamp: '2026-09-09T00:00:00.000Z',
  });
  if (edit.old && edit.updated) client.emit(Events.MessageUpdate, edit.old, edit.updated);

  assert.deepEqual(deleted, [{ id: 'uncached-delete', partial: true }]);
  assert.deepEqual(updated, [{ oldPartial: true, newPartial: true }]);
  client.destroy();
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

test('mirror text suppresses raw message content and carries a detectable event marker', () => {
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
  assert.match(text, /audit-event:one/);
  assert.match(text, new RegExp(MEMBER));
  assert.match(text, /message-2/);
  assert.doesNotMatch(text, /content|username|nickname|reason/);
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
    send: async () => { sent++; return { id: 'mirror-message' }; },
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
    send: async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient Discord failure');
      return { id: 'mirror-message-1' };
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
  assert.equal(await sink.record(event), true);
  assert.equal((await store.get(event.entryId))?.deliveryState, 'pending');
  assert.equal(await sink.record(event), false);
  assert.equal(attempts, 2);
  const row = await store.get(event.entryId);
  assert.equal(row?.deliveryState, 'delivered');
  assert.equal(row?.deliveryAttempts, 2);
  assert.equal(row?.deliveryNonce, event.entryId);
  assert.equal(row?.mirrorMessageId, 'mirror-message-1');
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM operational_audit_log`).get<{ n: number }>();
  assert.equal(Number(count?.n), 1);
  await db.close();
});

test('post-send acknowledgement retries reuse the durable Discord nonce', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  const sends: Array<{ nonce?: string | number; enforceNonce?: boolean }> = [];
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    send: async (body: { nonce?: string | number; enforceNonce?: boolean }) => {
      sends.push(body);
      return { id: 'same-discord-message' };
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
  store.markDelivered = async (entryId, messageId) => {
    acknowledgements++;
    if (acknowledgements === 1) throw new Error('database disconnected after Discord accepted the post');
    await realMarkDelivered(entryId, messageId);
  };

  assert.equal(await sink.record(event), true);
  const ambiguous = await store.get(event.entryId);
  assert.equal(ambiguous?.deliveryState, 'delivering');
  assert.equal(ambiguous?.deliveryAttempts, 1);
  await db.prepare(`UPDATE operational_audit_log SET delivery_lease_until = ? WHERE entry_id = ?`).run(
    '2000-01-01T00:00:00.000Z',
    event.entryId,
  );
  assert.equal(await sink.retryPending(), 1);

  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map((body) => body.nonce), [event.entryId, event.entryId]);
  assert.deepEqual(sends.map((body) => body.enforceNonce), [true, true]);
  const row = await store.get(event.entryId);
  assert.equal(row?.deliveryState, 'delivered');
  assert.equal(row?.mirrorMessageId, 'same-discord-message');
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
  assert.match(stderr, /discord_send_failed/);
  await db.close();
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
    send: async () => { sent++; return { id: 'mirror-message' }; },
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
