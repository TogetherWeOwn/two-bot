/**
 * Staff-alert burst throttle (TOG-9988).
 *
 * Why this exists: the containment and join-risk announcers post one
 * staff-channel message per alert. During a raid-scale burst that is dozens
 * of posts in seconds - a pager storm that buries the one message anyone
 * needs. This module bounds the send rate per guild and coalesces the
 * overflow into a single digest that preserves the security-relevant facts
 * (how many, which executors, worst outcome, peak heat), so nothing is
 * silently dropped. Per-event detail always remains in the database
 * (`containment_events`, `join_risk_flags`); the digest says so.
 *
 * Framework-free on purpose: the same throttle wraps any alert type and is
 * fully testable with a fake clock - no Discord, no database, no timers.
 * Timely delivery of a trailing digest (a burst with no further alerts) is
 * the caller's job: call `flush()` on an interval. See `src/index.ts`.
 */

import type { ContainmentAlert, JoinRiskAlert } from './containment.ts';

/** One guild's staff-channel budget: this many posts per this long, then digests. */
export const STAFF_ALERT_BURST_WINDOW_MS = 60_000;
export const STAFF_ALERT_BURST_MAX_SENDS = 3;
/** Cap on buffered suppressed alerts per guild. The digest count is always exact. */
export const STAFF_ALERT_BURST_MAX_BUFFERED = 200;
/** How many distinct executors / reasons a digest names before counting the rest. */
const DIGEST_LIST_CAP = 10;

export interface AlertBurstThrottleOptions<T> {
  /** Per-guild window in ms. Defaults to STAFF_ALERT_BURST_WINDOW_MS. */
  windowMs?: number;
  /** Alerts forwarded per guild per window before coalescing starts. */
  maxSendsPerWindow?: number;
  /** Cap on buffered suppressed alerts per guild; the count stays exact. */
  maxBufferedPerGuild?: number;
  /** Clock, so tests can run a burst without sleeping. */
  now?: () => number;
  /** Guild the alert belongs to. Budgets are per key. */
  keyOf: (alert: T) => string;
  /** Build the one digest that replaces `totalSuppressed` alerts. */
  summarize: (guildId: string, sample: T[], totalSuppressed: number) => T;
}

interface GuildWindow<T> {
  windowStart: number;
  sent: number;
  buffered: T[];
  suppressedTotal: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

/**
 * Fixed-window per-key throttle with coalescing.
 *
 * The first `maxSendsPerWindow` alerts per key per window are forwarded
 * immediately. The rest are counted (and a bounded sample buffered) until the
 * window rolls over or `flush()` is called, at which point a single digest
 * built by `summarize` replaces them. A burst of any size therefore produces
 * at most `maxSendsPerWindow + 1` sends per window per key.
 */
export class AlertBurstThrottle<T> {
  private readonly windowMs: number;
  private readonly maxSends: number;
  private readonly maxBuffered: number;
  private readonly now: () => number;
  private readonly keyOf: (alert: T) => string;
  private readonly summarize: (guildId: string, sample: T[], totalSuppressed: number) => T;
  private readonly windows = new Map<string, GuildWindow<T>>();

  constructor(options: AlertBurstThrottleOptions<T>) {
    const windowMs = positiveInteger(options.windowMs, STAFF_ALERT_BURST_WINDOW_MS, 'windowMs');
    if (windowMs === 0) throw new Error('windowMs must be a non-negative integer.');
    this.windowMs = windowMs;
    this.maxSends = positiveInteger(options.maxSendsPerWindow, STAFF_ALERT_BURST_MAX_SENDS, 'maxSendsPerWindow');
    const maxBuffered = positiveInteger(options.maxBufferedPerGuild, STAFF_ALERT_BURST_MAX_BUFFERED, 'maxBufferedPerGuild');
    if (maxBuffered === 0) throw new Error('maxBufferedPerGuild must be a non-negative integer.');
    this.maxBuffered = maxBuffered;
    this.now = options.now ?? Date.now;
    this.keyOf = options.keyOf;
    this.summarize = options.summarize;
  }

  /** Alerts to forward right now, in order. Usually zero or one. */
  admit(alert: T): T[] {
    const at = this.now();
    const key = this.keyOf(alert);
    let state = this.windows.get(key);
    const out: T[] = [];
    if (!state || at - state.windowStart >= this.windowMs) {
      if (state && state.suppressedTotal > 0) {
        out.push(this.summarize(key, state.buffered, state.suppressedTotal));
      }
      state = { windowStart: at, sent: 0, buffered: [], suppressedTotal: 0 };
      this.windows.set(key, state);
    }
    if (state.sent < this.maxSends) {
      state.sent += 1;
      out.push(alert);
    } else {
      state.suppressedTotal += 1;
      if (state.buffered.length < this.maxBuffered) state.buffered.push(alert);
    }
    return out;
  }

  /**
   * Emit pending digests without waiting for the next alert. Empties the
   * buffers but keeps the window budgets, so a mid-window flush cannot be
   * used to smuggle extra posts past the bound.
   */
  flush(guildId?: string): T[] {
    const out: T[] = [];
    const keys = guildId === undefined ? [...this.windows.keys()] : [guildId];
    for (const key of keys) {
      const state = this.windows.get(key);
      if (!state || state.suppressedTotal === 0) continue;
      out.push(this.summarize(key, state.buffered, state.suppressedTotal));
      state.buffered = [];
      state.suppressedTotal = 0;
    }
    return out;
  }

