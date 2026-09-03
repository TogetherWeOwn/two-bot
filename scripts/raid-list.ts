/**
 * The raid account list. READ-ONLY.
 *
 *   node scripts/raid-list.ts              # the list, with the safety checks shown
 *   node scripts/raid-list.ts --ids        # ids only, one per line, for a mod tool
 *   node scripts/raid-list.ts --verify     # ...and confirm each is still in the server
 *   node scripts/raid-list.ts --scan       # what the live detector would have caught
 *
 * WHY THIS EXISTS
 *
 * Three bot raids reached this server and 30 of those accounts are still in it,
 * so 30 of the 84 "humans" Discord counts are not people. Removing them is a
 * moderation decision and a human takes it (TWO-56). This produces the exact
 * list that decision needs, and nothing else: it kicks nobody, bans nobody,
 * messages nobody and writes nothing.
 *
 * THE SAFETY CHECK THAT MATTERS
 *
 * A real person who happened to join during a raid window would otherwise end
 * up on a kick list because of when they arrived. So an account is only listed
 * if it has never posted a message and never entered a voice channel. Anyone
 * inside the window who has ever done either is held back and printed under
 * KEEP, by name of the check that saved them.
 *
 * Snowflakes only - no usernames are fetched or printed. See docs/PRIVACY.md.
 */
import { openDb } from '../src/store/db.ts';
import { ANOMALIES, windowBounds } from '../src/analytics/anomalies.ts';
import { scanJoinsForBursts } from '../src/analytics/raidWatch.ts';

const argv = process.argv.slice(2);
const idsOnly = argv.includes('--ids');
const verify = argv.includes('--verify');
const scan = argv.includes('--scan');
const dbPath = process.env.TWO_DB_PATH || './data/two.db';
const guildId = process.env.DISCORD_GUILD_ID ?? '';

const db = await openDb(dbPath);

interface Row {
  member_id: string;
  joined_at: string;
  first_message_at: string | null;
  first_voice_at: string | null;
  left_at: string | null;
}

const raids = ANOMALIES.filter((a) => a.kind === 'raid').sort((a, b) => a.start.localeCompare(b.start));

interface Listed {
  windowId: string;
  row: Row;
}
const remove: Listed[] = [];
const keep: Listed[] = [];
const alreadyGone: number[] = [];

for (const raid of raids) {
  const { from, to } = windowBounds(raid);
  const rows = await db
    .prepare(
      `SELECT member_id, joined_at, first_message_at, first_voice_at, left_at
         FROM members
        WHERE joined_at >= ? AND joined_at < ? AND NOT is_bot
        ORDER BY joined_at ASC`,
    )
    .all<Row>(from, to);

  let gone = 0;
  for (const row of rows) {
    if (row.left_at) {
      gone++;
      continue;
    }
    const everActive = !!row.first_message_at || !!row.first_voice_at;
    (everActive ? keep : remove).push({ windowId: raid.id, row });
  }
  alreadyGone.push(gone);
}

if (idsOnly) {
  for (const r of remove) console.log(r.row.member_id);
  await db.close();
  process.exit(0);
}

console.log('\nTWO raid accounts still in the server\n');
console.log(`  Source: ${dbPath}, windows from src/analytics/anomalies.ts. Read-only.\n`);

raids.forEach((raid, i) => {
  const mine = remove.filter((r) => r.windowId === raid.id);
  const held = keep.filter((r) => r.windowId === raid.id);
  console.log(`  ${raid.id}  (${raid.status})`);
  console.log(`    ${raid.label}`);
  console.log(
    `    still in the server: ${mine.length}   already gone: ${alreadyGone[i]}` +
      (held.length ? `   held back as real people: ${held.length}` : ''),
  );
  for (const { row } of mine) {
    console.log(`      ${row.member_id}  joined ${row.joined_at.replace('T', ' ').slice(0, 19)}Z`);
  }
  console.log('');
});

const humansStillHere = (
  await db
    .prepare(`SELECT COUNT(*) AS n FROM members WHERE left_at IS NULL AND NOT is_bot`)
    .all<{ n: number }>()
)[0].n;

console.log(`  TOTAL to review: ${remove.length}`);
console.log(
  `  Member count Discord shows: ${humansStillHere} humans. Real humans if these are removed: ${humansStillHere - remove.length}.\n`,
);
console.log('  Every account above has never posted a message and never entered voice.');
console.log('  Nothing here has been kicked, banned or messaged. `--ids` prints the bare list.\n');

if (keep.length > 0) {
  console.log('  HELD BACK - joined inside a raid window but has been active, so not a bot:');
  for (const { row, windowId } of keep) {
    const why = row.first_message_at ? 'posted' : 'joined voice';
    console.log(`    ${row.member_id}  ${windowId}  ${why}`);
  }
  console.log('');
}

if (verify) {
  const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
  if (!token || !guildId) {
    console.error('  --verify needs DISCORD_BOT_TOKEN and DISCORD_GUILD_ID. Skipped.\n');
  } else {
    const { DiscordRest } = await import('../src/discord/rest.ts');
    const rest = new DiscordRest({ token });
    let present = 0;
    let missing = 0;
    let pending = 0;
    for (const { row } of remove) {
      const m = await rest.get<{ user?: { id: string }; pending?: boolean; joined_at?: string }>(
        `/guilds/${guildId}/members/${row.member_id}`,
      );
      if (!m?.user?.id) {
        missing++;
        console.log(`    GONE      ${row.member_id}  no longer in the server`);
        continue;
      }
      present++;
      if (m.pending) pending++;
    }
    console.log(
      `\n  Live check: ${present} still in the server, ${missing} already gone, ` +
        `${pending} of those present have never accepted the rules.\n`,
    );
  }
}

if (scan) {
  // What the shipped detector would have said, replayed over every join on
  // record. This is the evidence for the threshold, not a claim about it.
  const joins = await db
    .prepare(
      `SELECT member_id, guild_id, occurred_at FROM events WHERE event_type = 'member_join'`,
    )
    .all<{ member_id: string; guild_id: string; occurred_at: string }>();
  const alerts = scanJoinsForBursts(
    joins.map((j) => ({ guildId: j.guild_id, memberId: j.member_id, occurredAt: j.occurred_at })),
  );
  console.log(`  Detector replay over ${joins.length} recorded joins: ${alerts.length} alerts\n`);
  const byDay = new Map<string, { alerts: number; peak: number }>();
  for (const a of alerts) {
    const day = a.firstJoinAt.slice(0, 10);
    const cur = byDay.get(day) ?? { alerts: 0, peak: 0 };
    byDay.set(day, { alerts: cur.alerts + 1, peak: Math.max(cur.peak, a.count) });
  }
  for (const [day, v] of [...byDay.entries()].sort()) {
    const known = raids.some((r) => day >= r.start && day <= r.end);
    console.log(
      `    ${day}  ${String(v.alerts).padStart(3)} alerts, peak ${v.peak} joins in a window` +
        `  ${known ? '-- known raid' : '-- NOT a listed raid, worth a look'}`,
    );
  }
  console.log('');
}

await db.close();
