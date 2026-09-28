/**
 * Weekly unknown-attribution report (TOG-7212, threshold TOG-8293).
 *
 *   node scripts/unknown-attribution.ts                        # last 8 weeks, fail above 50%
 *   node scripts/unknown-attribution.ts 4                      # last 4 weeks
 *   node scripts/unknown-attribution.ts --seed                 # same report on seeded rows, no DB
 *   node scripts/unknown-attribution.ts --seed --max-unknown=25  # watch it flag
 *   TWO_UNKNOWN_THRESHOLD=25 node scripts/unknown-attribution.ts # same via env
 *
 * The operator's weekly question: is the unknown share going down, and what
 * is still producing it? One line per Monday-start week with the unknown
 * rate, then the top unknown patterns across the window - pre-tracking
 * (imported history, not fixable), downtime (bot-down joins, an upper bound),
 * unexplained (the residual to drive down).
 *
 * The threshold answers the harder question: is attribution good enough to
 * quote this week. The tripwire reads the TOTAL unknown share - above it
 * (default 50%) most joins carry no code and the per-code story is noise, so
 * the script prints FAIL and exits 1 instead of leaving the judgement to
 * whoever reads the table. One bad week in an otherwise attributed window is
 * named in the weeks-over lines, not a failed window. Set before the data
 * exists (the ledger's whole method); lower it as live capture accumulates.
 * Flag beats env beats default, so the reviewer flips it and watches the
 * verdict move. See docs/EVENTS.md.
 *
 * The arithmetic lives in src/analytics/unknownAttribution.ts and is pinned
 * by test/unit.unknownattribution.test.ts; this file only reads rows (same
 * split as funnel.ts). Guard rails match the funnel: exit 2 on a bad week
 * count or a bad threshold, exit 1 when TWO_DATABASE_URL is missing or the
 * share breaches the tripwire.
 */
import { openDb } from '../src/store/db.ts';
import { excludeClause } from '../src/analytics/anomalies.ts';
import { findBlindWindows } from '../src/core/voiceSessions.ts';
import type { DowntimeWindow } from '../src/core/inviteTracker.ts';
import {
  buildSeedData,
  buildUnknownReport,
  DEFAULT_UNKNOWN_THRESHOLD_PCT,
  evaluateThreshold,
  formatUnknownReport,
  parseThresholdPct,
} from '../src/analytics/unknownAttribution.ts';

const rawArgs = process.argv.slice(2);
const seeded = rawArgs.includes('--seed');

// Flag beats env beats default. `--max-unknown 25` and `--max-unknown=25`
// both read; a present-but-unparseable value exits 2 rather than running
// against a threshold nobody asked for.
const flagAt = rawArgs.findIndex((a) => a === '--max-unknown' || a.startsWith('--max-unknown='));
let flagRaw: string | undefined;
// Space form (`--max-unknown 25`) consumes the next argv: it is the
// threshold's value, never the week count below.
let flagValueIndex = -1;
if (flagAt >= 0) {
  const flag = rawArgs[flagAt]!;
  if (flag.includes('=')) {
    flagRaw = flag.slice(flag.indexOf('=') + 1);
  } else {
    flagRaw = rawArgs[flagAt + 1];
    flagValueIndex = flagAt + 1;
  }
  if (flagRaw === undefined || flagRaw.startsWith('-')) {
    console.error('Bad --max-unknown: give a percent 0-100, e.g. --max-unknown=25.');
    process.exit(2);
  }
}
const weeksRaw = rawArgs.find((a, i) => !a.startsWith('-') && i !== flagValueIndex) ?? '8';
const weeks = Number(weeksRaw);
if (!Number.isFinite(weeks) || weeks <= 0 || !Number.isInteger(weeks)) {
  console.error(`Bad week count "${weeksRaw}". Use a positive number of weeks.`);
  process.exit(2);
}
const envRaw = process.env.TWO_UNKNOWN_THRESHOLD?.trim() || undefined;
const thresholdRaw = flagRaw ?? envRaw ?? String(DEFAULT_UNKNOWN_THRESHOLD_PCT);
const thresholdPct = parseThresholdPct(thresholdRaw);
if (thresholdPct === null) {
  const where = flagRaw !== undefined ? '--max-unknown' : 'TWO_UNKNOWN_THRESHOLD';
  console.error(`Bad ${where} "${thresholdRaw}". Use a percent 0-100, e.g. 25 or 25%.`);
  process.exit(2);
}

const now = new Date();

if (seeded) {
  // Reviewer path: no database. Rows are relative to now so they always land
  // inside the window - 10 joins, 4 unknown (40%), under the 50% default and
  // over a flipped 25%.
  const seed = buildSeedData(now, weeks);
  const report = buildUnknownReport(
    seed.joins,
    { now, weeks, downtimeWindows: seed.downtimeWindows, firstCaptureAt: seed.firstCaptureAt },
  );
  const verdict = evaluateThreshold(report, thresholdPct);
  process.stdout.write(
    formatUnknownReport(report, {
      heading: `TWO unknown attribution - SEEDED DEMO, last ${weeks} weeks`,
      firstCaptureAt: seed.firstCaptureAt,
      threshold: verdict,
    }),
  );
  // exitCode, not exit(): stdout to a pipe drains before the natural end, and
  // an explicit exit() can truncate the table the reviewer is here to see.
  // The return keeps this branch from falling through to the live-DB branch
  // below - top-level await is on, so a bare `return` ends the module here.
  process.exitCode = verdict.breached ? 1 : 0;
} else {
  await runLive(now, weeks, thresholdPct);
}

async function runLive(now: Date, weeks: number, thresholdPct: number): Promise<void> {
  const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('unknown-attribution: TWO_DATABASE_URL is not set.');
    process.exit(1);
  }

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

  // Attribution starts at the first capture run: everything before it was
  // reconstructed from the log channels, which never name an invite.
  // `invite_snapshots.updated_at` IS the last capture; the minimum is the first.
  const firstCaptureAt =
    (
      await db
        .prepare(`SELECT MIN(updated_at) AS t FROM invite_snapshots`)
        .get<{ t: string | null }>()
        .catch(() => null)
    )?.t ?? null;

  await db.close();

  const report = buildUnknownReport(
    joins.map((r) => ({ occurredAt: r.occurred_at, source: r.source })),
    { now, weeks, downtimeWindows, firstCaptureAt },
  );
  const verdict = evaluateThreshold(report, thresholdPct);

  process.stdout.write(
    formatUnknownReport(report, {
      heading: `TWO unknown attribution - last ${weeks} weeks`,
      sinceLabel: since.slice(0, 10),
      firstCaptureAt,
      threshold: verdict,
    }),
  );
  // exitCode, not exit(): see the seeded branch above.
  process.exitCode = verdict.breached ? 1 : 0;
}
