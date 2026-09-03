# Secrets

## The rules

1. Secrets come from the environment. Never from a file in this repository.
2. `.env` is gitignored. `.env.example` holds the *names* of the variables and
   never a value.
3. In production, secrets are **systemd credentials**, not environment
   variables. Source files live in `/etc/two-bot/credentials/`, root-owned,
   `chmod 600`, and systemd copies each into a private per-service directory
   mode `0400` owned by the service user. `/etc/two-bot/two-bot.env` still
   exists and is still loaded by `EnvironmentFile=`, but it now holds
   **non-secret configuration only**: guild ID, channel IDs, log level, feature
   flags. See "Why credentials and not environment variables" below.
4. A secret never goes into a log line, an issue comment, a chat message, or a
   screenshot. `src/core/log.ts` only logs what it is explicitly given, and no
   call site passes it the token.
5. If a token is exposed, rotate it in the Discord developer portal first and
   worry about how it happened second. Rotation is cheap; a live leaked token is
   somebody else's bot in our server. The step-by-step, including the part
   people forget — deleting the old copy — is **"Rotate the bot token"** in
   `docs/RUNBOOK.md`.
6. Un-binding a secret from somewhere it should not have been is not the same as
   rotating it. The value was still readable while it was there. Un-bind, then
   rotate.

## Why credentials and not environment variables

The bot is going onto a machine it **shares** with the website, Postgres and
staging. That was not true when this file was written.

An environment variable is readable from `/proc/<pid>/environ`, is inherited by
every child process the bot spawns, and lands in a core dump. A systemd
credential is a `0400` file in a private directory that exactly one Unix user
can open. Against a fully compromised PHP-FPM worker running as the web user,
the first is a hope and the second is a fact.

Neither stops root. Nothing stops root — that is a custody question, answered by
whoever owns the box (TWO-79), not by a config file. The full accounting is the
`hosting-decision` document on TWO-37.

| Secret | Credential name | Env fallback |
|---|---|---|
| Discord bot token | `discord_token` | `DISCORD_BOT_TOKEN`, then `DISCORD_TOKEN` |
| Postgres URL | `database_url` | `TWO_DATABASE_URL` |
| Internal-actions signing keys | `internal_keys` | `TWO_INTERNAL_KEYS` |

The credential wins when present. The environment fallback is what makes local
development, CI and the one-off scripts keep working unchanged — none of those
run under systemd. Provisioning is in `deploy/two-bot.service`, and a credential
file that is empty or whitespace falls through to the environment rather than
starting the bot with an empty token.

**When you migrate a live box: delete the token line from
`/etc/two-bot/two-bot.env`.** The credential wins either way, so a stale copy
left behind is not a broken deploy — it is just the exposure you were removing,
still there, silently.

## What the bot needs

| Variable | Required | What it is |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token from the Discord developer application. Credential `discord_token` in production. |
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

**Permissions:** `View Channels`, `Manage Server`, `Manage Roles`,
`Manage Events`, `Create Instant Invite`, `Send Messages`.

**Permission integer: `8858373153`** (verified against `discord.js`'s own
`PermissionFlagsBits` constants, not hand-computed). Apply/invite URL, using
the live application id:

```
https://discord.com/api/oauth2/authorize?client_id=1539711683898118154&permissions=8858373153&scope=bot
```

`Manage Server` is the uncomfortable one, so to be explicit about why: it is the
only permission that allows reading the server's invite list, and reading invite
use-counts is the only way Discord lets anyone attribute a join to an invite.
Without it every join is recorded as `unknown` and we cannot tell which growth
efforts work.

The other four (`Manage Roles`, `Manage Events`, `Create Instant Invite`,
`Send Messages`) are not read-and-record permissions — they exist solely
because the internal-actions endpoint (TOG-44) needs them: `role.assign`,
`event.upsert`, `guild.add_member`, and `announcement.post` respectively. See
`docs/INTERNAL_ACTIONS.md` §8 for the full mapping. `Send Messages` should be
constrained to the announcement channel via a channel permission overwrite in
the Discord UI, not left as an unrestricted guild-wide grant, even though the
OAuth invite integer above necessarily requests it at the role level.

**Server-config prerequisite, not a permission bit:** the bot's highest role
must sit *above* any role `role.assign` grants. This is set in Discord's role
order UI, not via the OAuth invite, and is the most common way role assignment
breaks even when every bit above is correctly granted.

## Not needed, not requested

The bot does not ask for and must not be given: Administrator, Kick Members,
Ban Members, or Manage Channels. It is a read-and-record service plus the four
internal-actions bits above — nothing that lets it moderate the server.

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

**Preflight is not the acceptance test for the permission cut.** It asks
"is this bit present?", so it cannot fail on access we hold but did not ask
for — Administrator answers yes to every one of its checks. A bot re-invited
with the new integer but still carrying its old Administrator role passes
preflight with a WARN and exit 0. Use `verify-grant.ts` for that question:

```bash
DISCORD_TOKEN=... DISCORD_GUILD_ID=... npm run verify:grant
```

It exits non-zero on any missing bit, any extra bit, and on Administrator
specifically, so exit 0 means the live grant is bit-for-bit `8858373153` and
nothing more. `npm run verify:grant:selftest` runs its six cases offline with
no token and no network; CI runs it on every PR.

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
both are tracked on TWO-11. **They are not equally safe to act on.** Turning
Message Content Intent off is safe today and should happen. Dropping
Administrator down to exactly `View Channels` + `Manage Server` is **not**
safe: the routed welcome (TWO-69) needs `Send Messages` and `Manage Roles`,
and one-click join (TWO-57) additionally needs `Manage Events` and
`Create Instant Invite`. Administrator is covering all four by accident;
`Manage Server` implies none of them.

**TOG-64 reconciled this** (2026-09-02): the target grant is the six-bit set
above, permission integer `8858373153`, not the two-bit set this section used
to describe. `scripts/preflight.ts` now asserts all four internal-actions bits
explicitly. Applying it — via the invite URL above, re-inviting the bot with
the new permissions — is still a Discord-portal change gated on whoever
administers the server; this repo cannot execute it. After applying it, run
`npm run verify:grant` — **not** preflight — against the live token: it is the
only check that fails if Administrator is still attached, which is how this
change most plausibly gets half-done. Everything before the token arrived was
built and verified against a local mock Discord (see `tools/mock-discord/`).
