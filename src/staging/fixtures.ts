/**
 * The known state QA resets to.
 *
 * Ten synthetic members, each one a funnel shape the integration suite needs
 * to assert against. Nothing here is random and nothing here is a real person:
 * every id is in a reserved block that Discord will never allocate, and every
 * timestamp is derived from one anchor.
 *
 * TIMESTAMPS ARE RELATIVE, ON PURPOSE. Inactivity is "no activity for N days",
 * so a fixture pinned to an absolute date would silently become inactive as
 * the calendar moved and the suite would start passing for the wrong reason.
 * Every fixture time is an offset in days from `now`, which the caller
 * supplies. Tests pass a fixed `now` and get byte-identical output; QA passes
 * the real clock and gets the same funnel *shape* every time.
 *
 * If you add a fixture, update EXPECTED_FUNNEL in the same commit. The test
 * asserts the two agree, so a half-update fails rather than drifts.
 */
import type { Db } from '../store/driver.ts';
import { EventStore } from '../store/eventStore.ts';
import type { EventType, FunnelEvent } from '../core/events.ts';

/**
 * Discord snowflakes are time-ordered and currently ~19 digits starting with
 * a 1. `9000...` is below anything Discord has ever issued and above nothing
 * real, so a fixture id can never collide with a live member - and grepping
 * for `90000000000000` finds every one of them.
 */
const ID = (n: number) => `9000000000000000${String(n).padStart(2, '0')}`;

export const FIXTURE_MEMBER_IDS = {
  /** Joined a week ago, never said a word. Feeds the never-posted list. */
  lurker: ID(1),
  /** Joined, was prompted, posted. The ordinary happy path. */
  chatter: ID(2),
  /** Full onboarding plus a real voice session. */
  voicer: ID(3),
  /** Joined to first_message in 40 seconds. The "under 60s" claim. */
  fast: ID(4),
  /** Prompted and then nothing. Onboarding drop-off. */
  stalled: ID(5),
  /** Long gone quiet AND already flagged. Must not be flagged twice. */
  inactive: ID(6),
  /** Joined, posted, left. Must drop out of every active-member count. */
  leaver: ID(7),
  /** Joined, left, came back. Repeatable events and a cleared left_at. */
  rejoiner: ID(8),
  /** A bot. Must never appear in a funnel number. */
  bot: ID(9),
  /** Quiet for 30 days, never flagged. The one flagInactive() should catch. */
  quiet: ID(10),
} as const;

export type FixtureMemberKey = keyof typeof FIXTURE_MEMBER_IDS;

/** Invite codes the fixtures attribute joins to. Mirrors the live shape. */
export const FIXTURE_INVITES = {
  alpha: 'qa-alpha',
  beta: 'qa-beta',
} as const;

/**
 * Baseline invite usage. `uses` matches the number of fixture joins credited
 * to each code, so the first real diff after a reset reports honest growth.
 */
export const FIXTURE_INVITE_SNAPSHOTS: ReadonlyArray<{
  code: string;
  uses: number;
  inviterId: string;
  channelId: string;
}> = [
  { code: FIXTURE_INVITES.alpha, uses: 5, inviterId: ID(90), channelId: 'welcome' },
  { code: FIXTURE_INVITES.beta, uses: 4, inviterId: ID(91), channelId: 'general' },
];

const DAY = 86_400_000;
const MIN = 60_000;
const SEC = 1_000;

/** A fixed anchor for tests. Any ISO instant works; this one is arbitrary. */
export const TEST_NOW = '2026-08-19T12:00:00.000Z';

export interface SeedOptions {
  guildId: string;
  /**
   * ISO instant everything is measured back from. Defaults to the real clock.
   *
   * PASS THIS EXPLICITLY IF YOU SEED MORE THAN ONCE IN A RUN. The idempotency
   * key for repeatable events - member_join, member_leave, invite_click,
   * game_roles_selected, channel_routed - includes the timestamp, so two seeds
   * taken from two clock readings produce two sets of keys and double those
   * counts. Seeding is only idempotent against a fixed anchor.
   */
  now?: string;
}

