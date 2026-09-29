/**
 * Member_leave backfill gap analysis (TOG-8305).
 *
 * The question: members with a `member_join` row and no `member_leave` row who
 * are no longer in the guild. Every one of them makes retention read higher
 * than it is - the denominator keeps them as "still here".
 *
 * Why the gap exists at all is in the write paths, not the schema:
 *
 *   live bot down   `GuildMemberRemove` only fires while the gateway listener
 *                   is connected. A departure during downtime leaves no row,
 *                   and the member is gone from the roster, so the only
 *                   remaining evidence is the log channels - if the scan
 *                   reached that far back.
 *   log coverage    `scripts/backfill.ts` pages log channels newest-first with
 *                   a page cap. Anything older than the oldest message read
 *                   (`INCOMPLETE: hit the N-page cap`), in a deleted channel,
 *                   in a mixed feed skipped by the probe yield, or in an embed
 *                   whose footer carries no snowflake, never became a row.
 *   ban/kick shape  kicks and bans both surface as `GuildMemberRemove` on the
 *                   gateway, and the funnel row is written from that event by
 *                   `handlers.onLeave` (via the `src/discord/client.ts`
 *                   listener; the `sessionWelcome.ts` listener only sends the
 *                   goodbye message). The log parser likewise counts titled
 *                   "Member banned" as a leave (`src/backfill/parse.ts`) - so
 *                   a missing leave is a coverage miss, never a type the
 *                   pipeline ignores.
 *
 * Read-only by design, same split as `voiceReconcile.ts`: the script reads
 * the two event feeds (SELECT only) plus the live Discord roster (GET only)
 * and this module decides what they mean. The pure classifier takes rows, so
 * the taxonomy is pinned without a database; `fetchLeaveGapFeeds` takes the
 * narrow `Db` and the test fakes it in-memory (the fake also proves the sweep
 * never writes). Nothing here proposes touching production writes - the fill
 * rule below is a proposal for a future card, flagged row by row.
 */

import type { Db } from '../store/driver.ts';
import { windowBounds, type Anomaly } from './anomalies.ts';

/** One `member_join` row. The source tells log-derived apart from roster-derived. */
export interface GapJoin {
  guildId: string;
  memberId: string | null;
  occurredAt: string;
  source: string;
}

/** One `member_leave` row. */
export interface GapLeave {
  guildId: string;
  memberId: string | null;
  occurredAt: string;
}

/** One entry of the live Discord roster: proof the member is still here. */
export interface RosterMember {
  guildId: string;
  memberId: string | null;
}

/** Where a gap member's departure falls relative to what we can still read. */
export type GapKind =
  /** Last join predates the oldest log message scanned: the leave instant is unknowable. */
  | 'pre-coverage'
  /** Last join is inside scanned history but no leave row: a logger miss worth re-scanning. */
  | 'log-miss'
  /** Joined inside a raid window and never came back: mass-join residue, not organic churn. */
  | 'raid-residue'
  /** Joined twice or more with no leave between: necessarily left at least once. */
  | 'rejoin-gap';

/** One row a future fill card would write. Proposed here, written nowhere. */
export interface ProposedFill {
  occurredAt: string;
  /**
   * Always `earliest-possible`: the member was provably present at this join
   * instant and gone sometime after. A later rejoin additionally proves the
   * departure by its own instant, and the note says so - but stamping the
   * fill AT that later instant would share its `occurred_at` with the next
   * fill, and `member_leave` idempotency keys on `occurred_at`, so the two
   * would dedupe into one row and the inter-join departure would vanish.
   * Same doctrine as backfilled `gate_cleared` rows, which say THAT and
   * never WHEN.
   */
  bound: 'earliest-possible';
  note: string;
}

export interface LeaveGap {
  guildId: string;
  memberId: string;
  kind: GapKind;
  lastJoinAt: string;
  joinsSeen: number;
  /** The human sentence: what happened and what (if anything) to do. */
  detail: string;
  fills: ProposedFill[];
}

