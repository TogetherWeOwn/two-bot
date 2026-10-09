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
   * Durable first-capture evidence, if available: an `unknown` older than
   * this is pre-tracking, not a failure. Mutable invite-snapshot refresh
   * timestamps are not such evidence. Null (the default) disables only this
   * leg - `backfill:*` sources still classify as pre-tracking.
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
