/**
 * The crude-but-accurate funnel report. Run it any time:
 *
 *   node scripts/funnel.ts            # last 7 days
 *   node scripts/funnel.ts 30         # last 30 days
 *   node scripts/funnel.ts --json     # one JSON object, same numbers (TOG-5691)
 *
 * This is the stopgap until the dashboard exists. It reads the same numbers
 * the dashboard will read, so if this is wrong the dashboard would be too.
 *
 * --json prints a single JSON object (schema 1) built from the same collected
 * report the text renderer prints, so the dashboard stopgap can quote numbers
 * a human reproduces from the text report. test/e2e.funnel-json.test.ts pins
 * the two renderers together: one fixture, one run of each renderer.
 *
 * Scoped to one guild (TOG-8738): every collect query below carries a
 * `guild_id = ?` predicate bound to DISCORD_GUILD_ID, so a database holding
 * several guilds reports only this server's numbers. The one exception is
 * `invite_campaigns`, which has no guild column (migrations/0006) - its two
 * reads are marked exempt where they appear, and the per-campaign event
 * subselects are still guild-scoped.
 */
import { openDb } from '../src/store/db.ts';
import { ANOMALIES, detectSpikes, excludeClause } from '../src/analytics/anomalies.ts';
import {
  findBlindWindows,
  parseVoiceEndMetadata,
  summarizeVoiceDurations,
} from '../src/core/voiceSessions.ts';
import {
  countDowntimeUnknownJoins,
  summarizeAttributionSplit,
  totalDowntimeUnknown,
} from '../src/core/inviteTracker.ts';
import { formatFunnelText } from '../src/analytics/cliFormat.ts';
import { buildFunnelReport } from '../src/analytics/funnelReport.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/funnel.ts [days] [--json]');
  process.exit(0);
}

const rawArgs = process.argv.slice(2);
const asJson = rawArgs.includes('--json');
const daysRaw = rawArgs.find((a) => !a.startsWith('-')) ?? '7';
const days = Number(daysRaw);
if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
  console.error(`Bad day count "${daysRaw}". Use a positive number of days, e.g. 7.`);
  process.exit(2);
}
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim() ?? '';
if (!databaseUrl) {
  console.error('funnel: TWO_DATABASE_URL is not set.');
  process.exit(1);
}
if (!guildId) {
  console.error('DISCORD_GUILD_ID is not set - there is no server to report on.');
  process.exit(1);
}
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const db = await openDb(databaseUrl);

const one = async (sql: string, ...p: unknown[]) =>
  Number((await db.prepare(sql).get<{ n: number }>(...p))?.n ?? 0);

// --- collect: one report object both renderers read ------------------------
//
// Anomaly windows (bot raids, prunes) are reported on their own lines instead
// of averaged into the community's numbers. See src/analytics/anomalies.ts.
const joinExcl = excludeClause('member_join');
const joinsAll = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='member_join' AND guild_id = ? AND occurred_at >= ?`,
  guildId,
  since,
);
const joins = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='member_join' AND guild_id = ? AND occurred_at >= ?${joinExcl.sql}`,
  guildId,
  since,
  ...joinExcl.params,
);
const joinsSetAside = joinsAll - joins;
const clicks = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='invite_click' AND guild_id = ? AND occurred_at >= ?`,
  guildId,
  since,
);
// Counted over the same window as joins, and by DISTINCT member because a
// rejoin is re-screened and clears the gate again - which would otherwise push
// conversion over 100% for no interesting reason.
const gateCleared = await one(
  `SELECT COUNT(DISTINCT member_id) AS n FROM events
    WHERE event_type='gate_cleared' AND guild_id = ? AND occurred_at >= ?`,
  guildId,
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
    WHERE event_type='member_join' AND guild_id = ? AND occurred_at >= ?${joinExcl.sql}`,
  guildId,
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
  `SELECT COUNT(*) AS n FROM events WHERE event_type='gate_cleared' AND guild_id = ?`,
  guildId,
);
const stuckAtGate = gateEverObserved
  ? await one(
      `SELECT COUNT(*) AS n FROM members
        WHERE guild_id = ? AND NOT is_bot AND left_at IS NULL AND joined_at IS NOT NULL
          AND gate_cleared_at IS NULL`,
      guildId,
    )
  : 0;
