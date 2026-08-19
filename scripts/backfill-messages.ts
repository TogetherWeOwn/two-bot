/**
 * Backfill first_message by reading the server's conversation history.
 *
 *   node scripts/backfill-messages.ts --dry-run
 *   node scripts/backfill-messages.ts
 *   node scripts/backfill-messages.ts --max-pages=80
 *
 * Companion to scripts/backfill.ts, which recovers joins, leaves and voice.
 * This one is separate because it is the expensive half: joins come from one
 * member-list call, but "did they ever post" means paging real channels.
 *
 * Read-only against Discord. Safe to re-run - a first_message can only ever
 * move earlier, never later.
 */
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { setLogLevel } from '../src/core/log.ts';
import { DiscordRest } from '../src/discord/rest.ts';
import { findFirstMessages, writeFirstMessages } from '../src/backfill/messages.ts';

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
const dbPath = flag('db') ?? process.env.TWO_DB_PATH ?? './data/two.db';

setLogLevel((process.env.LOG_LEVEL as 'debug' | 'info' | 'error') || 'error');

const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token) {
  console.error('Missing DISCORD_TOKEN (or DISCORD_BOT_TOKEN). See docs/SECRETS.md.');
  process.exit(2);
}
if (!guildId) {
  console.error('Missing DISCORD_GUILD_ID.');
  process.exit(2);
}

const t0 = Date.now();
const rest = new DiscordRest({ token });
const db = await openDb(dbPath);
const store = new EventStore(db);

console.log(`\nTWO first-message backfill${dryRun ? '  (DRY RUN - nothing will be written)' : ''}`);
console.log(`  guild ${guildId}   db ${dbPath}   max ${maxPages} pages/channel\n`);

const { first, lastActive, summary } = await findFirstMessages(rest, {
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
console.log(`  oldest message reached  ${summary.scannedBackTo?.slice(0, 10) ?? 'n/a'}`);

if (!dryRun) {
  const written = await writeFirstMessages(store, guildId, first, lastActive);
  console.log(`\n  written               ${pad(written)} new first_message events`);
  console.log(`  already on file       ${pad(first.size - written)}   (re-run is a no-op, as intended)`);
}

if (summary.truncated.length) {
  // A truncated scan and a complete one produce different numbers and look
  // identical in the totals. Say it out loud.
  console.log(
    `\n  INCOMPLETE: hit the ${maxPages}-page cap on ${summary.truncated.length} channel(s).` +
      `\n  Some members' true first message may be older than what we recorded.` +
      `\n  Re-run with --max-pages=${maxPages * 4}.` +
      `\n  ${summary.truncated.join(', ')}`,
  );
}

console.log(
  `\n  ${rest.requests} Discord requests in ${((Date.now() - t0) / 1000).toFixed(1)}s.` +
    `${dryRun ? '' : '  Now run: node scripts/funnel.ts 7'}\n`,
);

await db.close();
