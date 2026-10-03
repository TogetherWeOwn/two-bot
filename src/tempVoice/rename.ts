/**
 * Channel-rename throttling (TOG-3052).
 *
 * Discord's real limit is 2 renames per 10 minutes per channel. It is
 * undocumented and, critically, it is NOT surfaced in the rate-limit headers -
 * discord.js queues the third rename silently instead of rejecting it, so an
 * awaited rename does not error, it *hangs*, and the user sees "This
 * interaction failed" three seconds later.
 *
 * So the throttle lives here, on our side of the call, and the caller must
 * defer its reply before ever awaiting a rename. We allow 1 per 5 minutes,
 * which is Auto Voice Channels' answer and leaves headroom under Discord's 2.
 *
 * Intermediate states are dropped: while the window is closed only the LATEST
 * requested name survives, because the user's last word is the one they meant.
 */

export const RENAME_MIN_INTERVAL_MS = 5 * 60 * 1000;

export interface RenameDecision {
  /** Apply this name to Discord now. */
  apply: boolean;
  /** The name that will eventually land - echoed back for the user's reply. */
  name: string;
  /** Milliseconds until the queued name is applied. 0 when applied now. */
  retryAfterMs: number;
}

interface OutstandingAttempt {
  /**
   * Reservation timestamp. Consecutive applies are always a full window
   * apart, so the timestamp IS the attempt's identity: a late rejection can
   * only match the attempt that made it, never a newer attempt that happens
   * to own the head now.
   */
  at: number;
  /** Generation snapshotted when this attempt was made. */
  generation: number;
  /**
   * Head reservation before this attempt reserved its slot. Restored when
   * this attempt is the last outstanding one to reject — so a rejection
   * drops exactly its own reservation, whether that is a fresh window or
   * an earlier attempt's still-unanswered reservation.
   */
  priorHead: number;
}

interface Pending {
  name: string;
  /** Head reservation: the latest outstanding attempt, else the live window. */
  lastAppliedAt: number;
  /**
   * Bumped on every request(). A rejection compares its attempt's snapshot:
   * equal means nothing arrived after it (drop the failed name), greater
   * means a newer request was acknowledged (keep the queue, roll back only
   * the failed attempt's window reservation).
   */
  generation: number;
  /** Attempts still awaiting a Discord answer, in request order. */
  attempts: OutstandingAttempt[];
}

export class RenameThrottle {
  private minIntervalMs: number;
  private state = new Map<string, Pending>();

  constructor(minIntervalMs: number = RENAME_MIN_INTERVAL_MS) {
    this.minIntervalMs = minIntervalMs;
  }

  /**
   * `lastAppliedAt` comes from the persisted row, so the throttle survives a
   * restart instead of handing a fresh process a free rename per channel.
   */
  seed(channelId: string, lastAppliedAt: number): void {
    const existing = this.state.get(channelId);
    if (existing && existing.lastAppliedAt >= lastAppliedAt) return;
    this.state.set(channelId, {
      name: existing?.name ?? '', lastAppliedAt,
      generation: existing?.generation ?? 0,
      attempts: existing?.attempts ?? [],
    });
  }

  request(channelId: string, name: string, now: number): RenameDecision {
    const existing = this.state.get(channelId);
    const elapsed = existing === undefined ? Number.POSITIVE_INFINITY : now - existing.lastAppliedAt;
    if (elapsed >= this.minIntervalMs) {
      const generation = (existing?.generation ?? 0) + 1;
      this.state.set(channelId, {
        name, lastAppliedAt: now,
        generation,
        attempts: [...(existing?.attempts ?? []), {
          at: now, generation,
          priorHead: existing?.lastAppliedAt ?? Number.NEGATIVE_INFINITY,
        }],
      });
      return { apply: true, name, retryAfterMs: 0 };
    }
    // Window closed: keep only the newest name. The previous pending one is
    // dropped on the floor deliberately - it was never sent to Discord.
    this.state.set(channelId, { ...existing!, name, generation: existing!.generation + 1 });
    return { apply: false, name, retryAfterMs: this.minIntervalMs - elapsed };
  }

  /**
   * The name waiting for this channel's window to open, if the pending name is
   * still different from what Discord currently holds.
   */
  pending(channelId: string, appliedName: string): string | null {
    const existing = this.state.get(channelId);
    if (!existing || !existing.name || existing.name === appliedName) return null;
    return existing.name;
  }

