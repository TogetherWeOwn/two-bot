import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import type { FunnelEvent } from '../src/core/events.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = 'membership-chronology';
const M = 'member';
const JOIN = '2026-08-01T00:00:00.000Z';
const LEAVE = '2026-08-02T00:00:00.000Z';
const REJOIN = '2026-08-03T00:00:00.000Z';
const LAST_LEAVE = '2026-08-04T00:00:00.000Z';

let harness: TestDb;
before(async () => { harness = await openTestDb(import.meta.filename); });
after(async () => { await harness.cleanup(); });
beforeEach(async () => { await harness.reset(); });

function event(eventType: FunnelEvent['eventType'], occurredAt: string, source = 'gateway'): FunnelEvent {
  return { guildId: G, memberId: M, eventType, occurredAt, source };
}

const journey = [
  event('member_join', JOIN, 'invite:first'),
  event('member_leave', LEAVE),
  event('member_join', REJOIN, 'invite:latest'),
  event('member_leave', LAST_LEAVE),
];

function permutations<T>(items: T[]): T[][] {
  if (!items.length) return [[]];
  return items.flatMap((item, i) =>
    permutations(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest]),
  );
}

async function projection() {
  return harness.db.prepare(
    `SELECT joined_at, join_source, left_at, inactive_flagged_at FROM members
     WHERE guild_id = ? AND member_id = ?`,
  ).get<{ joined_at: string | null; join_source: string | null; left_at: string | null; inactive_flagged_at: string | null }>(G, M);
}

for (const size of [3, 4]) {
  test(`all ${size === 3 ? 6 : 24} membership arrival orders preserve presence, attribution and history`, async () => {
    for (const order of permutations(journey.slice(0, size))) {
      await harness.reset();
      const store = new EventStore(harness.db);
      const seen: FunnelEvent[] = [];
      for (const e of order) {
        assert.equal((await store.record(e)).inserted, true);
        seen.push(e);
        const latestJoin = seen.filter((r) => r.eventType === 'member_join')
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
        const latestLeave = seen.filter((r) => r.eventType === 'member_leave')
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
        const leftAt = latestLeave && (!latestJoin || latestLeave.occurredAt >= latestJoin.occurredAt)
          ? latestLeave.occurredAt : null;
        assert.deepEqual(await projection(), {
          joined_at: latestJoin?.occurredAt ?? null,
          join_source: latestJoin?.source ?? null,
          left_at: leftAt,
          inactive_flagged_at: null,
        }, `after ${seen.map((r) => `${r.eventType}@${r.occurredAt}`).join(', ')}`);
      }
      // Every historical event stays in the log; replay still deduplicates.
      for (const e of order) assert.equal((await store.record(e)).inserted, false);
      const history = await harness.db.prepare(
        `SELECT event_type, occurred_at, source FROM events
         WHERE guild_id = ? AND member_id = ? ORDER BY occurred_at`,
      ).all(G, M);
      assert.deepEqual(history, journey.slice(0, size).map((e) => ({
        event_type: e.eventType, occurred_at: e.occurredAt, source: e.source,
      })));
    }
  });
}

test('a historical join cannot reset the latest spell inactivity flag', async () => {
  const store = new EventStore(harness.db);
  await store.record(journey[2]!);
  await store.record(event('member_inactive', LAST_LEAVE));
  const current = await projection();
  await store.record(journey[0]!);
  assert.deepEqual(await projection(), current);
  assert.equal(current?.inactive_flagged_at, LAST_LEAVE);
});

test('a chronological rejoin clears leave and inactivity but preserves milestones', async () => {
  const store = new EventStore(harness.db);
  await store.record(journey[0]!);
  await store.record(event('first_message', '2026-08-01T12:00:00.000Z'));
  await store.record(event('member_inactive', '2026-08-01T18:00:00.000Z'));
  await store.record(journey[1]!);
  await store.record(journey[2]!);
  assert.deepEqual(await projection(), {
    joined_at: REJOIN, join_source: 'invite:latest', left_at: null, inactive_flagged_at: null,
  });
  const row = await harness.db.prepare(
    `SELECT first_message_at FROM members WHERE guild_id = ? AND member_id = ?`,
  ).get<{ first_message_at: string }>(G, M);
  assert.equal(row?.first_message_at, '2026-08-01T12:00:00.000Z');
});

test('concurrent membership writes keep the latest join and leave paired', async () => {
  const store = new EventStore(harness.db);
  for (const size of [3, 4]) {
    await harness.reset();
    const results = await Promise.all(journey.slice(0, size).map((e) => store.record(e)));
    assert.ok(results.every((r) => r.inserted));
    assert.deepEqual(await projection(), {
      joined_at: REJOIN, join_source: 'invite:latest',
      left_at: size === 3 ? null : LAST_LEAVE, inactive_flagged_at: null,
    });
    const row = await harness.db.prepare(`SELECT COUNT(*) AS n FROM events`).get<{ n: number }>();
    assert.equal(Number(row?.n), size);
  }
});
