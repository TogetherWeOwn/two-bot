# Owen moderation

Owen exposes the moderation family through guild-scoped slash commands and the signed internal-actions endpoint:

- `ban`, `tempban`, `kick`, `timeout`, `warn`
- `purge` (1-100 recent messages)
- `slowmode` (0-21,600 seconds)
- `lockdown`, `unlock`

## Safety model

Every action requires a non-empty reason and an idempotency key. Slash commands use the Discord interaction id; internal actions require the existing `Idempotency-Key` header. The signed caller supplies `actor_id`; Owen resolves the actor's current roles and permissions from Discord rather than trusting permission claims in the body.

Target actions refuse:

- the guild owner;
- Owen itself;
- any bot;
- any member with a role in `TWO_MODERATION_PROTECTED_ROLE_IDS`;
- self-targets;
- targets at or above the moderator's highest role;
- targets at or above Owen's highest role;
- moderators lacking the command-specific Discord permission.

Warnings live in `moderation_warnings`. Every successful action has a row in `moderation_audit`. Temporary bans create `moderation_scheduled_unbans`; a 30-second poller unbans due members and writes a second audit row.

## Durability (TOG-1659)

- **One atomic claim per operation.** `(guild_id, idempotency_key)` is claimed in `moderation_idempotency` via `INSERT ... ON CONFLICT DO NOTHING` BEFORE any Discord mutation, for slash commands and internal actions alike. A concurrent duplicate loses the claim and gets `in_progress`; a retry of a completed key replays the stored result; a key reused with different content is refused as a mismatch; a failed attempt releases its claim so a retry is a real second attempt.
- **Tempban expiry is written before the ban.** A crash after Discord accepts the ban still leaves a pending unban job; the worst case is an unban of a re-appliable ban, never a permanent ban the moderator asked to be temporary. Re-tempbanning the same user moves the one pending job (partial unique index) instead of forking a second.
- **Unban sweeps claim rows.** `runDueUnbans()` moves due rows `pending -> running` with one `UPDATE ... RETURNING`, so two overlapping sweeps cannot process the same job. A failed unban is requeued; a `running` claim older than 60 seconds is taken over by the next sweep (crash recovery).
- **Lockdown preserves the @everyone overwrite.** Lock reads the current overwrite, stores the prior allow/deny masks in `moderation_lockdowns`, and writes back the prior bits plus a `SendMessages` deny. Unlock restores the recorded masks exactly. With no recorded state (a lock that predates this table), unlock clears only the `SendMessages` deny - the minimal change that cannot grant anything new.
- **Backups and migration carry all of it.** `moderation_warnings`, `moderation_scheduled_unbans`, `moderation_audit`, `moderation_lockdowns`, and `moderation_idempotency` are in `DUMP_TABLES` (pg-backup/pg-restore round trip) and in `scripts/migrate-sqlite-to-postgres.ts` (a source file lacking them is skipped, not fatal).

## Configuration

Moderation stays off unless all staging configuration is intentional:

```text
TWO_MODERATION=1
TWO_OWEN_USER_ID=<Owen QA Test application user id>
TWO_MODERATION_PROTECTED_ROLE_IDS=<comma-separated staging staff role ids>
TWO_INTERNAL_ALLOW_MODERATION=1
```

`DISCORD_GUILD_ID` must be the TWO Staging guild (`1545644954272137297`) during parity proof. Do not point this slice at the live guild. Live rollout is a separate owner-gated operator action.

## Internal action bodies

Target example:

```json
{
  "action": "moderation.timeout",
  "actor_id": "...",
  "target_id": "...",
  "duration_seconds": 600,
  "reason": "Repeated spam after warning"
}
```

Channel example:

```json
{
  "action": "moderation.purge",
  "actor_id": "...",
  "channel_id": "...",
  "count": 25,
  "reason": "Remove raid spam"
}
```

Use a fresh nonce for retries and the same `Idempotency-Key`. A matching retry replays the stored result and never performs a second moderation action.