/**
 * What the fixtures should produce, once seeded. QA asserts against these
 * rather than recomputing them, so a fixture change that alters the funnel is
 * visible in the diff.
 */
export const EXPECTED_FUNNEL: Readonly<Record<EventType, number>> = {
  invite_click: 5,
  member_join: 10, // 9 distinct members; the rejoiner joins twice
  // 8 of the 9 humans. The lurker is the one still behind the rules gate, so
  // QA has a member in every state the dashboard distinguishes: cleared, stuck,
  // and (via the leaver) cleared-then-gone. The rejoiner is re-screened on
  // their second join and still counts once, which is the once-per-member rule.
  gate_cleared: 8,
  onboarding_prompted: 4,
  game_roles_selected: 2,
  channel_routed: 2,
  first_message: 7,
  // The message ladder (TWO-95). Only `chatter` posts three times, so exactly
  // one member is AM7 on the exact 3+ bar and the rest of the posters sit on
  // the first_message proxy - which is the split the attribution report has to
  // keep telling apart. A fixture set where everyone had a third message would
  // never exercise the residual, and one where nobody did would never exercise
  // the exact path.
  second_message: 1,
  third_message: 1,
  first_voice_session: 1,
  // Zero on purpose. The staging fixtures seed the funnel by writing events
  // directly, and nothing in them opens a voice session yet; these rows only
  // appear once a real gateway listener runs against the staging guild
  // (TOG-99 / TWO-11). Left explicit so the day someone seeds a session, the
  // count moving off zero shows up in the diff.
  voice_session_start: 0,
  voice_session_end: 0,
  member_inactive: 1,
  member_leave: 2,
};

/** Distinct members who reached each stage. Differs from EXPECTED_FUNNEL only
 *  where an event legitimately repeats. */
export const EXPECTED_DISTINCT: Readonly<Partial<Record<EventType, number>>> = {
  member_join: 9,
  member_leave: 2,
  first_message: 7,
  gate_cleared: 8,
};

/** Members with a join and no message and no voice and no leave. */
export const EXPECTED_JOINED_NEVER_POSTED = 2; // lurker, stalled

/** Members a fresh flagInactive(14) run should newly flag. */
export const EXPECTED_NEWLY_INACTIVE = 1; // quiet

/** Joined -> first_message, in seconds, for the fixture that must beat 60s. */
export const EXPECTED_FAST_SECONDS = 40;

/**
 * Build the full event list. Pure - no database, no clock beyond `now` - so a
 * test can inspect it directly.
 */
