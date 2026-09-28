/**
 * Event-store index audit, pinned as a test (TOG-5709).
 *
 * The funnel counts are served by idx_events_type_time, the per-member reads
 * by idx_events_member, and the distinct-members-per-stage reads by
 * idx_events_type_member (migration 0038). This asserts the three indexes
 * exist with the expected definitions, and that the DISTINCT query they
 * serve counts people, not rows. Timings live in scripts/event-store-bench.ts;
 * this file guards the wiring, not the clock.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = 'idx-guild';

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

test('the funnel-serving events indexes exist with their expected definitions', async () => {
  const rows = await harness.db
    .prepare(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'events'`,
    )
    .all<{ indexname: string; indexdef: string }>();
  const def = new Map(rows.map((r) => [r.indexname, r.indexdef]));
  assert.match(def.get('idx_events_type_time') ?? '', /\(event_type, occurred_at\)/);
  assert.match(def.get('idx_events_member') ?? '', /\(guild_id, member_id, event_type\)/);
  // Migration 0038: the distinct-members-per-stage shape had no covering index.
  assert.match(def.get('idx_events_type_member') ?? '', /\(event_type, member_id\)/);
});

test('distinct-members-per-stage counts people once, rejoins included', async () => {
  const store = new EventStore(harness.db);
  const join = (memberId: string, at: string) =>
    store.record({ guildId: G, memberId, eventType: 'member_join', occurredAt: at, source: 'invite:x' });
  await join('m1', '2026-01-01T00:00:00.000Z');
  await join('m1', '2026-03-01T00:00:00.000Z'); // rejoin: second row, same person
  await join('m2', '2026-02-01T00:00:00.000Z');
  await store.record({ guildId: G, memberId: 'm1', eventType: 'first_message', occurredAt: '2026-01-02T00:00:00.000Z', source: 'channel:c1' });

  assert.equal(await store.countMembersWith('member_join'), 2);
  assert.equal(await store.countMembersWith('first_message'), 1);
  assert.equal(await store.countByType('member_join', G), 3);
});
