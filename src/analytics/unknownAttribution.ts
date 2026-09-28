/**
 * Weekly unknown-attribution arithmetic (TOG-7212).
 *
 * The funnel report prints one `unknown` line per window (TOG-5681) and one
 * downtime section (TOG-5719), but nothing answers the operator's weekly
 * question: is the unknown share going down, and what is still producing it?
 * This module is the arithmetic half of that answer. It is pure on purpose -
 * the script reads rows, this decides what they mean, and the test needs no
 * database. Same split as anomalies.ts / funnel.ts.
 *
 * Two sources count as unknown here, because the dashboard already renders
 * both as "we do not know" (labelSource in dashboard.ts):
 *
 *   `unknown`      nothing moved and no vanity URL (docs/EVENTS.md `source`
 *                  table). Discovery, or a join from while the bot was offline.
 *   `backfill:*`   imported history (scripts/backfill.ts). The log channels
 *                  record THAT somebody joined, never WHICH invite they used.
 *
 * Every unknown join lands in exactly one pattern, so the report names which
 * problem to work on instead of printing a bare percentage:
 *
 *   pre-tracking   the join predates invite attribution entirely - a backfill
 *                  source, or an `unknown` older than the first capture run.
 *                  Not fixable; the lever is to stop comparing new weeks
 *                  against it.
 *   downtime       the join's timestamp falls inside a bot-down window (a gap
 *                  in the `events.recorded_at` write series - the same probe
 *                  the funnel's TOG-5719 section uses, windows supplied by the
 *                  caller via findBlindWindows). An UPPER BOUND: a quiet
 *                  stretch with no writes reads as a gap.
 *   unexplained    the residual. Discovery joins on a vanity-less server, or
 *                  the Manage Server permission missing so no invite list is
 *                  readable (scripts/preflight.ts). This is the number to drive
 *                  down.
 *
 * Joins are EVENTS, not people - a rejoiner counts twice here, exactly as in
 * the funnel's bySource table. Anomaly (raid/prune) windows are excluded from
 * both sides of the rate, so a raid week cannot read as an attribution
 * collapse. Rows with an unparseable timestamp are skipped, never guessed
 * somewhere.
 */
import { ANOMALIES, isExcluded, type Anomaly } from './anomalies.ts';
import { recentWeeks, weekStart } from './dashboard.ts';
import type { DowntimeWindow } from '../core/inviteTracker.ts';

/** The only two fields the report needs from a member_join row. */
export interface UnknownReportJoin {
  /** ISO-8601 UTC (Discord's timestamp, not when we wrote the row). */
  occurredAt: string;
  /** Attribution string, e.g. `unknown`, `invite:abc`, `backfill:log:...`. */
  source: string;
}

/** Where one unknown join came from, in operator-action terms. */
export type UnknownPattern = 'pre-tracking' | 'downtime' | 'unexplained';

/** Fixed display order, also the tie-break when two patterns tie. */
export const PATTERNS: readonly UnknownPattern[] = ['pre-tracking', 'downtime', 'unexplained'];

/** One Monday-start week of the unknown trend. */
export interface WeekUnknown {
  /** Monday of the week, `YYYY-MM-DD` UTC. */
  weekStart: string;
  /** Counted joins (events, anomaly windows excluded). */
  joins: number;
  /** Of `joins`, how many sit in the unknown bucket. */
  unknown: number;
  /** `unknown / joins`, or null when the week had no joins. Never NaN. */
  unknownRate: number | null;
  /** Of `unknown`, how many predate attribution (backfill or pre-capture). */
  preTracking: number;
  /** Of `unknown`, how many fall in a bot-down window (upper bound). */
  downtime: number;
  /** Of `unknown`, the residual to drive down. */
  unexplained: number;
}

export interface UnknownTotals {
  joins: number;
  unknown: number;
  unknownRate: number | null;
  preTracking: number;
  downtime: number;
  unexplained: number;
}

export interface PatternCount {
  pattern: UnknownPattern;
  count: number;
}

export interface UnknownReport {
  weeks: WeekUnknown[];
  totals: UnknownTotals;
  /** All three patterns, most joins first. The top entry is the week's fix. */
  topPatterns: PatternCount[];
}

