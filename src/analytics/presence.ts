/**
 * Reading the presence series (TOG-469).
 *
 * Pure functions over readings. No database, no Discord, no clock - `now` is
 * always passed in, so a verdict is reproducible and a test can stand at any
 * point in time.
 *
 * This file exists because the trigger that would reopen the presence-intent
 * question has a NUMBER in it, and a number in prose gets re-improvised every
 * time somebody reads it. TOG-469 says "sustains peaks >= 45". That sentence
 * is not decidable as written - over what window, how many times, peak of
 * what? So it is decided once, here, with the reasoning attached, and
 * `evaluateTrigger()` is the only thing allowed to answer the question.
 */

/** One stored reading. The bot floor is null on most rows - see migration 0004. */
export interface PresenceReading {
  /** ISO-8601 UTC. */
  observedAt: string;
  /** Discord's `approximate_presence_count`. Includes bots. */
  presence: number;
  /** Members with `user.bot` true, or null if this cycle did not rescan. */
  botFloor: number | null;
}

/**
 * The reopen threshold from TOG-469: `approximate_presence_count` peaks at or
 * above this argue roughly 20+ humans online at once against a ~23 bot floor.
 * Raw Discord number, bots included - compare it to a raw reading, never to a
 * human estimate.
 */
export const REOPEN_PEAK_THRESHOLD = 45;

/**
 * "Sustains", made decidable. One good evening is a LAN party, not a change in
 * the community - and a single spike is exactly the thin evidence this
 * instrument exists to replace. Three separate days inside a fortnight is the
 * cheapest rule that cannot be satisfied by one unusual night.
 */
export const REOPEN_REQUIRED_DAYS = 3;
export const REOPEN_WINDOW_DAYS = 14;

/**
 * Below this many observed days in the window we decline to answer at all.
 *
 * A quiet Tuesday is not evidence, and neither is a collector that has been up
 * for two hours. Reporting `closed` off three readings would let the
 * instrument manufacture the very "one reading, standing decision" problem it
 * was built to fix - so a thin window is `insufficient_data`, which is a
 * different sentence from "we looked and the answer is no".
 */
export const MIN_DAYS_FOR_A_VERDICT = 7;

export type TriggerStatus =
  /** Not enough of a series yet to say anything. */
  | 'insufficient_data'
  /** We looked, and presence is not close. C stands, now on evidence. */
  | 'closed'
  /** The numbers qualify but `web_v1` is not live, so the other half fails. */
  | 'armed'
  /** Both halves hold. Reopen option A. */
  | 'fires';

export interface DailyPeak {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  peak: number;
  low: number;
  readings: number;
  /** True if this day's peak reached REOPEN_PEAK_THRESHOLD. */
  qualifies: boolean;
}

export interface TriggerVerdict {
  status: TriggerStatus;
  /** Days inside the window whose peak reached the threshold. */
  qualifyingDays: number;
  requiredDays: number;
  threshold: number;
  windowDays: number;
  /** Distinct UTC days that have at least one reading inside the window. */
  daysObserved: number;
  readingsInWindow: number;
  /** Highest reading in the window, or null if there were none. */
  peak: number | null;
  peakAt: string | null;
  /** Most recent known bot floor, or null if we have never recorded one. */
  botFloor: number | null;
  /** The second half of the trigger, which no instrument can observe. */
  webV1Live: boolean;
  /** One sentence, safe to paste into an issue comment. */
  reason: string;
}

/** UTC calendar day of an ISO timestamp. Slicing is correct only for UTC input. */
export function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Group readings into UTC days, oldest first.
 *
 * Daily PEAK rather than daily mean is deliberate: the question is whether the
 * community is ever busy enough to be worth a headline, and an average over 24
 * hours is dominated by the small hours in every timezone at once.
 */
