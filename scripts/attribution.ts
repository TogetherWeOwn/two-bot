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
 */
import { openDb } from '../src/store/db.ts';
import { ANOMALIES, excludeClause, windowBounds } from '../src/analytics/anomalies.ts';
import { collapseCrossSourceDuplicates } from '../src/backfill/dedupe.ts';
import { rollUp, rate, type JoinRecord, type AttributionRow } from '../src/analytics/attribution.ts';

const argv = process.argv.slice(2);
const csv = argv.includes('--csv');
const windowArg = argv.find((a) => !a.startsWith('--')) ?? '90';
const allTime = windowArg === 'all';
const days = allTime ? null : Number(windowArg);
if (!allTime && (!Number.isFinite(days!) || days! <= 0)) {
  console.error(`Bad window "${windowArg}". Use a number of days or "all".`);
  process.exit(2);
}

// Same resolution the bot and the funnel report use, so this always reads the
// bot's database and never a stale local file.
const dbSpec = process.env.TWO_DATABASE_URL || process.env.TWO_DB_PATH || './data/two.db';
const nowMs = Date.now();
const since = allTime ? '0000-01-01T00:00:00.000Z' : new Date(nowMs - days! * 86_400_000).toISOString();
const db = await openDb(dbSpec);

// --- joins -------------------------------------------------------------------

const joinExcl = excludeClause('member_join');
const joinEvents = await db
  .prepare(
    `SELECT member_id, occurred_at, source FROM events
      WHERE event_type='member_join' AND member_id IS NOT NULL AND occurred_at >= ?${joinExcl.sql}
      ORDER BY occurred_at`,
  )
  .all<{ member_id: string; occurred_at: string; source: string }>(since, ...joinExcl.params);

const { kept, collapsed } = collapseCrossSourceDuplicates(
  joinEvents.map((e) => ({
    eventType: 'member_join',
    memberId: e.member_id,
    occurredAt: e.occurred_at,
    source: e.source,
  })),
);

// --- what each of those members did afterwards -------------------------------

// One read of the projection, indexed in memory. The alternative is a join
// against a set of ids that changes shape with the window, and this table is
// under two thousand rows.
const memberRows = await db
  .prepare(
    `SELECT member_id, first_message_at, first_voice_at, last_active_at, left_at, is_bot
       FROM members`,
  )
  .all<{
    member_id: string;
    first_message_at: string | null;
    first_voice_at: string | null;
    last_active_at: string | null;
    left_at: string | null;
    is_bot: number;
  }>();
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
    // We do not record per-member message counts yet, so the AM7 text branch
    // falls back to first_message_at. src/analytics/attribution.ts explains
    // exactly what that costs, and the report prints it below.
    thirdMessageAt: null,
    lastActiveAt: m?.last_active_at ?? null,
    leftAt: m?.left_at ?? null,
  });
}

// --- clicks ------------------------------------------------------------------

// invite_click is only ever emitted by the live bot (src/core/handlers.ts), so
// this is zero until TWO-11 lands a host. Kept in the query rather than
// hardcoded to 0 so the column starts working the day it does.
const clickRows = await db
  .prepare(
    `SELECT source, COUNT(*) AS n FROM events
      WHERE event_type='invite_click' AND occurred_at >= ? GROUP BY source`,
  )
  .all<{ source: string; n: number }>(since);
const clicksBySource = new Map(clickRows.map((r) => [r.source, Number(r.n)]));

// --- every live code, including the ones producing nothing -------------------

const codes = await db
  .prepare(`SELECT code, uses, channel_id, updated_at FROM invite_snapshots ORDER BY code`)
  .all<{ code: string; uses: number; channel_id: string | null; updated_at: string }>();
const alwaysShow = codes.map((c) => `invite:${c.code}`);

// --- the community denominator, computed not assumed -------------------------

const memberExcl = excludeClause('member_join', ANOMALIES, 'joined_at');
const realMembers = Number(
  (
    await db
      .prepare(
        `SELECT COUNT(*) AS n FROM members
          WHERE is_bot = 0 AND left_at IS NULL${memberExcl.sql}`,
      )
      .get<{ n: number }>(...memberExcl.params)
  )?.n ?? 0,
);
const discordMembers = Number(
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM members WHERE is_bot = 0 AND left_at IS NULL`)
      .get<{ n: number }>()
  )?.n ?? 0,
);

const report = rollUp(records, { nowMs, clicksBySource, alwaysShow });
await db.close();

// --- output ------------------------------------------------------------------

if (csv) {
  console.log(
    'source,clicks,joins,am7,am7_eligible,am7_voice,am7_message_proxy,am30,am30_eligible,am30_proven_in_window,am30_proven_later',
  );
  const line = (r: AttributionRow) =>
    [
      r.source,
      r.clicks,
      r.joins,
      r.am7,
      r.am7Eligible,
      r.am7Voice,
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
// Wide enough for the longest backfill source string, so no row shifts out of
// its column. A misaligned table is a table people misread.
const w = Math.max(22, ...report.rows.map((r) => r.label.length)) + 2;
console.log(`\nTWO growth attribution - ${label}`);
console.log(
  `since ${allTime ? 'the beginning' : since.slice(0, 10)}, as of ${new Date(nowMs).toISOString().slice(0, 16)}Z\n`,
);
console.log(
  `  ${'invite code / source'.padEnd(w)}${'clicks'.padStart(7)}${'joins'.padStart(7)}` +
    `      ${'AM7 / matured'.padEnd(20)}   ${'AM30 / matured AM7'}`,
);
console.log(`  ${'-'.repeat(w + 14 + 46)}`);

const line = (r: AttributionRow, name: string) =>
  `  ${name.padEnd(w)}${String(r.clicks).padStart(7)}${String(r.joins).padStart(7)}` +
  `      ${rate(r.am7, r.am7Eligible)}   ${rate(r.am30, r.am30Eligible)}`;

for (const r of report.rows) console.log(line(r, r.label));
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
console.log(`    AM30      was AM7, still in the server, and active again afterwards.`);

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
if (report.totals.clicks === 0) {
  console.log(
    `    clicks are 0 for every code and will stay 0: invite_click is emitted by the`,
  );
  console.log(
    `      live bot only (TWO-11, no host yet), and a raw discord.gg link is clicked`,
  );
  console.log(`      off-platform where we cannot see it. It needs a redirect we control.`);
}
if (report.usedMessageProxy) {
  console.log(
    `    AM7 is an UPPER BOUND. We do not store per-member message counts, so the`,
  );
  console.log(
    `      text half of AM7 currently admits anyone who posted at all, not 3+.`,
  );
  console.log(
    `      ${report.totals.am7Voice} of the ${report.totals.am7} AM7 members qualified on voice alone - that number is exact.`,
  );
  console.log(
    `      ${report.totals.am7MessageProxy} rest on the proxy, so the true AM7 is between ${report.totals.am7Voice} and ${report.totals.am7}.`,
  );
}
if (report.totals.am30 > 0) {
  console.log(
    `    Of the ${report.totals.am30} AM30 members, ${report.totals.am30ProvenInWindow} are provably active again inside the 30-day`,
  );
  console.log(
    `      window. The other ${report.totals.am30ProvenLater} are still here and demonstrably active again, but we`,
  );
  console.log(
    `      store last-seen rather than every session, so we can only prove it later.`,
  );
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