export interface ClassifyResult {
  /** Join-without-leave members confirmed gone, one entry each with fills. */
  gaps: LeaveGap[];
  /** Join-without-leave members still on the roster: correct, not a gap. */
  present: number;
  /** Off-roster members with at least one leave row: already resolved. */
  resolved: number;
  /** Rows with an unparseable timestamp or no member. Counted, never paired. */
  skipped: number;
}

/** True when the instant falls inside a raid-kind anomaly window. */
function inRaidWindow(at: string, anomalies: Anomaly[]): boolean {
  return anomalies.some((a) => {
    if (a.kind !== 'raid') return false;
    const { from, to } = windowBounds(a);
    return at >= from && at < to;
  });
}

function usableTime(raw: string): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : raw;
}

/**
 * Sort every gap member's joins oldest-first and propose fills.
 *
 * One fill per join instant, each stamped AT the join it bounds: the member
 * was provably present then and gone sometime after. A rejoin additionally
 * proves the inter-join departure by its own instant (the note says so), but
 * the fill still stamps the earlier join - stamping the later one would share
 * its `occurred_at` with the next fill and the idempotency key would merge
 * them into a single row.
 */
function fillsFor(joins: string[], kind: GapKind): ProposedFill[] {
  const fills: ProposedFill[] = [];
  for (let i = 0; i < joins.length - 1; i++) {
    fills.push({
      occurredAt: joins[i],
      bound: 'earliest-possible',
      note:
        `provably present at ${joins[i]}, gone sometime after - and necessarily ` +
        `before the rejoin at ${joins[i + 1]}`,
    });
  }
  const last = joins[joins.length - 1];
  const kindNote =
    kind === 'raid-residue'
      ? 'raid-window join: confirm the cleanup before counting this as churn'
      : kind === 'pre-coverage'
        ? 'leave predates scanned log history: the instant is unknowable'
        : kind === 'log-miss'
          ? 're-scan the raw logs for this member id before filling'
          : 'final departure after the last join';
  fills.push({ occurredAt: last, bound: 'earliest-possible', note: kindNote });
  return fills;
}

/**
 * Partition every joined member into present / resolved / gap / skipped.
 *
 * `logFloor` is the oldest log timestamp the backfill actually read (its
 * `scannedBackTo`). Null means unknown, in which case nothing is called
 * pre-coverage - without a floor that label would be a guess, so those gaps
 * read as log-miss with the floor-unknown note.
 */
