import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openEphemeralTestDb as openDb } from './helpers/testDb.ts';
import { intentsFor } from '../src/discord/client.ts';
import { GatewayIntentBits } from 'discord.js';
import {
  TicketStore,
  ticketTestHelpers,
  ticketChannelName,
  buildTicketPanel,
  buildTicketControls,
} from '../src/discord/tickets.ts';

test('ticket controls have stable custom ids', () => {
  const panel = buildTicketPanel();
  const controls = buildTicketControls();
  const panelJson = panel.toJSON() as unknown as { components: Array<{ custom_id?: string }> };
  const controlsJson = controls.toJSON() as unknown as { components: Array<{ custom_id?: string }> };
  assert.equal(panelJson.components[0]?.custom_id, 'two:tickets:open');
  assert.deepEqual(
    controlsJson.components.map((button) => button.custom_id),
    ['two:tickets:claim', 'two:tickets:close'],
  );
});

test('ticket channel names are safe and bounded', () => {
  const name = ticketChannelName({ user: { username: 'A very unsafe Username!!!' } } as never);
  assert.match(name, /^ticket-[a-z0-9-]+$/);
  assert.ok(name.length <= 31);
});

test('ticket cooldown refuses only recent tickets', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z');
  assert.equal(ticketTestHelpers.withinCooldown('2026-09-08T11:59:00.000Z', now, 300), true);
  assert.equal(ticketTestHelpers.withinCooldown('2026-09-08T11:50:00.000Z', now, 300), false);
  assert.equal(ticketTestHelpers.withinCooldown(null, now, 300), false);
});

test('ticket transcripts request message content and expire after 90 days', () => {
  // TOG-5258: MessageContent is requested exactly when tickets are configured
  // (all three DISCORD_TICKET_* vars present) - the same guard as src/index.ts.
  assert.ok(
    intentsFor({
      DISCORD_TICKET_CATEGORY_ID: '111111111111111111',
      DISCORD_TICKET_STAFF_ROLE_ID: '222222222222222222',
      DISCORD_TICKET_PANEL_CHANNEL_ID: '333333333333333333',
    }).includes(GatewayIntentBits.MessageContent),
  );
  assert.ok(!intentsFor({}).includes(GatewayIntentBits.MessageContent));
  assert.equal(
    ticketTestHelpers.purgeAfter('2026-09-08T12:00:00.000Z'),
    '2026-12-07T12:00:00.000Z',
  );
});

test('Discord Unknown Channel is the only cleanup error treated as already deleted', () => {
  assert.equal(ticketTestHelpers.isUnknownChannel({ code: 10003 }), true);
  assert.equal(ticketTestHelpers.isUnknownChannel({ code: 50013 }), false);
  assert.equal(ticketTestHelpers.isUnknownChannel(new Error('Unknown Channel')), false);
});

