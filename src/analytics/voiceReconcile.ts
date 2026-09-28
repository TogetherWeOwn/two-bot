/**
 * One-shot reconciliation of voice open-half sessions (TOG-8289).
 *
 * A session is two halves: a `voice_session_start` row and a
 * `voice_session_end` row. Three production realities leave halves orphaned,
 * each with a NULL where a duration should be:
 *
 *   restart loss   the tracker in src/core/voiceSessions.ts is in memory, so a
 *                  restart or reconnect clears it. The member was already in
 *                  voice when the bot came back, the leave lands
 *                  `startKnown: false` with a null duration - but the START row
 *                  is still in the database, written before the restart.
 *   server leave   before TOG-6122 a member leaving the server left no end row
 *                  at all: the tracker entry leaked and only `member_leave`
 *                  marks when the session must have stopped.
 *   bad end row    a known-start end whose metadata carries no usable duration
 *                  (or no usable `startedAt`) yet still names its half.
 *
 * This module pairs halves per (guild, member) in time order and recovers a
 * duration wherever the stored rows allow it. What cannot be recovered is
 * returned with an explicit reason - never a silent NULL. Read-only by
 * design: it SELECTs the three feeds and computes; it writes nothing, so the
 * sweep can run against production without a write path to get wrong.
 *
 * Pure except for `fetchVoiceHalves`, which takes the narrow `Db` and issues
 * the three reads (same split as unknownAttribution.ts: the script reads rows,
 * this decides what they mean, the test needs no database).
 */

import type { Db } from '../store/driver.ts';
import { formatVoiceDurationSeconds } from '../core/voiceSessions.ts';

// --- input rows --------------------------------------------------------------

/** One `voice_session_start` row. The channel is the visit being credited. */
export interface HalfStart {
  guildId: string;
  memberId: string;
  /** ISO-8601 UTC of the join. */
  occurredAt: string;
  /** Channel id without the `channel:` prefix. */
  channel: string;
}

/** One `voice_session_end` row, with its metadata already parsed. */
export interface HalfEnd {
  guildId: string;
  memberId: string;
  /** ISO-8601 UTC of the leave. */
  occurredAt: string;
  /** The channel the session was credited to. */
  channel: string;
  /** False means the tracker never saw the start - the classic restart loss. */
  startKnown: boolean;
  /** The tracker's own record of the start, when the row carries one. */
  startedAt: string | null;
  /** Seconds, or null when the row never measured one. */
  durationSeconds: number | null;
}

/** One `member_leave` row: the backstop for pre-TOG-6122 server leaves. */
export interface LeaveRow {
  guildId: string;
  memberId: string;
  /** ISO-8601 UTC of the leave. */
  occurredAt: string;
}

// --- outcome -----------------------------------------------------------------

/** How an open half got its duration back. */
export type ResolutionKind = 'restart-gap' | 'server-leave' | 'metadata-recompute';

export interface ResolvedSession {
  guildId: string;
  memberId: string;
  channel: string;
  startAt: string;
  endAt: string;
  durationSeconds: number;
  resolution: ResolutionKind;
  /** Set when the arithmetic needed a judgement call (clock-skew clamp). */
  note?: string;
}

/** Why an open half stays without a duration. Every value has a fix or an owner. */
export type UnresolvableReason = 'no-start-on-file' | 'superseded' | 'still-open' | 'bad-end-row';

export interface UnresolvableSession {
  guildId: string;
  memberId: string;
  channel: string;
  /** Null for orphan ends, which never saw a start. */
  startAt: string | null;
  /** Null for still-open starts, which never saw an end. */
  endAt: string | null;
  reason: UnresolvableReason;
  /** The human sentence: what happened and what (if anything) to do. */
  detail: string;
}

export interface ReconcileResult {
  /** Open halves that got a duration back. */
  resolved: ResolvedSession[];
  /** Open halves that stay duration-less, each with its reason. */
  unresolvable: UnresolvableSession[];
  /** Ends that already carried a clean duration. Counted, not listed. */
  complete: number;
  /** Rows with an unparseable timestamp or no member. Counted, never paired. */
  skipped: number;
}

// --- the pairing --------------------------------------------------------------

