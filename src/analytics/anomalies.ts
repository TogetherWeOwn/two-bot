/**
 * Days that are not community behaviour.
 *
 * A prune, a raid cleanup or a ban wave puts hundreds of leaves on the board in
 * an afternoon. Averaged in, it makes every retention and churn number we print
 * look worse than the community actually is, and it does it silently.
 *
 * So: known one-off days are listed here, excluded from the baselines, and
 * always reported on their own line so nobody can mistake exclusion for hiding.
 * Nothing is deleted - the events stay in the database exactly as recorded.
 *
 * `status` is the honest part. `unconfirmed` means we can see the spike but no
 * human has told us what it was; the report says so every time it prints. Once
 * someone confirms the cause, set the label and flip it to `confirmed`.
 */

export type AnomalyStatus = 'confirmed' | 'unconfirmed';

export interface Anomaly {
  id: string;
  /** First affected UTC day, inclusive. `YYYY-MM-DD`. */
  start: string;
  /** Last affected UTC day, inclusive. `YYYY-MM-DD`. */
  end: string;
  /** Which event types this window swallows. Everything else still counts. */
  eventTypes: string[];
  status: AnomalyStatus;
  /** What it was. For an unconfirmed window, what it looks like. */
  label: string;
  note: string;
}

export const ANOMALIES: Anomaly[] = [
  {
    id: '2025-07-06-raid',
    start: '2025-07-06',
    end: '2025-07-06',
    eventTypes: ['member_join'],
    status: 'confirmed',
    label: 'Bot raid: 1,015 accounts joined in 56 minutes',
    note:
      'Every one of them arrived between 20:31 and 21:27 UTC. Not one has ever ' +
      'posted a message or entered a voice channel, and 976 were removed a ' +
      'month later in the 2025-08 cleanup. That is an automated mass-join, not ' +
      'people. It was 56% of every join the server had on record, so leaving ' +
      'it in made real retention look three times worse than it is.',
  },
  {
    id: '2025-08-raid-cleanup',
    start: '2025-08-05',
    end: '2025-08-06',
    eventTypes: ['member_leave'],
    status: 'confirmed',
    label: 'Cleanup of the 2025-07-06 raid: 1,009 removals in two days',
    note:
      '976 of the 1,009 are accounts from the raid a month earlier, which is ' +
      'what a prune or ban wave looks like from the outside. Members choosing ' +
      'to leave do not do it 500 at a time. Paired with 2025-07-06-raid; if ' +
      'one window is ever changed, check the other.',
  },
  {
    id: '2025-12-15-raid',
    start: '2025-12-15',
    end: '2025-12-15',
    eventTypes: ['member_join'],
    status: 'unconfirmed',
    label: 'Suspected bot raid: 15 accounts joined in 7 seconds',
    note:
      'All 15 arrived between 21:16:49 and 21:16:56 UTC and every one is still ' +
      'in the server. Not one has ever posted or entered voice. Usernames ' +
      'follow the same firstname-lastname-digits pattern as the confirmed ' +
      '2025-07-06 raid (heatherbrooks0010, annamartinez0652, ginamoreno0451). ' +
      'Unconfirmed only because nobody has told us what it was - the shape is ' +
      'not ambiguous. Not one was cleaned up: all 15 are still in the member ' +
      'count Discord shows, alongside 11 survivors of 2025-07-06 and 4 of ' +
      '2025-09-12. 30 of the server\'s 84 "humans" are raid accounts.',
  },
  {
    id: '2025-09-12-raid',
    start: '2025-09-12',
    end: '2025-09-12',
    eventTypes: ['member_join'],
    status: 'unconfirmed',
    label: 'Suspected bot raid: 15 accounts joined in 6 seconds',
    note:
      '17:42:59 to 17:43:04 UTC. Same username pattern and same never-active ' +
      'profile as 2025-12-15. Eleven were cleaned up; 4 are still in the ' +
      'server. Listed so all three raid clusters are counted the same way.',
  },
  {
    id: '2024-06-03-prune',
    start: '2024-06-03',
    end: '2024-06-03',
    eventTypes: ['member_leave'],
    status: 'confirmed',
    label: 'Inactivity prune: 64 removals in 16 minutes',
    note:
      '23:01 to 23:17 UTC, median tenure 275 days. Long-standing members do ' +
      'not all walk out inside a quarter of an hour - this is the server ' +
      'pruning, and counting it as churn blames the community for it.',
  },
  {
    id: '2023-05-23-prune',
    start: '2023-05-23',
    end: '2023-05-23',
    eventTypes: ['member_leave'],
    status: 'confirmed',
    label: 'Inactivity prune: 47 removals in 7 minutes',
    note: '20:12 to 20:19 UTC. Same shape as 2024-06-03-prune.',
  },
];

