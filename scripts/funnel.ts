/**
 * The crude-but-accurate funnel report. Run it any time:
 *
 *   node scripts/funnel.ts            # last 7 days
 *   node scripts/funnel.ts 30         # last 30 days
 *
 * This is the stopgap until the dashboard exists. It reads the same numbers
 * the dashboard will read, so if this is wrong the dashboard would be too.
 */
import { openDb } from '../src/store/db.ts';

const days = Number(process.argv[2] ?? 7);
// Same resolution the bot uses, so the report always reads the bot's database
// and not a stale local file.
const dbSpec = process.env.TWO_DATABASE_URL || process.env.TWO_DB_PATH || './data/two.db';
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const db = await openDb(dbSpec);

const one = async (sql: string, ...p: unknown[]) =>
  Number((await db.prepare(sql).get<{ n: number }>(...p))?.n ?? 0);

const joins = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='member_join' AND occurred_at >= ?`, since);
const clicks = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='invite_click' AND occurred_at >= ?`, since);
const firstMsg = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='first_message' AND occurred_at >= ?`, since);
const firstVoice = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='first_voice_session' AND occurred_at >= ?`, since);
const leaves = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='member_leave' AND occurred_at >= ?`, since);

const pct = (a: number, b: number) => (b === 0 ? '  n/a' : `${((a / b) * 100).toFixed(0).padStart(4)}%`);

console.log(`\nTWO funnel - last ${days} days (since ${since.slice(0, 10)})\n`);
console.log(`  invite clicks        ${String(clicks).padStart(6)}   (0 until the tracking link is live)`);
console.log(`  joins                ${String(joins).padStart(6)}   ${pct(joins, clicks)} of clicks`);
console.log(`  posted first message ${String(firstMsg).padStart(6)}   ${pct(firstMsg, joins)} of joins`);
console.log(`  first voice session  ${String(firstVoice).padStart(6)}   ${pct(firstVoice, joins)} of joins`);
console.log(`  left                 ${String(leaves).padStart(6)}`);

console.log(`\n  Where joins came from:`);
const bySource = await db
  .prepare(
    `SELECT source, COUNT(*) AS n FROM events
      WHERE event_type='member_join' AND occurred_at >= ?
      GROUP BY source ORDER BY n DESC LIMIT 15`,
  )
  .all<{ source: string; n: number }>(since);
if (bySource.length === 0) console.log('    (no joins yet)');
for (const r of bySource) console.log(`    ${String(r.n).padStart(5)}  ${r.source}`);

// Retention: of members who joined N days ago, how many were still active later?
console.log(`\n  Retention (of members who joined in the window):`);
// "Still around d days after joining". SQLite counts days with julianday();
// Postgres has no such function, so cast the ISO strings and subtract.
const daysAlive =
  db.kind === 'postgres'
    ? `EXTRACT(EPOCH FROM (last_active_at::timestamptz - joined_at::timestamptz)) / 86400`
    : `julianday(last_active_at) - julianday(joined_at)`;

for (const d of [1, 7, 30]) {
  const until = new Date(Date.now() - d * 86_400_000).toISOString();
  const cohort = await one(
    `SELECT COUNT(*) AS n FROM members
      WHERE joined_at >= ? AND joined_at <= ? AND is_bot = 0`,
    since,
    until,
  );
  const retained = await one(
    `SELECT COUNT(*) AS n FROM members
      WHERE joined_at >= ? AND joined_at <= ? AND is_bot = 0
        AND last_active_at IS NOT NULL
        AND ${daysAlive} >= ?`,
    since,
    until,
    d,
  );
  console.log(
    `    D${String(d).padEnd(2)}  ${String(retained).padStart(4)} / ${String(cohort).padEnd(4)}  ${pct(retained, cohort)}`,
  );
}

const never = await one(
  `SELECT COUNT(*) AS n FROM members
    WHERE joined_at IS NOT NULL AND first_message_at IS NULL AND first_voice_at IS NULL
      AND left_at IS NULL AND is_bot = 0`,
);
console.log(`\n  Joined but never posted (all time, still in server): ${never}`);
console.log(`  Total events on file: ${await one(`SELECT COUNT(*) AS n FROM events`)}\n`);

await db.close();