const firstMsg = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='first_message' AND guild_id = ? AND occurred_at >= ?`,
  guildId,
  since,
);
const firstVoice = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='first_voice_session' AND guild_id = ? AND occurred_at >= ?`,
  guildId,
  since,
);
const leavesAll = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='member_leave' AND guild_id = ? AND occurred_at >= ?`,
  guildId,
  since,
);
const leaveExcl = excludeClause('member_leave');
const leaves = await one(
  `SELECT COUNT(*) AS n FROM events WHERE event_type='member_leave' AND guild_id = ? AND occurred_at >= ?${leaveExcl.sql}`,
  guildId,
  since,
  ...leaveExcl.params,
);
const leavesSetAside = leavesAll - leaves;

// Average voice session length, over known-start sessions only (TOG-5684).
// `startKnown: false` ends carry no measured start, so they are counted in
// the voice-sessions reconcile and excluded here via the shared helper.
const voiceDurationSummary = summarizeVoiceDurations(
  (
    await db
      .prepare(
        `SELECT metadata FROM events
          WHERE event_type = 'voice_session_end' AND guild_id = ? AND occurred_at >= ?`,
      )
      .all<{ metadata: string | null }>(guildId, since)
      .catch(() => [] as Array<{ metadata: string | null }>)
  ).map((r) => parseVoiceEndMetadata(r.metadata)),
);

// Clicks only exist for invites posted as a go.two.gg link (TOG-116). A raw
// discord.gg link is clicked off-platform where nothing can observe it, so it
// produces joins with no clicks in front of them. Which case a zero is matters:
// "no tracked link exists" and "the link is live and nobody clicked" are
// opposite problems with opposite fixes.
//
// EXEMPT from guild scoping: invite_campaigns has no guild column
// (migrations/0006) - campaigns are server-global config, so this count is
// the table size by construction.
const trackedLinks = await one(`SELECT COUNT(*) AS n FROM invite_campaigns`).catch(() => 0);

const sourceRows = await db
  .prepare(
    `SELECT source, COUNT(*) AS n FROM events
      WHERE event_type='member_join' AND guild_id = ? AND occurred_at >= ?${joinExcl.sql}
      GROUP BY source ORDER BY n DESC`,
  )
  .all<{ source: string; n: number }>(guildId, since, ...joinExcl.params);
// Ambiguous (several invites grew at once) and unknown (nothing grew, no
// vanity URL) are different facts with different fixes (TOG-5681, EVENTS.md),
// so they get their own lines rather than disappearing into the table above.
// Quality totals cover every source; only the displayed table is capped.
const { ambiguous, unknown } = summarizeAttributionSplit(sourceRows);
const bySource = sourceRows.slice(0, 15).map((r) => ({ source: r.source, joins: Number(r.n) }));

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
      WHERE guild_id = ? AND occurred_at >= ?
      ORDER BY recorded_at`,
  )
  .all<{ at: string }>(guildId, since)
  .catch(() => [] as Array<{ at: string }>);
const downtimeCounts = countDowntimeUnknownJoins(
  findBlindWindows(writeSeries.map((r) => r.at)),
  (
    await db
      .prepare(
        `SELECT occurred_at, source FROM events
          WHERE event_type = 'member_join' AND guild_id = ? AND occurred_at >= ?${joinExcl.sql}
            AND source = 'unknown'`,
      )
      .all<{ occurred_at: string; source: string }>(guildId, since, ...joinExcl.params)
      .catch(() => [] as Array<{ occurred_at: string; source: string }>)
  ).map((r) => ({ occurredAt: r.occurred_at, source: r.source })),
);
const downtimeUnknown = totalDowntimeUnknown(downtimeCounts);

