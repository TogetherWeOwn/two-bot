/**
 * The funnel event vocabulary for TWO.
 *
 * Everything the dashboard ever reports is derived from this one list.
 * Adding a new event type means adding it here first, then emitting it.
 */

export const EVENT_TYPES = [
  'invite_click',
  'member_join',
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
  'first_voice_session',
  'member_inactive',
  'member_leave',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

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
  const repeatable: EventType[] = [
    'invite_click',
    'member_join',
    'member_inactive',
    'member_leave',
    'game_roles_selected',
    'channel_routed',
  ];
  if (repeatable.includes(e.eventType)) {
    return `${e.guildId}:${e.memberId ?? 'anon'}:${e.eventType}:${e.occurredAt}`;
  }
  return `${e.guildId}:${e.memberId}:${e.eventType}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
