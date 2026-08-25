# The funnel event schema

Every number we ever report about growth comes from one table: `events`. It is
append-only. If a number looks wrong, the answer is always in here.

## The shape

Every event has the same five fields, plus optional extras.

| Field | Type | Notes |
|---|---|---|
| `event_type` | text | One of the types below. `src/core/events.ts` is the authority. |
| `member_id` | text | Discord snowflake. `NULL` only for `invite_click`, where we do not know who it is yet. |
| `guild_id` | text | Discord snowflake of the server. |
| `occurred_at` | text | ISO-8601 UTC. **When it happened**, taken from Discord where possible. |
| `source` | text | Attribution. See below. |
| `metadata` | JSON text | Optional, kept deliberately small. |

There is also `recorded_at` (when *we* wrote it) and `idempotency_key`.
`occurred_at` and `recorded_at` differ when we backfill or when the bot was
down, and keeping both is the only way to tell those apart later.

## The event types

| Type | Fires when | Repeats? |
|---|---|---|
| `invite_click` | Someone clicks a tracked invite link. | Yes |
| `member_join` | A member joins the server. | Yes (rejoins are real) |
| `onboarding_prompted` | The welcome + game picker was posted for them. | No - once per member |
| `game_roles_selected` | They picked at least one game and we granted it. | Yes (they can change what they play) |
| `channel_routed` | We handed them links to channels they can now see. | Yes |
| `first_message` | A member's first ever message. | No - once per member |
| `first_voice_session` | A member's first time joining a voice channel. | No - once per member |
| `voice_session_start` | A member entered a voice channel. | **Yes - one per visit** |
| `voice_session_end` | A member left a voice channel. | **Yes - one per visit** |
| `member_inactive` | The nightly sweep flags a member as gone quiet. | Yes |
| `member_leave` | A member leaves or is removed. | Yes |

The "no" rows are enforced in the database by `idempotency_key`, not just in
code. A restart, a replayed gateway event, or a double-fired handler cannot
inflate the funnel.

For a repeatable type the key includes `occurred_at`, so counting *people*
rather than *occurrences* means `COUNT(DISTINCT member_id)` - the same rule
that already applies to `member_join`.

### Voice sessions

`first_voice_session` fires once and `members.last_active_at` is a single
rolling column, so between them they answer "did they come back" and nothing
else. The session pair exists because two questions need more than that:

* **How often somebody turns up.** One `voice_session_start` per visit, so a
  weekly regular and a one-time visitor stop looking identical.
* **When they turn up.** `occurred_at` on each start is that visit's join time,
  which is what picking an event slot off real attendance needs rather than a
  guess.

A move between voice channels is an **end for the old channel then a start for
the new one**, at the same instant, because `source` is meant to tell us which
rooms people actually use.

`voice_session_end.metadata` carries `startKnown`, `startedAt` and
`durationSeconds`. **`startKnown: false` means we never saw the start** - the
bot came up while the member was already in voice, or the gateway reconnected
and open sessions were dropped as unproven. `durationSeconds` is then `null`
rather than a number measured from whenever the process happened to start.

> **Filter on `startKnown` before averaging durations.** Counting sessions does
> not need it; averaging them does. Open sessions are held in memory only
> (`src/core/voiceSessions.ts`) because Discord serves no voice history over
> REST - there is nowhere else the start could come from.

## `source`: what gets the credit

| Value | Meaning |
|---|---|
| `invite:aB3xY9` | A specific invite code. |
| `ambiguous:a+b` | Two invites grew at once and we genuinely cannot tell. |
| `vanity` | No invite grew and the server has a vanity URL, so probably that. |
| `unknown` | No invite grew and there is no vanity URL. Discovery, or a code created while the bot was offline. |
| `channel:12345` | The channel the event happened in. |
| `job:inactivity` | Produced by a scheduled job, not a member action. |
| `gateway` | Discord told us, with no further attribution. |

**These last two categories matter.** `ambiguous` and `unknown` are reported as
themselves and never guessed into a real invite code. If half our joins say
`unknown`, that is important information about our attribution, and rounding it
away would hide it.

## Known limits, stated up front

1. **`invite_click` is not populated yet.** Discord does not report invite
   clicks. We only ever see a use-count delta at join time. Measuring the true
   top of the funnel needs a short link we control that redirects to the invite
   and logs the click. `FunnelHandlers.onInviteClick` is the entry point, ready
   for it. Until then click-to-join conversion is unknown, and the report says
   so rather than showing a fake number.

2. **Invite attribution is a diff, not a fact.** Discord gives no direct signal.
   We snapshot every invite's use count and, on a join, look for the one that
   grew. Two joins in the same instant through different codes come back
   `ambiguous`.

3. **Joins that happen while the bot is down are attributed `unknown`.** The
   member still gets counted - Discord replays `GUILD_MEMBER_ADD`-equivalent
   state on reconnect - but the invite delta is lost.

4. **`first_message` only counts messages sent after the bot was deployed.**
   We are not backfilling history. Anyone already in the server appears as
   "joined, never posted" until they post again. Worth remembering when reading
   the first few weeks of numbers.

5. **`voice_session_start` / `voice_session_end` produce zero rows until a bot
   with the gateway listener is actually running.** They cannot be backfilled:
   Discord serves no voice history over REST, so a session that happened while
   we were down is gone, not merely unrecorded. The gap between "we wanted this
   number" and "the first row exists" is permanent, which is the argument for
   the listener running sooner rather than for a cleverer query later. Until
   then the only instrument is the manual attendance log (TWO-66).

## Rebuilding

`members` is a cache, derived entirely from `events`. If it ever looks wrong it
can be dropped and rebuilt by replaying the log. `events` itself is the only
thing that must never be lost, which is what the backups protect.
