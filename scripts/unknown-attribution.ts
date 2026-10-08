/**
 * Weekly unknown-attribution report (TOG-7212).
 *
 *   node scripts/unknown-attribution.ts        # last 8 weeks
 *   node scripts/unknown-attribution.ts 4      # last 4 weeks
 *
 * The operator's weekly question: is the unknown share going down, and what
 * is still producing it? One line per Monday-start week with the unknown
 * rate, then the top unknown patterns across the window - pre-tracking
 * (imported history, not fixable), downtime (bot-down joins, an upper bound),
 * unexplained (the residual to drive down).
 *
 * The arithmetic lives in src/analytics/unknownAttribution.ts and is pinned
 * by test/unit.unknownattribution.test.ts; this file only reads rows (same
 * split as funnel.ts). Guard rails match the funnel: exit 2 on a bad week
 * count, exit 1 when TWO_DATABASE_URL is missing.
 */
import { openDb } from '../src/store/db.ts';
import { excludeClause } from '../src/analytics/anomalies.ts';
import { findBlindWindows } from '../src/core/voiceSessions.ts';
import type { DowntimeWindow } from '../src/core/inviteTracker.ts';
import {
  buildUnknownReport,
  formatUnknownRate,
} from '../src/analytics/unknownAttribution.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/unknown-attribution.ts [weeks]');
  process.exit(0);
}

const rawArgs = process.argv.slice(2);
const weeks = Number(rawArgs.find((a) => !a.startsWith('-')) ?? 8);
if (!Number.isFinite(weeks) || weeks <= 0 || !Number.isInteger(weeks)) {
  console.error(`Bad week count "${rawArgs.find((a) => !a.startsWith('-')) ?? ''}". Use a positive number of weeks.`);
  process.exit(2);
}

const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('unknown-attribution: TWO_DATABASE_URL is not set.');
  process.exit(1);
}

const now = new Date();
const since = new Date(now.getTime() - weeks * 7 * 86_400_000).toISOString();
const db = await openDb(databaseUrl);

const joinExcl = excludeClause('member_join');
const joins = await db
  .prepare(
    `SELECT occurred_at, source FROM events
      WHERE event_type = 'member_join' AND occurred_at >= ?${joinExcl.sql}
      ORDER BY occurred_at`,
  )
  .all<{ occurred_at: string; source: string }>(since, ...joinExcl.params);

// Bot-down windows: gaps in the bot's own append-only write series
// (`events.recorded_at` - every row is proof the bot was alive to write it),
// the same probe the funnel's TOG-5719 section uses. `recorded_at` (when WE
// wrote the row), not `occurred_at`: a backfilled row has a fresh
// recorded_at, so the series measures bot liveness, not event time.
const writeSeries = await db
  .prepare(
    `SELECT recorded_at AS at FROM events
      WHERE occurred_at >= ?
      ORDER BY recorded_at`,
  )
  .all<{ at: string }>(since)
  .catch(() => [] as Array<{ at: string }>);
const downtimeWindows: DowntimeWindow[] = findBlindWindows(writeSeries.map((r) => r.at));

// Snapshot updated_at is the last refresh, not the first capture. No durable
// first-capture boundary is recorded, so use the helper's null-boundary behavior:
// only explicit backfill sources are pre-tracking; unknowns remain actionable.
const firstCaptureAt = null;

await db.close();

const report = buildUnknownReport(
  joins.map((r) => ({ occurredAt: r.occurred_at, source: r.source })),
  { now, weeks, downtimeWindows, firstCaptureAt },
);

console.log(`\nTWO unknown attribution - last ${weeks} weeks (since ${since.slice(0, 10)})\n`);
console.log('  week        joins  unknown  rate   pre-track  downtime  unexplained');
for (const w of report.weeks) {
  const rate = formatUnknownRate(w.unknownRate).padStart(4);
  console.log(
    `  ${w.weekStart}  ${String(w.joins).padStart(5)}  ${String(w.unknown).padStart(7)}  ${rate}` +
      `  ${String(w.preTracking).padStart(9)}  ${String(w.downtime).padStart(8)}  ${String(w.unexplained).padStart(11)}`,
  );
}

const t = report.totals;
console.log(
  `  ${'TOTAL'.padEnd(10)}  ${String(t.joins).padStart(5)}  ${String(t.unknown).padStart(7)}  ` +
    `${formatUnknownRate(t.unknownRate).padStart(4)}  ${String(t.preTracking).padStart(9)}` +
    `  ${String(t.downtime).padStart(8)}  ${String(t.unexplained).padStart(11)}`,
);

console.log('\n  Top unknown patterns (most joins first - the first line is the fix):');
for (const { pattern, count } of report.topPatterns) {
  console.log(`    ${String(count).padStart(5)}  ${pattern}`);
}
if (t.downtime > 0) {
  console.log('    (downtime is an upper bound - a quiet stretch with no writes reads as a gap)');
}
if (firstCaptureAt === null && t.preTracking > 0) {
  console.log('    (first-capture boundary unavailable - only backfill sources are pre-tracking)');
}
if (t.joins === 0) {
  console.log('    (no joins in window - share an invite, then see npm run campaigns)');
}
console.log('');
