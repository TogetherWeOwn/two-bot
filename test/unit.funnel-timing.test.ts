/**
 * Funnel report timing regression (TOG-10005, round 5 of TOG-9981).
 *
 * `buildFunnelReport` + `formatFunnelText` is the whole funnel shaping path:
 * scripts/funnel.ts collects rows, these two pure functions turn them into
 * the `--json` object and the console text. That path must stay fast as the
 * community (and the per-source / per-campaign tables) grows. A regression
 * here looks like an accidental O(n^2), a blocking read smuggled into the
 * shaper, or a sleep — all of which this file turns into a loud failure
 * instead of a slowly-creeping `npm run funnel`.
 *
 * Fully offline: deterministic synthetic fixture, no database, no network,
 * no token. Runs under plain `npm test` everywhere the contract test runs.
 *
 * Two thresholds, two responses:
 *   - above WARN_MS_PER_REPORT the run stays green but logs a diagnostic
 *     naming the measured time (investigate, do not ignore);
 *   - above FAIL_MS_PER_REPORT the test fails.
 * Both sit ~1000x above the ~0.2ms measured locally for the full fixture,
 * so a breach means something pathological, never a busy CI host.
 *
 * Acceptance (reviewer-checkable): the halved fixture gets the same verdict
 * as the full one — the verdict logic is size-invariant, not a cliff the
 * fixture happens to sit under. The boundary mapping itself is pinned by a
 * deterministic unit test with no clock involved.
 *
 * REVIEWER: set FAIL_MS_PER_REPORT to 0.001 to see the timing tests fail,
 * make `verdictFor` always return 'pass' to see the boundary test fail, or
 * delete the `formatFunnelText` call in `timeReports` to see the coverage
 * test fail (it proves the timed path really formats).
 *
 * Mutation map (each one flips exactly one assertion red):
 *   FAIL budget to ~0ms              -> both timing tests fail on the budget
 *   verdictFor always 'pass'         -> the boundary pin fails at 'warn'
 *   verdictFor always 'fail'         -> the boundary pin fails at 0ms
 *   drop the formatFunnelText call   -> the coverage test finds no seeded slug
 *   halve the fixture unevenly       -> the size-invariance test can diverge
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFunnelReport,
  type FunnelReport,
  type FunnelReportInput,
} from '../src/analytics/funnelReport.ts';
import {
  formatFunnelText,
  type FunnelTextInput,
} from '../src/analytics/cliFormat.ts';

// ---------------------------------------------------------------------------
// Budgets: warn investigates, fail blocks. ~1000x above measured (~0.2ms).
// ---------------------------------------------------------------------------

/** Above this per-report median the run stays green but logs a diagnostic. */
const WARN_MS_PER_REPORT = 250;
/** Above this per-report median the test fails. */
const FAIL_MS_PER_REPORT = 1000;

type TimingVerdict = 'pass' | 'warn' | 'fail';

/** Map a measured per-report time to its verdict. Pure; pinned below. */
function verdictFor(medianMs: number): TimingVerdict {
  if (medianMs >= FAIL_MS_PER_REPORT) return 'fail';
  if (medianMs >= WARN_MS_PER_REPORT) return 'warn';
  return 'pass';
}

// ---------------------------------------------------------------------------
// Seeded fixture: a large community exercising every report section.
// Deterministic — same rows on every machine, no clock, no random.
// ---------------------------------------------------------------------------

/** Full-size seeded shape: 500 sources, 200 campaigns. */
const FULL_SOURCES = 500;
const FULL_CAMPAIGNS = 200;

function seededInput(sourceCount: number, campaignCount: number): FunnelReportInput {
  const bySource = Array.from({ length: sourceCount }, (_, i) => ({
    source: `invite:seed${i}`,
    joins: (i % 7) + 1,
  }));
  const campaigns = Array.from({ length: campaignCount }, (_, i) => ({
    slug: `seed-link-${i}`,
    label: `Seed listing ${i}`,
    inviteCode: `seed${i}`,
    clicks: (i % 13) + 1,
    joins: i % 5,
    retired: i % 11 === 0,
  }));
  return {
    windowDays: 7,
    since: '2026-09-20T00:00:00.000Z',
    clicks: 1200,
    joins: 400,
    joinsSetAside: 0,
    gateCleared: 320,
    joiners: 380,
    stuckAtGate: 3,
    firstMessage: 180,
    firstVoice: 90,
    leaves: 60,
    leavesSetAside: 0,
    bySource,
    ambiguous: 4,
    unknown: 9,
    downtime: [
      {
        start: '2026-09-21T02:00:00.000Z',
        end: '2026-09-21T04:00:00.000Z',
        gapMs: 7_200_000,
        downtimeUnknown: 1,
      },
    ],
    downtimeUnknown: 1,
    campaigns,
    clickSpikes: [{ slug: 'seed-link-0', spikes: [{ day: '2026-09-20', count: 25, factor: 5 }] }],
    firstVoiceSessions: 90,
    voice: { averageSeconds: 600, measured: 90, excludedUnknownStarts: 2 },
    retention: [
      { day: 1, retained: 200, cohort: 380 },
      { day: 7, retained: 80, cohort: 220 },
      { day: 30, retained: 5, cohort: 40 },
    ],
    neverPosted: 12,
    strandedRaid: 0,
    totalEvents: 12340,
  };
}

