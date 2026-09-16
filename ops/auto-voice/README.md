# Auto-Voice-Channels on the live TWO guild (TOG-3052, phase 1)

Join-to-create voice channels, **now**, by running the best existing bot as a
second bot beside Owen — rather than waiting for the port into Owen, which is
phase 2 (TOG-3044). `Squad` becomes the generator; `Lobby` is untouched.

**This directory contains no upstream code.** It is our deployment definition
only, and it builds upstream straight from a pinned commit. Nothing here is a
fork, and nothing here may become one — see *Licence*.

> **No `two-bot` code changes belong in this card's scope.** Owen must not gain a
> `voiceStateUpdate` handler while AVC is live: two bots reconciling the same
> voice channels is exactly the collision phase 2 exists to resolve.

---

## 1. Licence

Upstream ships **`LICENSE` = GNU Affero General Public License v3.0**
(`LICENSE:1`, blob `be3f7b28e564e7dd05eaf59d64adba1a4065ac0e`), and
`package.json:5` declares `"license": "AGPL-3.0-only"` — **self-hosting is
expressly permitted**, and running it unmodified as its own service keeps
`two-bot` proprietary because we create no derivative work.

The obligation that *does* reach us is **AGPL §13** (`LICENSE:540`, "Remote
Network Interaction"): users interacting with it over a network must be offered
the corresponding source. We discharge that by publishing the exact commit we
run:

> <https://github.com/GregZaal/Auto-Voice-Channels/tree/8fab5e8d78aa252195dcea1bcd3d313cb1ba0802>

**Therefore the load-bearing constraint on this deployment is: change no upstream
source file.** If a behaviour needs changing, configure it, upstream a PR, or
record it for phase 2. A local patch converts this into a modified AGPL work and
pulls a source-offer obligation back onto us. That is why the compose file here
builds from a git context instead of vendoring their tree.

(The `master` branch is the *old Python* bot, unmaintained and MIT. We do not run
it. `main` is the TypeScript rewrite and is the AGPL one.)

## 2. Pinned commit and runtime

| | |
|---|---|
| Commit | `8fab5e8d78aa252195dcea1bcd3d313cb1ba0802` (branch `main`, 2026-09-16 10:58:29 +0200) |
| Language | TypeScript / Node.js **≥ 22**, pnpm 9.15.0 workspace (`core/` + `bot/`) |
| Dockerfile | **Yes**, upstream ships one — multi-stage, base pinned by digest |
| Compose | Upstream ships one too; we do **not** use it (see §3) |
| Datastore | **PostgreSQL 16** — the only persistent state. No config file. |
| Migrations | Run automatically on boot |
| HTTP | `:8080` — `/health` (per-subsystem) and `/diagnostics` |

**Pin note:** tag `v2.1.1` is `48e0c3d07a0795ae6c32b7c45898799271cad195`, which is
*behind* `main`. `package.json` still says `2.1.1`, so the version string does not
identify the build — the commit above is the only honest identifier.

**Required gateway intents** (`bot/src/gateway/client.ts:52-56`):
`Guilds`, `GuildVoiceStates`, `GuildMembers`, `GuildPresences`.

> ⚠️ **`GuildMembers` and `GuildPresences` are privileged.** They must be toggled
> on in the Discord Developer Portal (Bot → Privileged Gateway Intents) or the
> bot fails to connect at all. Presence is what lets room names follow the game
> being played; it is not optional here because upstream requests it
> unconditionally.

## 3. Why not upstream's `docker-compose.yml`

Upstream's compose is written for a laptop. On this VPS it would:

- publish **Postgres on host `:5432`**, colliding with the owner's existing
  Postgres, **with the password `postgres`**; and
- publish the bot on host `:8477`, exposing `/diagnostics` off-box.

Fixing that in their file means editing upstream, which is precisely what the
licence position forbids. So `docker-compose.yml` here builds *their* Dockerfile
from the pinned git context and declares our own runtime: no published ports, a
real Postgres password, log caps, and a healthcheck on `/health`.

## 4. Coolify application

Create a **second, separate** Coolify application — not a service inside the
two-bot app.

| Field | Value |
|---|---|
| Type | Docker Compose |
| Source | the existing **two-bot** VPS git mirror |
| Branch | `main` (after this PR merges) |
| Compose path | `ops/auto-voice/docker-compose.yml` |
| Suggested name | `auto-voice` |

No mirror of the *upstream AVC* repo is needed: the build context is a pinned
git URL, fetched by the Docker daemon at build time. If the build host cannot
reach `github.com`, create a bare mirror of upstream on the VPS and point
`AVC_GIT_CONTEXT` at it — **keeping the `#<sha>` fragment**.

Environment variables: see [`.env.example`](./.env.example). Two are secrets
(`AVC_DISCORD_BOT_TOKEN`, `AVC_POSTGRES_PASSWORD`); the rest are plain values.

**Boot check before touching the live guild.** After the first deploy, with the
bot in the guild but **before** `Squad` is renamed or the config imported, the
container should reach healthy and `/health` should report the database and
gateway green. AVC does nothing to a guild it has no creator channel configured
for, so this is a safe, fully reversible state to stop and look at.

```bash
docker compose -f ops/auto-voice/docker-compose.yml ps
docker compose -f ops/auto-voice/docker-compose.yml exec bot \
  node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"
```

## 5. Permissions

A creator channel needs **all five** of these, or AVC refuses to use it
(`bot/src/commands/setupPanel.ts:83-87`): View Channels, Connect, Manage
Channels, **Move Members**, Manage Roles.

Measured against the live guild on 2026-09-16, the managed role **`Auto-Voice`
(`1549880755486851214`)** resolves on `Squad` (`1546777867978018887`) to:

| Permission | Effective on `Squad` |
|---|---|
| View Channels | ✅ (via `@everyone`, not the role) |
| Connect | ✅ |
| Manage Channels | ✅ |
| **Move Members** | ❌ **missing — required** |
| Manage Roles | ✅ |

**Move Members is the only gap, and it is required.** Without it the bot creates
the room and then cannot move the member into it — the worst failure mode here,
because it looks like the feature half-works. Grant it on the **🔊 VOICE
category** (`1545924266590081115`), not server-wide, and do **not** grant
Administrator.

## 6. Making `Squad` the generator

The generator is **not** an environment variable. AVC stores it in Postgres, set
either interactively via `/setup` or declaratively via `/import`.

Use `/import` with [`avc-config-326474832151838730-2026-09-16.json`](./avc-config-326474832151838730-2026-09-16.json).
It is reviewable, diffable, and identical every time, where `/setup` is a
click-path nobody can audit afterwards. `/import` shows a preview and emits a
pre-import snapshot file **before** it writes anything — keep that snapshot; it
is the documented undo.

That file sets:

- `settings.enabled: true`
- `settings.channel_name_template: "Squad ##"` → rooms named `Squad #1`, `Squad #2`, …
- creator channel `1546777867978018887` (`Squad`), `above: false` so rooms appear
  **below** `Squad`, which already sits directly below `Lobby` (positions 12/13
  under 🔊 VOICE)
- `adopted_channels: []` — **`Lobby` is not mentioned anywhere in the file** and
  is not touched

> `##` is the channel-number token. `@@num@@` is the **member count** and would
> name an empty room `Squad 0` — verified by rendering both through
> `renderChannelName` at this commit.

Settings keys that are simply absent from the file are left alone, so the import
changes exactly what is listed above and nothing else.

## 7. Rollback

Fully reversible, in the order things were done:

1. **Stop the bot.** Coolify → `auto-voice` → Stop. Rooms it already created stay
   until manually deleted; delete any empty `Squad #N` channels by hand.
2. **Restore the previous config** by re-importing the pre-import snapshot from
   §6 (or just leave it — a stopped bot acts on nothing).
3. **Rename `Squad` back** to `Squad` if it was renamed.
4. **Kick the bot** (`Auto-Voice`, `1549879082085515364`) from the guild.
5. **Remove the Coolify app.** Deleting the `avc-pgdata` volume destroys every
   setting — intended on a full teardown, and irreversible.

Nothing above touches Owen, `two-bot`'s database, or `Lobby`.

## 8. Verifying what is actually deployed

`GIT_COMMIT` is baked in at build time and surfaced on `/health` and
`/diagnostics`, so the running container can be asked what it is:

```bash
docker compose -f ops/auto-voice/docker-compose.yml exec bot \
  node -e "fetch('http://127.0.0.1:8080/diagnostics').then(r=>r.text()).then(console.log)"
```

It must equal `8fab5e8d78aa252195dcea1bcd3d313cb1ba0802`. A `dev` here means the
build arg did not reach the builder and the deploy is unpinned.
