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
import { formatRosterText } from '../src/analytics/cliFormat.ts';
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

// Table layout and zero-state guidance live in cliFormat.ts (TOG-5723) so
// fixture tests cover them without a live DB or Discord token.
console.log(
  formatRosterText(
    rows.map((r) => {
      const n = (names.get(r.member_id) ?? '').trim();
      return {
        memberId: r.member_id,
        displayName: n ? n : null,
        joinedAt: r.joined_at,
        joinSource: r.join_source,
        firstMessageAt: r.first_message_at,
        firstVoiceAt: r.first_voice_at,
        leftAt: r.left_at,
      };
    }),
    days,
    since,
  ),
);
await db.close();
