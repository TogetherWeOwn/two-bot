/**
 * Growth attribution: click -> join -> AM7 -> AM30, per invite code.
 *
 * This is the arithmetic half of scripts/attribution.ts. It is pure on purpose
 * - the script reads rows, this decides what they mean, and the test needs no
 * database. Same split as anomalies.ts / funnel.ts.
 *
 * The two definitions were agreed on TWO-62 (document `roadmap-30d`) and are
 * implemented here verbatim, with every place the data forces an
 * interpretation called out in a comment and surfaced in the printed report.
 *
 *   AM7  (activation) - within 7 days of joining, had a first voice session
 *                       OR posted 3 or more messages. Voice alone qualifies;
 *                       one message does not. TWO is voice-first (495 voice
 *                       events against 15 text messages in 90 days), so this
 *                       asymmetry is deliberate, not sloppiness.
 *
 *   AM30 (retention)  - was AM7, is still in the server, and was active again
 *                       in the 30 days after joining. The only number that
 *                       counts as growth.
 *
 * WHAT THE DATA CANNOT YET DO, STATED ONCE HERE
 *
 *  1. "3 or more messages" is answered by `members.third_message_at`, which
 *     TWO-95 added: the moment a member's third message landed. A timestamp
 *     rather than a count, because the question is "by day 7?" and a running
 *     total cannot answer it - 40 messages today says nothing about day 7.
 *
 *     A record whose `thirdMessageAt` is null still falls back to
 *     first_message_at, which admits people who posted once or twice, and to
 *     that extent AM7 is still an upper bound. But null now means one specific,
 *     fixable thing - nobody has scanned that member's history since the change
 *     - and `npm run backfill:messages` is what fixes it. It is no longer a
 *     permanent property of the schema.
 *
 *     The roll-up splits AM7 three ways so a reader never has to guess which
 *     they are looking at: `am7Voice` and `am7Messages` are both exact, and
 *     `am7MessageProxy` is the residual that is still soft. When that residual
 *     is zero, AM7 is a count and can be quoted as one.
 *
 *  2. "active again in the 30 days after joining" needs every activity, and
 *     the events table cannot give it: first_message and first_voice_session
 *     are once-per-member by idempotency key, and member_inactive is emitted
 *     by a schedule rather than by the member. The repeatable signal is the
 *     `members.last_active_at` column, which src/core/handlers.ts advances on
 *     EVERY message and EVERY voice join, not just the first (touchActivity).
 *     That is what this reads. Decided on TWO-64 against the alternative of a
 *     new repeatable voice_session event - see the comment on that issue.
 *
 *     TOG-99 has since ADDED that event (voice_session_start/end) for the
 *     questions last_active_at cannot answer - how often, and at what time of
 *     day. AM30 still reads last_active_at and should keep doing so: the
 *     session events cover voice only and produce no rows for any period the
 *     bot was down, so switching AM30 onto them would silently under-report
 *     everyone who is active by message and everyone active during an outage.
 *
 *     last_active_at is a LAST value, so the rule has a floor and no ceiling:
 *
 *       AM30 = was AM7, left_at IS NULL, and last_active_at is at or after
 *              day 8 - i.e. they were still turning up after their first week.
 *
 *     The floor at day 8 is what stops "joined, did one thing on day 3, gone"
 *     from reading as retention. There is deliberately NO day-30 ceiling: a
 *     ceiling would score a member who joined two years ago and was in voice
 *     yesterday as NOT retained, penalising exactly the best-retained members.
 *     Being more active cannot make the number worse.
 *
 *     The cost of dropping the ceiling is that for a member last seen on day
 *     400 we cannot prove anything about days 8-30 specifically. So the
 *     roll-up splits the number: `am30ProvenInWindow` (last seen between day 8
 *     and day 30 - no inference at all) and `am30ProvenLater` (last seen after
 *     day 30 - certainly a returning member, but the 8-30 window itself is not
 *     observable). Both are printed. Neither reading is hidden.
 *
 *  3. A capture window in which several invite codes moved yields exact per-code
 *     JOIN COUNTS but no member<->code pairing (TWO-73). Those joins arrive here
 *     with `attributionExact: false` and are counted into `joinsInexact`, so a
 *     row can say "these 3 joins are real, the AM7 beside them is a set of 3
 *     people who may not all be mine". The joins column is never affected.
 */

