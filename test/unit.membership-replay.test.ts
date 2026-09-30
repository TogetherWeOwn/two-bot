import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';
import { registerHandlers } from '../src/discord/client.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = 'membership-replay';
const M = 'member';
const FIRST = '2026-09-29T00:00:00.000Z';
const REJOIN = '2026-09-30T00:30:00.000Z';
const RESUMED = '2026-09-30T01:00:00.000Z';
let harness: TestDb;

before(async () => { harness = await openTestDb(import.meta.filename); });
after(async () => { await harness.cleanup(); });
beforeEach(async () => { await harness.reset(); });

async function projection() {
  return harness.db.prepare(
    `SELECT joined_at, join_source, left_at FROM members WHERE guild_id = ? AND member_id = ?`,
  ).get(G, M);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

for (const completion of ['leave-first', 'join-first'] as const) {
  test(`replayed live leave/rejoin keeps original join time with ${completion} completion`, async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(RESUMED) });
    try {
      const store = new EventStore(harness.db);
      const h = new FunnelHandlers(store);
      await store.record({ guildId: G, memberId: M, eventType: 'member_join', source: 'invite:first', occurredAt: FIRST });
      const leave = () => h.onLeave(G, M, undefined, {
        observedAt: '2026-09-30T01:00:00.000001Z',
      });
      const join = () => h.onJoin({
        guildId: G, memberId: M, isBot: false, source: 'invite:latest', occurredAt: REJOIN,
        observedAt: '2026-09-30T01:00:00.000002Z',
      });
      if (completion === 'leave-first') { await leave(); await join(); }
      else { await join(); await leave(); }
      assert.deepEqual(await projection(), { joined_at: REJOIN, join_source: 'invite:latest', left_at: null });
      const history = await harness.db.prepare(
        `SELECT event_type, occurred_at, source FROM events WHERE guild_id = ? AND member_id = ? ORDER BY id`,
      ).all(G, M);
      assert.equal(history.length, 3);
      assert.ok(history.some((r) => r.event_type === 'member_leave' && r.occurred_at === RESUMED));
      assert.ok(history.some((r) => r.event_type === 'member_join' && r.occurred_at === REJOIN));
      // Backfilled membership predating this live observation cannot close it.
      await store.record({ guildId: G, memberId: M, eventType: 'member_leave', occurredAt: '2026-09-30T00:45:00.000Z', source: 'backfill' });
      await store.record({ guildId: G, memberId: M, eventType: 'member_join', occurredAt: FIRST, source: 'backfill' });
      assert.deepEqual(await projection(), { joined_at: REJOIN, join_source: 'invite:latest', left_at: null });
    } finally { mock.timers.reset(); }
  });
}

test('same-tick handler replay reopens a member without rewriting join attribution on duplicate', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(RESUMED) });
  try {
    const store = new EventStore(harness.db);
    const h = new FunnelHandlers(store);
    const join = { guildId: G, memberId: M, isBot: false, source: 'invite:latest', occurredAt: REJOIN };
    await h.onJoin(join);
    await h.onLeave(G, M);
    await h.onJoin({ ...join, source: 'unknown' });
    assert.deepEqual(await projection(), { joined_at: REJOIN, join_source: 'invite:latest', left_at: null });
    assert.equal(await store.countByType('member_join', G), 1);
    assert.equal(await store.countByType('member_leave', G), 1);
  } finally { mock.timers.reset(); }
});

test('concurrent live writes and stale duplicates preserve the newest observation and original metadata', async () => {
  const store = new EventStore(harness.db);
  const join = {
    guildId: G, memberId: M, eventType: 'member_join' as const,
    occurredAt: REJOIN, source: 'invite:latest', metadata: { inviterId: 'inviter' },
  };
  const leave = {
    guildId: G, memberId: M, eventType: 'member_leave' as const,
    occurredAt: RESUMED, source: 'gateway',
  };
  await Promise.all([
    store.record(join, { membershipObservedAt: '2026-09-30T01:00:00.000002Z' }),
    store.record(leave, { membershipObservedAt: '2026-09-30T01:00:00.000001Z' }),
  ]);
  assert.deepEqual(await projection(), { joined_at: REJOIN, join_source: 'invite:latest', left_at: null });
  await store.record(leave, { membershipObservedAt: '2026-09-30T01:00:00.000003Z' });
  await Promise.all([
    store.record({ ...join, source: 'unknown', metadata: undefined }, { membershipObservedAt: '2026-09-30T01:00:00.000001Z' }),
    store.record(leave, { membershipObservedAt: '2026-09-30T01:00:00.000001Z' }),
  ]);
  assert.deepEqual(await projection(), { joined_at: REJOIN, join_source: 'invite:latest', left_at: RESUMED });
  const rows = await harness.db.prepare(
    `SELECT event_type, occurred_at, source, metadata FROM events WHERE guild_id = ? AND member_id = ? ORDER BY event_type`,
  ).all<{ event_type: string; occurred_at: string; source: string; metadata: string }>(G, M);
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].metadata), {
    inviterId: 'inviter', membershipObservedAt: '2026-09-30T01:00:00.000002Z',
  });
  assert.equal(JSON.parse(rows[1].metadata).membershipObservedAt, '2026-09-30T01:00:00.000003Z');
});

for (const delayed of ['leave', 'join'] as const) {
  test(`adapter captures membership dispatch order before a delayed ${delayed} finishes`, async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(RESUMED) });
    const hold = deferred();
    try {
      const store = new EventStore(harness.db);
      await store.record({ guildId: G, memberId: M, eventType: 'member_join', occurredAt: FIRST, source: 'invite:first' });
      class DelayedHandlers extends FunnelHandlers {
        async onLeave(...args: Parameters<FunnelHandlers['onLeave']>) {
          if (delayed === 'leave') await hold.promise;
          return super.onLeave(...args);
        }
      }
      const h = new DelayedHandlers(store);
      const invites = {
        diffAndStore: async () => ['latest'], attribute: () => 'invite:latest', inviterFor: async () => null,
      } as unknown as InviteTracker;
      const member = {
        id: M, user: { bot: false }, pending: true, joinedAt: new Date(REJOIN),
        guild: { id: G, vanityURLCode: null, invites: { fetch: async () => {
          if (delayed === 'join') await hold.promise;
          return [];
        } } },
      };
      const bus = new EventEmitter();
      registerHandlers(bus as unknown as Client, { handlers: h, invites });
      const add = bus.listeners(Events.GuildMemberAdd)[0]!;
      const remove = bus.listeners(Events.GuildMemberRemove)[0]!;
      const first = delayed === 'leave' ? remove(member) : add(member);
      await (delayed === 'leave' ? add(member) : remove(member));
      hold.resolve();
      await first;
      assert.deepEqual(await projection(), {
        joined_at: REJOIN, join_source: 'invite:latest', left_at: delayed === 'leave' ? null : RESUMED,
      });
    } finally { hold.resolve(); mock.timers.reset(); }
  });
}