export interface UnknownReportOptions {
  /** Defaults to now. Injected so the test is not a function of the wall clock. */
  now?: Date;
  /** How many Monday-start weeks to report. Defaults to 8. */
  weeks?: number;
  /** Raid/prune windows to exclude. Defaults to the shared ANOMALIES list. */
  anomalies?: Anomaly[];
  /**
   * Bot-down windows from findBlindWindows over the `events.recorded_at`
   * write series. Empty (the default) means no join classifies as downtime.
   */
  downtimeWindows?: readonly DowntimeWindow[];
  /**
   * Earliest invite-snapshot timestamp: attribution starts at the first
   * capture run, so an `unknown` older than this is pre-tracking, not a
   * failure. Null (the default) disables only this leg - `backfill:*`
   * sources still classify as pre-tracking.
   */
  firstCaptureAt?: string | null;
}

/**
 * True when this source belongs in the unknown bucket: `unknown` itself, or
 * imported history that never carried an invite code. `ambiguous:*` and
 * `vanity` are different facts with different fixes (TOG-5681) and stay out.
 */
export function isUnknownBucket(source: string): boolean {
  return source === 'unknown' || source.startsWith('backfill:');
}

function inWindow(t: number, w: DowntimeWindow): boolean {
  const start = Date.parse(w.start);
  const end = Date.parse(w.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  // Half-open [start, end): a join at exactly `end` was observed by the write
  // that closed the gap - same boundary as countDowntimeUnknownJoins.
  return start <= t && t < end;
}

function classify(
  t: number,
  source: string,
  opts: { downtimeWindows: readonly DowntimeWindow[]; firstCaptureAt: string | null },
): UnknownPattern {
  if (source.startsWith('backfill:')) return 'pre-tracking';
  if (opts.firstCaptureAt !== null) {
    const first = Date.parse(opts.firstCaptureAt);
    if (!Number.isNaN(first) && t < first) return 'pre-tracking';
  }
  if (opts.downtimeWindows.some((w) => inWindow(t, w))) return 'downtime';
  return 'unexplained';
}

function emptyWeek(weekStartDate: string): WeekUnknown {
  return {
    weekStart: weekStartDate,
    joins: 0,
    unknown: 0,
    unknownRate: null,
    preTracking: 0,
    downtime: 0,
    unexplained: 0,
  };
}

/**
 * Bucket joins into Monday-start weeks with the unknown share and its
 * pattern split. Joins outside the requested window are out of scope, not
 * rounded anywhere.
 */
export function buildUnknownReport(
  joins: readonly UnknownReportJoin[],
  opts: UnknownReportOptions = {},
): UnknownReport {
  const now = opts.now ?? new Date();
  const count = opts.weeks ?? 8;
  const anomalies = opts.anomalies ?? ANOMALIES;
  const downtimeWindows = opts.downtimeWindows ?? [];
  const firstCaptureAt = opts.firstCaptureAt ?? null;

  const wanted = recentWeeks(now, count);
  const wantedSet = new Set(wanted);
  const perWeek = new Map<string, WeekUnknown>();
  for (const w of wanted) perWeek.set(w, emptyWeek(w));

  for (const j of joins) {
    const t = Date.parse(j.occurredAt);
    if (Number.isNaN(t)) continue;
    if (isExcluded(j.occurredAt, 'member_join', anomalies)) continue;
    const w = weekStart(j.occurredAt);
    const bucket = perWeek.get(w);
    if (!bucket) continue;
    bucket.joins++;
    if (!isUnknownBucket(j.source)) continue;
    bucket.unknown++;
    const pattern = classify(t, j.source, { downtimeWindows, firstCaptureAt });
    if (pattern === 'pre-tracking') bucket.preTracking++;
    else if (pattern === 'downtime') bucket.downtime++;
    else bucket.unexplained++;
  }

  const weeks = wanted.map((w) => {
    const b = perWeek.get(w)!;
    b.unknownRate = b.joins === 0 ? null : b.unknown / b.joins;
    return b;
  });

  const totals: UnknownTotals = {
    joins: 0,
    unknown: 0,
    unknownRate: null,
    preTracking: 0,
    downtime: 0,
    unexplained: 0,
  };
  for (const b of weeks) {
    totals.joins += b.joins;
    totals.unknown += b.unknown;
    totals.preTracking += b.preTracking;
    totals.downtime += b.downtime;
    totals.unexplained += b.unexplained;
  }
  totals.unknownRate = totals.joins === 0 ? null : totals.unknown / totals.joins;

  const counts: Record<UnknownPattern, number> = {
    'pre-tracking': totals.preTracking,
    downtime: totals.downtime,
    unexplained: totals.unexplained,
  };
  const topPatterns: PatternCount[] = PATTERNS.map((pattern) => ({ pattern, count: counts[pattern] })).sort(
    (a, b) => b.count - a.count || PATTERNS.indexOf(a.pattern) - PATTERNS.indexOf(b.pattern),
  );

  return { weeks, totals, topPatterns };
}

/** `67%`, or `n/a` when the week had no joins - never a bare `NaN%`. */
export function formatUnknownRate(rate: number | null): string {
  if (rate === null) return 'n/a';
  return `${Math.round(rate * 100)}%`;
}

// ---------------------------------------------------------------------------
// Threshold (TOG-8293): funnel trust measured, not assumed
// ---------------------------------------------------------------------------
//
// The weekly table answers "is the unknown share going down". The threshold
// answers the harder question: "is attribution good enough to quote this
// week". Above the tripwire the per-code story cannot carry the week, and the
// script says so on its own line with a non-zero exit instead of leaving the
// judgement to whoever happens to read the table.
//
// The value is set before the data exists (the ledger's whole method -
// thresholds picked afterwards are the flattering ones). 50%: above half
// unknown, most joins carry no code and quoting a per-code winner is quoting
// noise. Lower it as live capture accumulates; the script takes
// TWO_UNKNOWN_THRESHOLD or --max-unknown so the reviewer can flip it and
// watch the verdict move.

/** Tripwire percent (0-100) when neither the env nor the flag names one. */
export const DEFAULT_UNKNOWN_THRESHOLD_PCT = 50;

/**
 * Parse a threshold like `25` or `25%` into a percent. Null when it is not a
 * number in [0, 100] - the caller exits 2 on that, the same as a bad week
 * count, rather than running against a threshold nobody asked for.
 */
export function parseThresholdPct(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim().replace(/%$/, '').trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

export interface ThresholdWeekOver {
  weekStart: string;
  unknownRate: number;
}

export interface ThresholdVerdict {
  thresholdPct: number;
  /** The TOTAL unknown rate the verdict reads, null when no joins exist. */
  rate: number | null;
  /** True when the total share strictly exceeds the tripwire. */
  breached: boolean;
  /** Weeks individually over the tripwire, oldest first - named, not averaged away. */
  weeksOver: ThresholdWeekOver[];
}

/**
 * Judge a built report against the tripwire. The verdict reads the TOTAL row:
 * one bad week in an otherwise attributed window is a line in weeksOver, not
 * a failed window. An empty window is n/a, never a pass or a fail - there is
 * nothing to judge.
 */
export function evaluateThreshold(report: UnknownReport, thresholdPct: number): ThresholdVerdict {
  const rate = report.totals.unknownRate;
  const weeksOver = report.weeks
    .filter((w) => w.unknownRate !== null && w.unknownRate * 100 > thresholdPct)
    .map((w) => ({ weekStart: w.weekStart, unknownRate: w.unknownRate! }));
  return {
    thresholdPct,
    rate,
    breached: rate !== null && rate * 100 > thresholdPct,
    weeksOver,
  };
}

export interface UnknownReportTextOptions {
  /** First line, e.g. the window line or the seeded-demo banner. */
  heading: string;
  /** `YYYY-MM-DD` of the window start, for the `since` tail of the heading. */
  sinceLabel?: string;
  /**
   * Earliest invite-snapshot timestamp, for the no-capture footnote. Null
   * means no capture run is on file.
   */
  firstCaptureAt?: string | null;
  /** Null omits the threshold block (older callers print the table only). */
  threshold?: ThresholdVerdict | null;
}

/**
 * The whole report as text, one code path for the database run and the seeded
 * demo (`--seed`) alike - so a figure the reviewer sees in the demo is
 * formatted exactly as the operator sees it live.
 */
export function formatUnknownReport(
  report: UnknownReport,
  opts: UnknownReportTextOptions,
): string {
  const since = opts.sinceLabel ? ` (since ${opts.sinceLabel})` : '';
  const lines: string[] = [];
  lines.push(`\n${opts.heading}${since}\n`);
  lines.push('  week        joins  unknown  rate   pre-track  downtime  unexplained');
  for (const w of report.weeks) {
    const rate = formatUnknownRate(w.unknownRate).padStart(4);
    lines.push(
      `  ${w.weekStart}  ${String(w.joins).padStart(5)}  ${String(w.unknown).padStart(7)}  ${rate}` +
        `  ${String(w.preTracking).padStart(9)}  ${String(w.downtime).padStart(8)}  ${String(w.unexplained).padStart(11)}`,
    );
  }

  const t = report.totals;
  lines.push(
    `  ${'TOTAL'.padEnd(10)}  ${String(t.joins).padStart(5)}  ${String(t.unknown).padStart(7)}  ` +
      `${formatUnknownRate(t.unknownRate).padStart(4)}  ${String(t.preTracking).padStart(9)}` +
      `  ${String(t.downtime).padStart(8)}  ${String(t.unexplained).padStart(11)}`,
  );

  if (opts.threshold) {
    const v = opts.threshold;
    lines.push('');
    lines.push(`  Threshold: unknown share <= ${v.thresholdPct}% across the window`);
    if (v.rate === null) {
      lines.push('  Result: n/a - no joins in window, nothing to judge');
    } else if (v.breached) {
      lines.push(
        `  Result: FAIL - ${formatUnknownRate(v.rate)} unknown exceeds the ${v.thresholdPct}% tripwire`,
      );
    } else {
      lines.push(
        `  Result: PASS - ${formatUnknownRate(v.rate)} unknown is within the ${v.thresholdPct}% tripwire`,
      );
    }
    for (const w of v.weeksOver) {
      lines.push(`  Week over threshold: ${w.weekStart} (${formatUnknownRate(w.unknownRate)})`);
    }
  }

  lines.push('\n  Top unknown patterns (most joins first - the first line is the fix):');
  for (const { pattern, count } of report.topPatterns) {
    lines.push(`    ${String(count).padStart(5)}  ${pattern}`);
  }
  if (t.downtime > 0) {
    lines.push('    (downtime is an upper bound - a quiet stretch with no writes reads as a gap)');
  }
  if ((opts.firstCaptureAt ?? null) === null && t.preTracking > 0) {
    lines.push('    (no capture run on file yet - attribution starts at the first capture)');
  }
  if (t.joins === 0) {
    lines.push('    (no joins in window - share an invite, then see npm run campaigns)');
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Seeded demo (TOG-8293): the reviewer path
// ---------------------------------------------------------------------------
//
// `node scripts/unknown-attribution.ts --seed` prints the same report without
// touching a database. Rows are relative to `now` so they always land inside
// the requested window and never inside a real anomaly window: 10 joins, 4
// unknown (one per fixable pattern plus a second unexplained) for a 40%
// total - under the 50% default, over a flipped 25%, so the reviewer watches
// the verdict move. The backfill row is pre-tracking by source whatever the
// era; firstCaptureAt sits before every row so the demo never prints the
// no-capture footnote about itself.

export interface SeedData {
  joins: UnknownReportJoin[];
  downtimeWindows: DowntimeWindow[];
  /** Before every seeded row: the demo measures attribution, not its absence. */
  firstCaptureAt: string;
}

/** Deterministic demo rows for `--seed`. Pure, so the unit test pins the 40%. */
export function buildSeedData(now: Date, weeks: number): SeedData {
  const wanted = recentWeeks(now, weeks);
  const last3 = wanted.slice(-Math.min(3, wanted.length));
  const [older, middle, current] = [
    last3[last3.length - 3],
    last3[last3.length - 2],
    last3[last3.length - 1],
  ];
  const at = (weekStartDate: string, dayOffset: number) =>
    new Date(`${weekStartDate}T00:00:00.000Z`).getTime() + dayOffset * 86_400_000 + 10 * 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  const joins: UnknownReportJoin[] = [];
  if (older !== undefined) {
    joins.push({ occurredAt: iso(at(older, 2)), source: 'invite:qa-seed' });
  }
  if (middle !== undefined) {
    joins.push({ occurredAt: iso(at(middle, 1)), source: 'backfill:log:member-join' });
    joins.push({ occurredAt: iso(at(middle, 2)), source: 'unknown' });
    joins.push({ occurredAt: iso(at(middle, 3)), source: 'invite:qa-seed' });
    joins.push({ occurredAt: iso(at(middle, 4)), source: 'unknown' });
    joins.push({ occurredAt: iso(at(middle, 5)), source: 'invite:qa-seed' });
  }
  if (current !== undefined && current !== middle) {
    joins.push({ occurredAt: iso(at(current, 1)), source: 'invite:qa-seed' });
    joins.push({ occurredAt: iso(at(current, 2)), source: 'unknown' });
    joins.push({ occurredAt: iso(at(current, 3)), source: 'invite:qa-seed' });
    joins.push({ occurredAt: iso(at(current, 4)), source: 'invite:qa-seed' });
  }

  const downtimeWindows: DowntimeWindow[] =
    middle !== undefined
      ? [
          {
            start: iso(at(middle, 2) - 10 * 3_600_000),
            end: iso(at(middle, 3) - 10 * 3_600_000),
            gapMs: 86_400_000,
          },
        ]
      : [];

  return { joins, downtimeWindows, firstCaptureAt: '2020-01-01T00:00:00.000Z' };
}
