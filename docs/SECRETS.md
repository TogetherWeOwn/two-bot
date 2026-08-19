# Secrets

## The rules

1. Secrets come from the environment. Never from a file in this repository.
2. `.env` is gitignored. `.env.example` holds the *names* of the variables and
   never a value.
3. In production, secrets live in `/etc/two-bot/two-bot.env`, root-owned,
   `chmod 600`, loaded by systemd's `EnvironmentFile=`.
4. A secret never goes into a log line, an issue comment, a chat message, or a
   screenshot. `src/core/log.ts` only logs what it is explicitly given, and no
   call site passes it the token.
5. If a token is exposed, rotate it in the Discord developer portal first and
   worry about how it happened second. Rotation is cheap; a live leaked token is
   somebody else's bot in our server.

## What the bot needs

| Variable | Required | What it is |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token from the Discord developer application. |
| `DISCORD_GUILD_ID` | no | Restrict to one server. |
| `TWO_DB_PATH` | no | Defaults to `./data/two.db`. |
| `TWO_INACTIVITY_DAYS` | no | Days of silence before flagging. Defaults to 14. |
| `LOG_LEVEL` | no | `debug` / `info` / `error`. Defaults to `info`. |
| `DISCORD_API_BASE` | no | **Testing only.** Points discord.js at the local mock. Must be unset in production. |

## Bot permissions to grant

Scoped to what the funnel actually needs. Not Administrator.

**Privileged gateway intents** (Discord developer portal → Bot):
- Server Members Intent — required for `member_join` / `member_leave`. Without
  it there is no funnel at all.
- Message Content Intent — **leave OFF.** We count that a message happened; we
  never read it.

**OAuth2 scopes:** `bot`

**Permissions:** `View Channels`, `Manage Server`.

`Manage Server` is the uncomfortable one, so to be explicit about why: it is the
only permission that allows reading the server's invite list, and reading invite
use-counts is the only way Discord lets anyone attribute a join to an invite.
Without it every join is recorded as `unknown` and we cannot tell which growth
efforts work. It does not grant kick, ban, or message-sending.

## Not needed, not requested

The bot does not ask for and must not be given: Administrator, Kick Members,
Ban Members, Manage Roles, Manage Channels, or Send Messages. It is a
read-and-record service. When onboarding automation lands it will need
`Send Messages` in specific channels only, and that is a separate conversation.

## Checking it is right

`scripts/preflight.ts` verifies all of the above against the live Discord API
without connecting to the gateway or touching the database:

```bash
DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/preflight.ts
```

It exits non-zero only on things that break the funnel (dead token, Server
Members Intent off, no Manage Server, invite list unreadable) and warns on
access we hold but did not ask for. Run it before a deploy and any time joins
start recording as `unknown`. It never prints the token.

## Current state

The live token was issued on 2026-08-19 and verified against the real
**TogetherWeOwn** server (`326474832151838730`) as bot `Owen`. It is held as the
Paperclip secret `discord_bot_token` and injected as an environment variable;
it is not written to any file in this repository.

Preflight against the live server currently passes with two warnings, neither
of which blocks data collection:

- **Message Content Intent is ON.** It should be off. We never request the
  intent in code, so no content can reach the database, but the application is
  configured to be capable of reading it and that contradicts `docs/PRIVACY.md`.
- **The bot was granted Administrator.** It needs `View Channels` and
  `Manage Server` only. Administrator implies every permission we explicitly
  said this bot must not have — kick, ban, manage roles, send messages.

Both are Discord-portal changes owned by whoever administers the server, and
both are tracked on TWO-11. Everything before the token arrived was built and
verified against a local mock Discord (see `tools/mock-discord/`).
