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

## Retention

Events are kept indefinitely today, because retention analysis needs history
and we have no history yet. Once we have a year of data, revisit: aggregate
counts older than ~18 months and drop the per-member rows behind them.

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
- The bot holds no permission to kick, ban, or manage roles.
