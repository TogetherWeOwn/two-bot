/**
 * Growth attribution, per invite code: click -> join -> AM7 -> AM30.
 *
 *   npm run attribution            # joins in the last 90 days
 *   npm run attribution -- 30      # last 30 days
 *   npm run attribution -- all     # every join on file
 *   npm run attribution -- 90 --csv   # same numbers, for a spreadsheet
 *
 * This is scripts/funnel.ts split by invite code. It reads the same database,
 * uses the same anomaly helpers and the same duplicate-logger collapse, so if
 * the two ever disagree one of them is wrong and it is worth knowing.
 *
 * The definitions of AM7 and AM30 live in src/analytics/attribution.ts, along
 * with a full account of the two places the data forces an interpretation.
 * Read that header before quoting a number out of this.
 *
 * THE THREE TRAPS THIS ROUTES AROUND
 *
 *  1. TWO ran several logging bots at once, so one real join is on file twice,
 *     seconds apart, under two different sources. Raw counts overstate joins
 *     by 42%. collapseCrossSourceDuplicates() keeps the earliest copy, which
 *     also means the join is credited to exactly one source.
 *  2. Three bot raids sit in the join curve. excludeClause() drops those
 *     windows from the table and the report names what it set aside.
 *  3. Discord says 84 humans. 30 of them are raid accounts. Per-member rates
 *     divide by the 54 that are real, computed here rather than hardcoded.
 *
 * WORKS WITHOUT A DEPLOYED BOT. Reads only the database, so it runs off
 * whatever `npm run capture` has written. It needs no token and no host.
 *
 * Scoped to one guild (TOG-9555): every events/members collect query below
 * carries a `guild_id = ?` predicate bound to DISCORD_GUILD_ID, so a database
 * holding several guilds reports only this server's numbers. The two
 * invite_campaigns / invite_snapshots reads are exempt and marked exempt
 * where they appear, matching the funnel precedent (TOG-8738).
 */
import { openDb } from '../src/store/db.ts';
import { ANOMALIES, excludeClause, windowBounds } from '../src/analytics/anomalies.ts';
import { collapseCrossSourceDuplicates } from '../src/backfill/dedupe.ts';
import { rollUp, rate, type JoinRecord, type AttributionRow } from '../src/analytics/attribution.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/attribution.ts [days|all] [--csv]');
  process.exit(0);
}

const argv = process.argv.slice(2);
const csv = argv.includes('--csv');
const windowArg = argv.find((a) => !a.startsWith('--')) ?? '90';
const allTime = windowArg === 'all';
const days = allTime ? null : Number(windowArg);
if (!allTime && (!Number.isFinite(days!) || days! <= 0)) {
  console.error(`Bad window "${windowArg}". Use a number of days or "all".`);
  process.exit(2);
}

const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('attribution: TWO_DATABASE_URL is not set.');
  process.exit(1);
}
// TOG-9555: one server per report. Without the guild the collects below would
// sum every guild in the database, the same bug f0caf422 fixed for funnel.
const guildId = process.env.DISCORD_GUILD_ID?.trim() ?? '';
if (!guildId) {
  console.error('DISCORD_GUILD_ID is not set - there is no server to report on.');
  process.exit(1);
}
const nowMs = Date.now();
// Postgres rejects year 0000 (`date/time field value out of range`). The real
// server has no pre-1970 joins, and this is only a lower bound, so 1970-01-01
// still reads as "the beginning" without producing an invalid timestamp.
const since = allTime ? '1970-01-01T00:00:00.000Z' : new Date(nowMs - days! * 86_400_000).toISOString();
const db = await openDb(databaseUrl);

// --- joins -------------------------------------------------------------------

const joinExcl = excludeClause('member_join');
const joinEvents = await db
  .prepare(
    `SELECT member_id, occurred_at, source, metadata FROM events
      WHERE event_type='member_join' AND guild_id = ? AND member_id IS NOT NULL AND occurred_at >= ?${joinExcl.sql}
      ORDER BY occurred_at`,
  )
  .all<{ member_id: string; occurred_at: string; source: string; metadata: string | null }>(
    guildId,
    since,
    ...joinExcl.params,
  );

/**
 * `metadata.attribution_exact` (TWO-73). Absent on every event written before
 * that change and on every event from the live bot, both of which only ever
 * name a code when exactly one moved - so absent means observed, not unknown.
 * Only an explicit `false` marks a placement.
 */
