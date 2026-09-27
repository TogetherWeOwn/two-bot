/**
 * Enforced startKnown:false exclusion from duration averages (TOG-5684).
 *
 * EVENTS.md warns to filter on `startKnown` before averaging, but a warning
 * is not enforcement: every averaging query has to remember it, and the one
 * that forgets silently includes nulls in a mean. The shared helper in
 * src/core/voiceSessions.ts is the single enforcement point, and all three
 * reports (scripts/voice-sessions.ts, scripts/funnel.ts, scripts/dashboard.ts
 * via src/analytics/dashboard.ts) go through it.
 *
 * Fixtures only - no database. The functions under test take
 * caller-supplied rows for exactly this reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageKnownVoiceDuration,
  formatVoiceDurationSeconds,
  knownVoiceDurations,
  parseVoiceEndMetadata,
  summarizeVoiceDurations,
} from '../src/core/voiceSessions.ts';

// --- parsing ---------------------------------------------------------------

test('parse: a known-start end keeps its flag and duration', () => {
  assert.deepEqual(
    parseVoiceEndMetadata(JSON.stringify({ startKnown: true, durationSeconds: 600 })),
    { startKnown: true, durationSeconds: 600 },
  );
});

test('parse: an unknown-start end keeps its flag even with a number attached', () => {
  // The enforcement is on the FLAG, not on the duration being null: a row
  // with startKnown:false and a numeric duration is still excluded, because
  // the start was never seen and any number on it is unproven.
  assert.deepEqual(
    parseVoiceEndMetadata(JSON.stringify({ startKnown: false, durationSeconds: 3600 })),
    { startKnown: false, durationSeconds: 3600 },
  );
});

test('parse: missing metadata means known with no duration', () => {
  assert.deepEqual(parseVoiceEndMetadata(null), { startKnown: true, durationSeconds: null });
});

test('parse: unparseable metadata does not claim the start is unknown', () => {
  // Matches the reconcile path's long-standing rule: an unreadable row is
  // not evidence of an unknown start.
  assert.deepEqual(parseVoiceEndMetadata('not-json{{{'), { startKnown: true, durationSeconds: null });
});

// --- the acceptance case: mixed fixtures ------------------------------------

const mixed = () =>
  [
    JSON.stringify({ startKnown: true, durationSeconds: 600 }), // 10m measured
    JSON.stringify({ startKnown: true, durationSeconds: 1800 }), // 30m measured
    JSON.stringify({ startKnown: false, durationSeconds: null }), // bot-down gap: excluded
    JSON.stringify({ startKnown: false, durationSeconds: 3600 }), // unknown WITH a number: still excluded
  ].map(parseVoiceEndMetadata);

test('mixed fixtures: the average covers known-start sessions only', () => {
  // (600 + 1800) / 2 = 1200. A naive mean over all four rows would be 1500
  // (treating null as 0 it would be 1500 too, by coincidence of these
  // numbers - the point is the unknowns never enter the denominator).
  assert.equal(averageKnownVoiceDuration(mixed()), 1200);
});

test('mixed fixtures: the summary names the excluded count', () => {
  assert.deepEqual(summarizeVoiceDurations(mixed()), {
    averageSeconds: 1200,
    measured: 2,
    excludedUnknownStarts: 2,
  });
});

test('unknown durations are dropped, never zero-filled', () => {
  // Zero-filling would print a 400s mean for one measured 1200s session plus
  // two unknowns. Dropping keeps the mean a statement about measured sessions.
  const rows = [
    JSON.stringify({ startKnown: true, durationSeconds: 1200 }),
    JSON.stringify({ startKnown: false, durationSeconds: null }),
    JSON.stringify({ startKnown: false, durationSeconds: null }),
  ].map(parseVoiceEndMetadata);
  assert.equal(averageKnownVoiceDuration(rows), 1200);
});

test('no measured session is null, not a zero average', () => {
  assert.equal(
    averageKnownVoiceDuration([JSON.stringify({ startKnown: false, durationSeconds: null })].map(parseVoiceEndMetadata)),
    null,
  );
  assert.equal(averageKnownVoiceDuration([]), null);
});

test('negative and non-finite durations never enter a mean', () => {
  const rows = [
    { startKnown: true, durationSeconds: 600 },
    { startKnown: true, durationSeconds: -5 },
    { startKnown: true, durationSeconds: Number.NaN },
    { startKnown: true, durationSeconds: null },
  ];
  assert.deepEqual(knownVoiceDurations(rows), [600]);
  assert.equal(averageKnownVoiceDuration(rows), 600);
});

// --- formatting ---------------------------------------------------------------

test('format: compact report durations', () => {
  assert.equal(formatVoiceDurationSeconds(45), '45s');
  assert.equal(formatVoiceDurationSeconds(600), '10m');
  assert.equal(formatVoiceDurationSeconds(3900), '1h05m');
});
