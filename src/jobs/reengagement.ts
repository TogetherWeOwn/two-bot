/**
 * The weekly re-engagement list: who we are losing, while we can still get
 * them back.
 *
 * Two questions, one list:
 *
 *   1. Who joined and never said a word (or entered a voice room)?
 *   2. Who used to turn up and has stopped?
 *
 * Both are answered from the funnel tables only - no Discord call, no message
 * content, no names. The output is a list of IDs a human works by hand.
 * Nothing in this file messages anybody; see docs/PRIVACY.md for why that line
 * is drawn here and not later.
 *
 * Two judgements are baked in, because getting them wrong makes the list
 * useless rather than merely imperfect:
 *
 *  * **Raid accounts are set aside.** 30 of the server's 84 "humans" arrived in
 *    three mass-joins and have never done anything (src/analytics/anomalies.ts).
 *    A naive "joined but never posted" query returns those 30 first, and a
 *    community team working the list top-down would spend the week talking to
 *    bots. They are excluded here and counted on their own line - never hidden.
 *  * **Recency is the whole ranking.** "While we can still get them back" is
 *    the brief. Somebody who missed the last three weeks is a different problem
 *    from somebody last seen in 2023, and mixing them buries the first in the
 *    second.
 */
import { ANOMALIES, excludeClause, windowBounds } from '../analytics/anomalies.ts';
import type { Db } from '../store/db.ts';
import type { EventStore } from '../store/eventStore.ts';
import { nowIso } from '../core/events.ts';
import { log } from '../core/log.ts';

/**
 * Where a member sits on the way out. Ordered by how likely we are to get them
 * back, best first - the report prints them in this order.
 */
export const SEGMENTS = ['never_engaged', 'slipping', 'dormant', 'lapsed'] as const;
export type Segment = (typeof SEGMENTS)[number];

export interface Thresholds {
  /** Joined this recently: too early to call them silent. */
  graceDays: number;
  /** Quiet at least this long before we count it as quiet at all. */
  quietDays: number;
  /** Quiet longer than this is dormant rather than slipping. */
  dormantDays: number;
  /** Quiet longer than this is a lapsed alumnus, not a save. */
  lapsedDays: number;
}

/**
 * Tuned for a small, weekly-rhythm gaming community, not a chat server.
 * Somebody who plays with the group most weeks and misses three is a signal;
 * missing four days is a holiday. Change these here, not at the call site, so
 * every report and every test moves together.
 */
export const THRESHOLDS: Thresholds = {
  graceDays: 3,
  quietDays: 21,
  dormantDays: 60,
  lapsedDays: 240,
};

/** What we know a member ever did. Drives what the team can plausibly invite them to. */
export type EngagedVia = 'voice' | 'text' | 'both' | 'never';

export interface MemberFacts {
  joinedAt: string | null;
  firstMessageAt: string | null;
  firstVoiceAt: string | null;
  lastActiveAt: string | null;
}

export interface ListEntry {
  memberId: string;
  segment: Segment;
  joinedAt: string | null;
  joinSource: string | null;
  lastActiveAt: string | null;
  /** Days since last activity. Null for members who were never active at all. */
  daysQuiet: number | null;
  daysSinceJoin: number | null;
  engagedVia: EngagedVia;
  /** Set if this member has been handed to the team before. Null means new this week. */
  previouslyListedAt: string | null;
}

export interface ReengagementList {
  generatedAt: string;
  guildId: string;
  entries: ListEntry[];
  counts: Record<Segment, number>;
  /** Members deliberately left off, and why. Reported, never silently dropped. */
  setAside: {
    raidAccounts: number;
    inGracePeriod: number;
    windows: string[];
  };
  totals: {
    presentHumans: number;
    /** Present, human, and active inside the quiet threshold. Nothing to do here. */
    stillActive: number;
  };
  thresholds: Thresholds;
}

const DAY = 86_400_000;

const daysBetween = (fromIso: string, nowMs: number): number =>
  Math.floor((nowMs - Date.parse(fromIso)) / DAY);

export function engagedVia(m: MemberFacts): EngagedVia {
  if (m.firstMessageAt && m.firstVoiceAt) return 'both';
  if (m.firstVoiceAt) return 'voice';
  if (m.firstMessageAt) return 'text';
  return 'never';
}

/**
 * Which bucket a member falls in, or null for "nothing to do about this one".
 *
 * Pure on purpose: this is the only judgement in the file, so it is the thing
 * worth testing, and it should be testable without a database.
 *
 * Null means either they are still active, or they joined so recently that
 * silence is not yet evidence of anything.
 */
export function classify(m: MemberFacts, nowMs: number, t: Thresholds = THRESHOLDS): Segment | null {
  if (!m.lastActiveAt) {
    if (!m.joinedAt) return null; // we have no dates at all - not a finding, a gap
    return daysBetween(m.joinedAt, nowMs) < t.graceDays ? null : 'never_engaged';
  }
  const quiet = daysBetween(m.lastActiveAt, nowMs);
  if (quiet < t.quietDays) return null;
  if (quiet < t.dormantDays) return 'slipping';
  if (quiet < t.lapsedDays) return 'dormant';
  return 'lapsed';
}

