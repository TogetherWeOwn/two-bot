/**
 * Who turns up to voice, how often, and when (TOG-99).
 *
 *   node scripts/voice-sessions.ts              # last 90 days, UTC
 *   node scripts/voice-sessions.ts 30           # last 30 days
 *   node scripts/voice-sessions.ts 90 --offset=-5   # bucket hours at UTC-5
 *
 * This is the instrument the anchor event time is meant to come off (TWO-66),
 * instead of a guess plus a manual attendance log.
 *
 * It reports zero until a bot with the gateway listener has actually run -
 * Discord serves no voice history over REST, so there is nothing to backfill.
 * See docs/EVENTS.md limit 5. The report says so in that case rather than
 * printing an empty grid that reads like "nobody comes to voice".
 */
import { openDb } from '../src/store/db.ts';
import {
  attendanceGrid,
  bestSlot,
  coverage,
  dowClaimIsSupported,
  DAY_NAMES,
  frequency,
  slotLabel,
  zoneLabel,
  MIN_OBSERVED_DAYS_FOR_DOW,
  type SessionRow,
} from '../src/analytics/voiceSessions.ts';
import {
  countUnknownStartsPerWindow,
  findBlindWindows,
  formatVoiceDurationSeconds,
  parseVoiceEndMetadata,
  renderReconcileReport,
  summarizeVoiceDurations,
} from '../src/core/voiceSessions.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/voice-sessions.ts [days] [--offset=<hours>]');
  process.exit(0);
}

const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 90);
const offsetHours = Number(args.find((a) => a.startsWith('--offset='))?.split('=')[1] ?? 0);
const offsetMinutes = Math.round(offsetHours * 60);

const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('voice-sessions: TWO_DATABASE_URL is not set.');
  process.exit(1);
}
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const db = await openDb(databaseUrl);

const starts = await db
  .prepare(
    `SELECT member_id, occurred_at, source FROM events
      WHERE event_type = 'voice_session_start' AND member_id IS NOT NULL
        AND occurred_at >= ?
      ORDER BY occurred_at`,
  )
  .all<{ member_id: string; occurred_at: string; source: string }>(since);

const rows: SessionRow[] = starts.map((r) => ({ memberId: r.member_id, occurredAt: r.occurred_at }));

console.log(`\nTWO voice sessions - last ${days} days (since ${since.slice(0, 10)})\n`);