export const AM7_WINDOW_DAYS = 7;
export const AM30_WINDOW_DAYS = 30;
/** Messages needed to activate on the text side. Voice needs one session. */
export const AM7_MESSAGE_THRESHOLD = 3;
/**
 * Day at which "active again" starts counting for AM30 - the day after the AM7
 * window closes. Activity inside the first week is activation, not retention.
 */
export const AM30_RETURN_FLOOR_DAYS = AM7_WINDOW_DAYS + 1;

const DAY_MS = 86_400_000;

/** One join, plus everything known about that member's activity afterwards. */
export interface JoinRecord {
  memberId: string;
  /** The join being credited. ISO-8601 UTC. */
  joinedAt: string;
  /** Raw `source` off the member_join event: `invite:CODE` / `vanity` / ... */
  source: string;
  firstVoiceAt: string | null;
  firstMessageAt: string | null;
  /**
   * When this member's third message landed, or null if we do not record
   * message counts yet. Null triggers the first_message proxy - see the header.
   */
  thirdMessageAt: string | null;
  /** Rolling last-seen. Moved forward by every voice session, not just the first. */
  lastActiveAt: string | null;
  /** Non-null once they have left. */
  leftAt: string | null;
  /**
   * Did we OBSERVE this member arriving through `source`, or only place them
   * there? (TWO-73, `metadata.attribution_exact` on the capture event.)
   *
   * False in a window where several codes moved: code A gained 2 uses and code
   * B gained 1, so A produced 2 joins and B produced 1 - the per-code join
   * COUNT is exact - but which of the three members was B's is not observable.
   *
   * That distinction only bites below the joins column. Counting joins per code
   * is unaffected; AM7 and AM30 are per-MEMBER rates, so on a row built from
   * placements they describe a set of people who may not be that code's. Null
   * means the event predates the flag - the old capture path only ever wrote an
   * `invite:CODE` when exactly one code moved, so those are observations.
   */
  attributionExact?: boolean | null;
}

/** How a member cleared the AM7 bar. */
export type ActivationBasis = 'voice' | 'messages' | 'message-proxy';

export interface Activation {
  basis: ActivationBasis;
  /** When they cleared it. */
  at: string;
}

/**
 * Did this member activate inside the 7-day window, and how?
 *
 * Earliest qualifying signal wins, so `at` is the true activation moment and
 * the AM30 "active again" test has something real to compare against.
 */
export function activation(j: JoinRecord): Activation | null {
  const join = Date.parse(j.joinedAt);
  if (Number.isNaN(join)) return null;
  const deadline = join + AM7_WINDOW_DAYS * DAY_MS;

  const inWindow = (ts: string | null): number | null => {
    if (!ts) return null;
    const t = Date.parse(ts);
    // `>= join` guards against activity stamped before the join we are
    // crediting, which happens on a rejoin: the member's first-ever message
    // can predate their second arrival by years.
    return !Number.isNaN(t) && t >= join && t <= deadline ? t : null;
  };

  const candidates: { basis: ActivationBasis; t: number }[] = [];
  const voice = inWindow(j.firstVoiceAt);
  if (voice !== null) candidates.push({ basis: 'voice', t: voice });

  if (j.thirdMessageAt !== null) {
    const third = inWindow(j.thirdMessageAt);
    if (third !== null) candidates.push({ basis: 'messages', t: third });
  } else {
    // No message counts on file. Fall back to "posted at all", which is a
    // looser bar than the agreed 3+, and label it so the report can say so.
    const first = inWindow(j.firstMessageAt);
    if (first !== null) candidates.push({ basis: 'message-proxy', t: first });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.t - b.t);
  const best = candidates[0];
  return { basis: best.basis, at: new Date(best.t).toISOString() };
}

