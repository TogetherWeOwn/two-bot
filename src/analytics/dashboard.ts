/**
 * The weekly growth dashboard: every number the company steers on, in one
 * object.
 *
 * Design rules, because they are the reason this file looks the way it does:
 *
 *  1. **The database only ever gets asked for rows, never for arithmetic.**
 *     Every aggregate is computed here in JS. The whole member table is under
 *     2,000 rows and the event log under 10,000, so pulling it all is free -
 *     and it means one code path works identically on SQLite and Postgres. No
 *     `julianday()` vs `EXTRACT(EPOCH ...)` forks, no dialect bugs that only
 *     show up in production.
 *
 *  2. **Everything that shapes a number is exported and pure**, so the tests
 *     can check the arithmetic without a database. `buildDashboard` is a thin
 *     wrapper: read rows, call the pure functions.
 *
 *  3. **A number we cannot compute is `null`, never 0.** "Nobody joined" and
 *     "the cohort has not aged 30 days yet" are different answers, and a
 *     dashboard that shows 0% for the second one is lying.
 *
 * Anomaly windows (bot raids, prunes - see anomalies.ts) are excluded from the
 * headline numbers and reported on their own line, never silently dropped.
 */
import type { Db } from '../store/db.ts';
import { ANOMALIES, isExcluded, type Anomaly } from './anomalies.ts';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One member, as the dashboard needs them. Mirrors the `members` table. */
export interface MemberRow {
  member_id: string;
  joined_at: string | null;
  join_source: string | null;
  first_message_at: string | null;
  first_voice_at: string | null;
  last_active_at: string | null;
  left_at: string | null;
}

export interface SourceCount {
  /** The raw `source` string as recorded. */
  source: string;
  /** What a human should read. See `labelSource`. */
  label: string;
  /** True when this bucket is "we do not know", not a real channel. */
  unattributed: boolean;
  joins: number;
}

export interface WeekRow {
  /** Monday of the week, `YYYY-MM-DD` UTC. */
  weekStart: string;
  /** Joins that count. */
  joins: number;
  /** Joins inside a known anomaly window - reported, never averaged in. */
  setAside: number;
  leaves: number;
  /** joins - leaves, on the counted numbers only. */
  net: number;
  bySource: SourceCount[];
}

/**
 * One retention measurement. `eligible` is the honest denominator: members
 * whose Nth day has actually happened. Everything else is null until it has.
 */
export interface RetentionCell {
  eligible: number;
  /** Still in the server N days after joining. */
  stayed: number;
  /** Recorded as active (posted or spoke) on or after their Nth day. */
  active: number;
}

export interface CohortRow {
  weekStart: string;
  /** Non-bot, non-anomaly joins in this week. */
  size: number;
  d1: RetentionCell | null;
  d7: RetentionCell | null;
  d30: RetentionCell | null;
}

export interface ChannelRow {
  channelId: string;
  name: string;
  category: string | null;
  /** From the server audit snapshot. Null when we have no snapshot. */
  humanMsgs30d: number | null;
  humanMsgs90d: number | null;
  uniqueHumans30d: number | null;
  lastMessageAt: string | null;
  daysSilent: number | null;
  /** Funnel events attributed to this channel in the window. Always known. */
  events30d: number;
  /** alive | quiet | silent - see `channelState`. */
  state: 'alive' | 'quiet' | 'silent';
}