/** A finite, non-negative duration, or null when the cell holds no number. */
function usableDuration(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const d = Number(raw);
  if (!Number.isFinite(d) || d < 0) return null;
  return Math.round(d);
}

type WalkEvent =
  | { order: 0; at: number; end: HalfEnd }
  | { order: 1; at: number; leave: LeaveRow }
  | { order: 2; at: number; start: HalfStart };

/**
 * Pair every half with its mate. One pass per (guild, member), oldest first;
 * at equal timestamps ends run before leaves before starts, matching the live
 * adapter (a channel move calls leave-old then join-new at the same instant,
 * and TOG-6122 closes voice before writing the leave).
 *
 * A start only ever pairs FORWARDS with an end or leave at or after it.
 * Pairing backwards across a later start would invent causality, so an end
 * older than every start stays orphaned and the start stays open.
 */
export function reconcileVoiceHalves(
  starts: readonly HalfStart[],
  ends: readonly HalfEnd[],
  leaves: readonly LeaveRow[],
): ReconcileResult {
  const result: ReconcileResult = { resolved: [], unresolvable: [], complete: 0, skipped: 0 };

  const byMember = new Map<string, WalkEvent[]>();
  const push = (guildId: string, memberId: string, ev: WalkEvent) => {
    const k = guildId + ":" + memberId;
    const list = byMember.get(k);
    if (list) list.push(ev);
    else byMember.set(k, [ev]);
  };

  for (const s of starts) {
    const at = Date.parse(s.occurredAt);
    if (!s.memberId || Number.isNaN(at)) {
      result.skipped++;
      continue;
    }
    push(s.guildId, s.memberId, { order: 2, at, start: s });
  }
  for (const e of ends) {
    const at = Date.parse(e.occurredAt);
    if (!e.memberId || Number.isNaN(at)) {
      result.skipped++;
      continue;
    }
    push(e.guildId, e.memberId, { order: 0, at, end: e });
  }
  for (const l of leaves) {
    const at = Date.parse(l.occurredAt);
    if (!l.memberId || Number.isNaN(at)) {
      result.skipped++;
      continue;
    }
    push(l.guildId, l.memberId, { order: 1, at, leave: l });
  }

  for (const events of byMember.values()) {
    events.sort((a, b) => a.at - b.at || a.order - b.order);
    let open: HalfStart | null = null;
    const openAt = (): number | null => (open ? Date.parse(open.occurredAt) : null);

    for (const ev of events) {
      if (ev.order === 2) {
        // A second start before any end: the tracker REPLACES (one channel at
        // a time), so the earlier session's end is gone. Its close is bounded
        // above by this start but the instant is unknowable - flag it, never
        // stamp this start's time as its end.
        if (open) {
          result.unresolvable.push({
            guildId: open.guildId,
            memberId: open.memberId,
            channel: open.channel,
            startAt: open.occurredAt,
            endAt: ev.start.occurredAt,
            reason: 'superseded',
            detail:
              `session starting ${open.occurredAt} in ${open.channel} was replaced by a later ` +
              `start at ${ev.start.occurredAt} before any end was recorded; it ended sometime ` +
              `before then (at most ${formatVoiceDurationSeconds(Math.max(0, Math.round((ev.at - Date.parse(open.occurredAt)) / 1000)))}), ` +
              `but the instant is unknowable - not a measurable duration.`,
          });
        }
        open = ev.start;
        continue;
      }

      if (ev.order === 1) {
        // Pre-TOG-6122 server leave: no end row, but the leave proves presence
        // up to its instant, so the open session closes here with a duration.
        const started = openAt();
        if (open && started !== null && started <= ev.at) {
          result.resolved.push({
            guildId: open.guildId,
            memberId: open.memberId,
            channel: open.channel,
            startAt: open.occurredAt,
            endAt: ev.leave.occurredAt,
            durationSeconds: Math.max(0, Math.round((ev.at - started) / 1000)),
            resolution: 'server-leave',
          });
          open = null;
        }
        continue;
      }

      // An end row.
      const end = ev.end;
      const clean = usableDuration(end.durationSeconds);
      const started = openAt();
      const openUsable = open && started !== null && started <= ev.at ? open : null;

      if (end.startKnown && clean !== null) {
        // The healthy case: both halves seen, duration measured. Not an open
        // half at all - counted so the summary proves what was NOT swept.
        result.complete++;
        if (openUsable) open = null;
        continue;
      }

      if (end.startKnown) {
        // Known start, unusable duration: first try the row's own `startedAt`
        // (the tracker's record travels with the end), then the open start row.
        const metaAt = end.startedAt ? Date.parse(end.startedAt) : NaN;
        if (!Number.isNaN(metaAt)) {
          const clamped = metaAt > ev.at;
          result.resolved.push({
            guildId: end.guildId,
            memberId: end.memberId,
            channel: end.channel,
            startAt: end.startedAt!,
            endAt: end.occurredAt,
            durationSeconds: Math.max(0, Math.round((ev.at - metaAt) / 1000)),
            resolution: 'metadata-recompute',
            ...(clamped ? { note: 'end stamped before the recorded start (clock skew), clamped to 0' } : {}),
          });
          if (openUsable) open = null;
          continue;
        }
        if (openUsable) {
          // The flag claims the start was seen but the row's own record of it
          // is unusable; the earlier start row on file is what saves it - the
          // same shape as a restart loss, so the same resolution name.
          result.resolved.push({
            guildId: open.guildId,
            memberId: open.memberId,
            channel: end.channel,
            startAt: open.occurredAt,
            endAt: end.occurredAt,
            durationSeconds: Math.max(0, Math.round((ev.at - started!) / 1000)),
            resolution: 'restart-gap',
            note: 'end claimed startKnown but carried no usable startedAt; duration recomputed from the earlier start row',
          });
          open = null;
          continue;
        }
        result.unresolvable.push({
          guildId: end.guildId,
          memberId: end.memberId,
          channel: end.channel,
          startAt: end.startedAt,
          endAt: end.occurredAt,
          reason: 'bad-end-row',
          detail:
            `end at ${end.occurredAt} claims a known start but carries no usable duration and no ` +
            `usable startedAt, and no start row for the member predates it - nothing to recompute from.`,
        });
        continue;
      }

      // Unknown start: the restart-loss case. The database still holds the
      // start the tracker forgot, so pair with the latest open start at or
      // before the end.
      if (openUsable) {
        result.resolved.push({
          guildId: open.guildId,
          memberId: open.memberId,
          channel: end.channel,
          startAt: open.occurredAt,
          endAt: end.occurredAt,
          durationSeconds: Math.max(0, Math.round((ev.at - started!) / 1000)),
          resolution: 'restart-gap',
        });
        open = null;
        continue;
      }
      result.unresolvable.push({
        guildId: end.guildId,
        memberId: end.memberId,
        channel: end.channel,
        startAt: null,
        endAt: end.occurredAt,
        reason: 'no-start-on-file',
        detail:
          `end at ${end.occurredAt} in ${end.channel} has no start row at or before it for this member - ` +
          `the bot was down for the join or the member was already in voice when it connected. ` +
          `Unmeasurable by construction (docs/EVENTS.md limit 5).`,
      });
    }

    // Whatever is still open after the last event is either live right now or
    // lost without a trace - the report says which it cannot tell apart.
    if (open) {
      result.unresolvable.push({
        guildId: open.guildId,
        memberId: open.memberId,
        channel: open.channel,
        startAt: open.occurredAt,
        endAt: null,
        reason: 'still-open',
        detail:
          `start at ${open.occurredAt} in ${open.channel} has no end or leave after it - the member ` +
          `may be in voice right now, or the end was lost while the bot was down. Re-run after the ` +
          `member leaves: a fresh end pairs it as complete, a missing one keeps it here.`,
      });
    }
  }

  // Stable output: oldest first, member as the tiebreak.
  const byTime = (a: { startAt: string | null }, b: { startAt: string | null }) =>
    (a.startAt ?? '').localeCompare(b.startAt ?? '');
  result.resolved.sort(
    (a, b) => a.startAt.localeCompare(b.startAt) || a.memberId.localeCompare(b.memberId),
  );
  result.unresolvable.sort(byTime);
  return result;
}