export function fixtureEvents(opts: SeedOptions): FunnelEvent[] {
  const guildId = opts.guildId;
  const base = Date.parse(opts.now ?? new Date().toISOString());
  const at = (ms: number) => new Date(base + ms).toISOString();
  const M = FIXTURE_MEMBER_IDS;

  const ev = (
    memberId: string | null,
    eventType: EventType,
    offsetMs: number,
    source: string,
    metadata?: Record<string, unknown>,
  ): FunnelEvent => ({ memberId, guildId, eventType, occurredAt: at(offsetMs), source, metadata });

  const invite = (code: string) => `invite:${code}`;
  const A = invite(FIXTURE_INVITES.alpha);
  const B = invite(FIXTURE_INVITES.beta);

  return [
    // --- top of funnel: clicks we cannot yet attribute to a person ---------
    ev(null, 'invite_click', -8 * DAY, A),
    ev(null, 'invite_click', -8 * DAY + 1 * MIN, A),
    ev(null, 'invite_click', -7 * DAY, A),
    ev(null, 'invite_click', -6 * DAY, B),
    ev(null, 'invite_click', -5 * DAY, 'vanity'),

    // --- lurker: joined, silent -------------------------------------------
    // NO gate_cleared, on purpose. This is the member who never accepted the
    // rules and physically cannot post - the state TOG-76 exists to make
    // visible, and the one every "joined but never posted" number used to
    // blame on disinterest.
    ev(M.lurker, 'member_join', -7 * DAY, A),

    // --- chatter: prompted, then posted three times the same evening -------
    // The only fixture that clears AM7's text bar exactly rather than by the
    // proxy: three messages, all inside the 7-day window.
    ev(M.chatter, 'member_join', -6 * DAY, A),
    ev(M.chatter, 'gate_cleared', -6 * DAY + 4 * SEC, 'gateway'),
    ev(M.chatter, 'onboarding_prompted', -6 * DAY + 10 * SEC, 'channel:welcome'),
    ev(M.chatter, 'first_message', -6 * DAY + 2 * 60 * MIN, 'channel:general'),
    ev(M.chatter, 'second_message', -6 * DAY + 3 * 60 * MIN, 'channel:general'),
    ev(M.chatter, 'third_message', -6 * DAY + 4 * 60 * MIN, 'channel:general'),

    // --- voicer: the complete path, ending in real voice ------------------
    ev(M.voicer, 'member_join', -5 * DAY, B),
    ev(M.voicer, 'gate_cleared', -5 * DAY + 3 * SEC, 'gateway'),
    ev(M.voicer, 'onboarding_prompted', -5 * DAY + 8 * SEC, 'channel:welcome'),
    ev(M.voicer, 'game_roles_selected', -5 * DAY + 22 * SEC, 'channel:welcome', {
      picks: ['test'],
    }),
    ev(M.voicer, 'channel_routed', -5 * DAY + 25 * SEC, 'channel:general'),
    ev(M.voicer, 'first_message', -5 * DAY + 90 * SEC, 'channel:general'),
    ev(M.voicer, 'first_voice_session', -5 * DAY + 60 * MIN, 'channel:Voice 1'),

    // --- fast: join to first message in 40 seconds ------------------------
    ev(M.fast, 'member_join', -4 * DAY, A),
    ev(M.fast, 'gate_cleared', -4 * DAY + 2 * SEC, 'gateway'),
    ev(M.fast, 'onboarding_prompted', -4 * DAY + 5 * SEC, 'channel:welcome'),
    ev(M.fast, 'game_roles_selected', -4 * DAY + 20 * SEC, 'channel:welcome', { picks: ['test'] }),
    ev(M.fast, 'channel_routed', -4 * DAY + 25 * SEC, 'channel:general'),
    ev(M.fast, 'first_message', -4 * DAY + EXPECTED_FAST_SECONDS * SEC, 'channel:general'),

    // --- stalled: prompted, then nothing ----------------------------------
    ev(M.stalled, 'member_join', -3 * DAY, B),
    ev(M.stalled, 'gate_cleared', -3 * DAY + 6 * SEC, 'gateway'),
    ev(M.stalled, 'onboarding_prompted', -3 * DAY + 12 * SEC, 'channel:welcome'),

    // --- inactive: quiet for 40 days and already flagged yesterday --------
    // Predates the gate listener, so their clearing comes off a roster read
    // and carries the join time as a placeholder. This is the fixture that
    // keeps the backfill's source label exercised.
    ev(M.inactive, 'member_join', -60 * DAY, A),
    ev(M.inactive, 'gate_cleared', -60 * DAY, 'backfill:member_list', {
      backfill: true,
      timestampIsJoinTime: true,
    }),
    ev(M.inactive, 'first_message', -59 * DAY, 'channel:general'),
    ev(M.inactive, 'member_inactive', -1 * DAY, 'job:inactivity', { thresholdDays: 14 }),

    // --- leaver: joined, posted, gone -------------------------------------
    ev(M.leaver, 'member_join', -20 * DAY, B),
    ev(M.leaver, 'gate_cleared', -20 * DAY + 30 * SEC, 'gateway'),
    ev(M.leaver, 'first_message', -19 * DAY, 'channel:general'),
    ev(M.leaver, 'member_leave', -2 * DAY, 'gateway'),

    // --- rejoiner: left and came back. left_at must end up NULL -----------
    // Discord re-screens a rejoin, so in life this member clears the gate
    // twice. Only the first appears here: the idempotency key would drop the
    // second, and this list is asserted to insert one row per entry. That the
    // key really does drop it is covered in test/unit.store.test.ts.
    ev(M.rejoiner, 'member_join', -30 * DAY, A),
    ev(M.rejoiner, 'gate_cleared', -30 * DAY + 15 * SEC, 'gateway'),
    ev(M.rejoiner, 'member_leave', -25 * DAY, 'gateway'),
    ev(M.rejoiner, 'member_join', -10 * DAY, B),
    ev(M.rejoiner, 'first_message', -9 * DAY, 'channel:general'),

    // --- quiet: 30 days silent, never flagged -----------------------------
    ev(M.quiet, 'member_join', -50 * DAY, A),
    ev(M.quiet, 'gate_cleared', -50 * DAY + 20 * SEC, 'gateway'),
    ev(M.quiet, 'first_message', -45 * DAY, 'channel:general'),
  ];
}

