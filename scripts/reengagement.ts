/**
 * The weekly re-engagement list. Run it every Monday:
 *
 *   node scripts/reengagement.ts                  # print the list
 *   node scripts/reengagement.ts --names          # resolve display names from Discord
 *   node scripts/reengagement.ts --csv            # also write data/reengagement-<date>.csv
 *   node scripts/reengagement.ts --all            # include the lapsed tail by name
 *   node scripts/reengagement.ts --mark           # record that the team has the list
 *
 * What this is for: TWO-8 asks for the members we are losing while we can
 * still get them back, as a list a human works by hand. Not a bot that DMs
 * them. Nothing here sends a message, and nothing should until the CEO signs
 * off on outbound contact.
 *
 * On --names: names are fetched from Discord at print time and never written
 * to the database, same as scripts/roster.ts. The CSV does contain them,
 * because a list of raw snowflakes is not workable by a human - delete the
 * file when the week's outreach is done. See docs/PRIVACY.md.
 */
import { writeFileSync } from 'node:fs';
import { openDb } from '../src/store/db.ts';
import { DiscordRest } from '../src/discord/rest.ts';
import {
  buildList,
  markListed,
  SEGMENTS,
  type ListEntry,
  type Segment,
} from '../src/jobs/reengagement.ts';
import { EventStore } from '../src/store/eventStore.ts';

const argv = process.argv.slice(2);
const withNames = argv.includes('--names');
const withCsv = argv.includes('--csv');
const showAll = argv.includes('--all');
const doMark = argv.includes('--mark');

const dbSpec = process.env.TWO_DATABASE_URL || process.env.TWO_DB_PATH || './data/two.db';
const guildId = process.env.DISCORD_GUILD_ID ?? '';

if (!guildId) {
  console.error('DISCORD_GUILD_ID is not set - there is no server to report on.');
  process.exit(1);
}

const db = await openDb(dbSpec);
const list = await buildList(db, guildId);

/** How the list is meant to be read, in the order the team should work it. */
const HEADLINE: Record<Segment, string> = {
  never_engaged: 'Joined and never said a word - never posted, never in voice',
  slipping: 'Were active, quiet for a few weeks - the best chance of a save',
  dormant: 'Were active, quiet for months',
  lapsed: 'Last seen a long time ago - lowest yield, work it last',
};

function describeSource(s: string | null): string {
  if (!s) return 'unknown';
  if (s.startsWith('invite:')) return s.slice('invite:'.length);
  if (s.startsWith('ambiguous:')) return `ambiguous (${s.slice('ambiguous:'.length)})`;
  if (s.startsWith('backfill:')) return 'unknown (pre-tracking)';
  if (s === 'vanity') return 'vanity URL';
  return s;
}

// Names are resolved for everything that will be printed or written, and
// nothing else - one Discord call per member on the list.
const needNames = showAll ? list.entries : list.entries.filter((e) => e.segment !== 'lapsed');
let names = new Map<string, string>();
if ((withNames || withCsv) && needNames.length > 0) {
  const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('Name lookup needs DISCORD_TOKEN (or DISCORD_BOT_TOKEN); printing ids only.\n');
  } else {
    const rest = new DiscordRest({ token });
    const fetched = await Promise.all(
      needNames.map((e) =>
        rest.get<{ user?: { id: string; username?: string }; nick?: string | null }>(
          `/guilds/${guildId}/members/${e.memberId}`,
        ),
      ),
    );
    names = new Map(
      fetched
        .filter((m): m is NonNullable<typeof m> => !!m?.user?.id)
        .map((m) => [m.user!.id, m.nick || m.user!.username || '']),
    );
  }
}

const label = (id: string) => {
  const n = names.get(id);
  return n ? `${n} (${id})` : id;
};
const ago = (e: ListEntry) =>
  e.daysQuiet === null ? `never (${e.daysSinceJoin}d in server)` : `${e.daysQuiet}d ago`;

console.log(`\nTWO re-engagement list - ${list.generatedAt.slice(0, 10)}\n`);

