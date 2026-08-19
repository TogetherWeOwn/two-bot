/**
 * Cross-logger de-duplication. The numbers this protects are the headline
 * ones - "how many people joined" - so both directions are tested: collapsing
 * a real duplicate, and refusing to collapse a real rejoin.
 *
 * The shapes below come from the live data: duplicate pairs a few seconds
 * apart from different log channels, genuine rejoins months apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseCrossSourceDuplicates } from '../src/backfill/dedupe.ts';

const ev = (memberId: string, occurredAt: string, source: string, eventType = 'member_join') => ({
  memberId,
  occurredAt,
  source,
  eventType,
});

test('two loggers recording the same join collapse to the earliest', () => {
  const { kept, collapsed } = collapseCrossSourceDuplicates([
    ev('1015384495525986346', '2025-07-06T21:23:10.604Z', 'backfill:log:member-join'),
    ev('1015384495525986346', '2025-07-06T21:20:57.662Z', 'backfill:log:join-leave-log'),
  ]);
  assert.equal(collapsed, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].occurredAt, '2025-07-06T21:20:57.662Z', 'the faster logger is closer to the truth');
});

test('a genuine rejoin months later is kept', () => {
  const { kept, collapsed } = collapseCrossSourceDuplicates([
    ev('42', '2024-01-01T10:00:00.000Z', 'backfill:log:member-join'),
    ev('42', '2024-06-01T10:00:00.000Z', 'backfill:log:member-join'),
  ]);
  assert.equal(collapsed, 0);
  assert.equal(kept.length, 2);
});

test('the same logger saying it twice is always kept', () => {
  // One bot reporting two events seconds apart is one bot telling us something
  // happened twice - not two bots telling us the same thing once.
  const { kept, collapsed } = collapseCrossSourceDuplicates([
    ev('42', '2024-01-01T10:00:00.000Z', 'backfill:log:member-join'),
    ev('42', '2024-01-01T10:00:04.000Z', 'backfill:log:member-join'),
  ]);
  assert.equal(collapsed, 0);
  assert.equal(kept.length, 2);
});

test('different people on the same second never merge', () => {
  const { kept, collapsed } = collapseCrossSourceDuplicates([
    ev('1', '2025-07-06T21:20:57.000Z', 'a'),
    ev('2', '2025-07-06T21:20:57.000Z', 'b'),
  ]);
  assert.equal(collapsed, 0);
  assert.equal(kept.length, 2);
});

test('a join and a leave at the same instant are different events', () => {
  const { kept, collapsed } = collapseCrossSourceDuplicates([
    ev('1', '2025-07-06T21:20:57.000Z', 'a', 'member_join'),
    ev('1', '2025-07-06T21:20:57.000Z', 'b', 'member_leave'),
  ]);
  assert.equal(collapsed, 0);
  assert.equal(kept.length, 2);
});

test('clusters are anchored, so near-misses cannot chain past the tolerance', () => {
  // 0, +10min, +20min from three loggers. The third is 20 minutes from the
  // event we kept, so it is its own event even though it is 10 from the second.
  const { kept } = collapseCrossSourceDuplicates([
    ev('1', '2025-01-01T00:00:00.000Z', 'a'),
    ev('1', '2025-01-01T00:10:00.000Z', 'b'),
    ev('1', '2025-01-01T00:20:00.000Z', 'c'),
  ]);
  assert.deepEqual(
    kept.map((e) => e.occurredAt),
    ['2025-01-01T00:00:00.000Z', '2025-01-01T00:20:00.000Z'],
  );
});

test('three loggers on one join collapse to one', () => {
  const { kept, collapsed } = collapseCrossSourceDuplicates([
    ev('1', '2025-01-01T00:00:01.000Z', 'a'),
    ev('1', '2025-01-01T00:00:03.000Z', 'b'),
    ev('1', '2025-01-01T00:00:06.000Z', 'c'),
  ]);
  assert.equal(collapsed, 2);
  assert.equal(kept.length, 1);
});

test('events with no member are passed through untouched', () => {
  const anon = [
    { memberId: null, occurredAt: '2025-01-01T00:00:00.000Z', source: 'a', eventType: 'invite_click' },
    { memberId: null, occurredAt: '2025-01-01T00:00:02.000Z', source: 'b', eventType: 'invite_click' },
  ];
  const { kept, collapsed } = collapseCrossSourceDuplicates(anon);
  assert.equal(collapsed, 0);
  assert.equal(kept.length, 2);
});

test('output is in time order regardless of input order', () => {
  const { kept } = collapseCrossSourceDuplicates([
    ev('2', '2025-03-01T00:00:00.000Z', 'a'),
    ev('1', '2025-01-01T00:00:00.000Z', 'a'),
    ev('3', '2025-02-01T00:00:00.000Z', 'a'),
  ]);
  assert.deepEqual(
    kept.map((e) => e.memberId),
    ['1', '3', '2'],
  );
});

test('an empty input is not a crash', () => {
  assert.deepEqual(collapseCrossSourceDuplicates([]), { kept: [], collapsed: 0 });
});
