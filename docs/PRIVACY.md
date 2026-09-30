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
  messages in memory for configured filters and never writes their content to
  the database, audit metadata, or process log. Repeat detection retains only a
  process-random keyed digest and message ID for the configured repeat window,
  then deletes both automatically. Ticket bodies are read only when staff closes
  a bot-created private ticket and are retained as a staff-only transcript for
  90 days. Funnel handlers record only that a public message happened, never
  what it said.
- **Usernames, nicknames, avatars outside ticket transcripts.** Not needed to count anything. A user ID is
  enough, and it is what Discord itself treats as the identifier. If the
  community team needs names for a re-engagement list, the list of IDs can be
  resolved to names at the moment it is used, and thrown away after.
- **Email, IP, location, voice audio.** Never collected.

## Invite-redirect clicks

`GET go.two.gg/<campaign>` records one `invite_click` row, then 302s to the
Discord invite (`src/redirect/`, TOG-116). A click row is a campaign and a
timestamp — the whole record:

- `member_id` is always NULL. `source` is `invite:<code>` and `metadata` is
  exactly `{"campaign": "<slug>"}` — both ours, never the visitor's.
  `occurred_at`/`recorded_at` are server timestamps; `idempotency_key` is the
  guild, the timestamp and a random per-request token.
- No IP address, user agent, referrer, cookie, query string or fingerprint is
  stored, logged or written to the event. The query string is dropped unparsed;
  HEAD previews, health/favicon probes, unknown slugs, throttled (429),
  outage-fallback and misconfigured-code paths record nothing.
- The socket address is read to pick a rate-limit bucket and never leaves the
  request handler — process memory only, never stored, logged or written.

`test/unit.redirect.test.ts` asserts this with identifying headers in: a
full-row allowlist (any extra populated column fails) plus error-path
coverage.

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

## Onboarding reply-rota measurements

The measurement core described in [ONBOARDING_ROTA.md](ONBOARDING_ROTA.md) adds
pseudonymous derived rows to `community_facts`. The disabled-by-default runtime
adapter observes the existing gateway flow. An explicitly bound primary can use
the staging-only, ephemeral acknowledgement command; it stores no message body,
handle or raw primary id. These rows contain a guild-separated keyed member pseudonym,
source-cohort code, timestamps, action/channel IDs and a keyed responder
pseudonym, never a public-message body or handle. The dedicated key is not stored
in the database. Do not expose rota rows through public reporting views.

Authorized rota-log readers are the accepted human primary, Community Manager
and President & COO. An authorized erasure must also delete derived rows for the
member pseudonym and any reply/latency/acknowledgement rows containing that responder pseudonym;
`OnboardingRota.eraseSubject()` performs the rota portion in one transaction
(see [ONBOARDING_ROTA.md](ONBOARDING_ROTA.md) for the key/guild scope and the
exact queries). Disabling measurement is
not erasure and does not rotate the pseudonym key.

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
DELETE FROM ticket_transcripts         WHERE opener_id = '<id>' OR claimed_by = '<id>';
DELETE FROM tickets                    WHERE opener_id = '<id>' OR claimed_by = '<id>';
DELETE FROM xp_awards                  WHERE member_id = '<id>';
DELETE FROM xp_cooldowns               WHERE member_id = '<id>';
DELETE FROM member_levels              WHERE member_id = '<id>';
DELETE FROM events                     WHERE member_id = '<id>';
DELETE FROM capture_pending_joins      WHERE member_id = '<id>';
DELETE FROM members                    WHERE member_id = '<id>';
DELETE FROM member_ranks               WHERE member_id = '<id>';
DELETE FROM member_exclusions          WHERE member_id = '<id>';
DELETE FROM invite_snapshots           WHERE inviter_id = '<id>';
DELETE FROM community_facts            WHERE actor_id = '<id>';
DELETE FROM automod_violations         WHERE user_id = '<id>';
DELETE FROM automod_processed_messages WHERE user_id = '<id>';
DELETE FROM moderation_warnings        WHERE user_id = '<id>' OR actor_id = '<id>';
DELETE FROM moderation_scheduled_unbans WHERE user_id = '<id>';
DELETE FROM moderation_audit           WHERE target_id = '<id>' OR actor_id = '<id>';
DELETE FROM operational_audit_log      WHERE target_id = '<id>' OR actor_id = '<id>';
DELETE FROM containment_events         WHERE target_id = '<id>' OR executor_id = '<id>';
DELETE FROM containment_incidents      WHERE executor_id = '<id>';
DELETE FROM join_risk_flags            WHERE member_id = '<id>';
DELETE FROM event_rsvps                WHERE user_id = '<id>';
DELETE FROM lfg_signups                WHERE user_id = '<id>';
DELETE FROM self_role_audit            WHERE member_id = '<id>';
DELETE FROM self_role_panel_claims     WHERE member_id = '<id>';
-- Rota pseudonym erasure (guild-separated HMAC pseudonym, NOT the raw ID:
-- compute it with the rota key first, or use OnboardingRota.eraseSubject()).
-- <id> below is the pseudonym; <guild> is the guild ID. All bound parameters.
DELETE FROM community_facts            WHERE guild_id = '<guild>' AND actor_id = '<id>';
DELETE FROM community_facts            WHERE guild_id = '<guild>'
                                         AND event_type IN ('welcome_rota_acknowledged', 'welcome_rota_replied',
                                                            'onboarding_first_human_reply', 'onboarding_reply_latency')
                                         AND metadata::json->>'responderId' = '<id>';