const attributionExact = (raw: string | null): boolean | null => {
  if (!raw) return null;
  try {
    const v = (JSON.parse(raw) as { attribution_exact?: unknown }).attribution_exact;
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null; // A metadata blob we cannot read is not evidence of anything.
  }
};

const { kept, collapsed } = collapseCrossSourceDuplicates(
  joinEvents.map((e) => ({
    eventType: 'member_join',
    memberId: e.member_id,
    occurredAt: e.occurred_at,
    source: e.source,
    attributionExact: attributionExact(e.metadata),
  })),
);

// --- what each of those members did afterwards -------------------------------

// One read of the projection, indexed in memory. The alternative is a join
// against a set of ids that changes shape with the window, and this table is
// under two thousand rows.
const memberRows = await db
  .prepare(
    `SELECT member_id, first_message_at, third_message_at, first_voice_at, last_active_at,
            left_at, is_bot
       FROM members WHERE guild_id = ?`,
  )
  .all<{
    member_id: string;
    first_message_at: string | null;
    third_message_at: string | null;
    first_voice_at: string | null;
    last_active_at: string | null;
    left_at: string | null;
    is_bot: number;
  }>(guildId);
const byMember = new Map(memberRows.map((m) => [m.member_id, m]));

const records: JoinRecord[] = [];
let botJoins = 0;
for (const e of kept) {
  const m = byMember.get(e.memberId!);
  if (m && Number(m.is_bot) === 1) {
    botJoins++;
    continue;
  }
  records.push({
    memberId: e.memberId!,
    joinedAt: e.occurredAt,
    source: e.source,
    firstVoiceAt: m?.first_voice_at ?? null,
    firstMessageAt: m?.first_message_at ?? null,
    // Non-null once we have seen this member's third message, which makes the
    // AM7 text branch exact for them (TWO-95). Still null for a member whose
    // history predates the message backfill and has not been re-scanned, and
    // for anyone who has genuinely posted once or twice - the two are different
    // and the report below separates them rather than averaging them.
    thirdMessageAt: m?.third_message_at ?? null,
    lastActiveAt: m?.last_active_at ?? null,
    leftAt: m?.left_at ?? null,
    attributionExact: e.attributionExact,
  });
}

// --- clicks ------------------------------------------------------------------

// invite_click is emitted by the redirect service (src/redirect/), not the bot,
// so a code shows clicks only once a campaign points at it and the link has
// been posted somewhere. A code with joins and no clicks is being shared as a
// raw discord.gg link - see docs/INVITE_TRACKING.md.
const clickRows = await db
  .prepare(
    `SELECT source, COUNT(*) AS n FROM events
      WHERE event_type='invite_click' AND guild_id = ? AND occurred_at >= ? GROUP BY source`,
  )
  .all<{ source: string; n: number }>(guildId, since);
const clicksBySource = new Map(clickRows.map((r) => [r.source, Number(r.n)]));

// Which zero this is matters. "No tracked link exists" and "the link is live and
// nobody clicked it" are opposite problems with opposite fixes.
//
// EXEMPT from guild scoping: invite_campaigns has no guild column
// (migrations/0006) - campaigns are server-global config, so this count is
// the table size by construction. Matches the funnel precedent (TOG-8738).
const trackedLinks = await db
  .prepare(`SELECT COUNT(*) AS n FROM invite_campaigns`)
  .get<{ n: number }>()
  .then((r) => Number(r?.n ?? 0))
  .catch(() => 0);

// --- every live code, including the ones producing nothing -------------------

// EXEMPT from guild scoping like the invite_campaigns read above: snapshot
// codes feed the always-show list, not the counts. Matches the funnel
// precedent (TOG-8738), which exempts its invite reads the same way.
const codes = await db
  .prepare(`SELECT code, uses, channel_id, updated_at FROM invite_snapshots ORDER BY code`)
  .all<{ code: string; uses: number; channel_id: string | null; updated_at: string }>();
const alwaysShow = codes.map((c) => `invite:${c.code}`);

// --- is the voice half of AM7 actually being captured right now? -------------