if (rows.length === 0) {
  // Never let a zero pass as an answer. A zero here has two very different
  // causes and the fix is different for each, so name both.
  const anyEver = await db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'voice_session_start'`)
    .get<{ n: number }>();
  const totalEvents = await db.prepare(`SELECT COUNT(*) AS n FROM events`).get<{ n: number }>();
  console.log('  No voice sessions on file for this window.');
  console.log(`    voice_session_start rows, all time: ${Number(anyEver?.n ?? 0)}`);
  console.log(`    events on file, all time:           ${Number(totalEvents?.n ?? 0)}`);
  console.log('');
  console.log('  This is NOT the same as "nobody comes to voice". Two causes:');
  console.log('    1. no bot with the gateway listener has run (see docs/RUNBOOK.md), or');
  console.log('    2. it has run and nobody entered a voice channel.');
  console.log('  This report cannot tell them apart. Check the bot is up first.');
  console.log('  Voice history cannot be backfilled - docs/EVENTS.md limit 5.\n');
  await db.close();
  process.exit(0);
}

// --- coverage first, because it bounds every claim below -------------------

const cov = coverage(rows);
console.log('  Coverage (what the listener actually observed):');
console.log(`    first session   ${cov.firstObserved}`);
console.log(`    last session    ${cov.lastObserved}`);
console.log(`    days with data  ${cov.observedDays}`);
if (!dowClaimIsSupported(cov)) {
  console.log(
    `    ** span is under ${MIN_OBSERVED_DAYS_FOR_DOW} days - the day-of-week result below is not yet`,
  );
  console.log('       evidence. One unusual week would be the entire signal.');
}

// --- how often -------------------------------------------------------------

const f = frequency(rows);
console.log(`\n  How often people turn up:`);
console.log(`    ${String(f.sessions).padStart(5)}  sessions`);
console.log(`    ${String(f.members).padStart(5)}  distinct members`);
console.log(`    ${String(f.once).padStart(5)}  came once and not again`);
console.log(`    ${String(f.occasional).padStart(5)}  came 2-3 times`);
console.log(`    ${String(f.regular).padStart(5)}  came 4+ times  <- the regulars`);
console.log(`\n  Most frequent:`);
for (const m of f.top) console.log(`    ${String(m.sessions).padStart(4)}  ${m.memberId}`);

// --- when ------------------------------------------------------------------

const grid = attendanceGrid(rows, offsetMinutes);
const best = bestSlot(grid);
const tzNote = zoneLabel(offsetMinutes);
console.log(`\n  Busiest slots (${tzNote}, ranked by distinct members, not by sessions):`);
console.log(`    ${'slot'.padEnd(10)} members  sessions`);
for (const s of grid.slice(0, 10)) {
  console.log(
    `    ${slotLabel(s).padEnd(10)} ${String(s.members).padStart(7)}  ${String(s.sessions).padStart(8)}`,
  );
}

if (best) {
  console.log(`\n  Suggested event slot: ${slotLabel(best)} ${tzNote}`);
  console.log(`    ${best.members} distinct members across ${best.sessions} sessions.`);
  if (!dowClaimIsSupported(cov)) {
    console.log('    TREAT AS PROVISIONAL - see the coverage warning above.');
  }
}

// A compact day x hour grid, so a human can see the shape rather than trust
// the ranking. Empty cells stay blank on purpose: a screen of zeroes hides
// exactly the pattern this is for.
console.log(`\n  Sessions by day and hour (${tzNote}):`);
const byCell = new Map(grid.map((s) => [`${s.day}:${s.hour}`, s.sessions]));
console.log(`       ${Array.from({ length: 24 }, (_, h) => String(h).padStart(3)).join('')}`);
for (let d = 0; d < 7; d++) {
  const cells = Array.from({ length: 24 }, (_, h) => {
    const n = byCell.get(`${d}:${h}`);
    return (n ? String(n) : '.').padStart(3);
  }).join('');
  console.log(`    ${DAY_NAMES[d]}${cells}`);
}
console.log('');

// --- blind-window reconcile (TOG-5683) --------------------------------------
//
// A voice gap while the bot is down can never be recovered (docs/EVENTS.md
// limit 5): Discord serves no voice history over REST. This section does not
// try. It names each blind window - a gap in the bot's own append-only write
// series (`events.recorded_at`: every row is proof the bot was alive to write
// it, cf. src/analytics/dashboard.ts) - and counts the `voice_session_end`
// rows with `startKnown: false` attributed to each window. A count, never an
// average: the rows carry no duration precisely because we never saw the
// start.
//
// NOTE (TOG-469 containment): the hourly instrument table is deliberately NOT
// a source here. Gaps in the write series are coarser - a quiet stretch with
// no writes reads as a gap - and the report says so.

// Every write is proof the bot was alive. Gaps in this series are the blind
// windows. `recorded_at` (when WE wrote the row), not `occurred_at` (when
// Discord says it happened): a backfilled row has a fresh recorded_at, so the
// series measures bot liveness, not event time.
const heartbeats = await db
  .prepare(
    `SELECT recorded_at AS at FROM events
      WHERE guild_id = ? AND recorded_at >= ?
      ORDER BY recorded_at`,
  )
  .all<{ at: string }>(process.env.DISCORD_GUILD_ID?.trim() ?? '', since)
  .catch(() => [] as Array<{ at: string }>);

// No write history for this guild yet (a fresh database): the voice-session
// starts are the only proof the listener was alive, so gaps in them are the
// windows. Coarser still - a quiet night reads as a gap - and the report
// says so.
const heartbeatAt =
  heartbeats.length > 0
    ? heartbeats.map((r) => r.at)
    : starts.map((r) => r.occurred_at);

const ends = await db
  .prepare(
    `SELECT occurred_at, metadata FROM events
      WHERE event_type = 'voice_session_end' AND occurred_at >= ?`,
  )
  .all<{ occurred_at: string; metadata: string | null }>(since);
// One parse for both jobs below: the reconcile counts the unknown starts,
// the average excludes them. Both go through the shared helper (TOG-5684).
const durationRows = ends.map((r) => parseVoiceEndMetadata(r.metadata));
const unknownEnds = ends.map((r, i) => ({ occurredAt: r.occurred_at, startKnown: durationRows[i]!.startKnown }));

// --- average session length (TOG-5684) --------------------------------------
//
// Mean over known-start sessions only. `startKnown: false` ends are counted
// in the reconcile below, never averaged here: we never saw the start, so any
// number on those rows is unproven.
const durationSummary = summarizeVoiceDurations(durationRows);
console.log('  Average session length (known-start sessions only):');
if (durationSummary.averageSeconds === null) {
  console.log('    —  (no measured session in this window)');
} else {
  console.log(
    `    ${formatVoiceDurationSeconds(durationSummary.averageSeconds)} ` +
      `over ${durationSummary.measured} measured session(s); ` +
      `${durationSummary.excludedUnknownStarts} unknown-start session(s) excluded, counted below.`,
  );
}
console.log('');

const reconcileCounts = countUnknownStartsPerWindow(findBlindWindows(heartbeatAt), unknownEnds);
console.log('  Blind-window reconcile (bot-down gaps the log cannot recover):');
for (const line of renderReconcileReport(reconcileCounts)) console.log(line);
if (heartbeats.length === 0 && starts.length > 0) {
  console.log('    (windows derived from session starts - the probe has no history for this guild,');
  console.log('     so a quiet night reads as a gap. Enable the presence probe for sharper windows.)');
}
console.log('');

await db.close();