// Clicks per tracked link, next to the joins that link's invite code produced.
// This is the per-place breakdown TOG-116 exists for: it is what separates "a
// listing nobody reads" from "a listing plenty of people read and bounce off".
// Both subqueries exclude the same anomaly windows as the headline counts
// (TOG-8446): without this a raid-day join on a tracked code counted in the
// campaign table while the headline set it aside, so campaign joins could
// exceed headline joins in one report.
const clickExcl = excludeClause('invite_click', ANOMALIES, 'e.occurred_at');
const joinCampExcl = excludeClause('member_join', ANOMALIES, 'e.occurred_at');
// The outer FROM invite_campaigns is EXEMPT from guild scoping (no guild
// column there, see the trackedLinks note); both event subselects below are
// guild-scoped, so per-campaign clicks/joins count this server only.
const perCampaign =
  trackedLinks > 0
    ? (
        await db
          .prepare(
            `SELECT c.slug, c.label, c.invite_code, c.disabled_at,
                    (SELECT COUNT(*) FROM events e
                       WHERE e.event_type='invite_click' AND e.guild_id = ? AND e.occurred_at >= ?${clickExcl.sql}
                         AND e.source = 'invite:' || c.invite_code) AS clicks,
                    (SELECT COUNT(*) FROM events e
                       WHERE e.event_type='member_join' AND e.guild_id = ? AND e.occurred_at >= ?${joinCampExcl.sql}
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
          }>(guildId, since, ...clickExcl.params, guildId, since, ...joinCampExcl.params)
      ).map((c) => ({
        slug: c.slug,
        label: c.label,
        inviteCode: c.invite_code,
        clicks: Number(c.clicks),
        joins: Number(c.joins),
        retired: c.disabled_at !== null,
      }))
    : [];

// Per-campaign click-spike flags (TOG-6232, follow-up to TOG-5895).
//
// TOG-5895 decided against a request-time per-campaign ceiling; the protection
// is a reporting flag instead. One `detectSpikes` pass per campaign over the
// stored `invite_click` rows - campaign slug plus server timestamps only, no
// visitor PII (`metadata` is exactly `{"campaign": "<slug>"}`, ours never the
// visitor's; see docs/PRIVACY.md, docs/INVITE_TRACKING.md). Bucketed in JS
// like the join/leave spike section below so the query stays in one tested
// code path. Reporting only: rows are never deleted, excluded, or set aside.
// Computed once here so the text and `--json` renderers read the same object.
const clickRows = await db
  .prepare(
    `SELECT occurred_at, source, metadata FROM events
      WHERE event_type='invite_click' AND guild_id = ? AND occurred_at >= ?`,
  )
  .all<{ occurred_at: string; source: string; metadata: string | null }>(guildId, since)
  .catch(() => [] as Array<{ occurred_at: string; source: string; metadata: string | null }>);
const slugForCode = new Map<string, string>();
for (const c of perCampaign) {
  // First slug wins when two campaigns share a code; the shared-code note in
  // the formatter already warns that counts repeat. Clicks carrying a metadata
  // slug still separate cleanly via the campaign key below.
  if (!slugForCode.has(c.inviteCode)) slugForCode.set(c.inviteCode, c.slug);
}
const clicksByCampaign = new Map<string, string[]>();
for (const r of clickRows) {
  let campaign: string | null = null;
  if (r.metadata) {
    try {
      const v = (JSON.parse(r.metadata) as { campaign?: unknown }).campaign;
      if (typeof v === 'string' && v.length > 0) campaign = v;
    } catch {
      // A metadata blob we cannot read is not evidence of anything.
    }
  }
  if (!campaign) {
    const code = r.source.startsWith('invite:') ? r.source.slice('invite:'.length) : null;
    campaign = (code && slugForCode.get(code)) ?? r.source;
  }
  const arr = clicksByCampaign.get(campaign);
  if (arr) arr.push(r.occurred_at);
  else clicksByCampaign.set(campaign, [r.occurred_at]);
}
const clickSpikes: Array<{ slug: string; spikes: Array<{ day: string; count: number; factor: number }> }> = [];
for (const [slug, stamps] of [...clicksByCampaign.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
  // No anomaly windows exist for clicks, so every hit is unlabelled by
  // construction - still counted above, flagged here.
  const spikes = detectSpikes(stamps, 'invite_click', { anomalies: [] });
  if (spikes.length === 0) continue;
  clickSpikes.push({
    slug,
    spikes: spikes.map((s) => ({ day: s.day, count: s.count, factor: s.factor })),
  });
}

// Retention: of members who joined N days ago, how many were still active later?
// The same windows are excluded here. 1,015 raid accounts that never posted
// would otherwise sit in every denominator and read as catastrophic retention.
const cohortExcl = excludeClause('member_join').sql.replaceAll('occurred_at', 'joined_at');
const cohortParams = excludeClause('member_join').params;
// "Still around d days after joining". Postgres stores these as timestamptz,
// so subtract them directly and convert the interval to days.
const daysAlive = `EXTRACT(EPOCH FROM (last_active_at - joined_at)) / 86400`;

const retention: Array<{ day: number; retained: number; cohort: number }> = [];
for (const d of [1, 7, 30]) {
  const until = new Date(Date.now() - d * 86_400_000).toISOString();
  const cohort = await one(
    `SELECT COUNT(*) AS n FROM members
      WHERE guild_id = ? AND joined_at >= ? AND joined_at <= ? AND NOT is_bot${cohortExcl}`,
    guildId,
    since,
    until,
    ...cohortParams,
  );
  const retained = await one(
    `SELECT COUNT(*) AS n FROM members
      WHERE guild_id = ? AND joined_at >= ? AND joined_at <= ? AND NOT is_bot${cohortExcl}
        AND last_active_at IS NOT NULL
        AND ${daysAlive} >= ?`,
    guildId,
    since,
    until,
    ...cohortParams,
    d,
  );
  retention.push({ day: d, retained, cohort });
}

const never = await one(
  `SELECT COUNT(*) AS n FROM members
    WHERE guild_id = ? AND joined_at IS NOT NULL AND first_message_at IS NULL AND first_voice_at IS NULL
      AND left_at IS NULL AND NOT is_bot${cohortExcl}`,
  guildId,
  ...cohortParams,
);
// Raid accounts that were never cleaned up still count towards the member
// total Discord shows, so they are named rather than quietly dropped.
const strandedRaid = await one(
  `SELECT COUNT(*) AS n FROM members
    WHERE guild_id = ? AND NOT is_bot AND left_at IS NULL AND first_message_at IS NULL
      AND first_voice_at IS NULL AND NOT (1=1${cohortExcl})`,
  guildId,
  ...cohortParams,
);
const totalEvents = await one(`SELECT COUNT(*) AS n FROM events WHERE guild_id = ?`, guildId);

// The --json shape lives in src/analytics/funnelReport.ts (TOG-8290) so the
// offline schema test pins the exact keys the dashboard stopgap parses. This
// file only collects rows; it never shapes the report.
// Reporting flag only (TOG-6232): per-campaign per-day click spikes. Every
// entry is unlabelled by construction (no click anomaly windows exist) and
// stays counted above - this names the day, nothing more.
const report = buildFunnelReport({
  windowDays: days,
  since,
  clicks,
  joins,
  joinsSetAside,
  gateCleared,
  joiners,
  stuckAtGate,
  firstMessage: firstMsg,
  firstVoice,
  leaves,
  leavesSetAside,
  bySource,
  ambiguous,
  unknown,
  downtime: downtimeCounts,
  downtimeUnknown,
  campaigns: perCampaign,
  clickSpikes,
  firstVoiceSessions: firstVoice,
  voice: voiceDurationSummary,
  retention,
  neverPosted: never,
  strandedRaid,
  totalEvents,
});

if (asJson) {
  // Exactly one JSON object on stdout - anything else (warnings, progress)
  // would break the dashboard stopgap's parser.
  console.log(JSON.stringify(report));
  await db.close();
} else {
  // Text layout lives in src/analytics/cliFormat.ts (TOG-5723) so fixture
  // tests cover it without a live DB. The rules gate sits between joining and
  // doing anything at all (TOG-76), directly under joins and above every
  // stage it gates - that ordering is pinned in the formatter, not here.
  console.log(
    formatFunnelText({
      days,
      since,
      clicks,
      joins,
      joinsSetAside,
      gateCleared,
      joiners,
      stuckAtGate,
      firstMessage: firstMsg,
      firstVoice,
      leaves,
      leavesSetAside,
      trackedLinks,
      bySource,
      ambiguous,
      unknown,
      downtime: downtimeCounts,
      downtimeUnknown,
      campaigns: perCampaign,
      // Known-start sessions only (TOG-5684): unknown starts carry no
      // measured duration and are excluded via the shared helper, counted in
      // `npm run voice` instead of averaged in here.
      avgSessionSeconds: voiceDurationSummary.averageSeconds,
      measuredSessions: voiceDurationSummary.measured,
      excludedUnknownStarts: voiceDurationSummary.excludedUnknownStarts,
      retention,
      neverPosted: never,
      strandedRaid,
      totalEvents,
    }),
  );

  // Days that are not community behaviour. Bucketing happens in JS so the query
  // stays in one tested code path - a few thousand timestamps is nothing.
  for (const type of ['member_leave', 'member_join'] as const) {
    const rows = await db
      .prepare(`SELECT occurred_at FROM events WHERE event_type=? AND guild_id = ? AND occurred_at >= ?`)
      .all<{ occurred_at: string }>(type, guildId, since);
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

  // Click-anomaly flags, one line per campaign (TOG-6232). Same `detectSpikes`
  // shape as the join/leave section above, bucketed per campaign from the
  // already-read click rows - no new query, no PII. Flag only: every click
  // stays counted above.
  if (clickSpikes.length > 0) {
    console.log('  Unusual days (clicks, per campaign):');
    for (const { slug, spikes } of clickSpikes) {
      for (const s of spikes) {
        console.log(
          `    ${s.day}  ${slug}: ${s.count} in one day, ${s.factor.toFixed(0)}x a normal day  -- UNLABELLED, still counted above`,
        );
      }
    }
    console.log('');
  }

  await db.close();
}
