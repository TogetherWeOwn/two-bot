/**
 * Voice blind-window reconcile (TOG-5683).
 *
 * EVENTS.md limit 5: a voice gap while the bot is down can never be recovered.
 * This pins what the reconcile DOES instead: it names each blind window (a
 * heartbeat gap) and counts the `voice_session_end` rows with
 * `startKnown: false` attributed to each window. A count, never an average.
 *
 * Fixtures only - no database. The functions under test take caller-supplied
 * rows for exactly this reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countUnknownStartsPerWindow,
  findBlindWindows,
  renderReconcileReport,
  type BlindWindow,
} from '../src/core/voiceSessions.ts';

const hourly = (base: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(base) + i * 3_600_000).toISOString());

// --- finding the windows ----------------------------------------------------

test('an hourly heartbeat with one 5h outage yields exactly one window', () => {
  const before = hourly('2026-09-01T00:00:00.000Z', 3); // 00, 01, 02
  const after = hourly('2026-09-01T07:00:00.000Z', 2); // 07, 08
  const windows = findBlindWindows([...before, ...after]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, '2026-09-01T02:00:00.000Z');
  assert.equal(windows[0].end, '2026-09-01T07:00:00.000Z');
  assert.equal(windows[0].gapMs, 5 * 3_600_000);
});

test('a steady hourly series has no blind windows', () => {
  assert.deepEqual(findBlindWindows(hourly('2026-09-01T00:00:00.000Z', 25)), []);
});

test('a single missed tick plus jitter is not an outage', () => {
  // One missed hourly tick minus ten minutes of jitter: 1h50m, under the
  // twice-cadence threshold.
  const beats = [
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T01:50:00.000Z',
    '2026-09-01T02:50:00.000Z',
  ];
  assert.deepEqual(findBlindWindows(beats), []);
});

test('duplicates, shuffling and malformed rows do not invent windows', () => {
  const beats = [
    '2026-09-01T02:00:00.000Z',
    'not-a-date',
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T01:00:00.000Z',
    '2026-09-01T01:00:00.000Z',
    '2026-09-01T02:00:00.000Z',
  ];
  assert.deepEqual(findBlindWindows(beats), []);
});

test('two outages are two windows, oldest first', () => {
  const beats = [
    ...hourly('2026-09-01T00:00:00.000Z', 2),
    ...hourly('2026-09-01T06:00:00.000Z', 2),
    ...hourly('2026-09-01T12:00:00.000Z', 2),
  ];
  const windows = findBlindWindows(beats);
  assert.equal(windows.length, 2);
  assert.ok(windows[0].start < windows[1].start, 'oldest first');
});

// --- counting unknown starts per window -------------------------------------

const W1: BlindWindow = {
  start: '2026-09-01T02:00:00.000Z',
  end: '2026-09-01T07:00:00.000Z',
  gapMs: 5 * 3_600_000,
};
const W2: BlindWindow = {
  start: '2026-09-01T20:00:00.000Z',
  end: '2026-09-02T01:00:00.000Z',
  gapMs: 5 * 3_600_000,
};

test('startKnown:false ends count toward the latest window at or before them', () => {
  const counts = countUnknownStartsPerWindow(
    [W1, W2],
    [
      { occurredAt: '2026-09-01T02:30:00.000Z', startKnown: false }, // mid-gap: W1
      { occurredAt: '2026-09-01T08:15:00.000Z', startKnown: false }, // left after return: W1
      { occurredAt: '2026-09-01T21:00:00.000Z', startKnown: false }, // W2
      { occurredAt: '2026-09-01T21:30:00.000Z', startKnown: true }, // known: ignored
      { occurredAt: '2026-09-01T01:00:00.000Z', startKnown: false }, // predates every window: unattributed
      { occurredAt: 'garbage', startKnown: false }, // malformed: skipped
    ],
  );
  assert.equal(counts[0].unknownStarts, 2);
  assert.equal(counts[1].unknownStarts, 1);
});

test('the count carries no duration - it cannot be averaged', () => {
  const counts = countUnknownStartsPerWindow([W1], [
    { occurredAt: '2026-09-01T03:00:00.000Z', startKnown: false },
  ]);
  assert.equal(counts[0].unknownStarts, 1);
  assert.ok(!('durationSeconds' in counts[0]), 'no duration field on the reconcile row');
  assert.ok(!('duration' in counts[0]), 'no duration field on the reconcile row');
  assert.equal(typeof counts[0].unknownStarts, 'number');
});

test('known-start ends never move any count', () => {
  const counts = countUnknownStartsPerWindow([W1, W2], [
    { occurredAt: '2026-09-01T03:00:00.000Z', startKnown: true },
    { occurredAt: '2026-09-01T22:00:00.000Z', startKnown: true },
  ]);
  assert.deepEqual(
    counts.map((c) => c.unknownStarts),
    [0, 0],
  );
});

// --- the report --------------------------------------------------------------

test('the report names each blind window with its count', () => {
  const lines = renderReconcileReport(countUnknownStartsPerWindow([W1, W2], []));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes(W1.start) && lines[0].includes(W1.end), 'window 1 named');
  assert.ok(lines[1].includes(W2.start) && lines[1].includes(W2.end), 'window 2 named');
  assert.ok(lines.every((l) => /\d+ session\(s\) with unknown start/.test(l)), 'each line has a count');
});

test('no windows is a sentence, not an empty grid', () => {
  const lines = renderReconcileReport([]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length > 0);
});
