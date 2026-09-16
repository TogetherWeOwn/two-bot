/**
 * Reading the repeatable voice session log (TOG-99).
 *
 * Two questions, and they want different answers:
 *
 *   "who actually comes back"  -> frequency(): sessions per member
 *   "when should we run it"    -> attendanceGrid(): day-of-week x hour
 *
 * Pure functions over rows, deliberately: bucketing a few thousand timestamps
 * in JS is free and keeps the reporting rules easy to test. Same reasoning as
 * detectSpikes in anomalies.ts.
 *
 * The ranking rule that matters is in bestSlot(): slots rank by DISTINCT
 * MEMBERS first and sessions second. One person who hops in and out of voice
 * eleven times on a Tuesday is eleven sessions and one attendee, and picking
 * the community's event time off that would be picking it off one person.
 */

export interface SessionRow {
  memberId: string;
  /** ISO-8601 UTC, the moment the member entered voice. */
  occurredAt: string;
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// --- how often do people turn up ------------------------------------------

export interface Frequency {
  /** Distinct members seen in voice at all. */
  members: number;
  /** Total visits. */
  sessions: number;
  /** Members with exactly one visit ever. */
  once: number;
  /** Members with 2-3 visits. */
  occasional: number;
  /** Members with 4 or more visits - the regulars. */
  regular: number;
  /** Busiest members first. */
  top: Array<{ memberId: string; sessions: number }>;
}

export function frequency(rows: readonly SessionRow[], topN = 10): Frequency {
  const perMember = new Map<string, number>();
  for (const r of rows) perMember.set(r.memberId, (perMember.get(r.memberId) ?? 0) + 1);

  let once = 0;
  let occasional = 0;
  let regular = 0;
  for (const n of perMember.values()) {
    if (n === 1) once++;
    else if (n <= 3) occasional++;
    else regular++;
  }

  const top = [...perMember.entries()]
    .map(([memberId, sessions]) => ({ memberId, sessions }))
    // memberId as the tiebreak so the output is stable run to run.
    .sort((a, b) => b.sessions - a.sessions || a.memberId.localeCompare(b.memberId))
    .slice(0, topN);

  return { members: perMember.size, sessions: rows.length, once, occasional, regular, top };
}

// --- when do they turn up --------------------------------------------------

export interface Slot {
  /** 0 = Sunday, matching Date#getUTCDay. */
  day: number;
  /** 0-23, in whatever offset the grid was built with. */
  hour: number;
  sessions: number;
  /** Distinct members. The number that should decide an event time. */
  members: number;
}

/**
 * @param offsetMinutes minutes to add to UTC before bucketing. The stored
 *   timestamps are UTC; a human picking an event time is not thinking in UTC,
 *   and quietly reporting one as the other is how a schedule ends up an hour
 *   wrong twice a year. The caller must say which it wants and the report must
 *   print it.
 */
export function attendanceGrid(rows: readonly SessionRow[], offsetMinutes = 0): Slot[] {
  const cells = new Map<string, { day: number; hour: number; sessions: number; members: Set<string> }>();
  for (const r of rows) {
    const t = Date.parse(r.occurredAt);
    if (Number.isNaN(t)) continue; // a malformed row must not shift the grid
    const shifted = new Date(t + offsetMinutes * 60_000);
    const day = shifted.getUTCDay();
    const hour = shifted.getUTCHours();
    const k = `${day}:${hour}`;
    let cell = cells.get(k);
    if (!cell) {
      cell = { day, hour, sessions: 0, members: new Set() };
      cells.set(k, cell);
    }
    cell.sessions++;
    cell.members.add(r.memberId);
  }

  return [...cells.values()]
    .map((c) => ({ day: c.day, hour: c.hour, sessions: c.sessions, members: c.members.size }))
    .sort((a, b) => b.members - a.members || b.sessions - a.sessions || a.day - b.day || a.hour - b.hour);
}

/** The slot most people are actually in voice. Null when there is no data. */
export function bestSlot(slots: readonly Slot[]): Slot | null {
  return slots[0] ?? null;
}

/** `Sun 19:00`. Fixed width, so a column of these lines up. */
export function slotLabel(s: Slot): string {
  return `${DAY_NAMES[s.day]} ${String(s.hour).padStart(2, '0')}:00`;
}

/** `UTC+00:00`. Kept separate from slotLabel so a table can say it once. */
export function zoneLabel(offsetMinutes = 0): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// --- how much of the answer we are actually entitled to --------------------

export interface Coverage {
  firstObserved: string | null;
  lastObserved: string | null;
  /** Distinct UTC calendar days on which we recorded at least one session. */
  observedDays: number;
}

/**
 * What period the log actually covers.
 *
 * This is the guard against the report's worst failure mode: the listener runs
 * for two days, both of them Sundays, and the grid confidently says "Sunday".
 * A caller must print this next to any recommendation.
 */
export function coverage(rows: readonly SessionRow[]): Coverage {
  const days = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  for (const r of rows) {
    if (Number.isNaN(Date.parse(r.occurredAt))) continue;
    days.add(r.occurredAt.slice(0, 10));
    if (first === null || r.occurredAt < first) first = r.occurredAt;
    if (last === null || r.occurredAt > last) last = r.occurredAt;
  }
  return { firstObserved: first, lastObserved: last, observedDays: days.size };
}

/**
 * Whether the grid has seen enough to be worth acting on.
 *
 * Four weeks of coverage is the bar for a day-of-week claim: anything less and
 * a single unusual week is the whole signal. Stated as a function rather than
 * left to the reader's judgement so the report says the same thing every time.
 */
export const MIN_OBSERVED_DAYS_FOR_DOW = 28;

export function dowClaimIsSupported(c: Coverage): boolean {
  if (!c.firstObserved || !c.lastObserved) return false;
  const spanDays = (Date.parse(c.lastObserved) - Date.parse(c.firstObserved)) / 86_400_000;
  return spanDays >= MIN_OBSERVED_DAYS_FOR_DOW;
}
