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

interface Pending {
  name: string;
  lastAppliedAt: number;
  /** Window before the latest attempt reserved a slot, for definitive rejection. */
  previousAppliedAt: number;
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
    this.state.set(channelId, { name: existing?.name ?? '', lastAppliedAt, previousAppliedAt: lastAppliedAt });
  }

  request(channelId: string, name: string, now: number): RenameDecision {
    const existing = this.state.get(channelId);
    const elapsed = existing === undefined ? Number.POSITIVE_INFINITY : now - existing.lastAppliedAt;
    if (elapsed >= this.minIntervalMs) {
      this.state.set(channelId, {
        name, lastAppliedAt: now,
        previousAppliedAt: existing?.lastAppliedAt ?? Number.NEGATIVE_INFINITY,
      });
      return { apply: true, name, retryAfterMs: 0 };
    }
    // Window closed: keep only the newest name. The previous pending one is
    // dropped on the floor deliberately - it was never sent to Discord.
    this.state.set(channelId, { ...existing!, name });
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
    this.state.set(channelId, { name, lastAppliedAt: now, previousAppliedAt: now });
  }

  /** Discard a definitively rejected attempt without erasing an earlier window. */
  rejected(channelId: string, name: string, attemptedAt: number): void {
    const existing = this.state.get(channelId);
    if (!existing || existing.lastAppliedAt !== attemptedAt) return;
    // A newer name queued while Discord was answering is not the failed intent.
    const pending = existing.name === name ? '' : existing.name;
    if (!pending && existing.previousAppliedAt === Number.NEGATIVE_INFINITY) {
      this.state.delete(channelId);
    } else {
      this.state.set(channelId, { ...existing, name: pending, lastAppliedAt: existing.previousAppliedAt });
    }
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