export function classifyLeaveGaps(
  joins: readonly GapJoin[],
  leaves: readonly GapLeave[],
  roster: readonly RosterMember[],
  opts: { logFloor?: string | null; anomalies?: Anomaly[] } = {},
): ClassifyResult {
  const result: ClassifyResult = { gaps: [], present: 0, resolved: 0, skipped: 0 };
  const anomalies = opts.anomalies ?? [];
  const floor = opts.logFloor ?? null;

  const joinsByMember = new Map<string, { guildId: string; at: string[] }>();
  for (const j of joins) {
    const at = usableTime(j.occurredAt);
    if (!j.memberId || !at) {
      result.skipped++;
      continue;
    }
    const k = `${j.guildId}:${j.memberId}`;
    const entry = joinsByMember.get(k);
    if (entry) entry.at.push(at);
    else joinsByMember.set(k, { guildId: j.guildId, at: [at] });
  }

  const leftMembers = new Set<string>();
  for (const l of leaves) {
    if (!l.memberId || !usableTime(l.occurredAt)) {
      result.skipped++;
      continue;
    }
    leftMembers.add(`${l.guildId}:${l.memberId}`);
  }

  const onRoster = new Set<string>();
  for (const r of roster) {
    if (!r.memberId) {
      result.skipped++;
      continue;
    }
    onRoster.add(`${r.guildId}:${r.memberId}`);
  }

  for (const [key, entry] of joinsByMember) {
    const [, memberId] = key.split(':');
    if (leftMembers.has(key)) {
      // At least one leave row: the departure is recorded, whatever else is missing.
      result.resolved++;
      continue;
    }
    if (onRoster.has(key)) {
      // Still here with no leave row is the correct state, not a gap.
      result.present++;
      continue;
    }
    const times = [...entry.at].sort();
    const lastJoin = times[times.length - 1];
    let kind: GapKind;
    let detail: string;
    if (times.length > 1) {
      kind = 'rejoin-gap';
      detail =
        `${times.length} joins and no leave: left at least once between them, ` +
        `and left again after ${lastJoin}. Fill one leave per inter-join gap plus the final departure.`;
    } else if (inRaidWindow(lastJoin, anomalies)) {
      kind = 'raid-residue';
      detail =
        `joined inside a raid window (${lastJoin}) and never recorded leaving: ` +
        `likely removed in a cleanup the logs do not show. Confirm against the ` +
        `cleanup before counting this as churn - never auto-fill as organic.`;
    } else if (floor && lastJoin < floor) {
      kind = 'pre-coverage';
      detail =
        `last join ${lastJoin} predates the oldest scanned log message (${floor}): ` +
        `the departure left no record we can still read. Fill establishes THAT they left, never WHEN.`;
    } else {
      kind = 'log-miss';
      detail =
        `last join ${lastJoin} is inside scanned history${floor ? ` (floor ${floor})` : ' (log floor unknown)'} ` +
        `but no leave row: the logger missed it (format drift, missing footer id, ` +
        `mixed-feed skip, or a bot-down window). Re-scan the raw logs for this id first.`;
    }
    result.gaps.push({
      guildId: entry.guildId,
      memberId: memberId!,
      kind,
      lastJoinAt: lastJoin,
      joinsSeen: times.length,
      detail,
      fills: fillsFor(times, kind),
    });
  }

  result.gaps.sort((a, b) => a.lastJoinAt.localeCompare(b.lastJoinAt) || a.memberId.localeCompare(b.memberId));
  return result;
}

/**
 * Read the two feeds the classifier needs. SELECT only - the sweep never
 * writes. `since` bounds both feeds; omit it for the full-history sweep.
 */
export async function fetchLeaveGapFeeds(
  db: Db,
  since?: string,
): Promise<{ joins: GapJoin[]; leaves: GapLeave[] }> {
  const inWindow = since ? 'AND occurred_at >= ?' : '';
  const params = since ? [since] : [];

  const joinRows = await db
    .prepare(
      `SELECT guild_id, member_id, occurred_at, source FROM events
        WHERE event_type = 'member_join' ${inWindow}
        ORDER BY occurred_at`,
    )
    .all<{ guild_id: string; member_id: string | null; occurred_at: string; source: string }>(
      ...params,
    );

  const leaveRows = await db
    .prepare(
      `SELECT guild_id, member_id, occurred_at FROM events
        WHERE event_type = 'member_leave' ${inWindow}
        ORDER BY occurred_at`,
    )
    .all<{ guild_id: string; member_id: string | null; occurred_at: string }>(...params);

  return {
    joins: joinRows.map((r) => ({
      guildId: r.guild_id,
      memberId: r.member_id,
      occurredAt: r.occurred_at,
      source: r.source,
    })),
    leaves: leaveRows.map((r) => ({
      guildId: r.guild_id,
      memberId: r.member_id,
      occurredAt: r.occurred_at,
    })),
  };
}

/** One gap line: member, kind, last join, and the fills it proposes. */
function gapLine(g: LeaveGap): string {
  const fills = g.fills.map((f) => `${f.occurredAt} (${f.bound})`).join('; ');
  return (
    `  ${g.memberId} kind=${g.kind} lastJoin=${g.lastJoinAt} joins=${g.joinsSeen}\n` +
    `    ${g.detail}\n` +
    `    proposed fills: ${fills}`
  );
}

/**
 * The reviewer-facing report. Every joined member lands in exactly one of
 * gaps / present / resolved / skipped, so a missing leave can never pass
 * through silently - and the fill rule below is a proposal, executed nowhere.
 */
