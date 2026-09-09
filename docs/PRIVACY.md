# What we store about members, and what we don't

Short version: **Discord user IDs, timestamps, and channel IDs. Private support
tickets additionally retain a staff-only text transcript for 90 days. Automod
inspects public messages in memory but stores no content. No email.**

## What is in the database

| Stored | Why |
|---|---|
| Discord user ID (a public snowflake) | To count a member once and follow them through the funnel. |
| Guild ID, channel IDs | To see which rooms convert. |
| Timestamps | The entire point - joins, first message, retention. |
| Invite code a join is attributed to | To see which growth efforts work. |
| Inviter's user ID | To credit members who bring people in. |

## What is deliberately not stored

- **Public-channel message content.** `MessageContent` is required for ticket
  parity and is also used by explicitly enabled automod. Automod inspects public
  messages in memory for configured filters, then discards the content; it is
  never written to the database, audit metadata, or process log. Ticket bodies
  are read only when staff closes a bot-created private ticket and are retained
  as a staff-only transcript for 90 days. Funnel handlers record only that a
  public message happened, never what it said.
- **Usernames, nicknames, avatars outside ticket transcripts.** Not needed to count anything. A user ID is
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

Private ticket transcripts are retained for **90 days after close**. Startup
deletes rows whose `purge_after` has passed. Attachment URLs are references to
Discord's copy, not retained attachment bytes, and may expire sooner.

## Deletion

If a member asks to be removed:

```sql
DELETE FROM ticket_transcripts WHERE opener_id = '<id>' OR claimed_by = '<id>';
DELETE FROM tickets            WHERE opener_id = '<id>' OR claimed_by = '<id>';
DELETE FROM xp_awards          WHERE member_id = '<id>';
DELETE FROM xp_cooldowns       WHERE member_id = '<id>';
DELETE FROM member_levels      WHERE member_id = '<id>';
DELETE FROM events             WHERE member_id = '<id>';
DELETE FROM members            WHERE member_id = '<id>';
DELETE FROM automod_violations WHERE user_id = '<id>';
```

`TicketStore.eraseMember()` performs the ticket-table portion in one transaction.
This makes historical counts drop slightly, which is correct.

## Boundaries this codebase enforces

- **Nothing here messages a member.** The inactivity job writes an event and
  returns a list of IDs. No DM, no ping, no bulk message. Anything outbound
  needs explicit CEO sign-off before it is built, not after.
- **Rules-gate timeout audits stay local.**
  `data/rules-gate-timeout-audit.jsonl` records one member ID and outcome per
  target. `data/*` is gitignored, so this per-member moderation record must not
  be committed or copied into an issue. Report aggregate counts there instead.
- **Public-channel bodies are never persisted.** Enabled automod evaluates them
  in memory and retains no content. The ticket closer reads only a bot-created
  private support channel, stores its transcript in the bot database, and deletes
  it after 90 days. The historical backfill still never reads a channel members
  talk in.
- **No presence intent.** `src/discord/client.ts` requests five intents and
  `GuildPresences` is not one of them, so we never see a member's online
  status. The bot does record the guild's `approximate_presence_count` hourly
  (TOG-469) — but that is a single number for the whole server from a REST
  response, with no per-member data in it at all, and it is never published. A
  test asserts both halves of that. See `docs/PRESENCE_PROBE.md`.

> **The bot account currently holds Administrator.** An earlier version of this
> page said it could not kick, ban or manage roles. That is no longer true: it
> was invited with Administrator so the permission set would not need redoing
> as features land. Nothing in this codebase uses those powers, and
> `scripts/preflight.ts` warns about it on every run — but the honest statement
> is "the code does not do this", not "the bot cannot". Narrowing the grant to
> View Channels + Manage Server is tracked as an open item.