// Voice sessions only reach us through the gateway listener on a running bot;
// Discord will not serve voice history over REST, so a gap cannot be backfilled
// later. If the newest voice event is stale, AM7 and AM30 below are floors for
// anyone who arrived since - and on a voice-first server that is most of AM7.
// This drives the banner at the top of the report, not a footnote, because a
// code that delivered people who show up on a Tuesday would otherwise read as a
// code that delivered nothing.
// The probe is a CONTRAST, not a single date. Text recency stays current on its
// own: messages are readable over REST, so `npm run backfill:messages` keeps
// moving last_active_at forward with no bot running. Voice has no such path. So
// if the newest voice signal is far behind the newest signal of any kind, the
// gap is missing voice capture rather than a quiet server. Comparing the two
// avoids the false alarm from reading voice alone on a quiet server. Repeat
// session starts and ends measure ongoing capture; first-ever events also
// cover older history, but alone only tell us when someone first entered
// voice. Ends count because a leave proves presence even when the start row
// is missing (bot-down unknown-start sessions still advance activity).
const VOICE_LAG_DAYS = 30;
const lastVoiceAt =
  (
    await db
      .prepare(`SELECT MAX(occurred_at) AS t FROM events WHERE event_type IN ('first_voice_session', 'voice_session_start', 'voice_session_end') AND guild_id = ?`)
      .get<{ t: string | null }>(guildId)
  )?.t ?? null;
const lastAnyActivityAt =
  (await db.prepare(`SELECT MAX(last_active_at) AS t FROM members WHERE guild_id = ?`).get<{ t: string | null }>(guildId))
    ?.t ?? null;
const daysAgo = (iso: string | null): number | null =>
  iso ? Math.floor((nowMs - Date.parse(iso)) / 86_400_000) : null;
const voiceGapDays = daysAgo(lastVoiceAt);
const activityGapDays = daysAgo(lastAnyActivityAt);
const voiceIsStale =
  voiceGapDays === null || voiceGapDays - (activityGapDays ?? 0) >= VOICE_LAG_DAYS;

// --- the community denominator, computed not assumed -------------------------

