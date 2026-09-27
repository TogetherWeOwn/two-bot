/**
 * The funnel event vocabulary for TWO.
 *
 * Everything the dashboard ever reports is derived from this one list.
 * Adding a new event type means adding it here first, then emitting it.
 */

export const EVENT_TYPES = [
  'invite_click',
  'member_join',
  // --- the rules gate (TOG-76) --------------------------------------------
  // TWO runs Discord's membership screening, so `member_join` is not arrival -
  // it is arrival at a locked door. A member behind it cannot type, react or
  // click anything, and 31 of the 84 humans on the server have been stuck
  // there since the day they joined. Without this event those 31 are
  // indistinguishable from members who joined and simply said nothing, which
  // is how three whole months of intake converted at under 10% for a year
  // without anybody noticing.
  'gate_cleared', // they accepted the rules and can now actually do things
  // ------------------------------------------------------------------------
  // --- onboarding (TWO-7) -------------------------------------------------
  // These three sit between member_join and first_message. They exist so we
  // can answer "of the people who joined, how many actually got routed
  // somewhere, and how long did it take?" - which is the whole point of the
  // onboarding work. Without them a stalled funnel looks identical to a slow
  // one.
  'onboarding_prompted', // the welcome + game picker was posted for them
  'game_roles_selected', // they picked at least one game and we granted it
  'channel_routed', // we handed them links to channels they can now see
  // ------------------------------------------------------------------------
  'first_message',
  // --- the message ladder (TWO-95) ----------------------------------------
  // AM7's text half is "3 or more messages within 7 days", which is a question
  // about WHEN the third message landed, not how many there are in total. A
  // count cannot answer it: 40 messages tells you nothing about day 7.
  //
  // So we record the rungs instead. `second_message` carries no meaning of its
  // own and nothing reports on it - it exists because you cannot identify the
  // third message without having identified the second. Keeping it in the log
  // rather than in a column is what lets `members` stay a pure projection: the
  // ladder position is derivable from `events` alone, so the cache can still be
  // rebuilt from the log, which is the rule the schema header sets out.
  'second_message',
  'third_message',
  // ------------------------------------------------------------------------
  'first_voice_session',
  // --- repeatable voice sessions (TOG-99) ---------------------------------
  // first_voice_session fires once per member and members.last_active_at is a
  // single rolling column, so between them they answer "did they come back"
  // and nothing else. These two answer "how often" and "at what time of day",
  // which is what scheduling an event off real attendance needs (TWO-66).
  //
  // One pair per visit to a voice channel. A move from channel A to channel B
  // is an end for A and a start for B, because "which room" is the question
  // the source field exists to answer.
  'voice_session_start',
  'voice_session_end',
  // ------------------------------------------------------------------------
  'member_inactive',
  'member_leave',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The message milestones in ladder order.
 *
 * A member's Nth message is the Nth rung. The order is the definition - the
 * store fills the lowest rung that is still empty - so this array is the one
 * place that decides what "third message" means. AM7_MESSAGE_THRESHOLD in
 * src/analytics/attribution.ts is the same 3, and the two are asserted equal in
 * test/unit.store.test.ts so that raising the bar cannot quietly leave the
 * ladder one rung short.
 */
export const MESSAGE_RUNGS = ['first_message', 'second_message', 'third_message'] as const;

export type MessageRung = (typeof MESSAGE_RUNGS)[number];

/**
 * Where an event came from. `source` answers "what should we credit for this?"
 * For joins that is the invite code / campaign. For everything else it is the
 * channel or subsystem that produced it, so we can see which rooms convert.
 */
export interface FunnelEvent {
  /** Discord snowflake of the member. For invite_click we may not know it yet. */
  memberId: string | null;
  /** Discord snowflake of the guild (server). */
  guildId: string;
  eventType: EventType;
  /** ISO-8601 UTC. Always set by the emitter, never by the database. */
  occurredAt: string;
  /**
   * Attribution string. Examples:
   *   'invite:aB3xY9'      - a specific invite code
   *   'vanity'             - the server vanity URL
   *   'channel:12345'      - the channel the event happened in
   *   'job:inactivity'     - produced by a scheduled job, not a member action
   *   'unknown'            - we genuinely could not tell
   */
  source: string;
  /** Anything extra. Kept small on purpose - see docs/PRIVACY.md. */
  metadata?: Record<string, unknown>;
  /**
   * Distinguishes two genuinely separate events that share every other field.
   *
   * Only the invite-click redirect sets this, and it is the reason clicks can
   * be counted at all: an anonymous event has no member id to tell two of them
   * apart, so without this, two people clicking within the same millisecond
   * produce one identical key and the second is discarded as a duplicate. That
   * under-counts the denominator of click-to-join and makes conversion look
   * better than it is - see idempotencyKey() below.
   *
   * It is NOT a member identifier and must never become one: the redirect
   * generates random bytes per request and stores nothing about who clicked.
   */
  dedupeToken?: string;
}

/** Stable key used to make event writes idempotent. */
export function idempotencyKey(e: FunnelEvent): string {
  // One member can only cross each funnel stage once, except for events that
  // legitimately repeat (invite_click, member_join for rejoins, member_inactive).
  //
  // game_roles_selected / channel_routed repeat by design: a member can come
  // back to the picker and change what they play. Counting reach still works -
  // use COUNT(DISTINCT member_id). onboarding_prompted stays once-per-member so
  // a re-post can never inflate the top of the onboarding funnel.
  //
  // gate_cleared stays once-per-member. A member who leaves and rejoins is
  // re-screened by Discord and clears the gate again, so a second one is a real
  // event - but conversion is "of the people who joined, how many got in", and
  // counting one person's two clearings as two would push it over 100%. The
  // first clearing is the one that answers the question.
  //
  // voice_session_start / voice_session_end are repeatable BY DESIGN and that
  // is the whole point of them - a member who turns up every week must produce
  // a row every week. Counting people rather than visits still works the same
  // way it does for member_join: COUNT(DISTINCT member_id).
  const repeatable: EventType[] = [
    'invite_click',
    'member_join',
    'member_inactive',
    'member_leave',
    'game_roles_selected',
    'channel_routed',
    'voice_session_start',
    'voice_session_end',
  ];
  if (repeatable.includes(e.eventType)) {
    // A repeatable event is told apart from the last one by member and time.
    // That works because every one of these has a member id - except
    // invite_click, which by definition does not, so two clicks in the same
    // millisecond collapse into one row. `dedupeToken` is what makes them two.
    // See FunnelEvent.dedupeToken; nothing else sets it.
    const token = e.dedupeToken ? `:${e.dedupeToken}` : '';
    return `${e.guildId}:${e.memberId ?? 'anon'}:${e.eventType}:${e.occurredAt}${token}`;
  }
  return `${e.guildId}:${e.memberId}:${e.eventType}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Whether a `gate_cleared` row may feed time-to-clear arithmetic (TOG-6474).
 *
 * A backfilled clearing says THAT a member is through the rules gate, never
 * WHEN: Discord reports `pending` present-tense and keeps no history of the
 * transition, so `scripts/backfill.ts` writes `occurred_at` as the member's
 * join time - a placeholder, flagged in the row itself. Reading one as a real
 * clearing would print members clearing in 0s and make onboarding-speed
 * claims false. Counting them is fine and is exactly what conversion needs;
 * only time arithmetic must exclude them (docs/EVENTS.md, limit 6).
 *
 * Either signal alone disqualifies: the `backfill:` source prefix (which
 * `labelSource()` already marks unattributable) or
 * `metadata.timestampIsJoinTime`. The writer sets both, but a row missing one
 * is still a placeholder until proven otherwise.
 */
export function isMeasurableGateClearing(
  source: string,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (source.startsWith('backfill:')) return false;
  if (metadata?.timestampIsJoinTime === true) return false;
  return true;
}