/**
 * Deliberately NOT listed, so nobody has to rediscover why:
 *
 *   2023-07-30 (52), 2024-01-24 (42), 2023-05-29 (38) are also unusually heavy
 *   leave days, but each is spread over four to six hours with mixed tenure.
 *   That could be a slow prune or it could be a real bad week, and guessing
 *   would be inventing good news. They stay in the baselines, and the funnel
 *   report flags them as UNLABELLED every time it runs.
 */

/** Half-open ISO instants `[from, to)` covering the whole of every listed day. */
export function windowBounds(a: Pick<Anomaly, 'start' | 'end'>): { from: string; to: string } {
  const from = `${a.start}T00:00:00.000Z`;
  const to = new Date(`${a.end}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from, to: to.toISOString() };
}

/** True if this event falls inside a listed window. */
export function isExcluded(
  occurredAt: string,
  eventType: string,
  anomalies: Anomaly[] = ANOMALIES,
): boolean {
  return anomalies.some((a) => {
    if (!a.eventTypes.includes(eventType)) return false;
    const { from, to } = windowBounds(a);
    return occurredAt >= from && occurredAt < to;
  });
}

/**
 * A SQL fragment that drops the listed windows, plus its parameters. Appended
 * to an existing WHERE, so it always starts with AND. Empty when the event type
 * has no windows, which keeps the caller free of special cases.
 *
 * `column` is for querying the `members` projection instead of the event log:
 * the raid windows are defined by when people joined, and in `members` that
 * instant is called `joined_at`.
 */
export function excludeClause(
  eventType: string,
  anomalies: Anomaly[] = ANOMALIES,
  column = 'occurred_at',
): { sql: string; params: string[] } {
  const hits = anomalies.filter((a) => a.eventTypes.includes(eventType));
  if (hits.length === 0) return { sql: '', params: [] };
  const params: string[] = [];
  const terms = hits.map((a) => {
    const { from, to } = windowBounds(a);
    params.push(from, to);
    return `(${column} >= ? AND ${column} < ?)`;
  });
  return { sql: ` AND NOT (${terms.join(' OR ')})`, params };
}

export interface Spike {
  day: string;
  count: number;
  /** How many times the typical day this was. */
  factor: number;
  /** Already listed in ANOMALIES for this event type. */
  known: boolean;
}

export interface SpikeOptions {
  /** A day must beat this multiple of the median active day. */
  factor?: number;
  /** ...and clear this floor, so a quiet server does not cry wolf at 3 leaves. */
  floor?: number;
  anomalies?: Anomaly[];
}

/**
 * Find days that do not look like the others.
 *
 * Median of the days that had any activity at all, not of the calendar - a
 * server that logs nothing for a week would otherwise have a median of zero and
 * flag every ordinary day after it.
 *
 * Pure on purpose: the caller reads the timestamps, this decides what is odd,
 * and the test needs no database.
 */
export function detectSpikes(
  occurredAts: string[],
  eventType: string,
  opts: SpikeOptions = {},
): Spike[] {
  const { factor = 10, floor = 20, anomalies = ANOMALIES } = opts;
  const perDay = new Map<string, number>();
  for (const ts of occurredAts) {
    const day = ts.slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  if (perDay.size === 0) return [];

  const counts = [...perDay.values()].sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  const median =
    counts.length % 2 === 1 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
  const bar = Math.max(floor, median * factor);

  return [...perDay.entries()]
    .filter(([, n]) => n >= bar)
    .map(([day, n]) => ({
      day,
      count: n,
      factor: median > 0 ? n / median : n,
      known: isExcluded(`${day}T12:00:00.000Z`, eventType, anomalies),
    }))
    .sort((a, b) => b.count - a.count);
}