export function formatLeaveGapReport(result: ClassifyResult, heading: string): string {
  const byKind = new Map<GapKind, number>();
  for (const g of result.gaps) byKind.set(g.kind, (byKind.get(g.kind) ?? 0) + 1);
  const fillsTotal = result.gaps.reduce((n, g) => n + g.fills.length, 0);

  const out: string[] = [`\n${heading}\n`];
  out.push(`  Gaps: members with a join, no leave row, and gone from the roster (${result.gaps.length}):`);
  if (result.gaps.length === 0) out.push('    (none - every departed member has a leave row)');
  for (const g of result.gaps) out.push(gapLine(g));
  out.push('');
  out.push('  Counts:');
  for (const kind of ['pre-coverage', 'log-miss', 'raid-residue', 'rejoin-gap'] as const) {
    out.push(`    ${kind}: ${byKind.get(kind) ?? 0}`);
  }
  out.push(`    present with no leave row (correct, not a gap): ${result.present}`);
  out.push(`    departed with a leave row (resolved): ${result.resolved}`);
  out.push(`    malformed rows skipped: ${result.skipped}`);
  out.push(`    proposed fill rows if a future card executes: ${fillsTotal}`);
  out.push('');
  out.push('  Proposed fill rule (NOT executed - proposal for a future card):');
  out.push('    1. Never fill for on-roster members; absence of a leave row is correct there.');
  out.push('    2. Never auto-fill raid-residue as organic churn; confirm the cleanup first,');
  out.push('       and keep fills out of the prune/cleanup baselines either way.');
  out.push('    3. Re-scan the raw logs for each log-miss id before filling (footer-id search).');
  out.push('    4. Fill with source backfill:leave_gap plus metadata {leaveInferred:true} and the');
  out.push('       bound above; fills establish THAT the member left, never WHEN - same doctrine');
  out.push('       as backfilled gate_cleared rows, so no timing arithmetic may use them.');
  out.push('    5. Report retention with and without fills to bracket the truth.');
  out.push('    6. Dry-run first, idempotent keys, re-runnable - same contract as scripts/backfill.ts.');
  out.push('');
  return out.join('\n');
}

/**
 * Reviewer fixture: seven members covering every path. Absolute timestamps so
 * the seed is deterministic: the raid join sits inside the confirmed
 * 2025-07-06 raid window, the pre-coverage join predates the seed floor, and
 * the log-miss join lands inside scanned history.
 */
export function buildSeedGapData(): {
  joins: GapJoin[];
  leaves: GapLeave[];
  roster: RosterMember[];
  logFloor: string;
} {
  const G = 'seed-guild';
  const join = (memberId: string | null, occurredAt: string, source = 'backfill:log:join-leave-log'): GapJoin => ({
    guildId: G,
    memberId,
    occurredAt,
    source,
  });
  return {
    // Still here with no leave row: correct, counted as present.
    joins: [
      join('m-present', '2025-06-01T10:00:00.000Z'),
      // Join plus leave, gone: resolved.
      join('m-clean', '2025-05-01T10:00:00.000Z'),
      // Last join older than the floor: the leave predates readable history.
      join('m-pre', '2023-01-15T10:00:00.000Z'),
      // Last join inside history with no leave: the logger missed it.
      join('m-miss', '2025-06-15T10:00:00.000Z'),
      // Joined mid-raid, never seen leaving: cleanup residue, not churn.
      join('m-raid', '2025-07-06T21:00:00.000Z'),
      // Two joins, no leaves: left between them and after the last one.
      join('m-rejoin', '2024-05-01T10:00:00.000Z'),
      join('m-rejoin', '2024-09-01T10:00:00.000Z'),
      // Malformed: skipped, never paired.
      join(null, '2025-06-01T10:00:00.000Z'),
      join('m-badtime', 'not-a-timestamp'),
    ],
    leaves: [
      { guildId: G, memberId: 'm-clean', occurredAt: '2025-05-10T10:00:00.000Z' },
      // Malformed: skipped, never paired.
      { guildId: G, memberId: null, occurredAt: '2025-05-11T10:00:00.000Z' },
    ],
    roster: [
      { guildId: G, memberId: 'm-present' },
      { guildId: G, memberId: 'someone-never-logged' },
    ],
    logFloor: '2024-01-01T00:00:00.000Z',
  };
}