// --- reading the store ---------------------------------------------------------

function channelOf(source: string): string {
  return source.startsWith('channel:') ? source.slice('channel:'.length) : source;
}

interface EndRow {
  guild_id: string;
  member_id: string | null;
  occurred_at: string;
  source: string;
  metadata: string | null;
}

/** Parse one end metadata blob. Unreadable rows are known with no duration -
 * the same rule as parseVoiceEndMetadata in src/core/voiceSessions.ts: an
 * unreadable row is not evidence of an unknown start. */
function parseEndMeta(e: EndRow): Pick<HalfEnd, 'startKnown' | 'startedAt' | 'durationSeconds'> {
  try {
    const m = JSON.parse(e.metadata ?? '{}') as {
      startKnown?: unknown;
      startedAt?: unknown;
      durationSeconds?: unknown;
    };
    const raw = m.durationSeconds;
    const durationSeconds =
      typeof raw === 'number' ? raw : raw === null || raw === undefined ? null : Number(raw);
    return {
      startKnown: m.startKnown !== false,
      startedAt: typeof m.startedAt === 'string' ? m.startedAt : null,
      durationSeconds: typeof durationSeconds === 'number' ? durationSeconds : null,
    };
  } catch {
    return { startKnown: true, startedAt: null, durationSeconds: null };
  }
}