for (const segment of SEGMENTS) {
  const rows = list.entries.filter((e) => e.segment === segment);
  if (rows.length === 0) {
    // An empty bucket is a finding, not a blank. "Nobody is slipping" and
    // "the query is broken" print the same thing otherwise.
    console.log(`  ${segment.toUpperCase()} - none\n    ${HEADLINE[segment]}\n`);
    continue;
  }

  console.log(`  ${segment.toUpperCase()} (${rows.length})`);
  console.log(`    ${HEADLINE[segment]}\n`);

  if (segment === 'lapsed' && !showAll) {
    console.log(`    ${rows.length} members, last seen ${rows[0].daysQuiet}-${rows[rows.length - 1].daysQuiet} days ago.`);
    console.log(`    Names withheld by default - re-run with --all if you want to work this tail.\n`);
    continue;
  }

  // Widths come from the data, not from a guess: a member who has been here
  // 1,197 days and an invite code both overflow any fixed column, and a table
  // whose columns do not line up is a table nobody reads.
  const w = Math.max(18, ...rows.map((r) => label(r.memberId).length));
  const seenW = Math.max(9, ...rows.map((r) => ago(r).length));
  const srcW = Math.max(9, ...rows.map((r) => describeSource(r.joinSource).length));
  console.log(
    `    ${'member'.padEnd(w)}  ${'last seen'.padEnd(seenW)}  ${'did what'.padEnd(8)}  ${'came from'.padEnd(srcW)}  new?`,
  );
  console.log(
    `    ${'-'.repeat(w)}  ${'-'.repeat(seenW)}  ${'-'.repeat(8)}  ${'-'.repeat(srcW)}  ----`,
  );
  for (const r of rows) {
    console.log(
      `    ${label(r.memberId).padEnd(w)}  ${ago(r).padEnd(seenW)}  ` +
        `${r.engagedVia.padEnd(8)}  ${describeSource(r.joinSource).padEnd(srcW)}  ` +
        `${r.previouslyListedAt ? 'seen ' + r.previouslyListedAt.slice(0, 10) : 'NEW'}`,
    );
  }
  console.log('');
}

const { setAside, totals, counts, thresholds } = list;
const listed = list.entries.length;

console.log(`  ${listed} on the list, out of ${totals.presentHumans} members still in the server.`);
console.log(`  ${totals.stillActive} were active in the last ${thresholds.quietDays} days - nothing to do there.`);
if (setAside.inGracePeriod > 0) {
  console.log(`  ${setAside.inGracePeriod} joined in the last ${thresholds.graceDays} days and have not had a fair chance yet.`);
}
if (setAside.raidAccounts > 0) {
  console.log(
    `\n  Set aside: ${setAside.raidAccounts} accounts from known mass-joins. They have never posted` +
      `\n  or entered voice and are almost certainly not people. They are still in the` +
      `\n  member count Discord shows. Windows:`,
  );
  for (const wnd of setAside.windows) console.log(`    ${wnd}`);
}
console.log(
  `\n  Buckets: quiet ${thresholds.quietDays}d+ = slipping, ${thresholds.dormantDays}d+ = dormant, ` +
    `${thresholds.lapsedDays}d+ = lapsed.`,
);
console.log(
  `  Activity means a message or a voice session. Voice is most of what TWO does,` +
    `\n  so "${counts.never_engaged} never engaged" means never in a voice room either.\n`,
);

if (withCsv) {
  const day = list.generatedAt.slice(0, 10);
  const path = `./data/reengagement-${day}.csv`;
  const rows = showAll ? list.entries : list.entries.filter((e) => e.segment !== 'lapsed');
  const csv = [
    'segment,member_id,display_name,profile_url,joined_at,days_in_server,came_from,last_active_at,days_quiet,engaged_via,previously_listed',
    ...rows.map((e) =>
      [
        e.segment,
        e.memberId,
        JSON.stringify(names.get(e.memberId) ?? ''),
        `https://discord.com/users/${e.memberId}`,
        e.joinedAt ?? '',
        e.daysSinceJoin ?? '',
        describeSource(e.joinSource),
        e.lastActiveAt ?? '',
        e.daysQuiet ?? '',
        e.engagedVia,
        e.previouslyListedAt?.slice(0, 10) ?? '',
      ].join(','),
    ),
  ].join('\n');
  writeFileSync(path, csv + '\n');
  console.log(`  Wrote ${rows.length} rows to ${path}`);
  console.log(`  It contains display names - delete it once the week's outreach is done.\n`);
}

if (doMark) {
  const store = new EventStore(db);
  const n = await markListed(store, guildId, list.entries);
  console.log(`  Marked ${n} members as handed over. Next week they will not read as NEW.\n`);
}

await db.close();