export type Am30Verdict =
  /** Still here, last seen between day 8 and day 30. No inference at all. */
  | 'proven-in-window'
  /** Still here, last seen after day 30. Returning member; days 8-30 unobservable. */
  | 'proven-later'
  /** Left, or never seen again after their first week. */
  | 'no';

/** Was this AM7 member retained? See note 2 in the header for why this is not one boolean. */
export function am30(j: JoinRecord, act: Activation): Am30Verdict {
  if (j.leftAt) return 'no';
  if (!j.lastActiveAt) return 'no';
  const last = Date.parse(j.lastActiveAt);
  const actAt = Date.parse(act.at);
  const join = Date.parse(j.joinedAt);
  if (Number.isNaN(last) || Number.isNaN(actAt) || Number.isNaN(join)) return 'no';
  // Strictly after: last-seen equal to the activation moment means the
  // activation IS the only thing they ever did.
  if (last <= actAt) return 'no';
  // The floor. Last seen on day 3 means they went quiet for the 27 days that
  // AM30 is actually asking about, so that is not retention.
  if (last < join + AM30_RETURN_FLOOR_DAYS * DAY_MS) return 'no';
  // No ceiling - being seen after day 30 is more retention, not less.
  return last <= join + AM30_WINDOW_DAYS * DAY_MS ? 'proven-in-window' : 'proven-later';
}

/**
 * One printed line. `joins` is people, not events - the caller collapses the
 * duplicate-logger copies before this ever sees them.
 */
export interface AttributionRow {
  /** `invite:CODE`, `vanity`, `unknown`, or a backfill source. */
  source: string;
  /** Human label: the bare code for invites, the source string otherwise. */
  label: string;
  clicks: number;
  joins: number;
  /**
   * Of `joins`, how many were placed on this code by the multi-code split
   * rather than observed. `joins` itself stays exact either way; anything to
   * the RIGHT of it on this row is soft when this is non-zero. See
   * JoinRecord.attributionExact.
   */
  joinsInexact: number;

  /** Joins old enough to have had their 7 days. The AM7 denominator. */
  am7Eligible: number;
  am7: number;
  /** Of `am7`, how many cleared the bar on voice alone. Exact. */
  am7Voice: number;
  /** Of `am7`, how many cleared the 3-message bar with a third message on file. Exact. */
  am7Messages: number;
  /**
   * Of `am7`, how many were admitted by the first_message proxy because no
   * third message is on file for them - so they posted at least once and we
   * cannot say whether it was three times. The only soft part of AM7, and the
   * only reason the total is ever an upper bound. See header note 1.
   */
  am7MessageProxy: number;

  /** AM7 members old enough to have had their 30 days. The AM30 denominator. */
  am30Eligible: number;
  am30: number;
  am30ProvenInWindow: number;
  am30ProvenLater: number;
}

function emptyRow(source: string): AttributionRow {
  return {
    source,
    label: source.startsWith('invite:') ? source.slice('invite:'.length) : source,
    clicks: 0,
    joins: 0,
    joinsInexact: 0,
    am7Eligible: 0,
    am7: 0,
    am7Voice: 0,
    am7Messages: 0,
    am7MessageProxy: 0,
    am30Eligible: 0,
    am30: 0,
    am30ProvenInWindow: 0,
    am30ProvenLater: 0,
  };
}

export interface RollUpOptions {
  /** Now, in ms. Injected so the test is not a function of the wall clock. */
  nowMs: number;
  /** Clicks per source. Empty until a tracked redirect link exists. */
  clicksBySource?: Map<string, number>;
  /**
   * Sources that must appear even with nothing behind them - every live invite
   * code. A channel producing zero joins is the finding, not a missing row.
   */
  alwaysShow?: string[];
}