/**
 * Read the three feeds the pairing needs. SELECT only - the sweep never
 * writes. `since` bounds all three feeds; omit it for the full-history sweep.
 */
export async function fetchVoiceHalves(
  db: Db,
  since?: string,
): Promise<{ starts: HalfStart[]; ends: HalfEnd[]; leaves: LeaveRow[] }> {
  const inWindow = since ? 'AND occurred_at >= ?' : '';
  const params = since ? [since] : [];

  const startRows = await db
    .prepare(
      `SELECT guild_id, member_id, occurred_at, source FROM events
        WHERE event_type = 'voice_session_start' ${inWindow}
        ORDER BY occurred_at`,
    )
    .all<{ guild_id: string; member_id: string | null; occurred_at: string; source: string }>(
      ...params,
    );

  const endRows = await db
    .prepare(
      `SELECT guild_id, member_id, occurred_at, source, metadata FROM events
        WHERE event_type = 'voice_session_end' ${inWindow}
        ORDER BY occurred_at`,
    )
    .all<EndRow>(...params);

  const leaveRows = await db
    .prepare(
      `SELECT guild_id, member_id, occurred_at FROM events
        WHERE event_type = 'member_leave' ${inWindow}
        ORDER BY occurred_at`,
    )
    .all<{ guild_id: string; member_id: string | null; occurred_at: string }>(...params);

  return {
    starts: startRows
      .filter((r) => r.member_id)
      .map((r) => ({
        guildId: r.guild_id,
        memberId: r.member_id!,
        occurredAt: r.occurred_at,
        channel: channelOf(r.source),
      })),
    ends: endRows
      .filter((r) => r.member_id)
      .map((r) => ({
        guildId: r.guild_id,
        memberId: r.member_id!,
        occurredAt: r.occurred_at,
        channel: channelOf(r.source),
        ...parseEndMeta(r),
      })),
    leaves: leaveRows
      .filter((r) => r.member_id)
      .map((r) => ({ guildId: r.guild_id, memberId: r.member_id!, occurredAt: r.occurred_at })),
  };
}

// --- the report ------------------------------------------------------------------

/** One resolved line names the session, its duration, and how it was recovered. */
function resolvedLine(r: ResolvedSession): string {
  return (
    `  ${r.memberId} ${r.channel} ${r.startAt} -> ${r.endAt} ` +
    `${formatVoiceDurationSeconds(r.durationSeconds)} (${r.resolution})` +
    (r.note ? ` [${r.note}]` : '')
  );
}

/** One unresolvable line names the session and the reason it stays open. */
function unresolvableLine(u: UnresolvableSession): string {
  return (
    `  ${u.memberId} ${u.channel} ${u.startAt ?? '(no start)'} -> ${u.endAt ?? '(no end)'} ` +
    `reason=${u.reason}: ${u.detail}`
  );
}

/** The full sweep output. Every open half appears exactly once, with either a
 * duration or a reason - the two lists partition the input, so a NULL can
 * never pass through silently. */