export interface DashboardData {
  generatedAt: string;
  guildId: string | null;
  /** Window the "this week" numbers cover: [weekStart, generatedAt). */
  thisWeek: { start: string; joins: number; leaves: number; net: number };
  lastWeek: { start: string; joins: number; leaves: number; net: number };
  /** Members with a recorded message or voice session in the last 7 / 30 days. */
  active7d: number;
  active30d: number;
  /** Non-bot members who have not left. */
  humansInServer: number;
  /** Of those, accounts that arrived in a known raid window. */
  raidAccountsStillCounted: number;
  /** humansInServer - raidAccountsStillCounted. */
  realHumans: number;
  /** Joined, never posted, never spoke, still here. */
  joinedNeverSpoke: number;
  weeks: WeekRow[];
  cohorts: CohortRow[];
  /** All-time roll-up of the cohort table, for the headline retention numbers. */
  retentionOverall: { d1: RetentionCell | null; d7: RetentionCell | null; d30: RetentionCell | null };
  sourcesAllTime: SourceCount[];
  channels: ChannelRow[];
  channelSnapshotAt: string | null;
  /** Honest caveats, rendered on the page. Never hidden in a comment. */
  caveats: string[];
  anomalies: Anomaly[];
}

export interface ChannelSnapshotEntry {
  id: string;
  name: string;
  parent_name?: string | null;
  human_msgs_30d?: number | null;
  human_msgs_90d?: number | null;
  unique_humans_30d?: number | null;
  last_message_at?: string | null;
  days_silent?: number | null;
}

export interface ChannelSnapshot {
  collected_at: string;
  channels: ChannelSnapshotEntry[];
}

export interface BuildOptions {
  /** Defaults to now. Injected so tests are not time-dependent. */
  now?: Date;
  /** How many weeks of history to chart. */
  weeks?: number;
  /** Output of scripts/audit-collect.ts, if we have one. */
  channelSnapshot?: ChannelSnapshot | null;
  anomalies?: Anomaly[];
}

// ---------------------------------------------------------------------------
// Pure helpers - the arithmetic the tests actually check
// ---------------------------------------------------------------------------

/** Monday 00:00 UTC of the week containing `iso`, as `YYYY-MM-DD`. */
export function weekStart(iso: string | Date): string {
  const d = new Date(typeof iso === 'string' ? iso : iso.getTime());
  const dow = d.getUTCDay(); // 0 = Sunday
  const backToMonday = (dow + 6) % 7;
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  m.setUTCDate(m.getUTCDate() - backToMonday);
  return m.toISOString().slice(0, 10);
}