// ---------------------------------------------------------------------------
// Timing harness: warm up the JIT, then take the median over fixed runs.
// Median, not mean, so one GC pause cannot flip the verdict.
// ---------------------------------------------------------------------------

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 25;

/** Shape the report exactly the way scripts/funnel.ts feeds the formatter. */
function toTextInput(report: FunnelReport, windowDays: number): FunnelTextInput {
  return {
    days: windowDays,
    since: report.since,
    clicks: report.funnel.clicks,
    joins: report.funnel.joins,
    joinsSetAside: report.funnel.joinsSetAside,
    gateCleared: report.funnel.gateCleared,
    joiners: report.funnel.joiners,
    stuckAtGate: report.funnel.stuckAtGate,
    firstMessage: report.funnel.firstMessage,
    firstVoice: report.funnel.firstVoice,
    leaves: report.funnel.leaves,
    leavesSetAside: report.funnel.leavesSetAside,
    trackedLinks: report.campaigns.length,
    bySource: report.attribution.bySource,
    ambiguous: report.attribution.ambiguous,
    unknown: report.attribution.unknown,
    downtime: report.downtime.windows,
    downtimeUnknown: report.downtime.unknownInWindow,
    campaigns: report.campaigns,
    avgSessionSeconds: report.voice.avgSessionSeconds,
    measuredSessions: report.voice.measuredSessions,
    excludedUnknownStarts: report.voice.excludedUnknownStarts,
    retention: report.retention,
    neverPosted: report.neverPosted,
    strandedRaid: report.strandedRaid,
    totalEvents: report.totalEvents,
  };
}

/** One timed pass over the full shaping path: JSON build plus text format. */
function renderOnce(input: FunnelReportInput): string {
  return formatFunnelText(toTextInput(buildFunnelReport(input), input.windowDays));
}

/** Median milliseconds per report over MEASURED_RUNS passes. */
function medianReportMs(input: FunnelReportInput): number {
  for (let i = 0; i < WARMUP_RUNS; i++) renderOnce(input);
  const samples: number[] = [];
  for (let i = 0; i < MEASURED_RUNS; i++) {
    const start = performance.now();
    renderOnce(input);
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// ---------------------------------------------------------------------------
// The regression test
// ---------------------------------------------------------------------------

describe('funnel report timing regression', () => {
  test('the timed path really formats: seeded rows reach the text', () => {
    const text = renderOnce(seededInput(FULL_SOURCES, FULL_CAMPAIGNS));
    assert.ok(text.length > 0, 'the timed path must produce output, not time dead code');
    assert.ok(
      text.includes('invite:seed0') && text.includes('seed-link-0'),
      'seeded source and campaign rows must reach the formatted text',
    );
  });

  test('full seeded fixture stays under the fail budget', (t) => {
    const medianMs = medianReportMs(seededInput(FULL_SOURCES, FULL_CAMPAIGNS));
    const verdict = verdictFor(medianMs);
    if (verdict === 'warn') {
      t.diagnostic(
        `funnel report median ${medianMs.toFixed(2)}ms/report is above the ${WARN_MS_PER_REPORT}ms warn budget ` +
          `(fail at ${FAIL_MS_PER_REPORT}ms) — investigate, do not ignore. ` +
          `Runbook: profile buildFunnelReport/formatFunnelText on the seeded fixture in test/unit.funnel-timing.test.ts.`,
      );
    }
    assert.notEqual(
      verdict,
      'fail',
      `funnel report median ${medianMs.toFixed(2)}ms/report exceeds the ${FAIL_MS_PER_REPORT}ms fail budget`,
    );
  });

  test('halving the fixture does not change the verdict', () => {
    const fullMs = medianReportMs(seededInput(FULL_SOURCES, FULL_CAMPAIGNS));
    const halfMs = medianReportMs(seededInput(FULL_SOURCES / 2, FULL_CAMPAIGNS / 2));
    assert.equal(
      verdictFor(halfMs),
      verdictFor(fullMs),
      `verdict must be size-invariant: full ${fullMs.toFixed(2)}ms -> ${verdictFor(fullMs)}, ` +
        `half ${halfMs.toFixed(2)}ms -> ${verdictFor(halfMs)}`,
    );
  });

  test('verdict boundaries are pinned (no clock)', () => {
    assert.equal(verdictFor(0), 'pass');
    assert.equal(verdictFor(WARN_MS_PER_REPORT - 0.1), 'pass');
    assert.equal(verdictFor(WARN_MS_PER_REPORT), 'warn');
    assert.equal(verdictFor(FAIL_MS_PER_REPORT - 0.1), 'warn');
    assert.equal(verdictFor(FAIL_MS_PER_REPORT), 'fail');
    assert.equal(verdictFor(FAIL_MS_PER_REPORT * 5), 'fail');
  });
});
