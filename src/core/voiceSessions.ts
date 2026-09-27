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

// --- duration averages (TOG-5684) -------------------------------------------
//
// EVENTS.md warns to filter on `startKnown` before averaging durations, but a
// warning is not enforcement: every averaging query has to remember it, and
// the one that forgets silently includes nulls (or outage-shortened numbers)
// in a mean. This section is the single enforcement point. Every report that
// averages voice durations - scripts/voice-sessions.ts, scripts/funnel.ts and
// scripts/dashboard.ts (via src/analytics/dashboard.ts) - parses its end rows
// with `parseVoiceEndMetadata` and averages with `averageKnownVoiceDuration`.
// There is no other supported path from an end row to a mean.
//
// The filter is on the FLAG, not on the duration being null. An unknown-start
// end carries `durationSeconds: null` today, but the enforcement must not
// depend on that staying true: a row with `startKnown: false` and a numeric
// duration is still excluded, because we never saw the start and any number
// on it is unproven.

/** The only two fields any duration average may read from an end row. */
export interface VoiceDurationRow {
  /** False means the bot never saw the start - excluded from every average. */
  startKnown: boolean;
  /** Seconds, or null when unmeasured. */
  durationSeconds: number | null;
}

/**
 * Parse one `voice_session_end` metadata blob into the shape averages read.
 *
 * Unparseable metadata defaults to `startKnown: true` with no duration: we
 * must not claim the start is unknown when the row itself is unreadable, and
 * a row with no duration contributes nothing to a mean either way. This
 * matches the reconcile path's long-standing rule in scripts/voice-sessions.ts.
 */
export function parseVoiceEndMetadata(metadata: string | null): VoiceDurationRow {
  try {
    const m = JSON.parse(metadata ?? '{}') as { startKnown?: unknown; durationSeconds?: unknown };
    const raw = m.durationSeconds;
    const durationSeconds =
      typeof raw === 'number' ? raw : raw === null || raw === undefined ? null : Number(raw);
    return {
      startKnown: m.startKnown !== false,
      durationSeconds: typeof durationSeconds === 'number' ? durationSeconds : null,
    };
  } catch {
    return { startKnown: true, durationSeconds: null };
  }
}

/**
 * The durations that may enter a mean: known-start ends with a finite,
 * non-negative duration. Everything else - unknown starts (even with a
 * number), nulls, negatives, NaNs - is dropped, never zero-filled. A
 * zero-filled unknown would drag the mean down with invented data; dropping
 * it keeps the mean a statement about measured sessions only.
 */
export function knownVoiceDurations(rows: readonly VoiceDurationRow[]): number[] {
  const out: number[] = [];
  for (const r of rows) {
    if (r.startKnown === false) continue;
    // Explicit null check BEFORE Number(): Number(null) is 0, and an
    // unmeasured duration entering a mean as a zero is exactly the silent
    // corruption this helper exists to prevent.
    if (r.durationSeconds === null || r.durationSeconds === undefined) continue;
    const d = Number(r.durationSeconds);
    if (!Number.isFinite(d) || d < 0) continue;
    out.push(d);
  }
  return out;
}

/**
 * Mean duration over known-start sessions only. Null when no measured
 * session exists - "no measured sessions" is not a zero-second average.
 */
export function averageKnownVoiceDuration(rows: readonly VoiceDurationRow[]): number | null {
  const known = knownVoiceDurations(rows);
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0) / known.length;
}

/** One call per report: the mean plus the two counts that prove it is honest. */
export interface VoiceDurationSummary {
  /** Mean over known-start sessions only; null when none measured. */
  averageSeconds: number | null;
  /** Known-start sessions with a usable duration that entered the mean. */
  measured: number;
  /** `startKnown: false` ends excluded before averaging. Counted, never averaged. */
  excludedUnknownStarts: number;
}

export function summarizeVoiceDurations(rows: readonly VoiceDurationRow[]): VoiceDurationSummary {
  return {
    averageSeconds: averageKnownVoiceDuration(rows),
    measured: knownVoiceDurations(rows).length,
    excludedUnknownStarts: rows.filter((r) => r.startKnown === false).length,
  };
}

/** `47m`, `2h05m`, `45s` - compact enough for a report column. */
export function formatVoiceDurationSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}
