/**
 * The crude-but-accurate funnel report. Run it any time:
 *
 *   node scripts/funnel.ts            # last 7 days
 *   node scripts/funnel.ts 30         # last 30 days
 *
 * This is the stopgap until the dashboard exists. It reads the same numbers
 * the dashboard will read, so if this is wrong the dashboard would be too.
 */
import { openDb } from '../src/store/db.ts';
import { ANOMALIES, detectSpikes, excludeClause } from '../src/analytics/anomalies.ts';
import { findBlindWindows } from '../src/core/voiceSessions.ts';
import {
  countDowntimeUnknownJoins,
  renderDowntimeReport,
  summarizeAttributionSplit,
  totalDowntimeUnknown,
} from '../src/core/inviteTracker.ts';

const days = Number(process.argv[2] ?? 7);
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('funnel: TWO_DATABASE_URL is not set.');
  process.exit(1);
}
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const db = await openDb(databaseUrl);

const one = async (sql: string, ...p: unknown[]) =>
  Number((await db.prepare(sql).get<{ n: number }>(...p))?.n ?? 0);

// Anomaly windows (bot raids, prunes) are reported on their own lines instead
// of averaged into the community's numbers. See src/analytics/anomalies.ts.
const joinExcl = excludeClause('member_join');
const joinsAll = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='member_join' AND occurred_at >= ?`, since);
const joins = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='member_join' AND occurred_at >= ?${joinExcl.sql}`,
  since,
  ...joinExcl.params,
);
const joinsSetAside = joinsAll - joins;
const clicks = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='invite_click' AND occurred_at >= ?`, since);
// Counted over the same window as joins, and by DISTINCT member because a
// rejoin is re-screened and clears the gate again - which would otherwise push
// conversion over 100% for no interesting reason.
const gateCleared = await one(
  `SELECT COUNT(DISTINCT member_id) AS n FROM events
    WHERE event_type='gate_cleared' AND occurred_at >= ?`,
  since,
);
// PEOPLE on both sides of this one. Every other rate on this report divides by
// `joins`, which counts join *events* - a rejoiner is in it twice. That is
// harmless for lines that only ever drift downwards, but here it silently
// understates the headline: 8 of 9 people is 89%, and dividing by 10 events
// prints 80%. The gate question is "of the people who arrived, how many got
// in", so both sides count people.
const joiners = await one(
  `SELECT COUNT(DISTINCT member_id) AS n FROM events
    WHERE event_type='member_join' AND occurred_at >= ?${joinExcl.sql}`,
  since,
  ...joinExcl.params,
);
// All-time, not windowed: these people are standing at the door right now
// regardless of when they arrived, which is what makes it an action list.
//
// Guarded on having observed the gate at all. Before the first clearing is
// recorded, EVERY member has a null gate_cleared_at and this query would
// report the whole server as stuck - a confident number that is pure absence
// of data, which is worse than no line.
const gateEverObserved = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='gate_cleared'`,
);
const stuckAtGate = gateEverObserved
  ? await one(
      `SELECT COUNT(*) AS n FROM members
        WHERE NOT is_bot AND left_at IS NULL AND joined_at IS NOT NULL
          AND gate_cleared_at IS NULL`,
    )
  : 0;