/** Best chance of a save first, then most-recently-seen first inside each bucket. */
export function rank(a: ListEntry, b: ListEntry): number {
  const bySegment = SEGMENTS.indexOf(a.segment) - SEGMENTS.indexOf(b.segment);
  if (bySegment !== 0) return bySegment;
  // never_engaged has no quiet clock, so it ranks on how fresh the join is.
  const av = a.daysQuiet ?? a.daysSinceJoin ?? Number.MAX_SAFE_INTEGER;
  const bv = b.daysQuiet ?? b.daysSinceJoin ?? Number.MAX_SAFE_INTEGER;
  return av - bv;
}

interface Row {
  member_id: string;
  joined_at: string | null;
  join_source: string | null;
  first_message_at: string | null;
  first_voice_at: string | null;
  last_active_at: string | null;
  inactive_flagged_at: string | null;
}

export interface BuildOptions {
  /** Overridable so tests do not depend on the clock. */
  now?: number;
  thresholds?: Thresholds;
}

/**
 * Build this week's list.
 *
 * Read-only. Use `markListed` if you want the handover recorded.
 */
export async function buildList(
  db: Db,
  guildId: string,
  opts: BuildOptions = {},
): Promise<ReengagementList> {
  const nowMs = opts.now ?? Date.now();
  const t = opts.thresholds ?? THRESHOLDS;

  // The anomaly windows are defined against `occurred_at` in the events table;
  // here the same instants are being matched against a member's join date.
  const raid = excludeClause('member_join', ANOMALIES, 'joined_at');

  const select = `SELECT member_id, joined_at, join_source, first_message_at, first_voice_at,
                         last_active_at, inactive_flagged_at
                    FROM members
                   WHERE guild_id = ? AND left_at IS NULL AND is_bot = 0`;

  const rows = await db.prepare(`${select}${raid.sql}`).all<Row>(guildId, ...raid.params);

  // Counted separately rather than merged in: a raid account and a real member
  // who never posted look identical in this table, and only one of them is a
  // person the community team can talk to.
  const raidAccounts = raid.sql
    ? Number(
        (
          await db
            .prepare(
              `SELECT COUNT(*) AS n FROM members
                WHERE guild_id = ? AND left_at IS NULL AND is_bot = 0
                  AND last_active_at IS NULL AND NOT (1=1${raid.sql})`,
            )
            .get<{ n: number }>(guildId, ...raid.params)
        )?.n ?? 0,
      )
    : 0;

  const entries: ListEntry[] = [];
  let stillActive = 0;
  let inGracePeriod = 0;

  for (const r of rows) {
    const facts: MemberFacts = {
      joinedAt: r.joined_at,
      firstMessageAt: r.first_message_at,
      firstVoiceAt: r.first_voice_at,
      lastActiveAt: r.last_active_at,
    };
    const segment = classify(facts, nowMs, t);
    if (!segment) {
      // Two very different reasons to skip, and the report says which.
      if (!r.last_active_at && r.joined_at) inGracePeriod++;
      else stillActive++;
      continue;
    }
    entries.push({
      memberId: r.member_id,
      segment,
      joinedAt: r.joined_at,
      joinSource: r.join_source,
      lastActiveAt: r.last_active_at,
      daysQuiet: r.last_active_at ? daysBetween(r.last_active_at, nowMs) : null,
      daysSinceJoin: r.joined_at ? daysBetween(r.joined_at, nowMs) : null,
      engagedVia: engagedVia(facts),
      previouslyListedAt: r.inactive_flagged_at,
    });
  }

  entries.sort(rank);

  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<Segment, number>;
  for (const e of entries) counts[e.segment]++;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    guildId,
    entries,
    counts,
    setAside: {
      raidAccounts,
      inGracePeriod,
      windows: ANOMALIES.filter((a) => a.eventTypes.includes('member_join')).map(
        (a) => `${a.start} ${a.label}`,
      ),
    },
    totals: { presentHumans: rows.length + raidAccounts, stillActive },
    thresholds: t,
  };
}

/**
 * Record that these members were handed to the community team.
 *
 * This is what makes "new on the list this week" mean anything - without it the
 * team gets the same forty names every Monday and cannot tell who they have
 * already tried. It writes an event and nothing else. It does not message
 * anybody, and it must not: outbound contact needs CEO sign-off first.
 */
export async function markListed(
  store: EventStore,
  guildId: string,
  entries: ListEntry[],
): Promise<number> {
  const at = nowIso();
  for (const e of entries) {
    await store.record({
      guildId,
      memberId: e.memberId,
      eventType: 'member_inactive',
      occurredAt: at,
      source: 'job:reengagement',
      metadata: { segment: e.segment, daysQuiet: e.daysQuiet },
    });
  }
  log.info('reengagement_marked', { listed: entries.length });
  return entries.length;
}

/** The dates covered by the set-aside join windows, for the report footer. */
export function raidWindowBounds(): { from: string; to: string }[] {
  return ANOMALIES.filter((a) => a.eventTypes.includes('member_join')).map(windowBounds);
}
