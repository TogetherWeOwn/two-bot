/**
 * Member_leave backfill gap sweep (TOG-8305).
 *
 *   node scripts/leave-gap.ts              # full history, read-only
 *   node scripts/leave-gap.ts 30           # last 30 days only
 *   node scripts/leave-gap.ts --seed       # same report on seeded rows, no DB, no token
 *   node scripts/leave-gap.ts --help       # usage, no DB
 *
 * Counts members with a `member_join` row and no `member_leave` row who are no
 * longer in the guild, classifies each gap (pre-coverage / log-miss /
 * raid-residue / rejoin-gap), and proposes a fill rule WITHOUT writing
 * anything: no production DB touched, and the fill proposal stays a proposal.
 * The pairing arithmetic lives in src/analytics/memberLeaveGap.ts and is
 * pinned by test/unit.leavegap.test.ts; this file only reads rows (same split
 * as voice-reconcile.ts and unknown-attribution.ts). Guard rails match those
 * scripts: exit 2 on a bad day count, exit 1 when TWO_DATABASE_URL or the
 * roster credentials are missing, exit 0 with the report otherwise - gaps are
 * findings, not failure.
 *
 * Live mode reads the Discord roster (GET only) plus the event feeds (SELECT
 * only), then closes the DB before printing. The log floor comes from the
 * floor flag, not a guess: without it every gap reads as log-miss with the
 * floor-unknown note rather than a fabricated pre-coverage label.
 */
import { openDb } from '../src/store/db.ts';
import { ANOMALIES } from '../src/analytics/anomalies.ts';
import {
  buildSeedGapData,
  classifyLeaveGaps,
  fetchLeaveGapFeeds,
  formatLeaveGapReport,
  type RosterMember,
} from '../src/analytics/memberLeaveGap.ts';
import {
  DiscordRest,
  fetchAllMembersCapped,
  type RawMember,
} from '../src/discord/rest.ts';

const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(`leave-gap: members with a join, no leave row, and gone from the roster (TOG-8305).

Usage: node scripts/leave-gap.ts [days] [--floor=ISO] [--seed]

  no args      full-history sweep, read-only (SELECT + roster GET only, never writes)
  days         last N days only, e.g. 30 (see the windowing caveat below)
  --floor=ISO  oldest log timestamp the backfill actually read (its scannedBackTo);
               gaps older than it read as pre-coverage, without it as log-miss
  --seed       reviewer path: same report on seeded rows, no database, no token
  --help       this usage, no database and no credentials needed

Read-only: no production DB touched. The fill rule in the report is a proposal
for a future card - this script writes nothing anywhere.

Roster paging is capped at 20 pages (20,000 members max). Above that the sweep
refuses the partial roster loudly instead of counting it.

Exit codes: 0 the report printed; 1 TWO_DATABASE_URL / roster credentials
missing, roster unreadable, or roster truncated; 2 bad day count or bad floor;
3 --floor flag present but unparseable.`);
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

const floorArg = rawArgs.find((a) => a.startsWith('--floor='));
let floor: string | null = null;
if (floorArg !== undefined) {
  const raw = floorArg.slice('--floor='.length);
  if (!raw || Number.isNaN(Date.parse(raw))) {
    console.error(`Bad --floor "${raw}". Pass the backfill's oldest scanned timestamp, e.g. --floor=2023-01-01T00:00:00.000Z.`);
    process.exit(3);
  }
  floor = new Date(raw).toISOString();
}

const now = new Date();

if (seeded) {
  // Reviewer path: no database, no token. Seven members cover every path -
  // one present, one resolved, one pre-coverage, one log-miss, one
  // raid-residue, one rejoin-gap, two malformed rows skipped.
  const seed = buildSeedGapData();
  const result = classifyLeaveGaps(seed.joins, seed.leaves, seed.roster, {
    logFloor: seed.logFloor,
    anomalies: ANOMALIES,
  });
  process.stdout.write(formatLeaveGapReport(result, 'TWO member_leave gap - SEEDED DEMO'));
  // exitCode, not exit(): stdout to a pipe drains before the natural end, and
  // an explicit exit() can truncate the report the reviewer is here to see
  // (same reason as unknown-attribution.ts). The return keeps this branch from
  // falling through to the live-DB branch below - top-level await is on, so a
  // bare `return` ends the module here.
  process.exitCode = 0;
} else {
  await runLive(now, days, floor);
}

/** Roster pages are full member JSON: cap the scan or a large guild costs unbounded reads. */
const ROSTER_MAX_PAGES = 20;

function toRoster(guildId: string, members: RawMember[]): RosterMember[] {
  const out: RosterMember[] = [];
  for (const m of members) {
    const id = m.user?.id;
    if (id) out.push({ guildId, memberId: id });
  }
  return out;
}

async function runLive(now: Date, liveDays: number | undefined, logFloor: string | null): Promise<void> {
  const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('leave-gap: TWO_DATABASE_URL is not set.');
    process.exit(1);
  }
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  if (!guildId) {
    console.error('leave-gap: DISCORD_GUILD_ID is not set. The sweep targets exactly one server on purpose.');
    process.exit(1);
  }
  const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('leave-gap: DISCORD_TOKEN (or DISCORD_BOT_TOKEN) is not set. The roster read needs it.');
    process.exit(1);
  }

  const since = liveDays === undefined ? undefined : new Date(now.getTime() - liveDays * 86_400_000).toISOString();
  const db = await openDb(databaseUrl);
  const { joins, leaves } = await fetchLeaveGapFeeds(db, since);
  await db.close();

  const rest = new DiscordRest({ token });
  const scan = await fetchAllMembersCapped(rest, guildId, { maxPages: ROSTER_MAX_PAGES });
  if (!scan) {
    console.error('leave-gap: roster read failed - refusing the empty result instead of counting it.');
    process.exit(1);
  }
  if (scan.truncated) {
    console.error(
      `leave-gap: roster exceeds the ${ROSTER_MAX_PAGES}-page cap - a partial roster is never presented as complete.`,
    );
    process.exit(1);
  }
  const roster = toRoster(guildId, scan.members);

  // The DB feeds are guild-unscoped here on purpose: fetchLeaveGapFeeds reads
  // every guild's rows and the roster proves presence in exactly one, so other
  // guilds' members correctly read as off-roster gaps rather than mixing into
  // this guild's counts. Filter to the sweep guild before classifying.
  const result = classifyLeaveGaps(
    joins.filter((j) => j.guildId === guildId),
    leaves.filter((l) => l.guildId === guildId),
    roster,
    { logFloor, anomalies: ANOMALIES },
  );
  const window = since === undefined ? 'full history' : `last ${liveDays} days (since ${since.slice(0, 10)})`;
  process.stdout.write(
    formatLeaveGapReport(result, `TWO member_leave gap - ${window}${logFloor ? `, log floor ${logFloor.slice(0, 10)}` : ', log floor unknown'}`),
  );
  // Windowing caveat, same shape as voice-reconcile.ts: a day count bounds
  // both feeds, so a join just before `since` with its leave inside reads as
  // a gap the live window cannot see resolved. Default to the full-history
  // sweep to certify; narrow only to bound a large table while triaging.
  if (since !== undefined) {
    process.stdout.write(
      '\n  NOTE: windowed sweep - a join before the window with its leave inside it reads as\n' +
        '  a gap here. Certify with the full-history sweep, not a narrowed one.\n',
    );
  }
  // exitCode, not exit(): see the seeded branch above.
  process.exitCode = 0;
}