const memberExcl = excludeClause('member_join', ANOMALIES, 'joined_at');
const realMembers = Number(
  (
    await db
      .prepare(
        `SELECT COUNT(*) AS n FROM members
          WHERE guild_id = ? AND NOT is_bot AND left_at IS NULL${memberExcl.sql}`,
      )
      .get<{ n: number }>(guildId, ...memberExcl.params)
  )?.n ?? 0,
);
const discordMembers = Number(
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM members WHERE guild_id = ? AND NOT is_bot AND left_at IS NULL`)
      .get<{ n: number }>(guildId)
  )?.n ?? 0,
);

const report = rollUp(records, { nowMs, clicksBySource, alwaysShow });
await db.close();

// --- output ------------------------------------------------------------------

if (csv) {
  console.log(
    'source,clicks,joins,joins_inexact,am7,am7_eligible,am7_voice,am7_messages,am7_message_proxy,am30,am30_eligible,am30_proven_in_window,am30_proven_later',
  );
  const line = (r: AttributionRow) =>
    [
      r.source,
      r.clicks,
      r.joins,
      r.joinsInexact,
      r.am7,
      r.am7Eligible,
      r.am7Voice,
      r.am7Messages,
      r.am7MessageProxy,
      r.am30,
      r.am30Eligible,
      r.am30ProvenInWindow,
      r.am30ProvenLater,
    ].join(',');
  for (const r of report.rows) console.log(line(r));
  console.log(line(report.totals));
  process.exit(0);
}

const label = allTime ? 'all joins on file' : `joins in the last ${days} days`;
// A row whose joins were placed by the multi-code split rather than observed
// (TWO-73). The joins count is still exact; the AM7/AM30 beside it describes a
// set of people who may not all be this code's. Marked in the label so it
// travels with the number when somebody copies one line into a chat.
const soft = (r: AttributionRow) => r.joinsInexact > 0;
const nameOf = (r: AttributionRow) => (soft(r) ? `${r.label} ~` : r.label);

// Wide enough for the longest backfill source string, so no row shifts out of
// its column. A misaligned table is a table people misread.
const w = Math.max(22, ...report.rows.map((r) => nameOf(r).length)) + 2;
console.log(`\nTWO growth attribution - ${label}`);
console.log(
  `since ${allTime ? 'the beginning' : since.slice(0, 10)}, as of ${new Date(nowMs).toISOString().slice(0, 16)}Z`,
);

if (voiceIsStale) {
  console.log(`
  ###########################################################################
  #  THESE ARE FLOORS, NOT COUNTS. VOICE IS NOT BEING RECORDED.             #
  ###########################################################################
  ${
    lastVoiceAt
      ? `Newest voice session on file: ${lastVoiceAt.slice(0, 10)}, ${voiceGapDays} days ago.\n  Newest activity of any kind: ${(lastAnyActivityAt ?? '-').slice(0, 10)}, ${activityGapDays} days ago.`
      : `No voice session has ever been recorded.`
  }
  Voice needs the gateway listener on a deployed bot (TWO-11, no host yet), and
  Discord will not serve voice history over REST - so unlike text, this gap can
  never be backfilled afterwards. TWO is voice-first: 495 voice events against
  15 text messages in 90 days. Voice is therefore nearly all of AM7.

  What that means for the table below: a member who joined recently, never
  posted, and is in voice every Tuesday is indistinguishable here from a member
  who joined and vanished. So every AM7 and AM30 figure is the LOWEST the true
  number could be. Read a low row as "no evidence", never as "this code failed".
  Deploying the bot is what turns these floors into counts.
`);
} else {
  console.log('');
}

console.log(
  `  ${'invite code / source'.padEnd(w)}${'clicks'.padStart(7)}${'joins'.padStart(7)}` +
    `      ${'AM7 / matured'.padEnd(20)}   ${'AM30 / matured AM7'}`,
);
console.log(`  ${'-'.repeat(w + 14 + 46)}`);

const line = (r: AttributionRow, name: string) =>
  `  ${name.padEnd(w)}${String(r.clicks).padStart(7)}${String(r.joins).padStart(7)}` +
  `      ${rate(r.am7, r.am7Eligible)}   ${rate(r.am30, r.am30Eligible)}`;

for (const r of report.rows) console.log(line(r, nameOf(r)));
console.log(`  ${'-'.repeat(w + 14 + 46)}`);
console.log(line(report.totals, 'TOTAL'));

// --- the parts a percentage cannot carry -------------------------------------

console.log(`\n  How to read this`);
console.log(
  `    matured   a join is only counted in AM7 once it has had its 7 days, and in`,
);
console.log(
  `              AM30 once it has had its 30. Immature joins are in the joins`,
);
console.log(`              column and in neither denominator - that is the "/ matured".`);
console.log(
  `    AM7       first voice session, or 3+ messages, within 7 days of joining.`,
);
console.log(`    AM30      was AM7, still in the server, and seen again on day 8 or later.`);
console.log(
  `              Day 8 because activity in the first week is activation, not`,
);
console.log(
  `              retention. No upper day: being seen recently is more retention,`,
);
console.log(`              not less. Read from members.last_active_at (TWO-64).`);
if (report.totals.joinsInexact > 0) {
  console.log(
    `    ~         this code's JOINS COUNT IS EXACT; its AM7/AM30 is not. See below.`,
  );
}

console.log(`\n  Community size`);
console.log(
  `    ${realMembers} real members. Discord shows ${discordMembers}; the difference is raid accounts`,
);
console.log(`    that have never posted or entered voice (scripts/raid-list.ts, TWO-56).`);
if (report.totals.am30 > 0) {
  console.log(
    `    AM30 members from this window: ${report.totals.am30} of ${realMembers} current real members` +
      ` (${Math.round((report.totals.am30 / realMembers) * 100)}%).`,
  );
}

