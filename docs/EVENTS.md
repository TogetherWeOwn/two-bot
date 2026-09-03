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
| `gate_cleared` | They accept the rules and Discord's membership screen lets them in. | No - once per member |
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

### The rules gate

TWO runs Discord's membership screening, so `member_join` is not arrival - it is
arrival at a locked door. A member behind it carries `pending: true` and cannot
type, react or click anything. `gate_cleared` is the moment that flips.

Splitting the two apart is the whole point: without it, somebody who joined and
never got in is indistinguishable from somebody who joined and simply said
nothing, and those have opposite fixes. On the 2026-08-19 roster 31 of 84 humans
had never cleared it, concentrated in three months that converted at 8%, 0% and
6% while every quiet month converted at 100%.

`gate_cleared` is **once per member on purpose**, even though a rejoin is
genuinely re-screened. Conversion is "of the people who joined, how many got
in", and counting one person's two clearings twice pushes it over 100% for no
interesting reason. The earliest clearing wins in the `members` projection.

Two emitters, so the denominator stays honest:

* `GuildMemberUpdate` where `pending` went true → false. This is the real
  measurement, accurate to the second.
* `GuildMemberAdd` for a member who arrives already un-pending - screening off,
  or a bypass role. There is no gate for them to clear, and leaving them out
  would read as a permanent conversion shortfall.

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

1. **`invite_click` only covers invites posted as a tracked link.** Discord
   reports invite clicks to nobody, so the only clicks we can ever see are the
   ones that pass through our own redirect: `go.two.gg/<campaign>` logs the
   click and 302s to the invite (`src/redirect/`, `docs/INVITE_TRACKING.md`).
   An invite pasted as a raw `discord.gg` link is clicked somewhere we have no
   presence, and produces a join with no click in front of it — which is why
   click-to-join can read over 100%. `npm run funnel` says so on its own line
   rather than hiding it. Adding a tracked link for a new place is
   `npm run campaigns -- --add`, not a deploy.

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

6. **A backfilled `gate_cleared` says *that*, never *when*.** Discord reports
   `pending` present-tense and keeps no record of when it changed, so for
   everybody who joined before the listener existed we can learn the binary and
   nothing else. `scripts/backfill.ts` writes those rows with
   `source = 'backfill:member_list'` and `occurred_at` set to the member's
   **join time** - a placeholder, not a measurement, flagged in the row itself
   as `metadata.timestampIsJoinTime`.

   So: **no time-to-clear arithmetic may use a `backfill:` row.** Counting them
   is fine and is exactly what the conversion number needs. The dashboard makes
   the distinction structurally - `gateWatchedSince` is derived from live rows
   only, and backfilled rows are used solely to establish that the roster was
   read at all (`src/analytics/dashboard.ts`).

## Rebuilding

`members` is a cache, derived entirely from `events`. If it ever looks wrong it
can be dropped and rebuilt by replaying the log. `events` itself is the only
thing that must never be lost, which is what the backups protect.
