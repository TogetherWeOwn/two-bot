/**
 * Deterministic rules-gate timeout.
 *
 * A member is a target only when Discord says they are still `pending` and its
 * own `joined_at` timestamp is at least fourteen days old. No activity score,
 * raid window, username or other heuristic is involved. The script that calls
 * this module reports by default and can only kick through DiscordKicker after
 * an operator explicitly types `--execute --expect <n>`.
 */
import type { RawMember } from '../discord/rest.ts';

/** Two weekends: the community decision on TOG-412, implemented by TOG-479. */
export const RULES_GATE_TIMEOUT_DAYS = 14;
const DAY_MS = 86_400_000;
const RULES_GATE_TIMEOUT_MS = RULES_GATE_TIMEOUT_DAYS * DAY_MS;

export interface RulesGateTarget {
  memberId: string;
  joinedAt: string;
}

export interface RulesGateScan {
  targets: RulesGateTarget[];
  humans: number;
  bots: number;
  pending: number;
  invalidJoinedAt: string[];
}

/**
 * Select timed-out members from one complete Discord roster.
 *
 * The comparison is inclusive: exactly fourteen days old is due. An invalid or
 * absent `joined_at` is held back and named rather than guessed at.
 */
export function scanRulesGateTimeouts(members: RawMember[], nowMs = Date.now()): RulesGateScan {
  const targets: RulesGateTarget[] = [];
  const invalidJoinedAt: string[] = [];
  let humans = 0;
  let bots = 0;
  let pending = 0;

  for (const member of members) {
    const memberId = member.user?.id;
    if (!memberId) continue;
    if (member.user?.bot) {
      bots++;
      continue;
    }
    humans++;
    if (member.pending !== true) continue;
    pending++;

    const joinedMs = Date.parse(member.joined_at ?? '');
    if (!Number.isFinite(joinedMs)) {
      invalidJoinedAt.push(memberId);
      continue;
    }
    if (nowMs - joinedMs < RULES_GATE_TIMEOUT_MS) continue;

    targets.push({ memberId, joinedAt: new Date(joinedMs).toISOString() });
  }

  targets.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.memberId.localeCompare(b.memberId));
  return { targets, humans, bots, pending, invalidJoinedAt };
}
