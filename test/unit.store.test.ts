/**
 * Funnel rules, tested without a network or a token.
 *
 * The assertions run against an isolated Postgres schema supplied through
 * TWO_TEST_DATABASE_URL.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { InviteTracker } from '../src/core/inviteTracker.ts';
import { flagInactive, joinedNeverPosted } from '../src/jobs/inactivity.ts';
import { MESSAGE_RUNGS } from '../src/core/events.ts';
import { AM7_MESSAGE_THRESHOLD } from '../src/analytics/attribution.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = '1';

let harness: TestDb;

before(async () => {
  harness = await openTestDb(import.meta.filename);
});
after(async () => {
  await harness.cleanup();
});
beforeEach(async () => {
  await harness.reset();
});

function fixture() {
  const db = harness.db;
  const store = new EventStore(db);
  return { db, store, h: new FunnelHandlers(store) };
}

test('a repeated join for the same instant is not double counted', async () => {
  const { store } = fixture();
  const at = '2026-08-19T10:00:00.000Z';
  const e = { guildId: G, memberId: 'm1', eventType: 'member_join' as const, occurredAt: at, source: 'invite:x' };
  assert.equal((await store.record(e)).inserted, true);
  assert.equal((await store.record(e)).inserted, false);
  assert.equal(await store.countByType('member_join'), 1);
});

test('bots are excluded from the funnel', async () => {
  const { h, store } = fixture();
  await h.onJoin({ guildId: G, memberId: 'bot1', isBot: true, source: 'invite:x' });
  await h.onMessage({ guildId: G, memberId: 'bot1', isBot: true, channelId: 'c1' });
  assert.equal(await store.countByType('member_join'), 0);
  assert.equal(await store.countByType('first_message'), 0);
});

test('first_message fires once, and two messages are not yet a third', async () => {
  const { h, store, db } = fixture();
  await h.onJoin({ guildId: G, memberId: 'm1', isBot: false, source: 'invite:x' });
  await h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z' });
  await h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c2', occurredAt: '2026-08-05T00:00:00.000Z' });
  assert.equal(await store.countByType('first_message'), 1);
  const m = (await db.prepare(`SELECT * FROM members WHERE member_id='m1'`).get()) as any;
  assert.equal(m.first_message_at, '2026-08-01T00:00:00.000Z');
  assert.equal(m.last_active_at, '2026-08-05T00:00:00.000Z');
  // Two messages is not the AM7 text bar, and the column says so rather than
  // guessing. This is the case the old proxy silently admitted.
  assert.equal(m.third_message_at, null);
});

// --- the message ladder (TWO-95) --------------------------------------------

test('the ladder is exactly as long as the AM7 bar', () => {
  // If someone raises AM7 to 5 messages, the ladder has to grow with it or the
  // report goes quietly back to being an upper bound.
  assert.equal(MESSAGE_RUNGS.length, AM7_MESSAGE_THRESHOLD);
  assert.equal(MESSAGE_RUNGS.at(-1), 'third_message');
});

test('the third message is recorded, and it is the third one - not the latest', async () => {
  const { h, store, db } = fixture();
  await h.onJoin({ guildId: G, memberId: 'm1', isBot: false, source: 'invite:x' });
  for (const day of ['01', '02', '03', '04', '05']) {
    await h.onMessage({
      guildId: G, memberId: 'm1', isBot: false, channelId: 'c1',
      occurredAt: `2026-08-${day}T00:00:00.000Z`,
    });
  }
  const m = (await db.prepare(`SELECT * FROM members WHERE member_id='m1'`).get()) as any;
  assert.equal(m.third_message_at, '2026-08-03T00:00:00.000Z');
  assert.equal(m.last_active_at, '2026-08-05T00:00:00.000Z');
  // Five messages, three rungs. We stop counting at the bar.
  assert.equal(await store.countByType('first_message'), 1);
  assert.equal(await store.countByType('second_message'), 1);
  assert.equal(await store.countByType('third_message'), 1);
});

test('a redelivered message does not climb the ladder twice', async () => {
  // A gateway resume replays frames we have already handled, and a replay
  // carries the original timestamp. Counting it again would inflate AM7, which
  // is the exact failure this column exists to end.
  const { h, db } = fixture();
  const at = '2026-08-01T00:00:00.000Z';
  await h.onJoin({ guildId: G, memberId: 'm1', isBot: false, source: 'invite:x' });
  for (let i = 0; i < 3; i++) {
    await h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c1', occurredAt: at });
  }
  const m = (await db.prepare(`SELECT * FROM members WHERE member_id='m1'`).get()) as any;
  assert.equal(m.first_message_at, at);
  assert.equal(m.third_message_at, null);
});

test('nextMessageRung reports the rung a message would fill', async () => {
  const { h, store } = fixture();
  assert.equal(await store.nextMessageRung(G, 'm1', '2026-08-01T00:00:00.000Z'), 'first_message');
  await h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z' });
  assert.equal(await store.nextMessageRung(G, 'm1', '2026-08-02T00:00:00.000Z'), 'second_message');
  await h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c1', occurredAt: '2026-08-02T00:00:00.000Z' });
  assert.equal(await store.nextMessageRung(G, 'm1', '2026-08-03T00:00:00.000Z'), 'third_message');
  await h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c1', occurredAt: '2026-08-03T00:00:00.000Z' });
  // Ladder full. Every later message is recency only.
  assert.equal(await store.nextMessageRung(G, 'm1', '2026-08-09T00:00:00.000Z'), null);
});

test('a backfilled older third message moves the milestone earlier, never later', async () => {
  // recordEarliest is what makes a deeper re-scan safe: it may only improve the
  // timestamp. A member whose true third message was inside their 7-day window
  // becomes AM7 on a re-run; one already recorded early never regresses.
  const { store, db } = fixture();
  const rung = (occurredAt: string) => ({
    guildId: G, memberId: 'm1', eventType: 'third_message' as const,
    occurredAt, source: 'channel:c1',
  });
  await store.recordEarliest(rung('2026-08-20T00:00:00.000Z'));
  await store.recordEarliest(rung('2026-08-02T00:00:00.000Z'));
  await store.recordEarliest(rung('2026-08-11T00:00:00.000Z'));
  const m = (await db.prepare(`SELECT * FROM members WHERE member_id='m1'`).get()) as any;
  assert.equal(m.third_message_at, '2026-08-02T00:00:00.000Z');
  assert.equal(await store.countByType('third_message'), 1);
});

test('clearing the rules gate is its own event, once per member', async () => {
  const { h, store, db } = fixture();
  await h.onJoin({ guildId: G, memberId: 'm1', isBot: false, source: 'invite:x', occurredAt: '2026-08-01T00:00:00.000Z' });

  // Joined is not in. Until they accept the rules there is no clearing on file.
  assert.equal(await store.countByType('gate_cleared'), 0);

  await h.onGateCleared({ guildId: G, memberId: 'm1', isBot: false, occurredAt: '2026-08-01T00:05:00.000Z' });
  // A rejoin is genuinely re-screened, so the listener fires again. It must not
  // count twice: conversion is people, not clearings, and a second one pushes
  // the rate over 100%.
  await h.onGateCleared({ guildId: G, memberId: 'm1', isBot: false, occurredAt: '2026-09-01T00:00:00.000Z' });

  assert.equal(await store.countByType('gate_cleared'), 1);
  const m = (await db.prepare(`SELECT * FROM members WHERE member_id='m1'`).get()) as any;
  assert.equal(m.gate_cleared_at, '2026-08-01T00:05:00.000Z', 'the earliest clearing wins');
});

test('bots do not clear the gate', async () => {
  const { h, store } = fixture();
  await h.onGateCleared({ guildId: G, memberId: 'bot1', isBot: true });
  assert.equal(await store.countByType('gate_cleared'), 0);
});

test('invite attribution: one code grew', async () => {
  const { db } = fixture();
  const t = new InviteTracker(db);
  await t.diffAndStore(G, [
    { code: 'a', uses: 1, inviterId: 'u1', channelId: 'c1' },
    { code: 'b', uses: 7, inviterId: 'u2', channelId: 'c1' },
  ]);
  const grew = await t.diffAndStore(G, [
    { code: 'a', uses: 2, inviterId: 'u1', channelId: 'c1' },
    { code: 'b', uses: 7, inviterId: 'u2', channelId: 'c1' },
  ]);
  assert.deepEqual(grew, ['a']);
  assert.equal(t.attribute(grew, false), 'invite:a');
  assert.equal(await t.inviterFor(G, 'a'), 'u1');
});

test('invite attribution is honest when it cannot tell', async () => {
  const { db } = fixture();
  const t = new InviteTracker(db);
  assert.equal(t.attribute([], false), 'unknown');
  assert.equal(t.attribute([], true), 'vanity');
  assert.equal(t.attribute(['a', 'b'], false), 'ambiguous:a+b');
});

test('inactivity flags the quiet and spares the active', async () => {
  const { h, db, store } = fixture();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();

  await h.onJoin({ guildId: G, memberId: 'quiet', isBot: false, source: 'invite:x', occurredAt: old });
  await h.onJoin({ guildId: G, memberId: 'chatty', isBot: false, source: 'invite:x', occurredAt: old });
  await h.onMessage({ guildId: G, memberId: 'chatty', isBot: false, channelId: 'c1', occurredAt: recent });

  const flagged = await flagInactive(db, store, 14);
  assert.deepEqual(flagged, ['quiet']);
  assert.deepEqual(await joinedNeverPosted(db, G), ['quiet']);

  // Re-running the sweep must not re-flag the same member.
  assert.deepEqual(await flagInactive(db, store, 14), []);
});

test('a member who left is excluded from re-engagement lists', async () => {
  const { h, db, store } = fixture();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  await h.onJoin({ guildId: G, memberId: 'gone', isBot: false, source: 'invite:x', occurredAt: old });
  await h.onLeave(G, 'gone');
  assert.deepEqual(await flagInactive(db, store, 14), []);
  assert.deepEqual(await joinedNeverPosted(db, G), []);
});
