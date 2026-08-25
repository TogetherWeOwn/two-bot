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

const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 90);
const offsetHours = Number(args.find((a) => a.startsWith('--offset='))?.split('=')[1] ?? 0);
const offsetMinutes = Math.round(offsetHours * 60);

// Same resolution the bot uses, so this always reads the bot's database.
const dbSpec = process.env.TWO_DATABASE_URL || process.env.TWO_DB_PATH || './data/two.db';
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const db = await openDb(dbSpec);

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

await db.close();
