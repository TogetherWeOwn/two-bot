/**
 * Join-downtime unknown attribution (TOG-5719).
 *
 * EVENTS.md limit 3: joins that happen while the bot is down are attributed
 * `unknown` with no accounting. This pins what the funnel DOES instead: it
 * names each bot-down window (a gap in the bot's own append-only write
 * series) and counts the `unknown` joins whose Discord timestamp falls
 * inside each window. A count, never a re-attribution.
 *
 * Fixtures only - no database. The functions under test take caller-supplied
 * rows for exactly this reason. Window detection itself is `findBlindWindows`
 * (src/core/voiceSessions.ts, tested in unit.voiceblindwindow.test.ts); these
 * tests drive it end to end from a heartbeat fixture so the reviewer verifies
 * one gap function, not two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBlindWindows } from '../src/core/voiceSessions.ts';
import {
  countDowntimeUnknownJoins,
  renderDowntimeReport,
  totalDowntimeUnknown,
  type DowntimeWindow,
} from '../src/core/inviteTracker.ts';

const hourly = (base: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(base) + i * 3_600_000).toISOString());

/** One 5h outage: writes at 00-02, then nothing until 07-08. */
function outageWindows(): DowntimeWindow[] {
  const beats = [...hourly('2026-09-01T00:00:00.000Z', 3), ...hourly('2026-09-01T07:00:00.000Z', 2)];
  const found = findBlindWindows(beats);
  assert.equal(found.length, 1, 'fixture must yield exactly one down window');
  return found;
}

test('a down window flags the N unknown joins inside it', () => {
  const counts = countDowntimeUnknownJoins(outageWindows(), [
    { occurredAt: '2026-09-01T02:30:00.000Z', source: 'unknown' },
    { occurredAt: '2026-09-01T04:00:00.000Z', source: 'unknown' },
    { occurredAt: '2026-09-01T06:59:59.000Z', source: 'unknown' },
    // Same window, but attributed despite the gap - not downtime-unknown.
    { occurredAt: '2026-09-01T03:00:00.000Z', source: 'invite:abc123' },
    // Unknown, but outside every window - a genuine Discovery join, not downtime.
    { occurredAt: '2026-09-01T00:30:00.000Z', source: 'unknown' },
    { occurredAt: '2026-09-01T09:00:00.000Z', source: 'unknown' },
    // Malformed: skipped, never guessed somewhere.
    { occurredAt: 'garbage', source: 'unknown' },
  ]);
  assert.equal(counts.length, 1);
  assert.equal(counts[0].downtimeUnknown, 3);
  assert.equal(totalDowntimeUnknown(counts), 3);
});

test('window membership is half-open [start, end)', () => {
  const [w] = outageWindows();
  const counts = countDowntimeUnknownJoins([w], [
    { occurredAt: w.start, source: 'unknown' }, // the last write before the gap: in
    { occurredAt: w.end, source: 'unknown' }, // the first write after it: observed, out
  ]);
  assert.equal(counts[0].downtimeUnknown, 1, 'a join at exactly end was observed by the closing write');
});

test('ambiguous and vanity joins inside a window are not downtime', () => {
  const counts = countDowntimeUnknownJoins(outageWindows(), [
    { occurredAt: '2026-09-01T03:00:00.000Z', source: 'ambiguous:aaa+bbb' },
    { occurredAt: '2026-09-01T04:00:00.000Z', source: 'vanity' },
    { occurredAt: '2026-09-01T05:00:00.000Z', source: 'web:one_click' },
  ]);
  assert.equal(counts[0].downtimeUnknown, 0);
  assert.equal(totalDowntimeUnknown(counts), 0);
});

test('the total can never exceed the unknown bucket', () => {
  const joins = [
    { occurredAt: '2026-09-01T03:00:00.000Z', source: 'unknown' },
    { occurredAt: '2026-09-01T09:00:00.000Z', source: 'unknown' },
    { occurredAt: '2026-09-01T03:30:00.000Z', source: 'invite:abc123' },
  ];
  const counts = countDowntimeUnknownJoins(outageWindows(), joins);
  const unknownTotal = joins.filter((j) => j.source === 'unknown').length;
  assert.ok(totalDowntimeUnknown(counts) <= unknownTotal);
});

test('the report names each down window with its count', () => {
  const [w] = outageWindows();
  const lines = renderDowntimeReport([{ ...w, downtimeUnknown: 3 }]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(w.start) && lines[0].includes(w.end), 'window named');
  assert.match(lines[0], /3 unknown join\(s\) in-window/);
});

test('no windows is a sentence, not an empty grid', () => {
  const lines = renderDowntimeReport([]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length > 0);
});