const firstMsg = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='first_message' AND occurred_at >= ?`, since);
const firstVoice = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='first_voice_session' AND occurred_at >= ?`, since);
const leavesAll = await one(`SELECT COUNT(*) AS n FROM events WHERE event_type='member_leave' AND occurred_at >= ?`, since);
const leaveExcl = excludeClause('member_leave');
const leaves = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='member_leave' AND occurred_at >= ?${leaveExcl.sql}`,
  since,
  ...leaveExcl.params,
);
const leavesSetAside = leavesAll - leaves;

const pct = (a: number, b: number) => (b === 0 ? '  n/a' : `${((a / b) * 100).toFixed(0).padStart(4)}%`);

// Clicks only exist for invites posted as a go.two.gg link (TOG-116). A raw
// discord.gg link is clicked off-platform where nothing can observe it, so it
// produces joins with no clicks in front of them. Which case a zero is matters:
// "no tracked link exists" and "the link is live and nobody clicked" are
// opposite problems with opposite fixes.
const trackedLinks = await one(`SELECT COUNT(*) AS n FROM invite_campaigns`).catch(() => 0);

console.log(`\nTWO funnel - last ${days} days (since ${since.slice(0, 10)})\n`);
console.log(
  `  invite clicks        ${String(clicks).padStart(6)}` +
    (trackedLinks === 0 ? '   (no tracked links yet - see npm run campaigns)' : ''),
);
console.log(`  joins                ${String(joins).padStart(6)}   ${pct(joins, clicks)} of clicks`);
if (clicks > 0 && joins > clicks) {
  // Over 100% is expected while some invites are tracked and some are raw.
  // Stated, because otherwise it reads as a bug in the report.
  console.log(`                                 (>100%: some invites are posted as raw discord.gg links)`);
}
if (joinsSetAside > 0) {
  console.log(`   +${String(joinsSetAside).padStart(5)} set aside as a one-off event, see below`);
}
// The rules gate sits between joining and doing anything at all (TOG-76), so
// it goes here, directly under joins and above every stage it gates. A member
// who never cleared it is a guaranteed zero on every line below this one.
console.log(
  `  cleared rules gate   ${String(gateCleared).padStart(6)}   ${pct(gateCleared, joiners)} of joiners` +
    (gateCleared === 0 && joiners > 0
      ? '   (no clearing recorded - run npm run backfill)'
      : ''),
);
if (stuckAtGate > 0) {
  console.log(
    `   ${String(stuckAtGate).padStart(5)} in the server right now, never accepted the rules`,
  );
}
console.log(`  posted first message ${String(firstMsg).padStart(6)}   ${pct(firstMsg, joins)} of joins`);
console.log(`  first voice session  ${String(firstVoice).padStart(6)}   ${pct(firstVoice, joins)} of joins`);
console.log(`  left                 ${String(leaves).padStart(6)}`);
if (leavesSetAside > 0) {
  console.log(`   +${String(leavesSetAside).padStart(5)} set aside as a one-off event, see below`);
}

console.log(`\n  Where joins came from:`);
const bySource = await db
  .prepare(
    `SELECT source, COUNT(*) AS n FROM events
      WHERE event_type='member_join' AND occurred_at >= ?${joinExcl.sql}
      GROUP BY source ORDER BY n DESC LIMIT 15`,
  )
  .all<{ source: string; n: number }>(since, ...joinExcl.params);
if (bySource.length === 0) console.log('    (no joins yet)');
for (const r of bySource) console.log(`    ${String(r.n).padStart(5)}  ${r.source}`);
// Ambiguous (several invites grew at once) and unknown (nothing grew, no
// vanity URL) are different facts with different fixes (TOG-5681, EVENTS.md),
// so they get their own lines rather than disappearing into the table above.
const { ambiguous, unknown } = summarizeAttributionSplit(
  bySource.map((r) => ({ source: r.source, n: Number(r.n) })),
);
console.log(
  `    ${String(ambiguous).padStart(5)}  ambiguous (several invites grew at once)`,
);
console.log(
  `    ${String(unknown).padStart(5)}  unknown (no invite grew, no vanity URL)`,
);

// --- join-downtime unknown attribution (TOG-5719) ---------------------------
//
// EVENTS.md limit 3: joins that happen while the bot is down are attributed
// `unknown` with no accounting. This names each bot-down window - a gap in
// the bot's own append-only write series (`events.recorded_at`: every row is
// proof the bot was alive to write it, cf. scripts/voice-sessions.ts
// TOG-5683) - and counts the `unknown` joins whose Discord timestamp
// (`occurred_at`) falls inside each window. A count, never a
// re-attribution: the rows stay `unknown`, and this says how many of them
// the outage explains. An upper bound, not a proof - a quiet stretch with
// no writes reads as a gap - and the report says so.
//
// Window detection is the shared `findBlindWindows`; the join side lives in
// src/core/inviteTracker.ts so the reviewer verifies one gap function.
const writeSeries = await db
  .prepare(
    `SELECT recorded_at AS at FROM events
      WHERE occurred_at >= ?
      ORDER BY recorded_at`,
  )
  .all<{ at: string }>(since)
  .catch(() => [] as Array<{ at: string }>);
const downtimeCounts = countDowntimeUnknownJoins(
  findBlindWindows(writeSeries.map((r) => r.at)),
  (
    await db
      .prepare(
        `SELECT occurred_at, source FROM events
          WHERE event_type = 'member_join' AND occurred_at >= ?${joinExcl.sql}
            AND source = 'unknown'`,
      )
      .all<{ occurred_at: string; source: string }>(since, ...joinExcl.params)
      .catch(() => [] as Array<{ occurred_at: string; source: string }>)
  ).map((r) => ({ occurredAt: r.occurred_at, source: r.source })),
);
const downtimeUnknown = totalDowntimeUnknown(downtimeCounts);
console.log(`\n  Join downtime (EVENTS.md limit 3 - unknown joins the outage explains):`);
for (const line of renderDowntimeReport(downtimeCounts)) console.log(line);
if (downtimeCounts.length > 0) {
  console.log(
    `    ${String(downtimeUnknown).padStart(5)} of ${unknown} unknown in-window ` +
      `(upper bound - a quiet stretch with no writes reads as a gap)`,
  );
}

// Clicks per tracked link, next to the joins that link's invite code produced.
// This is the per-place breakdown TOG-116 exists for: it is what separates "a
// listing nobody reads" from "a listing plenty of people read and bounce off".
if (trackedLinks > 0) {
  console.log(`\n  Tracked links (clicks -> joins on the same invite code):`);
  const perCampaign = await db
    .prepare(
      `SELECT c.slug, c.label, c.invite_code, c.disabled_at,
              (SELECT COUNT(*) FROM events e
                 WHERE e.event_type='invite_click' AND e.occurred_at >= ?
                   AND e.source = 'invite:' || c.invite_code) AS clicks,
              (SELECT COUNT(*) FROM events e
                 WHERE e.event_type='member_join' AND e.occurred_at >= ?
                   AND e.source = 'invite:' || c.invite_code) AS joins
         FROM invite_campaigns c
        ORDER BY clicks DESC, c.slug`,
    )
    .all<{
      slug: string;
      label: string;
      invite_code: string;
      disabled_at: string | null;
      clicks: number;
      joins: number;
    }>(since, since);
  const w = Math.max(...perCampaign.map((c) => c.slug.length), 4);
  for (const c of perCampaign) {
    const n = Number(c.clicks);
    const j = Number(c.joins);
    console.log(
      `    ${c.slug.padEnd(w)}  ${String(n).padStart(5)} clicks  ${String(j).padStart(4)} joins  ` +
        `${pct(j, n)}  ${c.label}${c.disabled_at ? '  (retired)' : ''}`,
    );
  }
  // Two campaigns on one invite code cannot be told apart by joins - a join
  // only ever carries the code. Say so rather than print the same join count
  // on two lines as if each had earned it.
  const shared = new Map<string, string[]>();
  for (const c of perCampaign) {
    const arr = shared.get(c.invite_code);
    if (arr) arr.push(c.slug);
    else shared.set(c.invite_code, [c.slug]);
  }
  for (const [code, slugs] of shared) {
    if (slugs.length > 1) {
      console.log(
        `    note: ${slugs.join(', ')} share invite code ${code}, so the join counts above ` +
          `repeat one number. Give each its own code to split them.`,
      );
    }
  }
}

// Retention: of members who joined N days ago, how many were still active later?
// The same windows are excluded here. 1,015 raid accounts that never posted
// would otherwise sit in every denominator and read as catastrophic retention.
const cohortExcl = excludeClause('member_join').sql.replaceAll('occurred_at', 'joined_at');
const cohortParams = excludeClause('member_join').params;
console.log(`\n  Retention (of members who joined in the window):`);
// "Still around d days after joining". Postgres stores these as timestamptz,
// so subtract them directly and convert the interval to days.
const daysAlive = `EXTRACT(EPOCH FROM (last_active_at - joined_at)) / 86400`;

for (const d of [1, 7, 30]) {
  const until = new Date(Date.now() - d * 86_400_000).toISOString();
  const cohort = await one(
    `SELECT COUNT(*) AS n FROM members
      WHERE joined_at >= ? AND joined_at <= ? AND NOT is_bot${cohortExcl}`,
    since,
    until,
    ...cohortParams,
  );
  const retained = await one(
    `SELECT COUNT(*) AS n FROM members
      WHERE joined_at >= ? AND joined_at <= ? AND NOT is_bot${cohortExcl}
        AND last_active_at IS NOT NULL
        AND ${daysAlive} >= ?`,
    since,
    until,
    ...cohortParams,
    d,
  );
  console.log(
    `    D${String(d).padEnd(2)}  ${String(retained).padStart(4)} / ${String(cohort).padEnd(4)}  ${pct(retained, cohort)}`,
  );
}

const never = await one(
  `SELECT COUNT(*) AS n FROM members
    WHERE joined_at IS NOT NULL AND first_message_at IS NULL AND first_voice_at IS NULL
      AND left_at IS NULL AND NOT is_bot${cohortExcl}`,
  ...cohortParams,
);
// Raid accounts that were never cleaned up still count towards the member
// total Discord shows, so they are named rather than quietly dropped.
const strandedRaid = await one(
  `SELECT COUNT(*) AS n FROM members
    WHERE NOT is_bot AND left_at IS NULL AND first_message_at IS NULL
      AND first_voice_at IS NULL AND NOT (1=1${cohortExcl})`,
  ...cohortParams,
);
console.log(`\n  Joined but never posted (all time, still in server): ${never}`);
if (strandedRaid > 0) {
  console.log(`  Raid accounts never cleaned up, still in the member count: ${strandedRaid}`);
}
console.log(`  Total events on file: ${await one(`SELECT COUNT(*) AS n FROM events`)}\n`);

// Days that are not community behaviour. Bucketing happens in JS so the query
// stays in one tested code path - a few thousand timestamps is nothing.
for (const type of ['member_leave', 'member_join'] as const) {
  const rows = await db
    .prepare(`SELECT occurred_at FROM events WHERE event_type=? AND occurred_at >= ?`)
    .all<{ occurred_at: string }>(type, since);
  const spikes = detectSpikes(
    rows.map((r) => r.occurred_at),
    type,
  );
  if (spikes.length === 0) continue;
  const noun = type === 'member_leave' ? 'leaves' : 'joins';
  console.log(`  Unusual days (${noun}):`);
  for (const s of spikes) {
    const known = ANOMALIES.find(
      (a) => a.eventTypes.includes(type) && s.day >= a.start && s.day <= a.end,
    );
    const how = `${s.count} in one day, ${s.factor.toFixed(0)}x a normal day`;
    if (!known) {
      console.log(`    ${s.day}  ${how}  -- UNLABELLED, still counted above`);
    } else if (known.status === 'unconfirmed') {
      console.log(`    ${s.day}  ${how}  -- set aside, cause NOT confirmed by a human`);
    } else {
      console.log(`    ${s.day}  ${how}  -- set aside: ${known.label}`);
    }
  }
  console.log('');
}

await db.close();