/** The `count` week-start dates ending with the week containing `now`. */
export function recentWeeks(now: Date, count: number): string[] {
  const out: string[] = [];
  const cursor = new Date(`${weekStart(now)}T00:00:00.000Z`);
  for (let i = 0; i < count; i++) {
    out.unshift(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }
  return out;
}

/**
 * Turn a raw `source` into something a community operator can read, and say
 * plainly when it means "we do not know".
 *
 * Anything recorded by the backfill is unattributed by definition: Discord's
 * audit log and the join/leave log channel record *that* somebody joined, never
 * *which invite* they used. Calling that "unknown" rather than folding it into
 * a real bucket is the whole point - otherwise the biggest invite source on the
 * page is an artefact of how we imported history.
 */
export function labelSource(source: string | null): { label: string; unattributed: boolean } {
  if (!source || source === 'unknown') return { label: 'Unknown', unattributed: true };
  if (source.startsWith('backfill:')) {
    return { label: 'Before tracking (imported history)', unattributed: true };
  }
  if (source === 'vanity') return { label: 'Vanity URL', unattributed: false };
  if (source.startsWith('invite:')) return { label: `Invite ${source.slice(7)}`, unattributed: false };
  if (source.startsWith('channel:')) return { label: `Channel ${source.slice(8)}`, unattributed: false };
  return { label: source, unattributed: false };
}

/**
 * Tally joins by what a reader should see, not by the raw string.
 *
 * Grouping is by *label*, deliberately. `backfill:log:member-join` and
 * `backfill:log:join-leave-log` are two import paths for the same fact - "we do
 * not know" - and showing them as two rows invents a distinction the CEO would
 * have to learn our import plumbing to ignore. Raw sources stay on the row so
 * nothing is lost.
 */
export function countBySource(sources: (string | null)[]): SourceCount[] {
  const tally = new Map<string, { joins: number; raw: Set<string>; unattributed: boolean }>();
  for (const s of sources) {
    const raw = s ?? 'unknown';
    const { label, unattributed } = labelSource(raw);
    const cur = tally.get(label) ?? { joins: 0, raw: new Set<string>(), unattributed };
    cur.joins++;
    cur.raw.add(raw);
    tally.set(label, cur);
  }
  return [...tally.entries()]
    .map(([label, v]) => ({
      label,
      unattributed: v.unattributed,
      joins: v.joins,
      source: [...v.raw].sort().join(', '),
    }))
    .sort((a, b) => b.joins - a.joins || a.label.localeCompare(b.label));
}

/**
 * Retention for one cohort at day N.
 *
 * Two numbers, because we can measure two different things and only one of
 * them is complete:
 *
 *   stayed - they were still in the server on day N. Leaves are logged for
 *            every member, so this is exact.
 *   active - they posted or entered voice on or after day N. This is the
 *            number we actually want, and it under-reports history: message
 *            activity before the bot went live was only recoverable for
 *            members who appear in a log channel. Accurate going forward.
 *
 * Returns null when day N has not happened yet for the whole cohort - a
 * half-aged cohort is not a smaller cohort, it is an unanswerable question.
 */
export function retentionAt(members: MemberRow[], dayN: number, now: Date): RetentionCell | null {
  const eligible = members.filter((m) => {
    if (!m.joined_at) return false;
    return Date.parse(m.joined_at) + dayN * DAY_MS <= now.getTime();
  });
  if (eligible.length === 0) return null;

  let stayed = 0;
  let active = 0;
  for (const m of eligible) {
    const mark = Date.parse(m.joined_at!) + dayN * DAY_MS;
    if (!m.left_at || Date.parse(m.left_at) >= mark) stayed++;
    if (m.last_active_at && Date.parse(m.last_active_at) >= mark) active++;
  }
  return { eligible: eligible.length, stayed, active };
}

/** alive: talked this month. quiet: talked this quarter. silent: neither. */
export function channelState(row: {
  humanMsgs30d: number | null;
  humanMsgs90d: number | null;
  events30d: number;
}): 'alive' | 'quiet' | 'silent' {
  if ((row.humanMsgs30d ?? 0) > 0 || row.events30d > 0) return 'alive';
  if ((row.humanMsgs90d ?? 0) > 0) return 'quiet';
  return 'silent';
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export async function buildDashboard(db: Db, opts: BuildOptions = {}): Promise<DashboardData> {
  const now = opts.now ?? new Date();
  const weekCount = opts.weeks ?? 12;
  const anomalies = opts.anomalies ?? ANOMALIES;
  const snapshot = opts.channelSnapshot ?? null;

  // One scan of each table. See rule 1 at the top of the file.
  const members = await db
    .prepare(
      `SELECT member_id, joined_at, join_source, first_message_at, first_voice_at,
              last_active_at, left_at
         FROM members
        WHERE is_bot = 0`,
    )
    .all<MemberRow>();

  const joinEvents = await db
    .prepare(
      `SELECT member_id, occurred_at, source FROM events WHERE event_type = 'member_join'`,
    )
    .all<{ member_id: string | null; occurred_at: string; source: string }>();

  const leaveEvents = await db
    .prepare(`SELECT occurred_at FROM events WHERE event_type = 'member_leave'`)
    .all<{ occurred_at: string }>();

  const channelEvents = await db
    .prepare(
      `SELECT source, occurred_at FROM events
        WHERE source LIKE 'channel:%' AND occurred_at >= ?`,
    )
    .all<{ source: string; occurred_at: string }>(iso(now.getTime() - 30 * DAY_MS));

  const guildRow = await db
    .prepare(`SELECT guild_id FROM events ORDER BY id DESC LIMIT 1`)
    .get<{ guild_id: string }>();

  // Bots are excluded from members above; joinEvents still carries them, so
  // filter by the member set we kept.
  const humanIds = new Set(members.map((m) => m.member_id));
  const humanJoins = joinEvents.filter((e) => e.member_id && humanIds.has(e.member_id));

  // -- weekly joins / leaves ------------------------------------------------
  const wanted = recentWeeks(now, weekCount);
  const wantedSet = new Set(wanted);
  const perWeek = new Map<string, { joins: string[]; setAside: number; leaves: number }>();
  for (const w of wanted) perWeek.set(w, { joins: [], setAside: 0, leaves: 0 });

  for (const e of humanJoins) {
    const w = weekStart(e.occurred_at);
    if (!wantedSet.has(w)) continue;
    const bucket = perWeek.get(w)!;
    if (isExcluded(e.occurred_at, 'member_join', anomalies)) bucket.setAside++;
    else bucket.joins.push(e.source);
  }
  for (const e of leaveEvents) {
    const w = weekStart(e.occurred_at);
    if (!wantedSet.has(w)) continue;
    if (isExcluded(e.occurred_at, 'member_leave', anomalies)) continue;
    perWeek.get(w)!.leaves++;
  }

  const weeks: WeekRow[] = wanted.map((weekStartDate) => {
    const b = perWeek.get(weekStartDate)!;
    return {
      weekStart: weekStartDate,
      joins: b.joins.length,
      setAside: b.setAside,
      leaves: b.leaves,
      net: b.joins.length - b.leaves,
      bySource: countBySource(b.joins),
    };
  });

  const thisWeekRow = weeks[weeks.length - 1];
  const lastWeekRow = weeks[weeks.length - 2];
  const slim = (r: WeekRow | undefined) => ({
    start: r?.weekStart ?? weekStart(now),
    joins: r?.joins ?? 0,
    leaves: r?.leaves ?? 0,
    net: r?.net ?? 0,
  });

  // -- cohorts --------------------------------------------------------------
  // A member belongs to the cohort of the week they joined. Raid accounts are
  // kept out entirely: 1,015 accounts that never spoke would drag every
  // retention row on the page to near zero and none of it would be about us.
  const cohortMembers = members.filter(
    (m) => m.joined_at && !isExcluded(m.joined_at, 'member_join', anomalies),
  );
  const byCohort = new Map<string, MemberRow[]>();
  for (const m of cohortMembers) {
    const w = weekStart(m.joined_at!);
    if (!wantedSet.has(w)) continue;
    if (!byCohort.has(w)) byCohort.set(w, []);
    byCohort.get(w)!.push(m);
  }
  const cohorts: CohortRow[] = wanted.map((w) => {
    const group = byCohort.get(w) ?? [];
    return {
      weekStart: w,
      size: group.length,
      d1: retentionAt(group, 1, now),
      d7: retentionAt(group, 7, now),
      d30: retentionAt(group, 30, now),
    };
  });

  const retentionOverall = {
    d1: retentionAt(cohortMembers, 1, now),
    d7: retentionAt(cohortMembers, 7, now),
    d30: retentionAt(cohortMembers, 30, now),
  };

  // -- membership state -----------------------------------------------------
  const stillHere = members.filter((m) => !m.left_at);
  // Only join windows count here, which in practice means raids. A member who
  // survived a prune (a `member_leave` window) is a real member, and counting
  // them as an artefact would understate the community.
  const raidStillHere = stillHere.filter(
    (m) => m.joined_at && isExcluded(m.joined_at, 'member_join', anomalies),
  ).length;
  const since7 = iso(now.getTime() - 7 * DAY_MS);
  const since30 = iso(now.getTime() - 30 * DAY_MS);
  const active7d = stillHere.filter((m) => m.last_active_at && m.last_active_at >= since7).length;
  const active30d = stillHere.filter((m) => m.last_active_at && m.last_active_at >= since30).length;
  const joinedNeverSpoke = stillHere.filter(
    (m) => m.joined_at && !m.first_message_at && !m.first_voice_at,
  ).length;

  // -- channels -------------------------------------------------------------
  const eventsPerChannel = new Map<string, number>();
  for (const e of channelEvents) {
    const id = e.source.slice('channel:'.length);
    eventsPerChannel.set(id, (eventsPerChannel.get(id) ?? 0) + 1);
  }
  const channels: ChannelRow[] = [];
  const seenChannels = new Set<string>();
  for (const c of snapshot?.channels ?? []) {
    seenChannels.add(c.id);
    const row = {
      channelId: c.id,
      name: c.name,
      category: c.parent_name ?? null,
      humanMsgs30d: numOrNull(c.human_msgs_30d),
      humanMsgs90d: numOrNull(c.human_msgs_90d),
      uniqueHumans30d: numOrNull(c.unique_humans_30d),
      lastMessageAt: c.last_message_at ?? null,
      daysSilent: numOrNull(c.days_silent),
      events30d: eventsPerChannel.get(c.id) ?? 0,
    };
    channels.push({ ...row, state: channelState(row) });
  }
  // Channels we have live events for but no snapshot row (new channel, or the
  // snapshot is older than the channel). Better a bare id than a silent gap.
  for (const [id, n] of eventsPerChannel) {
    if (seenChannels.has(id)) continue;
    const row = {
      channelId: id,
      name: `#${id}`,
      category: null,
      humanMsgs30d: null,
      humanMsgs90d: null,
      uniqueHumans30d: null,
      lastMessageAt: null,
      daysSilent: null,
      events30d: n,
    };
    channels.push({ ...row, state: channelState(row) });
  }
  channels.sort(
    (a, b) =>
      (b.humanMsgs30d ?? 0) - (a.humanMsgs30d ?? 0) ||
      (b.humanMsgs90d ?? 0) - (a.humanMsgs90d ?? 0) ||
      b.events30d - a.events30d ||
      a.name.localeCompare(b.name),
  );

  // -- caveats --------------------------------------------------------------
  const caveats: string[] = [];
  const attributed = countBySource(humanJoins.map((e) => e.source)).filter((s) => !s.unattributed);
  if (attributed.length === 0) {
    caveats.push(
      'No join has an invite source yet. Every join on record was imported from ' +
        'the server log, which does not say which invite was used. Invite attribution ' +
        'starts working on the first join after the bot went live.',
    );
  }
  if (!snapshot) {
    caveats.push(
      'No channel snapshot found, so channel activity shows only funnel events. ' +
        'Run `npm run audit:collect` to get real message counts.',
    );
  } else {
    const ageDays = Math.floor((now.getTime() - Date.parse(snapshot.collected_at)) / DAY_MS);
    if (ageDays > 7) {
      caveats.push(
        `Channel message counts are ${ageDays} days old (snapshot taken ` +
          `${snapshot.collected_at.slice(0, 10)}). Re-run \`npm run audit:collect\` to refresh.`,
      );
    }
  }
  const everActive = members.filter((m) => m.first_message_at || m.first_voice_at).length;
  caveats.push(
    `Activity history is partial: of ${members.length.toLocaleString()} members on record, ` +
      `${everActive.toLocaleString()} have a message or voice session we could recover. ` +
      'Anything before the bot went live was reconstructed from log channels, so the ' +
      '"active" retention column under-reports old cohorts. It is exact from now on.',
  );

  return {
    generatedAt: now.toISOString(),
    guildId: guildRow?.guild_id ?? null,
    thisWeek: slim(thisWeekRow),
    lastWeek: slim(lastWeekRow),
    active7d,
    active30d,
    humansInServer: stillHere.length,
    raidAccountsStillCounted: raidStillHere,
    realHumans: stillHere.length - raidStillHere,
    joinedNeverSpoke,
    weeks,
    cohorts,
    retentionOverall,
    sourcesAllTime: countBySource(humanJoins.map((e) => e.source)),
    channels,
    channelSnapshotAt: snapshot?.collected_at ?? null,
    caveats,
    anomalies: anomalies.filter((a) => a.status === 'unconfirmed' || a.status === 'confirmed'),
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