console.log(`\n  What is set aside or missing, so nobody has to ask`);
if (collapsed > 0) {
  console.log(
    `    ${collapsed} duplicate join records collapsed - one real join logged twice by two`,
  );
  console.log(`      different logging bots. ${joinEvents.length} rows in, ${kept.length} real joins out.`);
}
if (botJoins > 0) console.log(`    ${botJoins} joins by bot accounts, dropped.`);
const overlapping = ANOMALIES.filter((a) => a.eventTypes.includes('member_join')).filter((a) => {
  const { to } = windowBounds(a);
  return to > since;
});
for (const a of overlapping) {
  console.log(`    ${a.start}  set aside: ${a.label}${a.status === 'unconfirmed' ? ' (cause NOT confirmed by a human)' : ''}`);
}
if (report.totals.clicks === 0 && trackedLinks === 0) {
  console.log(
    `    clicks are 0 for every code because no tracked link exists yet. A raw`,
  );
  console.log(
    `      discord.gg link is clicked off-platform where we cannot see it; only a`,
  );
  console.log(
    `      go.two.gg/<campaign> link is counted. npm run campaigns -- --add <slug>`,
  );
  console.log(`      <code> "<where>" to make one. See docs/INVITE_TRACKING.md.`);
} else if (report.totals.clicks === 0) {
  console.log(
    `    clicks are 0 despite ${trackedLinks} tracked link(s). Either the links have not`,
  );
  console.log(
    `      been posted anywhere yet, or the redirect is not reachable - check that`,
  );
  console.log(`      go.two.gg resolves and npm run redirect is up.`);
}
if (report.totals.joinsInexact > 0) {
  const marked = report.rows.filter(soft);
  console.log(
    `    ${report.totals.joinsInexact} of ${report.totals.joins} joins were placed on a code, not observed on it (marked ~).`,
  );
  console.log(
    `      They landed in a capture window where several codes moved at once. The`,
  );
  console.log(
    `      counters said exactly how many joins each code produced and the member`,
  );
  console.log(
    `      list agreed on the total, so the JOINS COLUMN IS EXACT for those codes -`,
  );
  console.log(
    `      that is the number the campaign is asking for, and it can be quoted.`,
  );
  console.log(
    `      What Discord does not record is WHICH member used which code, so on a`,
  );
  console.log(
    `      marked row the AM7 and AM30 cells describe a set of people who may not`,
  );
  console.log(`      all be that code's. Do not quote those as hard.`);
  console.log(
    `      Marked: ${marked.map((r) => `${r.label} (${r.joinsInexact}/${r.joins})`).join(', ')}.`,
  );
  console.log(
    `      Shorter capture windows shrink this: one code moving per window is exact`,
  );
  console.log(`      end to end. Running capture more often is the only lever (TWO-11).`);
}
// The text half of AM7 is exact for anyone with a third_message on file
// (TWO-95). Anyone without one is still admitted by the looser "posted at all"
// proxy, so the total is an upper bound by exactly that many members - and
// unlike before, that residual is fixable rather than structural.
if (report.usedMessageProxy) {
  const exact = report.totals.am7Voice + report.totals.am7Messages;
  console.log(
    `    AM7 IS AN UPPER BOUND BY ${report.totals.am7MessageProxy}. ${report.totals.am7MessageProxy} of the ${report.totals.am7} AM7 members have no third message`,
  );
  console.log(
    `      on file, so they are admitted by the looser "posted at all" proxy rather`,
  );
  console.log(
    `      than the agreed 3+ bar. The true AM7 is between ${exact} and ${report.totals.am7}.`,
  );
  console.log(
    `      Exact so far: ${report.totals.am7Voice} on voice, ${report.totals.am7Messages} on a third message we have recorded.`,
  );
  console.log(
    `      THIS IS FIXABLE, AND IT IS ONE COMMAND: npm run backfill:messages reads the`,
  );
  console.log(
    `      channels and records each member's first three posts. Run it, then re-run`,
  );
  console.log(`      this report, and the residual above drops to what is genuinely 1-2 posts.`);
} else if (report.totals.am7 > 0) {
  // Worth saying out loud rather than leaving as an absent warning: the number
  // above changed status, and whoever quotes it should know it is quotable.
  console.log(
    `    AM7 is EXACT - no member was admitted by the old "posted at all" proxy.`,
  );
  console.log(
    `      ${report.totals.am7Voice} qualified on voice, ${report.totals.am7Messages} on 3+ messages inside their first 7 days.`,
  );
}
if (report.totals.am30 > 0) {
  console.log(
    `    Of the ${report.totals.am30} AM30 members, ${report.totals.am30ProvenInWindow} were last seen between day 8 and day 30 - no`,
  );
  console.log(
    `      inference at all. The other ${report.totals.am30ProvenLater} were last seen after day 30, so they are`,
  );
  console.log(
    `      certainly returning members, but we store last-seen rather than every`,
  );
  console.log(`      session, so days 8-30 themselves are not observable for them.`);
}
const attributed = report.rows
  .filter((r) => r.source.startsWith('invite:') || r.source === 'vanity')
  .reduce((n, r) => n + r.joins, 0);
if (attributed < report.totals.joins) {
  console.log(
    `    ${report.totals.joins - attributed} of ${report.totals.joins} joins carry no invite code. Everything before the first`,
  );
  console.log(
    `      capture run was reconstructed from the server's log channels, which record`,
  );
  console.log(
    `      that somebody joined but not how. Attribution starts at the first capture.`,
  );
}
console.log('');
