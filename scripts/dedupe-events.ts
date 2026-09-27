/**
 * One-off repair: remove joins and leaves that two logging bots each recorded.
 *
 *   node scripts/dedupe-events.ts --dry-run     # count them, change nothing
 *   node scripts/dedupe-events.ts               # delete the copies
 *
 * The first backfill wrote one row per log entry, and TWO ran several logging
 * bots at once - so a single join arrived twice, seconds apart, from different
 * channels. That put 738 phantom joins and 463 phantom leaves on the board.
 *
 * scripts/backfill.ts no longer creates them (src/backfill/dedupe.ts), but rows
 * already written need clearing out, and re-running the whole backfill to do it
 * would mean trusting a fresh scan to reach as far back as the first one did.
 * This is the smaller, safer operation: it touches nothing but the copies.
 *
 * The kept row is always the earliest of each cluster, so `members.joined_at`
 * and `left_at` - which were derived from whichever copy landed - move by at
 * most the few seconds between the two loggers. Nothing else is rewritten.
 */
import { openDb } from '../src/store/db.ts';
import { collapseCrossSourceDuplicates } from '../src/backfill/dedupe.ts';

const dryRun = process.argv.includes('--dry-run');

// --help boots with no database and deletes nothing.
if (process.argv.includes('--help')) {
  console.log('usage: node scripts/dedupe-events.ts [--dry-run]');
  console.log('');
  console.log('One-off repair: delete cross-logger duplicate member_join/member_leave rows, keeping the earliest of each cluster.');
  console.log('--dry-run counts without deleting; --help opens no database.');
  process.exit(0);
}
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('dedupe-events: TWO_DATABASE_URL is not set.');
  process.exit(1);
}
const db = await openDb(databaseUrl);

console.log(`\nEvent de-duplication${dryRun ? '  (DRY RUN - nothing will be deleted)' : ''}\n`);

let found = 0;
let deleted = 0;
for (const eventType of ['member_join', 'member_leave']) {
  const rows = await db
    .prepare(
      `SELECT id, member_id, occurred_at, source FROM events
        WHERE event_type = ? AND member_id IS NOT NULL`,
    )
    .all<{ id: number; member_id: string; occurred_at: string; source: string }>(eventType);

  const keep = new Set(
    collapseCrossSourceDuplicates(
      rows.map((r) => ({
        id: r.id,
        eventType,
        memberId: r.member_id,
        occurredAt: r.occurred_at,
        source: r.source,
      })),
    ).kept.map((e) => e.id),
  );

  const drop = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  const people = new Set(rows.map((r) => r.member_id)).size;
  found += drop.length;
  console.log(
    `  ${eventType.padEnd(13)} ${String(rows.length).padStart(5)} rows  ` +
      `${String(people).padStart(5)} people  ->  ${String(drop.length).padStart(4)} duplicate rows`,
  );

  if (dryRun || drop.length === 0) continue;
  // Chunked so the statement stays a sane size on either driver.
  for (let i = 0; i < drop.length; i += 200) {
    const chunk = drop.slice(i, i + 200);
    await db
      .prepare(`DELETE FROM events WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .run(...chunk);
    deleted += chunk.length;
  }
}

const remaining = Number(
  (await db.prepare(`SELECT COUNT(*) AS n FROM events`).get<{ n: number }>())?.n ?? 0,
);
console.log(
  `\n  ${dryRun ? `would delete ${found}` : `deleted ${deleted}`} rows; ` +
    `${remaining} events ${dryRun ? 'currently' : 'now'} on file\n`,
);

await db.close();