test('Postgres ticket store reserves one active ticket and supports cleanup recovery', async () => {
  const db = await openDb();
  try {
    const store = new TicketStore(db);
    const reserved = await store.reserve('guild', 'member', '2026-09-08T12:00:00.000Z');
    assert.ok(reserved);
    assert.equal(reserved.status, 'creating');
    assert.equal(await store.reserve('guild', 'member', '2026-09-08T12:00:01.000Z'), null);

    assert.equal((await store.recordCreatedChannel(reserved.id, 'channel'))?.status, 'creating');
    const active = await store.activate(reserved.id, 'channel');
    assert.equal(active?.status, 'open');
    assert.equal(active?.channelId, 'channel');
    const closing = await store.beginClose('channel', '2026-09-08T12:00:30.000Z');
    assert.equal(closing?.status, 'closing');
    assert.equal((await store.staleClosing('2026-09-08T12:01:00.000Z', 'guild')).length, 1);
    assert.equal(await store.reopenInterruptedClose(reserved.id, closing!.closingStartedAt!), true);
    assert.equal((await store.byChannel('channel'))?.status, 'open');
    assert.equal((await store.byChannel('channel'))?.closingStartedAt, null);

    const secondClosing = await store.beginClose('channel', '2026-09-08T12:01:30.000Z');
    assert.ok(secondClosing);
    assert.equal(await store.saveTranscript({
      ticketId: reserved.id,
      guildId: 'guild',
      channelId: 'channel',
      openerId: 'member',
      claimedBy: null,
      content: 'complete snapshot',
      messageCount: 2,
      createdAt: '2026-09-08T12:02:00.000Z',
      purgeAfter: '2026-12-07T12:02:00.000Z',
    }, secondClosing.closingStartedAt), true);
    assert.equal(await store.transcriptExists(reserved.id), true);
    assert.equal(await store.recoverClosingToCleanup(reserved.id, secondClosing.closingStartedAt!), true);
    assert.equal((await store.byChannel('channel'))?.status, 'cleanup_pending');
    assert.equal(await store.saveTranscript({
      ticketId: reserved.id,
      guildId: 'guild',
      channelId: 'channel',
      openerId: 'member',
      claimedBy: null,
      content: 'late stale snapshot',
      messageCount: 1,
      createdAt: '2026-09-08T12:03:00.000Z',
      purgeAfter: '2026-12-07T12:03:00.000Z',
    }, secondClosing.closingStartedAt), false);
    assert.equal((await db.prepare(`SELECT content FROM ticket_transcripts WHERE ticket_id = ?`).get<{ content: string }>(reserved.id))?.content, 'complete snapshot');

    await store.markCleanupPending(reserved.id, '2026-09-08T12:02:00.000Z');
    assert.equal((await store.cleanupPending('guild')).length, 1);
    await store.markClosed(reserved.id, '2026-09-08T12:02:00.000Z');
    assert.equal((await store.byChannel('channel'))?.status, 'closed');
  } finally {
    await db.close();
  }
});

test('interrupted ticket creation remains recoverable after its cutoff', async () => {
  const db = await openDb();
  try {
    const store = new TicketStore(db);
    const reservation = await store.reserve('guild', 'member', '2026-09-08T12:00:00.000Z');
    assert.ok(reservation);
    assert.equal((await store.staleCreating('2026-09-08T12:01:00.000Z', 'guild')).length, 1);
    assert.equal((await store.staleClosing('2026-09-08T12:01:00.000Z', 'guild')).length, 0);
    assert.equal((await store.activeFor('guild', 'member'))?.status, 'creating');
    await store.recordCreatedChannel(reservation.id, 'channel');
    assert.equal((await store.staleCreating('2026-09-08T12:01:00.000Z', 'guild'))[0]?.channelId, 'channel');
  } finally {
    await db.close();
  }
});

test('ticket transcript purge and member erasure delete sensitive rows', async () => {
  const db = await openDb();
  try {
    const store = new TicketStore(db);
    const reserved = (await store.reserve('guild', 'member', '2026-09-08T12:00:00.000Z'))!;
    await store.activate(reserved.id, 'channel');
    const closing = await store.beginClose('channel', '2026-09-08T12:00:30.000Z');
    assert.ok(closing);
    assert.equal(await store.saveTranscript({
      ticketId: reserved.id,
      guildId: 'guild',
      channelId: 'channel',
      openerId: 'member',
      claimedBy: null,
      content: 'sensitive',
      messageCount: 1,
      createdAt: '2026-09-08T12:01:00.000Z',
      purgeAfter: '2026-09-09T12:01:00.000Z',
    }, closing.closingStartedAt), true);
    assert.equal(await store.purgeExpired('2026-09-09T12:01:00.000Z'), 1);

    assert.equal(await store.saveTranscript({
      ticketId: reserved.id,
      guildId: 'guild',
      channelId: 'channel',
      openerId: 'member',
      claimedBy: null,
      content: 'sensitive again',
      messageCount: 1,
      createdAt: '2026-09-08T12:02:00.000Z',
      purgeAfter: '2026-12-07T12:02:00.000Z',
    }, closing.closingStartedAt), true);
    await store.eraseMember('member');
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM tickets`).get<{ n: number }>())?.n, 0);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ticket_transcripts`).get<{ n: number }>())?.n, 0);
  } finally {
    await db.close();
  }
});
