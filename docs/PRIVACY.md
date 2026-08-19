# What we store about members, and what we don't

Short version: **Discord user IDs, timestamps, and channel IDs. No names, no
message content, no email, nothing else.**

## What is in the database

| Stored | Why |
|---|---|
| Discord user ID (a public snowflake) | To count a member once and follow them through the funnel. |
| Guild ID, channel IDs | To see which rooms convert. |
| Timestamps | The entire point - joins, first message, retention. |
| Invite code a join is attributed to | To see which growth efforts work. |
| Inviter's user ID | To credit members who bring people in. |

## What is deliberately not stored

- **Message content.** The `MessageContent` intent is not requested. We record
  that a member posted, never what they posted.
- **Usernames, nicknames, avatars.** Not needed to count anything. A user ID is
  enough, and it is what Discord itself treats as the identifier. If the
  community team needs names for a re-engagement list, the list of IDs can be
  resolved to names at the moment it is used, and thrown away after.
- **Email, IP, location, voice audio.** Never collected.

## The historical backfill

`scripts/backfill.ts` reads two things that already exist in the server, once,
and then exits:

- Discord's own `joined_at` for every current member.
- The **log channels TWO's logging bots have written for years** — joins,
  leaves and voice sessions. These are staff-only channels that are already
  hidden from `@everyone`.

It stores exactly the same fields as the live bot: user ID, timestamp, event
type. It reads message text in order to *parse* those log entries, and keeps
none of it — no usernames, no descriptions, no content of any human message.
It never reads a channel members talk in.

The one thing worth being clear about: this means the database contains join
and leave records going back years, for people who are no longer in the server.
That is deliberate — leaving departed members out would make our retention
numbers look better than reality — and the deletion query below removes them
just the same.

## Retention

Events are kept indefinitely today, because retention analysis needs history.
Once we have a year of data past the backfill, revisit: aggregate counts older
than ~18 months and drop the per-member rows behind them.

## Deletion

If a member asks to be removed:

```sql
DELETE FROM events  WHERE member_id = '<id>';
DELETE FROM members WHERE member_id = '<id>';
```

This makes historical counts drop slightly, which is correct.

## Boundaries this codebase enforces

- **Nothing here messages a member.** The inactivity job writes an event and
  returns a list of IDs. No DM, no ping, no bulk message. Anything outbound
  needs explicit CEO sign-off before it is built, not after.
- **Nothing here reads a channel members talk in.** Not the live bot, not the
  backfill.

> **The bot account currently holds Administrator.** An earlier version of this
> page said it could not kick, ban or manage roles. That is no longer true: it
> was invited with Administrator so the permission set would not need redoing
> as features land. Nothing in this codebase uses those powers, and
> `scripts/preflight.ts` warns about it on every run — but the honest statement
> is "the code does not do this", not "the bot cannot". Narrowing the grant to
> View Channels + Manage Server is tracked as an open item.
