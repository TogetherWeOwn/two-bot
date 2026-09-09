import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, ChannelType, Collection, Events, GatewayIntentBits, Partials, type Client } from 'discord.js';
import { createClient, INTENTS, registerHandlers } from '../src/discord/client.ts';
import { moderationAuditEvent } from '../src/audit/discordEvents.ts';
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
  const realSaveDeliverySearchBefore = store.saveDeliverySearchBefore.bind(store);
  let boundaryWrites = 0;
  store.saveDeliverySearchBefore = async (entryId, claimToken, before) => {
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
  await db.prepare(`UPDATE operational_audit_log SET delivery_lease_until = ? WHERE entry_id = ?`).run(
    '2000-01-01T00:00:00.000Z',
    event.entryId,
  );
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
    store.authorizeDeliverySend(event.entryId, first.deliveryClaimToken),
    /audit_delivery_send_not_authorized/,
  );
  await assert.rejects(
    store.authorizeDeliverySend(event.entryId, replacement.deliveryClaimToken),
    /audit_delivery_send_not_authorized/,
  );
  await assert.rejects(
    store.saveDeliverySearchBefore(event.entryId, first.deliveryClaimToken, '10'),
    /audit_delivery_search_bound_not_persisted/,
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

test('send authorization closes the final reclaim window before Discord I/O', async () => {
  const db = await openDb(':memory:');
  const store = new OperationalAuditStore(db);
  let sends = 0;
  let reclaim: StoredOperationalAudit | null = null;
  const channel = {
    id: CHANNEL_A,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Collection() },
    client: { user: { id: 'bot' } },
    send: async () => {
      sends++;
      reclaim = await store.claim('authorized-before-send');
      return { id: '1' };
    },
  };
  const client = { channels: { cache: new Map([[CHANNEL_A, channel]]), fetch: async () => channel } } as unknown as Client;
  const sink = makeOperationalAudit(client, {
    guildId: GUILD, channels: { audit: CHANNEL_A, voice: null, moderation: null }, store,
  });

  await sink.record({
    entryId: 'authorized-before-send', kind: 'message_delete', channel: 'audit', guildId: GUILD,
    occurredAt: '2026-09-09T00:00:00.000Z', sourceChannelId: CHANNEL_B,
  });
  assert.equal(sends, 1);
  assert.equal(reclaim, null, 'an authorized send has no expiring lease to reclaim');
  const row = await store.get('authorized-before-send');
  assert.equal(row?.deliveryState, 'delivered');
  assert.equal(row?.mirrorMessageId, '1');
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
  const realAuthorize = store.authorizeDeliverySend.bind(store);
  store.authorizeDeliverySend = async (entryId, claimToken) => {
    await db.prepare(
      `UPDATE operational_audit_log
          SET delivery_search_before = NULL, delivery_lease_until = ?
        WHERE entry_id = ?`,
    ).run('2000-01-01T00:00:00.000Z', entryId);
    replacementToken = (await store.claim(entryId))?.deliveryClaimToken ?? null;
    await realAuthorize(entryId, claimToken);
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
  store.saveDeliverySearchBefore = async () => {
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

test('a post-send rejection retains its recovery bound for marker reconciliation', async () => {
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
  assert.equal(row?.deliveryState, 'pending');
  assert.equal(row?.deliveryLastError, 'discord_marker_missing');
  assert.equal(row?.deliverySearchBefore, acceptedMessageId);
  assert.equal(row?.deliveryAttempts, 2);
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
    async saveDeliverySearchBefore() {},
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
