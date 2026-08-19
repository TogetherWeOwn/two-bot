/** Funnel rules, tested without a network or a token. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { InviteTracker } from '../src/core/inviteTracker.ts';
import { flagInactive, joinedNeverPosted } from '../src/jobs/inactivity.ts';

const G = '1';

function fixture() {
  const db = openDb(':memory:');
  const store = new EventStore(db);
  return { db, store, h: new FunnelHandlers(store) };
}

test('a repeated join for the same instant is not double counted', () => {
  const { store } = fixture();
  const at = '2026-08-19T10:00:00.000Z';
  const e = { guildId: G, memberId: 'm1', eventType: 'member_join' as const, occurredAt: at, source: 'invite:x' };
  assert.equal(store.record(e).inserted, true);
  assert.equal(store.record(e).inserted, false);
  assert.equal(store.countByType('member_join'), 1);
});

test('bots are excluded from the funnel', () => {
  const { h, store } = fixture();
  h.onJoin({ guildId: G, memberId: 'bot1', isBot: true, source: 'invite:x' });
  h.onMessage({ guildId: G, memberId: 'bot1', isBot: true, channelId: 'c1' });
  assert.equal(store.countByType('member_join'), 0);
  assert.equal(store.countByType('first_message'), 0);
});

test('first_message fires once, later messages only move recency', () => {
  const { h, store, db } = fixture();
  h.onJoin({ guildId: G, memberId: 'm1', isBot: false, source: 'invite:x' });
  h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z' });
  h.onMessage({ guildId: G, memberId: 'm1', isBot: false, channelId: 'c2', occurredAt: '2026-08-05T00:00:00.000Z' });
  assert.equal(store.countByType('first_message'), 1);
  const m = db.prepare(`SELECT * FROM members WHERE member_id='m1'`).get() as any;
  assert.equal(m.first_message_at, '2026-08-01T00:00:00.000Z');
  assert.equal(m.last_active_at, '2026-08-05T00:00:00.000Z');
});

test('invite attribution: one code grew', () => {
  const { db } = fixture();
  const t = new InviteTracker(db);
  t.diffAndStore(G, [
    { code: 'a', uses: 1, inviterId: 'u1', channelId: 'c1' },
    { code: 'b', uses: 7, inviterId: 'u2', channelId: 'c1' },
  ]);
  const grew = t.diffAndStore(G, [
    { code: 'a', uses: 2, inviterId: 'u1', channelId: 'c1' },
    { code: 'b', uses: 7, inviterId: 'u2', channelId: 'c1' },
  ]);
  assert.deepEqual(grew, ['a']);
  assert.equal(t.attribute(grew, false), 'invite:a');
  assert.equal(t.inviterFor(G, 'a'), 'u1');
});

test('invite attribution is honest when it cannot tell', () => {
  const { db } = fixture();
  const t = new InviteTracker(db);
  assert.equal(t.attribute([], false), 'unknown');
  assert.equal(t.attribute([], true), 'vanity');
  assert.equal(t.attribute(['a', 'b'], false), 'ambiguous:a+b');
});

test('inactivity flags the quiet and spares the active', () => {
  const { h, db, store } = fixture();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();

  h.onJoin({ guildId: G, memberId: 'quiet', isBot: false, source: 'invite:x', occurredAt: old });
  h.onJoin({ guildId: G, memberId: 'chatty', isBot: false, source: 'invite:x', occurredAt: old });
  h.onMessage({ guildId: G, memberId: 'chatty', isBot: false, channelId: 'c1', occurredAt: recent });

  const flagged = flagInactive(db, store, 14);
  assert.deepEqual(flagged, ['quiet']);
  assert.deepEqual(joinedNeverPosted(db, G), ['quiet']);

  // Re-running the sweep must not re-flag the same member.
  assert.deepEqual(flagInactive(db, store, 14), []);
});

test('a member who left is excluded from re-engagement lists', () => {
  const { h, db, store } = fixture();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  h.onJoin({ guildId: G, memberId: 'gone', isBot: false, source: 'invite:x', occurredAt: old });
  h.onLeave(G, 'gone');
  assert.deepEqual(flagInactive(db, store, 14), []);
  assert.deepEqual(joinedNeverPosted(db, G), []);
});