DELETE FROM operational_audit_log      WHERE guild_id = '<guild>' AND event_kind = 'rota_notice' AND target_id = '<id>';
DELETE FROM temp_voice_creates         WHERE user_id = '<id>';
DELETE FROM temp_voice_audit           WHERE actor_id = '<id>';
DELETE FROM temp_voice_channels        WHERE owner_id = '<id>' OR generator_id = '<id>'
                                        OR pending_owner_id = '<id>';
DELETE FROM announcements_audit_log    WHERE actor_id = '<id>';
DELETE FROM automation_audit_log       WHERE actor_id = '<id>';
```

`TicketStore.eraseMember()` performs the ticket-table portion in one transaction.
`OperationalAuditStore.eraseMember()` performs the operational-audit portion in one transaction;
its opaque `entry_id` may still contain a member ID for event identity, so matching rows are deleted rather than anonymized.
This makes historical counts drop slightly, which is correct.

What the block above deliberately does not touch, and why:

- **Inviter IDs inside other members' join rows.** `events.metadata` on a
  `member_join` row can carry `{inviterId}`. Deleting the member's own rows
  leaves that attribution inside somebody else's join record, where it belongs
  — it is that member's funnel history, and removing it would corrupt their
  row. Erasure removes what the member *is*, not what they caused.
- **Staff-admin attribution** (`created_by`/`updated_by` on automation,
  scheduled/sticky, feed, LFG-post and temp-voice-channel definitions;
  `guild_settings.updated_by` and `guild_settings_audit.actor`). These name
  the admin who saved a definition, not the member being erased. When the
  requester was themselves the admin author, reassign or remove those rows
  case by case; there is no blanket DELETE because most of the time the two
  people are not the same.
- **Free-form audit keys** (`target_key` on the automation/announcements
  audit logs, `source_id` on self-role audit rows). These are not provably
  member IDs, so no DELETE line can match them reliably; review the rows by
  hand when the action that wrote them could have named the member.
- **`presence_probe`** holds one guild-wide number per hour with no
  per-member data (see `docs/PRESENCE_PROBE.md`). Nothing to delete.

`test/unit.privacyretention.test.ts` pins this section: the 90-day
`purge_after` arithmetic, the startup-purge predicate, both `eraseMember`
implementations, and a schema sweep that fails when a new per-member column
lands without a DELETE line (or a written reason it needs none).

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
- **No presence intent.** `src/discord/client.ts` requests six intents and
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
