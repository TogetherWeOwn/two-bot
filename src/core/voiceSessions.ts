/**
 * Who is in a voice channel right now, so `voice_session_end` can carry a
 * duration (TOG-99).
 *
 * In memory on purpose. Discord serves no voice history over REST, so the only
 * thing that can tell us a session started is the gateway event we already saw.
 * A restart therefore loses every open session, and the honest thing to emit
 * afterwards is `durationSeconds: null` - not a duration measured from the
 * moment the process happened to come up, which would look like a real number
 * and be short by however long the bot was down.
 *
 * That is why the end event carries `startKnown`. A query that averages
 * durations must filter on it; a query that only counts sessions does not care.
 *
 * One entry per member per guild: Discord allows a member exactly one voice
 * channel at a time, so a move from A to B is an end for A then a start for B.
 */

export interface OpenSession {
  /** The channel the session is in - the one the END should be credited to. */
  channelId: string;
  /** ISO-8601 UTC. */
  startedAt: string;
  /** Durable scorecard key for this exact Discord voice interval. */
  sessionKey?: string;
}

function key(guildId: string, memberId: string): string {
  return `${guildId}:${memberId}`;
}

export class VoiceSessionTracker {
  // NB: explicit field, not a parameter property - Node's type-stripping
  // loader rejects those. Same constraint as EventStore. See docs/STACK.md.
  private open: Map<string, OpenSession>;

  constructor() {
    this.open = new Map();
  }

  /** Record that a member is now in voice. Replaces any session already open. */
  start(guildId: string, memberId: string, channelId: string, startedAt: string, sessionKey?: string): void {
    this.open.set(key(guildId, memberId), { channelId, startedAt, sessionKey });
  }

  /**
   * Close the open session and return what we knew about it.
   * `null` means we never saw the start - the bot came up mid-session, or the
   * member was already in voice when we connected.
   */
  end(guildId: string, memberId: string): OpenSession | null {
    const k = key(guildId, memberId);
    const session = this.open.get(k) ?? null;
    this.open.delete(k);
    return session;
  }

  /** Whether we are holding an open session for this member. */
  isOpen(guildId: string, memberId: string): boolean {
    return this.open.has(key(guildId, memberId));
  }

  /** How many sessions we believe are open. Diagnostics and tests. */
  get openCount(): number {
    return this.open.size;
  }

  /** Drop everything. Used when the gateway reconnects and state is suspect. */
  clear(): void {
    this.open.clear();
  }
}

// --- blind-window reconcile (TOG-5683) --------------------------------------
//
// EVENTS.md limit 5: a voice gap while the bot is down can never be recovered.
// Discord serves no voice history over REST, so sessions that happened mid-gap
// are gone, not merely unrecorded. What CAN be quantified is the gap itself:
// the bot's own append-only write series (`events.recorded_at` - every row is
// proof the bot was alive to write it) shows exactly when it stopped looking,
// and every `voice_session_end` with `startKnown: false` after a gap is a
// session that gap made unmeasurable.
//
// Pure functions over caller-supplied rows, deliberately - same reasoning as
// the analytics in src/analytics/voiceSessions.ts. The script feeds them the
// event timestamps and the end rows; the tests feed them fixtures.
//
// NOTE (TOG-469 containment): the hourly instrument table is deliberately NOT
// a source here - only its collector, reader, migration and own script/test
// may name it. The events write series is coarser - a quiet stretch with no
// writes reads as a gap - and the report says so.
//
// Two honesty rules shape the counting:
//   1. An unknown-start end is ATTRIBUTED, never averaged. The functions below
//      do not take durations at all, so there is no number here that could
//      silently include a null in a mean.
//   2. The bot writes nothing while it is down, so an end recorded during a
//      window is the rare case, not the norm: the common unknown end is a
//      member who was already in voice when the bot came back and left later.
//      Each unknown end therefore counts toward the latest window that started
//      at or before it, not toward the window containing it. An end older than
//      every window predates the heartbeat history and is counted nowhere
//      rather than guessed somewhere.

/** One interval in which the bot was not looking. */
export interface BlindWindow {
  /** ISO-8601 UTC of the last heartbeat before the gap. */
  start: string;
  /** ISO-8601 UTC of the first heartbeat after the gap. */
  end: string;
  /** `end` minus `start` in milliseconds. */
  gapMs: number;
}

/** A blind window plus the unknown-start ends attributed to it. */
export interface BlindWindowCount extends BlindWindow {
  /** `voice_session_end` rows with `startKnown: false`. A count, never an average. */
  unknownStarts: number;
}

/** The only two fields the reconcile needs from an end row. No duration. */
export interface UnknownEnd {
  /** ISO-8601 UTC. */
  occurredAt: string;
  startKnown: boolean;
}

/**
 * Write-series cadence breach that declares a blind window.
 *
 * The default suits an approximately hourly write series: a breach at twice
 * the cadence tolerates one missed tick plus jitter without declaring an
 * outage. Callers over a denser series (every bot write) pass their own
 * value; callers over a sparser one do the same.
 */
export const DEFAULT_BLIND_WINDOW_MAX_GAP_MS = 2 * 60 * 60 * 1000;

/** Every gap between consecutive heartbeats wider than `maxGapMs`. Sorted oldest first. */
export function findBlindWindows(
  heartbeats: readonly string[],
  maxGapMs: number = DEFAULT_BLIND_WINDOW_MAX_GAP_MS,
): BlindWindow[] {
  const times = [...new Set(heartbeats)]
    .map((s) => ({ s, t: Date.parse(s) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);
  const windows: BlindWindow[] = [];
  for (let i = 1; i < times.length; i++) {
    const gapMs = times[i].t - times[i - 1].t;
    if (gapMs > maxGapMs) windows.push({ start: times[i - 1].s, end: times[i].s, gapMs });
  }
  return windows;
}

/**
 * Attribute each `startKnown: false` end to the latest window that started at
 * or before it. Known-start ends are ignored; malformed timestamps are
 * skipped; ends older than every window are left unattributed (they still come
 * back in the unattributed count the caller derives, so the numbers reconcile).
 */
export function countUnknownStartsPerWindow(
  windows: readonly BlindWindow[],
  ends: readonly UnknownEnd[],
): BlindWindowCount[] {
  const counts: BlindWindowCount[] = windows.map((w) => ({ ...w, unknownStarts: 0 }));
  const starts = counts.map((w) => Date.parse(w.start));
  for (const e of ends) {
    if (e.startKnown !== false) continue;
    const t = Date.parse(e.occurredAt);
    if (Number.isNaN(t)) continue;
    let best = -1;
    for (let i = 0; i < counts.length; i++) {
      if (starts[i] <= t) best = i;
      else break;
    }
    if (best >= 0) counts[best].unknownStarts++;
  }
  return counts;
}

/** One line per window, each naming the window and its count. */
export function renderReconcileReport(counts: readonly BlindWindowCount[]): string[] {
  if (counts.length === 0) {
    return ['  No blind windows in heartbeat history - nothing the bot missed that we can see.'];
  }
  return counts.map(
    (w) =>
      `  Blind window ${w.start} -> ${w.end} ` +
      `(${(w.gapMs / 3_600_000).toFixed(1)}h gap): ` +
      `${w.unknownStarts} session(s) with unknown start (counted, never averaged)`,
  );
}