export interface AttributionTotals extends AttributionRow {
  /** Members counted once each, however many codes they arrived through. */
  distinctJoiners: number;
}

export interface RollUp {
  rows: AttributionRow[];
  totals: AttributionTotals;
  /** True if any row leaned on the first_message proxy. Drives the caveat line. */
  usedMessageProxy: boolean;
}

/**
 * Aggregate joins into one row per source.
 *
 * Maturity is tracked per column, not per row, because at ~15 joins a month a
 * cohort that has not had its 30 days yet is most of the table. Folding
 * immature members into the denominator would print a retention collapse that
 * is really just the calendar.
 */
export function rollUp(joins: JoinRecord[], opts: RollUpOptions): RollUp {
  const { nowMs, clicksBySource = new Map(), alwaysShow = [] } = opts;
  const rows = new Map<string, AttributionRow>();
  const row = (source: string): AttributionRow => {
    let r = rows.get(source);
    if (!r) rows.set(source, (r = emptyRow(source)));
    return r;
  };

  for (const s of alwaysShow) row(s);
  for (const [s, n] of clicksBySource) row(s).clicks += n;

  const totals = { ...emptyRow('TOTAL'), distinctJoiners: 0 } as AttributionTotals;
  const seen = new Set<string>();
  let usedMessageProxy = false;

  for (const j of joins) {
    const r = row(j.source);
    r.joins++;
    totals.joins++;
    if (j.attributionExact === false) {
      r.joinsInexact++;
      totals.joinsInexact++;
    }
    if (!seen.has(j.memberId)) {
      seen.add(j.memberId);
      totals.distinctJoiners++;
    }

    const join = Date.parse(j.joinedAt);
    const am7Mature = !Number.isNaN(join) && nowMs >= join + AM7_WINDOW_DAYS * DAY_MS;
    if (!am7Mature) continue;
    r.am7Eligible++;
    totals.am7Eligible++;

    const act = activation(j);
    if (!act) continue;
    r.am7++;
    totals.am7++;
    if (act.basis === 'voice') {
      r.am7Voice++;
      totals.am7Voice++;
    } else if (act.basis === 'messages') {
      r.am7Messages++;
      totals.am7Messages++;
    } else if (act.basis === 'message-proxy') {
      r.am7MessageProxy++;
      totals.am7MessageProxy++;
      usedMessageProxy = true;
    }

    if (nowMs < join + AM30_WINDOW_DAYS * DAY_MS) continue;
    r.am30Eligible++;
    totals.am30Eligible++;
    const verdict = am30(j, act);
    if (verdict === 'no') continue;
    r.am30++;
    totals.am30++;
    if (verdict === 'proven-in-window') {
      r.am30ProvenInWindow++;
      totals.am30ProvenInWindow++;
    } else {
      r.am30ProvenLater++;
      totals.am30ProvenLater++;
    }
  }

  for (const [, r] of rows) totals.clicks += r.clicks;

  const sorted = [...rows.values()].sort(
    (a, b) =>
      b.am30 - a.am30 || b.am7 - a.am7 || b.joins - a.joins || a.label.localeCompare(b.label),
  );
  return { rows: sorted, totals, usedMessageProxy };
}

/**
 * `n / d (p%)`, never a bare percentage.
 *
 * At ~15 joins a month "33%" is one person out of three and reads like a
 * trend. The denominator is not decoration, so it is not optional and the
 * formatter has no mode that drops it.
 */
export function rate(n: number, d: number): string {
  const frac = `${String(n).padStart(3)} /${String(d).padStart(4)}`;
  return d === 0 ? `${frac}   ( n/a)` : `${frac}   (${String(Math.round((n / d) * 100)).padStart(3)}%)`;
}
