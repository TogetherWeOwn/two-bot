/**
 * Backfill the message milestones by reading the server's conversation history.
 *
 *   TWO_DATABASE_URL=postgres://... node scripts/backfill-messages.ts --dry-run
 *   TWO_DATABASE_URL=postgres://... node scripts/backfill-messages.ts
 *   TWO_DATABASE_URL=postgres://... node scripts/backfill-messages.ts --max-pages=80
 *
 * Companion to scripts/backfill.ts, which recovers joins, leaves and voice.
 * This one is separate because it is the expensive half: joins come from one
 * member-list call, but "what did they post" means paging real channels.
 *
 * Records each member's earliest three messages, which is what makes AM7's text
 * half exact rather than an upper bound (TWO-95). Run this before quoting AM7.
 *
 * Read-only against Discord. Safe to re-run - a milestone can only ever move
 * earlier, never later, so a deeper scan strictly improves the numbers.
 */
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { setLogLevel } from '../src/core/log.ts';
import { DiscordRest } from '../src/discord/rest.ts';
import { findEarlyMessages, writeEarlyMessages } from '../src/backfill/messages.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
};

const dryRun = flag('dry-run') !== null;
const maxPages = Number(flag('max-pages') || 60);
const since = flag('since');
if (flag('db') !== null) {
  console.error('The --db option has been removed. Set TWO_DATABASE_URL instead.');
  process.exit(2);
}
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();

setLogLevel((process.env.LOG_LEVEL as 'debug' | 'info' | 'error') || 'error');

const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token) {
  console.error('Missing DISCORD_TOKEN (or DISCORD_BOT_TOKEN). See docs/SECRETS.md.');
  process.exit(2);
}
if (!databaseUrl) {
  console.error('Missing TWO_DATABASE_URL. See docs/SECRETS.md.');
  process.exit(2);
}
if (!guildId) {
  console.error('Missing DISCORD_GUILD_ID.');
  process.exit(2);
}

const t0 = Date.now();
const rest = new DiscordRest({ token });
const db = await openDb(databaseUrl);
const store = new EventStore(db);

console.log(`\nTWO message backfill${dryRun ? '  (DRY RUN - nothing will be written)' : ''}`);
console.log(`  guild ${guildId}   max ${maxPages} pages/channel\n`);

const { early, lastActive, summary } = await findEarlyMessages(rest, {
  guildId,
  maxPagesPerChannel: maxPages,
  since: since ? new Date(since).toISOString() : null,
});

const pad = (n: number | string) => String(n).padStart(5);
console.log(`  conversation channels ${pad(summary.channelsConsidered)}   (log/bot channels skipped)`);
console.log(`  channels scanned      ${pad(summary.channelsScanned)}`);
console.log(`  threads scanned       ${pad(summary.threadsScanned)}`);
console.log(`  messages read         ${pad(summary.messagesRead)}`);
console.log(`  members who ever posted ${pad(summary.authorsSeen)}`);
// The number TWO-95 is about: these are the members AM7 can now judge on the
// agreed 3+ bar instead of the "posted at all" proxy.
console.log(`  members with 3+ posts   ${pad(summary.authorsWithFullLadder)}   (AM7 text bar, exactly)`);
console.log(`  oldest message reached  ${summary.scannedBackTo?.slice(0, 10) ?? 'n/a'}`);

if (!dryRun) {
  const { written, laddersCompleted } = await writeEarlyMessages(store, guildId, early, lastActive);
  console.log(`\n  written               ${pad(written)} new message milestone events`);
  console.log(`  third_message on file ${pad(laddersCompleted)} members`);
  console.log(`  (a re-run writes 0 and is a no-op, as intended)`);
}

if (summary.truncated.length) {
  // A truncated scan and a complete one produce different numbers and look
  // identical in the totals. Say it out loud.
  console.log(
    `\n  INCOMPLETE: hit the ${maxPages}-page cap on ${summary.truncated.length} channel(s).` +
      `\n  A capped scan sees a subset of each member's posts, so the milestones we` +
      `\n  recorded are at or LATER than the true ones - never earlier. AM7 can` +
      `\n  therefore miss a member here, but it cannot wrongly admit one, and a` +
      `\n  deeper re-run only moves the milestones towards the truth.` +
      `\n  Re-run with --max-pages=${maxPages * 4}.` +
      `\n  ${summary.truncated.join(', ')}`,
  );
}

console.log(
  `\n  ${rest.requests} Discord requests in ${((Date.now() - t0) / 1000).toFixed(1)}s.` +
    `${dryRun ? '' : '  Now run: node scripts/funnel.ts 7'}\n`,
);

await db.close();