  /** True when `channelId` may be renamed right now. */
  ready(channelId: string, now: number): boolean {
    const existing = this.state.get(channelId);
    if (!existing) return true;
    return now - existing.lastAppliedAt >= this.minIntervalMs;
  }

  /** Mark a rename as having landed, starting a fresh window. */
  applied(channelId: string, name: string, now: number): void {
    // A landing attempt leaves no room for a stale rejection: its answer has
    // already arrived, so its identity is dropped with every earlier one —
    // none of them can still be answered.
    this.state.set(channelId, {
      name, lastAppliedAt: now,
      generation: 0, attempts: [],
    });
  }

  /**
   * Discard a definitively rejected attempt without erasing a newer queued
   * request. Identity is the attempt's own reservation timestamp — never the
   * current head, which a newer attempt may already own. Generation — not
   * name equality — tells the failed intent apart from a successor queued
   * while Discord was answering: a newer request keeps its acknowledgement
   * even when it repeats the failed name. Either way the failed attempt
   * spent no Discord budget, so its own reservation rolls back; sweeps
   * therefore never replay the rejected request, while an acknowledged
   * successor still lands once the restored window opens.
   */
  rejected(channelId: string, name: string, attemptedAt: number): void {
    const existing = this.state.get(channelId);
    if (!existing) return;
    const index = existing.attempts.findIndex((attempt) => attempt.at === attemptedAt);
    // Unknown to this window — already removed by its own earlier rejection,
    // cleared by a landing `applied`, or from a forgotten channel: nothing
    // to do. An older attempt that is still outstanding keeps its identity
    // here; the generation check below is what spares a successor queued
    // after it.
    if (index === -1) return;
    const failed = existing.attempts[index]!;
    let attempts = [...existing.attempts.slice(0, index), ...existing.attempts.slice(index + 1)];
    // Only the head attempt reserves the current window. Dropping a buried
    // attempt never moves the head — but it splices the reservation chain:
    // any remaining attempt that reserved against the failed one now rests
    // on the failed attempt's own prior head. Otherwise a later head
    // rejection would restore the dead attempt's reservation (a phantom
    // window), or match a revived head it no longer owns.
    const last = attempts.length > 0 ? attempts[attempts.length - 1]! : null;
    if (last !== null && last.at === existing.lastAppliedAt && last.at !== failed.at) {
      attempts = attempts.map((attempt) =>
        attempt.priorHead === failed.at ? { ...attempt, priorHead: failed.priorHead } : attempt,
      );
    }
    const head = last?.at ?? failed.priorHead;
    // A newer request (queued or applied) arrived after the failed attempt:
    // keep its acknowledgement. Otherwise the failed name itself is dropped
    // so no sweep can replay it.
    const newerArrived = existing.generation > failed.generation;
    const keepName = newerArrived || existing.name !== name;
    if (head === Number.NEGATIVE_INFINITY && !keepName) {
      this.state.delete(channelId);
      return;
    }
    this.state.set(channelId, {
      name: keepName ? existing.name : '',
      lastAppliedAt: head,
      generation: newerArrived ? existing.generation : 0,
      attempts,
    });
  }

  forget(channelId: string): void {
    this.state.delete(channelId);
  }
}

/**
 * Rename-collision check (TOG-9992).
 *
 * Discord permits duplicate voice-channel names, so nothing below us refuses a
 * rename that clones a sibling's name. The service therefore checks the
 * persisted live rows first and refuses with a named error instead of minting
 * a duplicate.
 */
export interface SiblingName {
  channelId: string;
  name: string;
}

/**
 * Fold a channel name for collision comparison: NFKC (so fullwidth and
 * compatibility variants match their plain forms, and NFC/NFD canonically
 * equivalent strings match each other) plus case-insensitive (`Squad` and
 * `squad` collide - users cannot reliably tell them apart in the voice UI).
 * The filter already NFKC-sanitizes the candidate; siblings are folded here
 * because stored rows predate any single normalization.
 */
export function foldChannelNameForCollision(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/**
 * The sibling already holding `candidate`, or null. The channel being renamed
 * never collides with itself.
 */
export function findRenameCollision(
  candidate: string,
  channelId: string,
  siblings: readonly SiblingName[],
): SiblingName | null {
  const folded = foldChannelNameForCollision(candidate);
  for (const sibling of siblings) {
    if (sibling.channelId === channelId) continue;
    if (foldChannelNameForCollision(sibling.name) === folded) return sibling;
  }
  return null;
}
