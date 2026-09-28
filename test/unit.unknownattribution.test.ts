/**
 * Weekly unknown-attribution report arithmetic (TOG-7212).
 *
 * No database: buildUnknownReport() takes rows and a clock, so every case
 * here is literals. The acceptance is the seeded-bucketing test below: three
 * unknown joins in one week - one imported history, one inside a bot-down
 * window, one genuinely unexplained - must land in three different patterns
 * with a 3/4 unknown rate over the week's joins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSeedData,
  buildUnknownReport,
  DEFAULT_UNKNOWN_THRESHOLD_PCT,
  evaluateThreshold,
  formatUnknownReport,
  formatUnknownRate,
  isUnknownBucket,
  parseThresholdPct,
  type UnknownReportJoin,
} from '../src/analytics/unknownAttribution.ts';

// Sunday 2026-09-27: the two reported weeks start Mon 2026-09-14 and Mon 2026-09-21.
const NOW = new Date('2026-09-27T12:00:00.000Z');
const WEEKS = 2;

test('only unknown and backfill sources sit in the unknown bucket', () => {
  assert.equal(isUnknownBucket('unknown'), true);
  assert.equal(isUnknownBucket('backfill:log:member-join'), true);
  assert.equal(isUnknownBucket('backfill:member_list'), true);
  // Different facts with different fixes (TOG-5681) - never the unknown bucket.
  assert.equal(isUnknownBucket('ambiguous:aaa+bbb'), false);
  assert.equal(isUnknownBucket('vanity'), false);
  assert.equal(isUnknownBucket('invite:abc123'), false);
  assert.equal(isUnknownBucket('web:one_click'), false);
});

test('seeded unknowns appear correctly bucketed with the weekly rate', () => {
  const joins: UnknownReportJoin[] = [
    { occurredAt: '2026-09-15T10:00:00.000Z', source: 'invite:abc123' },
    // Imported history: pre-tracking, whatever else is true.
    { occurredAt: '2026-09-16T10:00:00.000Z', source: 'backfill:log:member-join' },
    // Inside the bot-down window below: downtime, upper bound.
    { occurredAt: '2026-09-17T10:00:00.000Z', source: 'unknown' },
    // Attributed despite the era: never unknown.
    { occurredAt: '2026-09-22T10:00:00.000Z', source: 'invite:abc123' },
    // No window, no history: the residual to drive down.
    { occurredAt: '2026-09-23T10:00:00.000Z', source: 'unknown' },
    // Ambiguous is a different bucket and stays out of unknown.
    { occurredAt: '2026-09-24T10:00:00.000Z', source: 'ambiguous:aaa+bbb' },
  ];
  const report = buildUnknownReport(joins, {
    now: NOW,
    weeks: WEEKS,
    downtimeWindows: [
      { start: '2026-09-17T00:00:00.000Z', end: '2026-09-18T00:00:00.000Z', gapMs: 86_400_000 },
    ],
  });

  assert.equal(report.weeks.length, 2);
  const [older, current] = report.weeks;
  assert.equal(older.weekStart, '2026-09-14');
  assert.equal(older.joins, 3);
  assert.equal(older.unknown, 2);
  assert.equal(older.unknownRate, 2 / 3);
  assert.equal(older.preTracking, 1);
  assert.equal(older.downtime, 1);
  assert.equal(older.unexplained, 0);

  assert.equal(current.weekStart, '2026-09-21');
  assert.equal(current.joins, 3);
  assert.equal(current.unknown, 1);
  assert.equal(current.unexplained, 1);

  assert.deepEqual(report.totals, {
    joins: 6,
    unknown: 3,
    unknownRate: 3 / 6,
    preTracking: 1,
    downtime: 1,
    unexplained: 1,
  });
  // Every unknown is in exactly one pattern: the split reconciles with the total.
  assert.equal(report.totals.preTracking + report.totals.downtime + report.totals.unexplained, 3);
});

test('top patterns rank the fix, pre-tracking first on ties', () => {
  const report = buildUnknownReport(
    [
      { occurredAt: '2026-09-22T10:00:00.000Z', source: 'backfill:log:x' },
      { occurredAt: '2026-09-23T10:00:00.000Z', source: 'unknown' },
    ],
    { now: NOW, weeks: WEEKS },
  );
  assert.deepEqual(report.topPatterns, [
    { pattern: 'pre-tracking', count: 1 },
    { pattern: 'unexplained', count: 1 },
    { pattern: 'downtime', count: 0 },
  ]);
});

test('window membership is half-open [start, end)', () => {
  const report = buildUnknownReport(
    [
      // The last write before the gap: still outage-unknown.
      { occurredAt: '2026-09-17T00:00:00.000Z', source: 'unknown' },
      // The first write after it: observed, so unexplained.
      { occurredAt: '2026-09-18T00:00:00.000Z', source: 'unknown' },
    ],
    {
      now: NOW,
      weeks: WEEKS,
      downtimeWindows: [
        { start: '2026-09-17T00:00:00.000Z', end: '2026-09-18T00:00:00.000Z', gapMs: 86_400_000 },
      ],
    },
  );
  assert.equal(report.totals.downtime, 1);
  assert.equal(report.totals.unexplained, 1);
});

test('unknowns older than the first capture are pre-tracking', () => {
  const report = buildUnknownReport(
    [
      { occurredAt: '2026-09-15T10:00:00.000Z', source: 'unknown' },
      { occurredAt: '2026-09-23T10:00:00.000Z', source: 'unknown' },
    ],
    { now: NOW, weeks: WEEKS, firstCaptureAt: '2026-09-20T00:00:00.000Z' },
  );
  assert.equal(report.totals.preTracking, 1);
  assert.equal(report.totals.unexplained, 1);
});

test('anomaly windows leave both sides of the rate', () => {
  const report = buildUnknownReport(
    [
      { occurredAt: '2026-09-15T10:00:00.000Z', source: 'unknown' },
      { occurredAt: '2026-09-22T10:00:00.000Z', source: 'invite:abc123' },
    ],
    {
      now: NOW,
      weeks: WEEKS,
      anomalies: [
        {
          id: 'test-raid',
          kind: 'raid',
          start: '2026-09-15',
          end: '2026-09-15',
          eventTypes: ['member_join'],
          status: 'confirmed',
          label: 'test raid',
          note: 'fixture',
        },
      ],
    },
  );
  // A raid week must not read as an attribution collapse.
  assert.equal(report.totals.joins, 1);
  assert.equal(report.totals.unknown, 0);
  assert.equal(report.weeks[0].unknownRate, null);
});

test('malformed timestamps are skipped, never guessed somewhere', () => {
  const report = buildUnknownReport(
    [
      { occurredAt: 'garbage', source: 'unknown' },
      { occurredAt: '2026-09-22T10:00:00.000Z', source: 'invite:abc123' },
    ],
    { now: NOW, weeks: WEEKS },
  );
  assert.equal(report.totals.joins, 1);
  assert.equal(report.totals.unknown, 0);
});

test('a join before the window is out of scope, not rounded anywhere', () => {
  const report = buildUnknownReport(
    [
      { occurredAt: '2026-01-05T10:00:00.000Z', source: 'unknown' },
      { occurredAt: '2026-09-22T10:00:00.000Z', source: 'unknown' },
    ],
    { now: NOW, weeks: WEEKS },
  );
  assert.equal(report.totals.joins, 1);
  assert.equal(report.totals.unknown, 1);
});

test('an empty fortnight is a null rate, not a zero or a percentage', () => {
  const report = buildUnknownReport([], { now: NOW, weeks: WEEKS });
  assert.equal(report.weeks.length, 2);
  for (const w of report.weeks) {
    assert.equal(w.joins, 0);
    assert.equal(w.unknownRate, null);
  }
  assert.equal(report.totals.unknownRate, null);
  assert.deepEqual(
    report.topPatterns.map((p) => p.count),
    [0, 0, 0],
  );
});

test('rates print as whole percents, empties as n/a', () => {
  assert.equal(formatUnknownRate(null), 'n/a');
  assert.equal(formatUnknownRate(0), '0%');
  assert.equal(formatUnknownRate(2 / 3), '67%');
  assert.equal(formatUnknownRate(1), '100%');
});

test('the default tripwire is 50%, set before the data exists', () => {
  assert.equal(DEFAULT_UNKNOWN_THRESHOLD_PCT, 50);
});

test('threshold values parse with or without a percent sign', () => {
  assert.equal(parseThresholdPct('25'), 25);
  assert.equal(parseThresholdPct('25%'), 25);
  assert.equal(parseThresholdPct(' 25 % '), 25);
  assert.equal(parseThresholdPct('0'), 0);
  assert.equal(parseThresholdPct('100'), 100);
  assert.equal(parseThresholdPct(''), null);
  assert.equal(parseThresholdPct('abc'), null);
  assert.equal(parseThresholdPct('-1'), null);
  assert.equal(parseThresholdPct('101'), null);
  assert.equal(parseThresholdPct(null), null);
  assert.equal(parseThresholdPct(undefined), null);
});

test('the verdict reads the TOTAL row, naming bad weeks without failing on them', () => {
  const joins: UnknownReportJoin[] = [
    // Older week: 1 of 2 unknown (50%) - over a 25% tripwire on its own.
    { occurredAt: '2026-09-15T10:00:00.000Z', source: 'unknown' },
    { occurredAt: '2026-09-16T10:00:00.000Z', source: 'invite:abc123' },
    // Current week: fully attributed - the window as a whole holds.
    { occurredAt: '2026-09-22T10:00:00.000Z', source: 'invite:abc123' },
    { occurredAt: '2026-09-23T10:00:00.000Z', source: 'invite:abc123' },
    { occurredAt: '2026-09-24T10:00:00.000Z', source: 'invite:abc123' },
    { occurredAt: '2026-09-25T10:00:00.000Z', source: 'invite:abc123' },
  ];
  const report = buildUnknownReport(joins, { now: NOW, weeks: WEEKS });
  assert.equal(report.totals.unknownRate, 1 / 6);

  const verdict = evaluateThreshold(report, 25);
  assert.equal(verdict.breached, false);
  assert.deepEqual(
    verdict.weeksOver.map((w) => w.weekStart),
    ['2026-09-14'],
  );

  const strict = evaluateThreshold(report, 10);
  assert.equal(strict.breached, true);
});

test('an empty window is n/a, never a pass or a fail', () => {
  const report = buildUnknownReport([], { now: NOW, weeks: WEEKS });
  const verdict = evaluateThreshold(report, 50);
  assert.equal(verdict.rate, null);
  assert.equal(verdict.breached, false);
  assert.deepEqual(verdict.weeksOver, []);
});

test('seeded demo rows total 40% unknown across every pattern', () => {
  const seed = buildSeedData(NOW, 8);
  const report = buildUnknownReport(seed.joins, {
    now: NOW,
    weeks: 8,
    downtimeWindows: seed.downtimeWindows,
    firstCaptureAt: seed.firstCaptureAt,
  });
  assert.equal(report.totals.joins, 10);
  assert.equal(report.totals.unknown, 4);
  assert.equal(report.totals.unknownRate, 0.4);
  assert.equal(report.totals.preTracking, 1);
  assert.equal(report.totals.downtime, 1);
  assert.equal(report.totals.unexplained, 2);

  // The reviewer path: under the default, over a flipped threshold.
  assert.equal(evaluateThreshold(report, 50).breached, false);
  assert.equal(evaluateThreshold(report, 25).breached, true);
});

test('the shared renderer prints the threshold verdict and the weeks over it', () => {
  const report = buildUnknownReport(
    [
      { occurredAt: '2026-09-15T10:00:00.000Z', source: 'unknown' },
      { occurredAt: '2026-09-16T10:00:00.000Z', source: 'invite:abc123' },
    ],
    { now: NOW, weeks: WEEKS },
  );
  const pass = formatUnknownReport(report, {
    heading: 'heading',
    threshold: evaluateThreshold(report, 75),
  });
  assert.match(pass, /Threshold: unknown share <= 75%/);
  assert.match(pass, /Result: PASS - 50% unknown is within the 75% tripwire/);

  const fail = formatUnknownReport(report, {
    heading: 'heading',
    threshold: evaluateThreshold(report, 25),
  });
  assert.match(fail, /Result: FAIL - 50% unknown exceeds the 25% tripwire/);
  assert.match(fail, /Week over threshold: 2026-09-14 \(50%\)/);

  const empty = formatUnknownReport(buildUnknownReport([], { now: NOW, weeks: WEEKS }), {
    heading: 'heading',
    threshold: evaluateThreshold(buildUnknownReport([], { now: NOW, weeks: WEEKS }), 50),
  });
  assert.match(empty, /Result: n\/a - no joins in window, nothing to judge/);
});
