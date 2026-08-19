/**
 * Anomaly windows: the rules that decide which days stop counting as churn.
 *
 * This is arithmetic that changes what the CEO reads, so it is tested rather
 * than eyeballed. The two failure modes that matter: excluding a day we should
 * have counted (flatters us), and failing to notice a spike at all (a prune
 * quietly becomes "our retention collapsed").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANOMALIES,
  detectSpikes,
  excludeClause,
  isExcluded,
  windowBounds,
  type Anomaly,
} from '../src/analytics/anomalies.ts';

const AUG: Anomaly = {
  id: 'test',
  start: '2025-08-05',
  end: '2025-08-06',
  eventTypes: ['member_leave'],
  status: 'unconfirmed',
  label: 'test window',
  note: '',
};

test('a window covers both end days completely, and nothing after', () => {
  const { from, to } = windowBounds(AUG);
  assert.equal(from, '2025-08-05T00:00:00.000Z');
  assert.equal(to, '2025-08-07T00:00:00.000Z');
  // the last second of the last day is in; the first of the next is out
  assert.equal(isExcluded('2025-08-06T23:59:59.000Z', 'member_leave', [AUG]), true);
  assert.equal(isExcluded('2025-08-07T00:00:00.000Z', 'member_leave', [AUG]), false);
  assert.equal(isExcluded('2025-08-04T23:59:59.000Z', 'member_leave', [AUG]), false);
});

test('a window only swallows the event types it names', () => {
  assert.equal(isExcluded('2025-08-05T10:00:00.000Z', 'member_leave', [AUG]), true);
  // a join on the same day is still a join - a prune does not erase arrivals
  assert.equal(isExcluded('2025-08-05T10:00:00.000Z', 'member_join', [AUG]), false);
});

test('the SQL fragment is empty for an event type with no windows', () => {
  const { sql, params } = excludeClause('member_join', [AUG]);
  assert.equal(sql, '');
  assert.deepEqual(params, []);
});

test('the SQL fragment pairs one bound per placeholder', () => {
  const second: Anomaly = { ...AUG, id: 'b', start: '2024-01-01', end: '2024-01-01' };
  const { sql, params } = excludeClause('member_leave', [AUG, second]);
  assert.equal(sql.match(/\?/g)?.length, params.length);
  assert.match(sql, /^ AND NOT \(/);
  assert.deepEqual(params, [
    '2025-08-05T00:00:00.000Z',
    '2025-08-07T00:00:00.000Z',
    '2024-01-01T00:00:00.000Z',
    '2024-01-02T00:00:00.000Z',
  ]);
});

test('a mass-departure day is flagged, and ordinary days are not', () => {
  const days: string[] = [];
  for (let d = 1; d <= 20; d++) {
    const day = `2025-07-${String(d).padStart(2, '0')}`;
    for (let i = 0; i < 2; i++) days.push(`${day}T09:00:00.000Z`);
  }
  for (let i = 0; i < 600; i++) days.push('2025-08-05T09:00:00.000Z');

  const spikes = detectSpikes(days, 'member_leave', { anomalies: [AUG] });
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].day, '2025-08-05');
  assert.equal(spikes[0].count, 600);
  assert.equal(spikes[0].known, true, 'it is in the list, so it reads as already set aside');
});

test('a spike nobody has labelled is reported as unlabelled', () => {
  const days = Array.from({ length: 30 }, (_, d) => `2026-03-${String(d + 1).padStart(2, '0')}T09:00:00.000Z`);
  for (let i = 0; i < 300; i++) days.push('2026-04-02T09:00:00.000Z');

  const spikes = detectSpikes(days, 'member_leave', { anomalies: [AUG] });
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].known, false, 'unknown spikes must stay visible, not silently pass');
});

test('a quiet server does not cry wolf', () => {
  // 1 leave most days, 6 on one day. Six times the median, but six people.
  const days = ['a', 'b', 'c', 'd', 'e'].map((_, d) => `2026-05-0${d + 1}T09:00:00.000Z`);
  for (let i = 0; i < 6; i++) days.push('2026-05-09T09:00:00.000Z');
  assert.deepEqual(detectSpikes(days, 'member_leave', { anomalies: [] }), []);
});

test('no timestamps means no spikes, not a divide-by-zero', () => {
  assert.deepEqual(detectSpikes([], 'member_leave'), []);
});

test('every shipped window is well formed', () => {
  for (const a of ANOMALIES) {
    assert.match(a.start, /^\d{4}-\d{2}-\d{2}$/, `${a.id} start`);
    assert.match(a.end, /^\d{4}-\d{2}-\d{2}$/, `${a.id} end`);
    assert.ok(a.end >= a.start, `${a.id} ends before it starts`);
    assert.ok(a.eventTypes.length > 0, `${a.id} excludes nothing`);
    assert.ok(a.note.length > 0, `${a.id} has no explanation`);
  }
});
