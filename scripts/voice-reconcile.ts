/**
 * One-shot voice open-half reconciliation (TOG-8289).
 *
 *   node scripts/voice-reconcile.ts              # full history, read-only
 *   node scripts/voice-reconcile.ts 30           # last 30 days only
 *   node scripts/voice-reconcile.ts --seed       # same report on seeded halves, no DB
 *   node scripts/voice-reconcile.ts --help       # usage, no DB
 *
 * A voice session is two halves: a `voice_session_start` row and a
 * `voice_session_end` row. Restarts, pre-TOG-6122 server leaves, and bad end
 * rows orphan one half, leaving a NULL where a duration should be. This sweep
 * lists every open half and resolves what the stored rows allow; what cannot
 * be recovered is listed with an explicit reason - never a silent NULL.
 *
 * Read-only by design: it SELECTs the three feeds and computes. It writes
 * nothing, so it is safe to run against production. The pairing arithmetic
 * lives in src/analytics/voiceReconcile.ts and is pinned by
 * test/unit.voicereconcile.test.ts; this file only reads rows (same split as
 * funnel.ts and unknown-attribution.ts). Guard rails match those scripts:
 * exit 2 on a bad day count, exit 1 when TWO_DATABASE_URL is missing, exit 0
 * with the report otherwise - flagged unresolvables are findings, not failure.
 *
 * Windowing caveat: a day count bounds all three feeds, so a start just
 * before `since` with its end inside reads as no-start-on-file. The default
 * is the full-history sweep for exactly this reason; narrow only to bound a
 * large table while triaging, not to certify it.
 */
import { openDb } from '../src/store/db.ts';
import {
  buildSeedHalves,
  fetchVoiceHalves,
  formatReconcileReport,
  reconcileVoiceHalves,
} from '../src/analytics/voiceReconcile.ts';

const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(`voice-reconcile: list voice sessions with only one half seen (TOG-8289).

Usage:
  node scripts/voice-reconcile.ts [days] [--seed]

  no args      full-history sweep, read-only (SELECT only, never writes)
  days         last N days only, e.g. 30 (see the windowing caveat above)
  --seed       reviewer path: same report on seeded halves, no database
  --help       this usage, no database and no credentials needed

Exit codes: 0 the report printed; 1 TWO_DATABASE_URL missing; 2 bad day count.`);
  process.exit(0);
}

const seeded = rawArgs.includes('--seed');
const daysRaw = rawArgs.find((a) => !a.startsWith('-'));
let days: number | undefined;
if (daysRaw !== undefined) {
  const n = Number(daysRaw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`Bad day count "${daysRaw}". Use a positive number of days, e.g. 30.`);
    process.exit(2);
  }
  days = n;
}

const now = new Date();

if (seeded) {
  // Reviewer path: no database. Halves are relative to now so they always land
  // inside the window - 3 resolve (restart-gap, server-leave,
  // metadata-recompute), 3 stay flagged (still-open, superseded,
  // no-start-on-file), 2 more ends are healthy completes.
  const seed = buildSeedHalves(now);
  const result = reconcileVoiceHalves(seed.starts, seed.ends, seed.leaves);
  process.stdout.write(formatReconcileReport(result, 'TWO voice reconcile - SEEDED DEMO'));
  // exitCode, not exit(): stdout to a pipe drains before the natural end, and
  // an explicit exit() can truncate the report the reviewer is here to see
  // (same reason as unknown-attribution.ts). The return keeps this branch from
  // falling through to the live-DB branch below - top-level await is on, so a
  // bare `return` ends the module here.
  process.exitCode = 0;
} else {
  await runLive(days);
}

async function runLive(days: number | undefined): Promise<void> {
  const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('voice-reconcile: TWO_DATABASE_URL is not set.');
    process.exit(1);
  }

  const since = days === undefined ? undefined : new Date(now.getTime() - days * 86_400_000).toISOString();
  const db = await openDb(databaseUrl);
  const { starts, ends, leaves } = await fetchVoiceHalves(db, since);
  await db.close();

  const result = reconcileVoiceHalves(starts, ends, leaves);
  const window = since === undefined ? 'full history' : `last ${days} days (since ${since.slice(0, 10)})`;
  process.stdout.write(formatReconcileReport(result, `TWO voice reconcile - ${window}`));
  // exitCode, not exit(): see the seeded branch above.
  process.exitCode = 0;
}