  /** Suppressed-but-undelivered count, per guild or across all guilds. */
  pendingCount(guildId?: string): number {
    if (guildId !== undefined) return this.windows.get(guildId)?.suppressedTotal ?? 0;
    let total = 0;
    for (const state of this.windows.values()) total += state.suppressedTotal;
    return total;
  }
}

export interface ThrottledAnnouncer<T> {
  announce: (alert: T) => Promise<void>;
  flush: () => Promise<void>;
  pendingCount: (guildId?: string) => number;
}

/** Wrap a sender so a burst becomes bounded posts plus digests. Same signature in. */
export function withAlertBurstThrottle<T>(
  send: (alert: T) => Promise<void>,
  options: AlertBurstThrottleOptions<T>,
): ThrottledAnnouncer<T> {
  const throttle = new AlertBurstThrottle(options);
  return {
    announce: async (alert) => {
      for (const next of throttle.admit(alert)) await send(next);
    },
    flush: async () => {
      for (const next of throttle.flush()) await send(next);
    },
    pendingCount: (guildId?: string) => throttle.pendingCount(guildId),
  };
}

/** Lower wins: the outcome staff most need to see. Unknown outcomes surface first. */
const CONTAINMENT_OUTCOME_SEVERITY: Record<string, number> = {
  uncertain: 0,
  contained: 1,
  refused: 2,
  dry_run: 3,
};

function outcomeSeverity(outcome: string): number {
  return CONTAINMENT_OUTCOME_SEVERITY[outcome] ?? -1;
}

function cappedList(names: string[], total: number, label: string): string {
  const shown = names.slice(0, DIGEST_LIST_CAP).join(', ');
  const hidden = total - Math.min(total, names.length);
  return hidden > 0 ? `${shown} (…and ${hidden} more ${label})` : shown;
}

/**
 * One alert standing in for `totalSuppressed`. Reuses the worst outcome and
 * peak heat so the digest reads like the scariest thing it replaced, and says
 * where the per-event detail lives.
 */
export function summarizeContainmentBurst(
  guildId: string,
  sample: ContainmentAlert[],
  totalSuppressed: number,
): ContainmentAlert {
  const perExecutor = new Map<string, number>();
  const perAction = new Map<string, number>();
  let heat = 0;
  let threshold = 0;
  // Seed from the sample: seeding 'uncertain' would pin the digest there,
  // since the comparison below only ever replaces with equal-or-lower.
  let worst = sample[0]?.outcome ?? 'uncertain';
  for (const alert of sample) {
    const executor = alert.executorId ?? 'unknown';
    perExecutor.set(executor, (perExecutor.get(executor) ?? 0) + 1);
    perAction.set(alert.action, (perAction.get(alert.action) ?? 0) + 1);
    heat = Math.max(heat, alert.heat);
    threshold = Math.max(threshold, alert.threshold);
    if (outcomeSeverity(alert.outcome) <= outcomeSeverity(worst)) worst = alert.outcome;
  }
  const executors = cappedList(
    [...perExecutor.entries()].map(([id, count]) => `${id}×${count}`),
    perExecutor.size,
    'executors',
  );
  const action = [...perAction.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'member.kick';
  return {
    kind: 'containment',
    guildId,
    executorId: null,
    action: action as ContainmentAlert['action'],
    targetId: null,
    heat,
    threshold,
    outcome: worst,
    note: `Burst throttle coalesced ${totalSuppressed} alert(s): ${executors || 'no detail retained'}. `
      + `Worst outcome ${worst}, peak heat ${heat}/${threshold}. Per-event detail remains in containment_events.`,
  };
}

/** One flag standing in for `totalSuppressed`, keeping the peak score and distinct reasons. */
export function summarizeJoinRiskBurst(
  guildId: string,
  sample: JoinRiskAlert[],
  totalSuppressed: number,
): JoinRiskAlert {
  const members = new Set<string>();
  const reasons = new Set<string>();
  let score = 0;
  for (const alert of sample) {
    members.add(alert.memberId);
    score = Math.max(score, alert.score);
    for (const reason of alert.reasons) reasons.add(reason);
  }
  const reasonList = [...reasons];
  const shown = reasonList.slice(0, DIGEST_LIST_CAP);
  if (reasonList.length > shown.length) shown.push(`…and ${reasonList.length - shown.length} more distinct reasons`);
  shown.push(`${totalSuppressed} flag(s) coalesced by the burst throttle; per-join detail remains in join_risk_flags`);
  return {
    guildId,
    memberId: `${members.size} member(s)`,
    score,
    reasons: shown,
    bulkJoinWindow: false,
    note: `Burst throttle coalesced ${totalSuppressed} join-risk flag(s) across ${members.size} member(s), peak score ${score}.`,
  };
}

/** Announcer-shaped wrapper for containment alerts, keyed by guild. */
export function throttledContainmentAnnouncer(
  send: (alert: ContainmentAlert) => Promise<void>,
  overrides: Partial<AlertBurstThrottleOptions<ContainmentAlert>> = {},
): ThrottledAnnouncer<ContainmentAlert> {
  return withAlertBurstThrottle(send, {
    keyOf: (alert) => alert.guildId,
    summarize: summarizeContainmentBurst,
    ...overrides,
  });
}

/** Announcer-shaped wrapper for join-risk flags, keyed by guild. */
export function throttledJoinRiskAnnouncer(
  send: (alert: JoinRiskAlert) => Promise<void>,
  overrides: Partial<AlertBurstThrottleOptions<JoinRiskAlert>> = {},
): ThrottledAnnouncer<JoinRiskAlert> {
  return withAlertBurstThrottle(send, {
    keyOf: (alert) => alert.guildId,
    summarize: summarizeJoinRiskBurst,
    ...overrides,
  });
}
