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
