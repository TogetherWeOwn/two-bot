/**
 * Funnel rules, tested without a network or a token.
 *
 * The assertions are the same ones this suite has always made. What changed in
 * TWO-18 is that they now run against whichever driver the run is pointed at -
 * SQLite by default, Postgres when TWO_TEST_DATABASE_URL is set. Same rules,
 * both engines, or the migration is not done.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { InviteTracker } from '../src/core/inviteTracker.ts';
import { flagInactive, joinedNeverPosted } from '../src/jobs/inactivity.ts';
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

test('first_message fires once, later messages only move recency', async () => {
  const { h, store, db } = fixture();
  await h.onJoin({ guildId: G, memberId: 'm1', isBot: false, source: 'invite:x' });
  await h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z' });
  await h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c2', occurredAt: '2026-08-05T00:00:00.000Z' });
  assert.equal(await store.countByType('first_message'), 1);
  const m = (await db.prepare(`SELECT * FROM members WHERE member_id='m1'`).get()) as any;
  assert.equal(m.first_message_at, '2026-08-01T00:00:00.000Z');
  assert.equal(m.last_active_at, '2026-08-05T00:00:00.000Z');
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