export function dailyPeaks(
  readings: PresenceReading[],
  threshold: number = REOPEN_PEAK_THRESHOLD,
): DailyPeak[] {
  const byDay = new Map<string, { peak: number; low: number; readings: number }>();
  for (const r of readings) {
    const day = utcDay(r.observedAt);
    const cur = byDay.get(day);
    if (!cur) {
      byDay.set(day, { peak: r.presence, low: r.presence, readings: 1 });
    } else {
      cur.peak = Math.max(cur.peak, r.presence);
      cur.low = Math.min(cur.low, r.presence);
      cur.readings++;
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({ date, ...v, qualifies: v.peak >= threshold }));
}

/** The most recent bot floor we actually observed, or null. See migration 0004. */
export function latestBotFloor(readings: PresenceReading[]): number | null {
  let best: { at: string; floor: number } | null = null;
  for (const r of readings) {
    if (r.botFloor === null) continue;
    if (!best || r.observedAt > best.at) best = { at: r.observedAt, floor: r.botFloor };
  }
  return best?.floor ?? null;
}

export interface TriggerOptions {
  /** ISO-8601. Required: a verdict must be reproducible. */
  now: string;
  /**
   * Whether the website is actually serving. Nothing in this repo can observe
   * that - the contract views existing is not the same as a live site - so it
   * is an input a human supplies, and it defaults to false so the trigger
   * cannot fire by accident on a number alone.
   */
  webV1Live?: boolean;
  threshold?: number;
  requiredDays?: number;
  windowDays?: number;
  minDays?: number;
}

/**
 * Decide whether TOG-469's reopen condition is met.
 *
 * Both halves must hold: `web_v1` live AND presence sustaining peaks at or
 * above the threshold. Returning `armed` when only the numbers qualify keeps
 * those two failures distinguishable, which matters because they need
 * completely different follow-ups.
 */
export function evaluateTrigger(
  readings: PresenceReading[],
  opts: TriggerOptions,
): TriggerVerdict {
  const threshold = opts.threshold ?? REOPEN_PEAK_THRESHOLD;
  const requiredDays = opts.requiredDays ?? REOPEN_REQUIRED_DAYS;
  const windowDays = opts.windowDays ?? REOPEN_WINDOW_DAYS;
  const minDays = opts.minDays ?? MIN_DAYS_FOR_A_VERDICT;
  const webV1Live = opts.webV1Live ?? false;

  const cutoff = new Date(new Date(opts.now).getTime() - windowDays * 86_400_000).toISOString();
  const window = readings.filter((r) => r.observedAt >= cutoff && r.observedAt <= opts.now);

  const days = dailyPeaks(window, threshold);
  const qualifyingDays = days.filter((d) => d.qualifies).length;

  let peak: number | null = null;
  let peakAt: string | null = null;
  for (const r of window) {
    if (peak === null || r.presence > peak) {
      peak = r.presence;
      peakAt = r.observedAt;
    }
  }

  // The floor is taken from the WHOLE series, not the window. It is a slow
  // property of the server, and the newest one we know is the best answer even
  // if this fortnight happened not to rescan.
  const botFloor = latestBotFloor(readings);

  const base = {
    qualifyingDays,
    requiredDays,
    threshold,
    windowDays,
    daysObserved: days.length,
    readingsInWindow: window.length,
    peak,
    peakAt,
    botFloor,
    webV1Live,
  };

  if (days.length < minDays) {
    return {
      ...base,
      status: 'insufficient_data',
      reason:
        `Only ${days.length} of the ${minDays} days needed for a verdict have readings ` +
        `in the trailing ${windowDays} days. Not enough series to say anything yet.`,
    };
  }

  if (qualifyingDays < requiredDays) {
    return {
      ...base,
      status: 'closed',
      reason:
        `${qualifyingDays} of the required ${requiredDays} days peaked at >= ${threshold} ` +
        `in the trailing ${windowDays} days (best reading ${peak ?? 'none'}` +
        `${botFloor === null ? '' : `, bot floor ${botFloor}`}). ` +
        `TOG-75 option C stands, now on a series rather than one reading.`,
    };
  }

  if (!webV1Live) {
    return {
      ...base,
      status: 'armed',
      reason:
        `Presence qualifies - ${qualifyingDays} days peaked at >= ${threshold} in the ` +
        `trailing ${windowDays} days - but the trigger also requires web_v1 to be live, ` +
        `which was not asserted. No action yet; re-run with --web-live once it ships.`,
    };
  }

  return {
    ...base,
    status: 'fires',
    reason:
      `Both halves hold: web_v1 is live and ${qualifyingDays} days peaked at >= ${threshold} ` +
      `in the trailing ${windowDays} days (best ${peak}` +
      `${botFloor === null ? '' : `, bot floor ${botFloor}`}). ` +
      `Reopen TOG-75 option A against the CISO's controls 1-5 - do not re-derive them.`,
  };
}
