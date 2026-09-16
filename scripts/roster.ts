/**
 * The new-member roster: one line per member who joined recently, saying where
 * they came from and how far into the community they actually got.
 *
 *   node scripts/roster.ts            # last 7 days
 *   node scripts/roster.ts 30         # last 30 days
 *   node scripts/roster.ts 7 --names  # resolve display names from Discord
 *
 * This is the question TWO-5 exists to answer, printed directly rather than
 * inferred from a funnel total: for each recent joiner, which invite brought
 * them, and did they ever post.
 *
 * On --names: display names are fetched from Discord at print time and never
 * written to the database. The funnel stores snowflakes only. See docs/PRIVACY.md.
 */
import { openDb } from '../src/store/db.ts';
import { DiscordRest } from '../src/discord/rest.ts';

const argv = process.argv.slice(2);
const days = Number(argv.find((a) => /^\d+$/.test(a)) ?? 7);
const withNames = argv.includes('--names');
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
const guildId = process.env.DISCORD_GUILD_ID ?? '';
if (!databaseUrl) {
  console.error('roster: TWO_DATABASE_URL is not set.');
  process.exit(1);
}

const since = new Date(Date.now() - days * 86_400_000).toISOString();
const db = await openDb(databaseUrl);

interface Row {
  member_id: string;
  joined_at: string;
  join_source: string | null;
  first_message_at: string | null;
  first_voice_at: string | null;
  left_at: string | null;
}

const rows = await db
  .prepare(
    `SELECT member_id, joined_at, join_source, first_message_at, first_voice_at, left_at
       FROM members
      WHERE guild_id = ? AND joined_at IS NOT NULL AND joined_at >= ? AND NOT is_bot
      ORDER BY joined_at DESC`,
  )
  .all<Row>(guildId, since);

/**
 * Turn a stored source into something a community operator can act on.
 * `backfill:*` means the member predates the instrumentation, and saying
 * "unknown (pre-tracking)" is honest where "unknown" alone would look like a
 * bug in the tracker.
 */
function describeSource(s: string | null): string {
  if (!s) return 'unknown';
  if (s.startsWith('invite:')) return s.slice('invite:'.length);
  if (s.startsWith('ambiguous:')) return `ambiguous (${s.slice('ambiguous:'.length)})`;
  if (s.startsWith('backfill:')) return 'unknown (pre-tracking)';
  if (s === 'vanity') return 'vanity URL';
  return s;
}

let names = new Map<string, string>();
if (withNames && guildId) {
  const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('--names needs DISCORD_TOKEN (or DISCORD_BOT_TOKEN); printing ids only.\n');
  } else {
    const rest = new DiscordRest({ token });
    const fetched = await Promise.all(
      rows.map((r) =>
        rest.get<{ user?: { id: string; username?: string }; nick?: string | null }>(
          `/guilds/${guildId}/members/${r.member_id}`,
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

console.log(`\nTWO new members - last ${days} days (since ${since.slice(0, 10)})\n`);

if (rows.length === 0) {
  console.log('  No joins recorded in this window.\n');
} else {
  const w = Math.max(20, ...rows.map((r) => label(r.member_id).length));
  console.log(
    `  ${'member'.padEnd(w)}  ${'joined'.padEnd(16)}  ${'came from'.padEnd(22)}  posted?  voice?  still here?`,
  );
  console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(16)}  ${'-'.repeat(22)}  -------  ------  -----------`);
  for (const r of rows) {
    console.log(
      `  ${label(r.member_id).padEnd(w)}  ${r.joined_at.slice(0, 16).replace('T', ' ')}  ` +
        `${describeSource(r.join_source).padEnd(22)}  ` +
        `${(r.first_message_at ? 'yes' : 'NO').padEnd(7)}  ` +
        `${(r.first_voice_at ? 'yes' : 'no').padEnd(6)}  ` +
        `${r.left_at ? 'left' : 'yes'}`,
    );
  }

  const posted = rows.filter((r) => r.first_message_at).length;
  const silent = rows.filter((r) => !r.first_message_at && !r.left_at).length;
  const attributed = rows.filter((r) => (r.join_source ?? '').startsWith('invite:')).length;
  console.log(`\n  ${rows.length} joined, ${posted} posted, ${rows.length - posted} never posted`);
  console.log(`  ${attributed} of ${rows.length} attributed to a specific invite code`);
  if (attributed < rows.length) {
    console.log(
      `  The rest joined before per-invite tracking was live. Every join from` +
        `\n  deploy onward is attributed to a code.`,
    );
  }
  if (silent > 0) {
    console.log(`\n  ${silent} still in the server and have never posted - the re-engagement list.`);
  }
}

console.log();
await db.close();
