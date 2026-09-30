import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import type { FunnelEvent } from '../src/core/events.ts';
import type { Db } from '../src/store/driver.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = 'membership-precision';
const M = 'member';
let harness: TestDb;
before(async () => { harness = await openTestDb(import.meta.filename); });
after(async () => { await harness.cleanup(); });
beforeEach(async () => { await harness.reset(); });

function event(eventType: FunnelEvent['eventType'], occurredAt: string, source = 'gateway'): FunnelEvent {
  return { guildId: G, memberId: M, eventType, occurredAt, source };
}

function journey(fraction: 'microsecond' | 'millisecond') {
  const at = (n: number) => `2026-08-01T00:00:00.${String(n).padStart(fraction === 'microsecond' ? 6 : 3, '0')}Z`;
  return [
    event('member_join', at(1), 'invite:first'),
    event('member_leave', at(2)),
    event('member_join', at(3), 'invite:latest'),
    event('member_leave', at(4)),
  ];
}

function permutations<T>(items: T[]): T[][] {
  if (!items.length) return [[]];
  return items.flatMap((item, i) =>
    permutations(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest]),
  );
}

async function assertProjection(db: Db, seen: FunnelEvent[]) {
  const latestJoin = seen.filter((e) => e.eventType === 'member_join')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  const latestLeave = seen.filter((e) => e.eventType === 'member_leave')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  const departed = latestLeave && (!latestJoin || latestLeave.occurredAt >= latestJoin.occurredAt);
  // Compare inside Postgres: the ordinary driver result truncates to milliseconds,
  // so inspecting its returned Date-shaped ISO alone would hide precision loss.
  const row = await db.prepare(
    `SELECT member_id FROM members WHERE guild_id = ? AND member_id = ?
      AND ${latestJoin ? 'joined_at = ? AND join_source = ?' : 'joined_at IS NULL'}
      AND ${departed ? 'left_at = ?' : 'left_at IS NULL'}`,
  ).get(G, M, ...(latestJoin ? [latestJoin.occurredAt, latestJoin.source] : []),
    ...(departed ? [latestLeave!.occurredAt] : []));
  assert.ok(row, `after ${seen.map((e) => `${e.eventType}@${e.occurredAt}`).join(', ')}`);
}

for (const fraction of ['microsecond', 'millisecond'] as const) {
  for (const size of [3, 4]) {
    test(`${fraction} occurrence precision survives all ${size === 3 ? 6 : 24} membership permutations`, async () => {
      const events = journey(fraction).slice(0, size);
      for (const order of permutations(events)) {
        await harness.reset();
        const store = new EventStore(harness.db);
        const seen: FunnelEvent[] = [];
        for (const e of order) {
          assert.equal((await store.record(e)).inserted, true);
          seen.push(e);
          await assertProjection(harness.db, seen);
        }
        for (const e of order) assert.equal((await store.record(e)).inserted, false);
        for (const e of events) {
          const history = await harness.db.prepare(
            `SELECT source FROM events WHERE guild_id = ? AND member_id = ?
              AND event_type = ? AND occurred_at = ?`,
          ).get<{ source: string }>(G, M, e.eventType, e.occurredAt);
          assert.equal(history?.source, e.source);
        }
        assert.equal(await store.countByType('member_join', G), 2);
        assert.equal(await store.countByType('member_leave', G), size - 2);
      }
    });
  }
}

test('microsecond join occurrences retain paired attribution under concurrent writers', async () => {
  for (const size of [3, 4]) {
    await harness.reset();
    const store = new EventStore(harness.db);
    const events = journey('microsecond').slice(0, size);
    const results = await Promise.all(events.map((e) => store.record(e)));
    assert.ok(results.every((r) => r.inserted));
    await assertProjection(harness.db, events);
  }
});

test('microsecond inactivity comparisons use the actual join, not a truncated flag', async () => {
  const events = journey('microsecond');
  for (const flag of ['2026-08-01T00:00:00.000002Z', '2026-08-01T00:00:00.000004Z']) {
    await harness.reset();
    const store = new EventStore(harness.db);
    await store.record(events[0]!);
    await store.record(event('member_inactive', flag));
    await store.record(events[2]!);
    const cleared = flag < events[2]!.occurredAt;
    const row = await harness.db.prepare(
      `SELECT member_id FROM members WHERE guild_id = ? AND member_id = ?
        AND ${cleared ? 'inactive_flagged_at IS NULL' : 'inactive_flagged_at = ?'}`,
    ).get(G, M, ...(cleared ? [] : [flag]));
    assert.ok(row, `flag ${flag} must ${cleared ? 'clear' : 'remain'}`);
  }
});

test('microsecond occurrence ordering survives a non-UTC Postgres session', async () => {
  await harness.db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL TIME ZONE 'America/New_York'`);
    const store = new EventStore(tx);
    const seen: FunnelEvent[] = [];
    for (const e of journey('microsecond').slice(0, 3).reverse()) {
      await store.record(e);
      seen.push(e);
      await assertProjection(tx, seen);
    }
  });
});

test('live observation order and microsecond actual-join attribution remain independent', async () => {
  const store = new EventStore(harness.db);
  const events = journey('microsecond');
  await store.record(events[0]!, { membershipObservedAt: '2026-08-01T00:00:01.000001Z' });
  await store.record(events[2]!, { membershipObservedAt: '2026-08-01T00:00:01.000002Z' });
  await store.record(events[1]!, { membershipObservedAt: '2026-08-01T00:00:01.000003Z' });
  const row = await harness.db.prepare(
    `SELECT member_id FROM members WHERE guild_id = ? AND member_id = ?
      AND joined_at = ? AND join_source = ? AND left_at = ?`,
  ).get(G, M, events[2]!.occurredAt, events[2]!.source, events[1]!.occurredAt);
  assert.ok(row);
});