/** Activity touches that are not funnel events - they only move recency. */
function fixtureTouches(opts: SeedOptions): Array<{ memberId: string; atIso: string }> {
  const base = Date.parse(opts.now ?? new Date().toISOString());
  const at = (ms: number) => new Date(base + ms).toISOString();
  const M = FIXTURE_MEMBER_IDS;
  return [
    // inactive last spoke 40 days ago, long after their first message.
    { memberId: M.inactive, atIso: at(-40 * DAY) },
    // quiet last spoke 30 days ago - past the 14-day threshold, unflagged.
    { memberId: M.quiet, atIso: at(-30 * DAY) },
    // the bot is chatty and must still never count.
    { memberId: M.bot, atIso: at(-1 * DAY) },
  ];
}

export interface SeedResult {
  events: number;
  inserted: number;
  members: number;
  /** The anchor actually used. Pass it back in to seed again idempotently. */
  now: string;
}

/**
 * Write the fixtures. Idempotent: every event goes through EventStore, which
 * is idempotency-keyed, so running this twice leaves the same rows. It does
 * NOT clear anything first - `resetStagingData` does that.
 */
export async function seedFixtures(db: Db, opts: SeedOptions): Promise<SeedResult> {
  const store = new EventStore(db);
  // Resolve the clock exactly once, here, and use that value everywhere below.
  const now = opts.now ?? new Date().toISOString();
  opts = { ...opts, now };
  const events = fixtureEvents(opts);

  let inserted = 0;
  for (const e of events) {
    const r = await store.record(e);
    if (r.inserted) inserted++;
  }

  // The bot exists in `members` with is_bot = 1 but no join event. Any query
  // that forgets `is_bot = 0` will pick it up - that is what it is for.
  await store.markBot(opts.guildId, FIXTURE_MEMBER_IDS.bot);
  for (const t of fixtureTouches(opts)) {
    await store.touchActivity(opts.guildId, t.memberId, t.atIso);
  }

  // Baseline invite counts, so that the next InviteTracker.diffAndStore() has
  // something to diff against. Without these the first observation of any
  // code looks like "no growth" and attribution tests cannot start.
  const seedNow = now;
  for (const s of FIXTURE_INVITE_SNAPSHOTS) {
    await db
      .prepare(
        `INSERT INTO invite_snapshots (guild_id, code, uses, inviter_id, channel_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, code) DO UPDATE SET uses = excluded.uses,
           inviter_id = excluded.inviter_id, channel_id = excluded.channel_id,
           updated_at = excluded.updated_at`,
      )
      .run(opts.guildId, s.code, s.uses, s.inviterId, s.channelId, seedNow);
  }

  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM members WHERE guild_id = ?`)
    .get<{ n: number }>(opts.guildId);

  return { events: events.length, inserted, members: Number(row?.n ?? 0), now };
}

/**
 * Delete everything for one guild, then reseed.
 *
 * Scoped by guild id rather than TRUNCATE so that a mistake cannot empty a
 * table someone else is using. The guard in scripts/staging-reset.ts is the
 * real protection; this is the second one.
 */
export async function resetStagingData(db: Db, opts: SeedOptions): Promise<SeedResult> {
  await db.transaction(async (tx) => {
    await tx.prepare(`DELETE FROM events WHERE guild_id = ?`).run(opts.guildId);
    await tx.prepare(`DELETE FROM members WHERE guild_id = ?`).run(opts.guildId);
    await tx.prepare(`DELETE FROM invite_snapshots WHERE guild_id = ?`).run(opts.guildId);
  });
  return seedFixtures(db, opts);
}