export function formatReconcileReport(result: ReconcileResult, heading: string): string {
  const out: string[] = [`\n${heading}\n`];
  out.push(`  Resolved with a duration (${result.resolved.length}):`);
  if (result.resolved.length === 0) out.push('    (none)');
  for (const r of result.resolved) out.push(resolvedLine(r));
  out.push('');
  out.push(`  Unresolvable with a reason (${result.unresolvable.length}):`);
  if (result.unresolvable.length === 0) out.push('    (none - every open half resolved)');
  for (const u of result.unresolvable) out.push(unresolvableLine(u));
  out.push('');
  out.push(
    `  Summary: ${result.complete} complete session(s) with clean durations (not listed); ` +
      `${result.resolved.length} open half/halves resolved with a duration; ` +
      `${result.unresolvable.length} flagged unresolvable with a reason; ` +
      `${result.skipped} malformed row(s) skipped.\n`,
  );
  return out.join('\n');
}

// --- seeded demo -------------------------------------------------------------------

const isoAt = (now: Date, msOffset: number): string => new Date(now.getTime() + msOffset).toISOString();

/**
 * Reviewer fixture: seven sessions covering every path, relative to now so
 * they always land inside the window. Three resolve (restart-gap,
 * server-leave, metadata-recompute), three stay flagged (still-open,
 * superseded, no-start-on-file), two more ends are healthy completes.
 */
export function buildSeedHalves(now: Date): {
  starts: HalfStart[];
  ends: HalfEnd[];
  leaves: LeaveRow[];
} {
  const G = 'seed-guild';
  const H = 3_600_000;
  const M = 60_000;
  return {
    starts: [
      // m1: healthy pair, ends below as a complete (not listed).
      { guildId: G, memberId: 'm1', occurredAt: isoAt(now, -5 * H), channel: 'ch-a' },
      // m2: restart loss - the tracker forgot this start, the end is unknown.
      { guildId: G, memberId: 'm2', occurredAt: isoAt(now, -4 * H), channel: 'ch-a' },
      // m3: pre-TOG-6122 server leave - no end row at all.
      { guildId: G, memberId: 'm3', occurredAt: isoAt(now, -2 * H), channel: 'ch-a' },
      // m4: nothing after this start - still open (or lost without a trace).
      { guildId: G, memberId: 'm4', occurredAt: isoAt(now, -1 * H), channel: 'ch-b' },
      // m5: two starts, one end - the first start is superseded, the end
      // pairs with the second as a complete.
      { guildId: G, memberId: 'm5', occurredAt: isoAt(now, -50 * M), channel: 'ch-a' },
      { guildId: G, memberId: 'm5', occurredAt: isoAt(now, -40 * M), channel: 'ch-b' },
      // m7: start row present; the end below carries a null duration but a
      // valid startedAt, so the duration recomputes from the row itself.
      { guildId: G, memberId: 'm7', occurredAt: isoAt(now, -90 * M), channel: 'ch-a' },
    ],
    ends: [
      { guildId: G, memberId: 'm1', occurredAt: isoAt(now, -5 * H + 1800_000), channel: 'ch-a', startKnown: true, startedAt: isoAt(now, -5 * H), durationSeconds: 1800 },
      { guildId: G, memberId: 'm2', occurredAt: isoAt(now, -3 * H), channel: 'ch-a', startKnown: false, startedAt: null, durationSeconds: null },
      { guildId: G, memberId: 'm5', occurredAt: isoAt(now, -35 * M), channel: 'ch-b', startKnown: true, startedAt: isoAt(now, -40 * M), durationSeconds: 300 },
      // m6: unknown end with no start anywhere on file.
      { guildId: G, memberId: 'm6', occurredAt: isoAt(now, -20 * M), channel: 'ch-a', startKnown: false, startedAt: null, durationSeconds: null },
      { guildId: G, memberId: 'm7', occurredAt: isoAt(now, -60 * M), channel: 'ch-a', startKnown: true, startedAt: isoAt(now, -90 * M), durationSeconds: null },
    ],
    leaves: [
      { guildId: G, memberId: 'm3', occurredAt: isoAt(now, -2 * H + 600_000) },
    ],
  };
}
