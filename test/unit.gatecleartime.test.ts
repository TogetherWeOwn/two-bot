/**
 * TOG-6474: backfilled `gate_cleared` rows must never feed time-to-clear.
 *
 * A backfilled clearing says THAT a member is through the rules gate, never
 * WHEN - its `occurred_at` is the join time, a placeholder flagged as
 * `metadata.timestampIsJoinTime` with a `backfill:` source. Conversion counts
 * MUST keep including those rows; only time arithmetic must exclude them
 * (docs/EVENTS.md, limit 6).
 *
 * REVIEWER: flip the guard to see this fail - make `isMeasurableGateClearing`
 * always return true (or have `timeToGateClearSeconds` call `secondsBetween`
 * directly). The inactive fixture member then reports 0 seconds instead of
 * null, because their clearing placeholder equals their join time.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { isMeasurableGateClearing } from '../src/core/events.ts';
import { buildDashboard } from '../src/analytics/dashboard.ts';
import {
  EXPECTED_DISTINCT,
  FIXTURE_MEMBER_IDS,
  TEST_NOW,
  seedFixtures,
} from '../src/staging/fixtures.ts';

const G = '999000111222333444'; // a stand-in staging guild id
const DAY = 86_400_000;

// Synthetic members for this file only, in the same reserved block as the
// fixtures (below anything Discord has ever issued) but clear of the fixture
// suffixes 01-10 and 90-91 so a future fixture cannot collide with them.
const LIVE = '90000000000000061';

/** A member who cleared live, 300 seconds after joining. */
const LIVE_JOIN_OFFSET = -1 * DAY;
const LIVE_CLEAR_SECONDS = 300;

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

async function seededWithLiveClearing() {
  const db = harness.db;
  const store = new EventStore(db);
  await seedFixtures(db, { guildId: G, now: TEST_NOW });
  const base = Date.parse(TEST_NOW);
  const joinAt = new Date(base + LIVE_JOIN_OFFSET).toISOString();
  const clearAt = new Date(base + LIVE_JOIN_OFFSET + LIVE_CLEAR_SECONDS * 1000).toISOString();
  await store.record({
    memberId: LIVE,
    guildId: G,
    eventType: 'member_join',
    occurredAt: joinAt,
    source: 'invite:qa-live',
  });
  await store.record({
    memberId: LIVE,
    guildId: G,
    eventType: 'gate_cleared',
    occurredAt: clearAt,
    source: 'gateway',
  });
  return { db, store, joinAt, clearAt };
}

test('the guard excludes either backfill signal, alone or together', () => {
  assert.equal(isMeasurableGateClearing('gateway'), true, 'a live clearing is measurable');
  assert.equal(
    isMeasurableGateClearing('backfill:member_list', { backfill: true, timestampIsJoinTime: true }),
    false,
    'the writer sets both signals',
  );
  assert.equal(
    isMeasurableGateClearing('backfill:log:some-channel', {}),
    false,
    'the source prefix alone disqualifies',
  );
  assert.equal(
    isMeasurableGateClearing('gateway', { timestampIsJoinTime: true }),
    false,
    'the metadata flag alone disqualifies',
  );
});

test('counts and conversion include the backfill row', async () => {
  const { db, store } = await seededWithLiveClearing();
  // The fixtures carry exactly one backfilled clearing (the inactive member);
  // the synthetic live member is the +1 on both sides.
  assert.equal(
    await store.countMembersWith('gate_cleared'),
    (EXPECTED_DISTINCT.gate_cleared ?? 0) + 1,
    'gate counts must keep including backfilled clearings',
  );
  const dashboard = await buildDashboard(db, { guildId: G, now: new Date(TEST_NOW), weeks: 4 });
  assert.equal(
    dashboard.gateOverall?.cleared,
    (EXPECTED_DISTINCT.gate_cleared ?? 0) + 1,
    'gate conversion must keep including backfilled clearings',
  );
});

test('time-to-clear excludes the backfill row and keeps the live one', async () => {
  const { store } = await seededWithLiveClearing();
  // The inactive fixture member joined 60 days ago and their clearing carries
  // the join time as a placeholder. As timing it is nothing; as a binary it
  // is already counted above.
  assert.equal(
    await store.timeToGateClearSeconds(G, FIXTURE_MEMBER_IDS.inactive),
    null,
    'a backfilled clearing must never feed time-to-clear arithmetic',
  );
  // The control: a live clearing with a known delta measures exactly that.
  assert.equal(
    await store.timeToGateClearSeconds(G, LIVE),
    LIVE_CLEAR_SECONDS,
    'a live clearing keeps its measured delta',
  );
});

test('a member with no clearing on file has no time-to-clear', async () => {
  const { store } = await seededWithLiveClearing();
  assert.equal(
    await store.timeToGateClearSeconds(G, FIXTURE_MEMBER_IDS.lurker),
    null,
    'the lurker never cleared, so there is nothing to measure',
  );
});
