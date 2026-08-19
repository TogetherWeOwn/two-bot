# The funnel event schema

Every number we ever report about growth comes from one table: `events`. It is
append-only. If a number looks wrong, the answer is always in here.

## The shape

Every event has the same five fields, plus optional extras.

| Field | Type | Notes |
|---|---|---|
| `event_type` | text | One of the six types below. |
| `member_id` | text | Discord snowflake. `NULL` only for `invite_click`, where we do not know who it is yet. |
| `guild_id` | text | Discord snowflake of the server. |
| `occurred_at` | text | ISO-8601 UTC. **When it happened**, taken from Discord where possible. |
| `source` | text | Attribution. See below. |
| `metadata` | JSON text | Optional, kept deliberately small. |

There is also `recorded_at` (when *we* wrote it) and `idempotency_key`.
`occurred_at` and `recorded_at` differ when we backfill or when the bot was
down, and keeping both is the only way to tell those apart later.

## The six event types

| Type | Fires when | Repeats? |
|---|---|---|
| `invite_click` | Someone clicks a tracked invite link. | Yes |
| `member_join` | A member joins the server. | Yes (rejoins are real) |
| `first_message` | A member's first ever message. | No - once per member |
| `first_voice_session` | A member's first time joining a voice channel. | No - once per member |
| `member_inactive` | The nightly sweep flags a member as gone quiet. | Yes |
| `member_leave` | A member leaves or is removed. | Yes |

The "no" rows are enforced in the database by `idempotency_key`, not just in
code. A restart, a replayed gateway event, or a double-fired handler cannot
inflate the funnel.

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

## Rebuilding

`members` is a cache, derived entirely from `events`. If it ever looks wrong it
can be dropped and rebuilt by replaying the log. `events` itself is the only
thing that must never be lost, which is what the backups protect.
