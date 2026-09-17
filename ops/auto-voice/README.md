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

### 1.1 One deliberate exception: the bot status (TOG-3143)

**We now run a modified version.** The owner asked for upstream's
`auto-voice.io · /setup` advertisement to be removed from the bot's Discord
status, and then — 01:48Z, after seeing `/setup` alone — for the whole status to
go. Upstream offers no way to configure either: at the pinned commit
`bot/src/gateway/client.ts:17` is a module constant with no environment or
database read, `:50` is the `activities:` array that renders it, those are its
only two references in the tree, and `setPresence`/`setActivity` have zero hits
anywhere — so identify is the only place a presence is ever set. The only way to
honour the request is to change the code, and §3.1 describes how.

What that costs us, stated plainly:

- **Removing the advert is itself permitted.** It is a marketing status, not an
  "Appropriate Legal Notice" under §5(d) and not an author attribution protected
  under §7(b), and upstream's `LICENSE` is stock AGPL-3.0 with no §7 additional
  terms. Nothing forbids the edit.
- **But §13 now applies to us.** Running a modified version as a network service
  means we must offer its Corresponding Source to the users interacting with it.
  The commit pointer above is no longer a sufficient offer on its own, because
  the thing we run is no longer that commit.
- **The fix is small and does not reach `two-bot`.** Corresponding Source here is
  the pinned upstream commit (already public) plus
  [`status-patch.sh`](./status-patch.sh) — and nothing else. It does not extend
  to `two-bot`'s own source: Owen is a separate program in a separate container
  under a separate Discord application, with no linking — so the earlier worry
  that a patch "pulls a source-offer obligation onto `two-bot`" overstates it.
- **One file, by construction.** The patch is kept out of `docker-compose.yml`
  precisely so the artifact we must offer is ~40 lines of self-contained shell
  rather than a deployment definition carrying our Postgres topology, our secret
  variable names, our healthcheck and our guild ids. `status-patch.sh` is the
  only file that modifies upstream's program, it references no credential and no
  identifier of ours, and `test-status-patch.sh` asserts that (G10) so it stays
  true. Offering the compose file is not required and should not be volunteered.

> ⚠️ **Open item:** publishing this directory is a public-facing act and is not
> an engineering call. It is raised on **TOG-3150** (Director of Engineering), not
> decided here and not decided on TOG-3143. Until it is settled we are
> running a modified AGPL work with an undischarged §13 offer — which was already
> true the moment the operator patched the live container by hand at 01:46Z on
> 2026-09-17; this file did not create that state, it only made it durable and
> visible.

The escape hatch, if the answer is "do not publish": set `AVC_STATUS_MODE` to
`upstream`. The patch then does nothing, upstream runs verbatim, advert and all,
and §1's original constraint holds again with no other change. Note this is an
escape hatch from the *licence* position only — it reinstates the advertisement
the owner asked twice to remove, so it is not a decision to take quietly.

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

### 3.1 The bot-status patch (TOG-3143)

Read §1.1 first for why this exists and what it costs.

**Mechanism.** [`status-patch.sh`](./status-patch.sh) rewrites the compiled
constant in `/app/bot/dist/gateway/client.js` and then execs the command it was
given. `docker-compose.yml` bind-mounts it read-only at
`/opt/avc/status-patch.sh`, sets `entrypoint: [/bin/sh, /opt/avc/status-patch.sh]`,
and restates upstream's own `CMD` as `command:` — necessary because setting
`entrypoint:` clears the image's CMD. It runs **on every container start**, in
the container's writable layer. That is the whole point of the card: the
operator's original hand-edit survived a restart but a Coolify redeploy recreates
the container from the image and would have brought the advert back.

**Why a separate file and not an inline `entrypoint:` script.** Licence, not
correctness — see §1.1. AGPL §13 makes us offer the patch as Corresponding
Source; keeping it out of the compose file means what we offer is one
self-contained script with no secrets and no topology in it. It is mounted rather
than baked into the image because baking it in needs a Dockerfile of our own,
which is the thing §3.1 exists to avoid.

**Why start-time and not build-time.** A build-time patch needs a Dockerfile of
our own, and the only way to inject a step into upstream's multi-stage build is
to duplicate it — which drifts from upstream silently and copies their tree into
ours. Patching at start keeps the image we build byte-identical to stock
upstream, so the pinned commit stays an honest description of what we *build*,
and it keeps this whole change to one reversible block in one file. A tracked
fork was the other option on the card and is strictly worse on both counts.

**Two anchors, not one.** The patch rewrites both lines of upstream's presence:
the `SETUP_STATUS` constant at `client.ts:17` *and* the `activities:` array at
`client.ts:50` that renders it. The array anchor is what makes **removal**
expressible — no value of the status text can ever produce `activities: []`, and
removal is what was actually asked for (01:48Z: *"REMOVE THE WHOLE STATUS
PLEASE"*). A revision that only rewrote the string could change the advert but
never delete it.

| Variable | Default | Meaning |
|---|---|---|
| `AVC_STATUS_MODE` | `none` | `none` = no custom status at all. `text` = a custom status reading `AVC_STATUS_TEXT`. `upstream` = do not patch; upstream's advert in full. |
| `AVC_STATUS_TEXT` | *(empty)* | The status text. Required and non-empty when `MODE=text`; setting it under `MODE=none` is a **hard start-up failure**, not a silent no-op. |
| `AVC_STATUS_ENFORCE` | `strict` | `strict` = refuse to start if an anchor is missing. `warn` = log and boot with upstream's advert. Covers upstream *moving*; never covers a bad `MODE`/`TEXT` pair. |
| `AVC_STATUS_PATCH_PATH` | `./status-patch.sh` | Host path of the script to mount. Only set it if your runner overrides the Compose project directory — see §8. |

> **The default is removal.** With no `AVC_*` variable set at all — a redeploy
> that forgets to pass environment, a fresh Coolify app, a `docker compose up`
> from a clean shell — the bot comes up with no custom status. The wanted
> behaviour is what you get by doing nothing; the advert has to be asked for by
> name. `test-status-patch.sh` G0 scrubs the environment and asserts exactly
> that, and G0c proves the unpatched fixture really does render the advert, so
> G0's green is the patch working and not an inert test.

> **TOG-3142** no longer gates this. It did while `/setup` was a placeholder
> status awaiting the owner's pick; the owner has since said they want no status
> at all, so there is no template to choose. TOG-3142 still covers **channel
> name** templates, which is a different surface. `MODE=text` is kept because it
> costs one branch and makes a future "actually, show X" a variable change plus a
> restart rather than a new patch.

**Fail-closed by default, on purpose.** The anchor can only go missing if someone
bumps `AVC_GIT_COMMIT`, so `strict` turns an upstream bump into a loud failure
*inside that deploy*, which is far cheaper than silently re-advertising for
weeks. If you hit it and need the bot up immediately, set `AVC_STATUS_ENFORCE=warn`,
then re-derive the patch against the new pin.

**Tests.** The anchor is a string match against generated code, so it is a script,
not a habit:

```bash
ops/auto-voice/test-status-patch.sh
```

It runs the shipped `status-patch.sh` itself — no copy, no extraction — so it
cannot drift from what deploys. **75 assertions**, of which the load-bearing ones
are behavioural rather than textual: seven cases `import()` the patched module,
call `buildGatewayClient`, and read the presence it would hand the gateway, so
they assert what Discord renders instead of asserting that a line of text looks
right.

Covered: removal as the no-environment default (G0) with a positive control that
the unpatched fixture really does render the advert (G0c); the advert being
unreachable except by asking for it by name (G0b, G8); idempotency of both modes
across a restart (G2, G13); mode switching in both directions on one writable
layer, which `docker restart` makes reachable (G14); our own misconfiguration
failing hard even under `warn` (G15); fail-closed on either anchor moving, with
`MODE=none` correctly *not* requiring the constant it does not use (G3, G5, G5b,
G16, G16b); the `warn` hatch (G4); injection safety (G6); the 128-character
Discord limit (G7); the compose⇄script wiring — mount path, entrypoint, restated
CMD, and both defaults — which is the seam the split created (G9); that the
script stays publishable under §1.1 (G10); and that being handed no command fails
loudly instead of exiting 0 (G12).

Verified by mutation, not by assumption. Reverting the default mode to `text` —
the defect the review caught — turns exactly four assertions red, G0 among them,
with the failure printing the rendered advert. Breaking the `activities:` anchor
turns 27 red. Restoring the file returns 75/75.

Point it at a real build with `AVC_REAL_DIST=/path/to/bot/dist/gateway/client.js`
(the `import()` cases skip there, since a real build needs `discord.js` on the
module path). Last run 2026-09-17: **75/75 green** on the fixture and **68/68
green, 7 skipped** against the actual `tsc --build` output of
`bot/src/gateway/client.ts` at the pinned commit — which is what pins the two
anchors, including the 12-space indent and the U+00B7 MIDDLE DOT, to real
upstream bytes rather than to a hand-written approximation of them.

## 4. Coolify application

Create a **second, separate** Coolify application — not a service inside the
two-bot app.

| Field | Value |
|---|---|
| Type | Docker Compose |
| Source | the existing **two-bot** VPS git mirror |
| Branch | `main` |
| Compose path | `ops/auto-voice/docker-compose.yml` |
| Name | `auto-voice` — created 2026-09-16, Coolify UUID `dygtaoqg0h4ap1dajl3pdm2d` |

> ⚠️ **The deployed app still builds from `tog-3052/ops-auto-voice`, not `main`.**
> That branch was auto-deleted when this directory merged and has been recreated
> as a prop so the app does not break on its next redeploy. Flipping the app to
> `main` is **TOG-3121**; the compose content is byte-identical, so it is a
> save-only change and needs no redeploy.

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

The managed role is **`Auto-Voice` (`1549880755486851214`)**. Measured against
the live guild on 2026-09-17 — re-derived from the live overwrites, not read off
the role bitfield, which reports two false gaps — it resolves on the generator
channel (`1546777867978018887`) to:

| Permission | Effective on the generator |
|---|---|
| View Channels | ✅ (via `@everyone`, not the role) |
| Connect | ✅ |
| Manage Channels | ✅ |
| **Move Members** | ✅ granted 2026-09-16 22:14Z on the category |
| Manage Roles | ✅ |
| Administrator | ❌ — and it stays that way |

**Move Members was the last gap and it is required.** Without it the bot creates
the room and then cannot move the member into it — the worst failure mode here,
because it looks like the feature half-works. It is granted on the **🔊 VOICE
category** (`1545924266590081115`), not server-wide.

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

> ⚠️ **This file was never imported, and the live guild does not match it.**
> `/import` needs a human to attach the file in Discord, so the generator was
> configured by writing the two rows the import would have produced. The room
> name template was not among them: a live join on 2026-09-17 produced
> **`Hangout #1`**, upstream's default, not `Squad #1`. The generator channel
> itself was also renamed to **`➕ Join to Create`**.
>
> Two consequences. The template is cosmetic and is tracked on **TOG-3122**. The
> **pre-import snapshot that rollback step 3 depends on does not exist**, because
> nothing ran `/import` to emit one — so treat §7 step 2 as "clear the settings
> rows", not "re-import the snapshot".

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

**Rolling back just the status patch (TOG-3143)**, without touching anything
else: set `AVC_STATUS_MODE=upstream` in Coolify and restart. Upstream runs
verbatim, advert and all, and the §1 licence position is restored. Deleting
the `volumes:`/`entrypoint:`/`command:` block from `docker-compose.yml` and
`status-patch.sh` alongside it has the same effect permanently — remove all of
them together, since without the `command:` line an image whose CMD is cleared
has nothing left to start.

## 8. Verifying what is actually deployed

`GIT_COMMIT` is baked in at build time and surfaced on `/health` and
`/diagnostics`, so the running container can be asked what it is:

```bash
docker compose -f ops/auto-voice/docker-compose.yml exec bot \
  node -e "fetch('http://127.0.0.1:8080/diagnostics').then(r=>r.text()).then(console.log)"
```

It must equal `8fab5e8d78aa252195dcea1bcd3d313cb1ba0802`. A `dev` here means the
build arg did not reach the builder and the deploy is unpinned.

**And the status patch (TOG-3143), which a redeploy is exactly what tests:**

```bash
# 1. the patch ran this boot — one line, near the top of the container log
docker compose -f ops/auto-voice/docker-compose.yml logs bot | grep avc-status
#    expect: [avc-status] bot status set to "/setup"   (or "already applied")

# 2. the advert is gone from the code the container is actually running
docker compose -f ops/auto-voice/docker-compose.yml exec bot \
  grep -n 'SETUP_STATUS = ' bot/dist/gateway/client.js
#    expect exactly one line, and NO `auto-voice.io`

# 3. the bot came up anyway
docker compose -f ops/auto-voice/docker-compose.yml ps
#    expect bot = healthy, and `bot ready` in the log
```

Then **look at the bot in Discord** — the member list is the only place that
proves what Discord actually rendered. A custom status shows with no "Playing"
prefix. Steps 1–2 can pass while Discord still shows a cached presence for a
minute or two after a restart.

If step 1 prints nothing, the container is running an image whose entrypoint was
not overridden — check that Coolify redeployed from the branch that has this
compose file, not a cached one.

**If the container crash-loops at start with one of:**

```
/bin/sh: can't open /opt/avc/status-patch.sh: Is a directory
/bin/sh: 0: Can't open /opt/avc/status-patch.sh
```

the bind mount resolved to the wrong host path. Compose resolves the host side of
a relative mount against the **project directory**, which defaults to the
directory holding the compose file; a runner that passes
`--project-directory <repo root>` instead makes `./status-patch.sh` mean
`<repo root>/status-patch.sh`, and Docker helpfully creates an empty directory
there. Fix: set `AVC_STATUS_PATCH_PATH=./ops/auto-voice/status-patch.sh` in
Coolify and redeploy. Confirm the mount before blaming anything else:

```bash
docker compose -f ops/auto-voice/docker-compose.yml exec bot \
  head -1 /opt/avc/status-patch.sh
#    expect: #!/bin/sh
```

This failure is loud by design. The alternative — a missing patch that lets the
bot start with the advert intact — is the outcome this card exists to prevent.

## 9. The seven-day gate

Phase 2 (**TOG-3062** — porting this into Owen and retiring the second bot) is
blocked until AVC has run clean in the live guild for seven consecutive days.
That condition has numbers in it, so it is a script rather than a habit:

```bash
node ops/auto-voice/observe-tick.ts            # observe the live guild
node ops/auto-voice/observe-tick.ts --selftest # drive the fixtures, no network
```

One tick per day. It needs a bot token that is already in the guild
(`AVC_OBSERVE_TOKEN`, falling back to `DISCORD_BOT_TOKEN`) and reads the channel
list and voice states out of a single `GUILD_CREATE`. It is **read-only** — no
REST writes, and it never joins a voice channel, so it cannot manufacture the
rooms it is counting.

Three conditions, and the exit code is the verdict:

| Check | Breached when |
|---|---|
| `generator_present` | the generator is gone, or left the 🔊 VOICE category |
| `lobby_untouched` | `Lobby` is missing, moved, **or renamed** — a renamed Lobby is the signature of AVC having adopted a channel it was never given |
| `no_ghost_rooms` | a generated room under the category has nobody in it |

```
exit 0  PASS          every condition held
exit 1  FAIL          a condition was breached
exit 2  INCONCLUSIVE  could not observe - no token, gateway refused, timed out
```

**Three codes, not two, on purpose.** A tick that could not reach the gateway
must not be readable as a clean day; that is how a seven-day streak gets made of
days nobody looked at.

Any voice channel under the category that is neither the generator nor `Lobby`
counts as a generated room. If a permanent one is added deliberately, put its id
in `AVC_OBSERVE_IGNORE_CHANNEL_IDS` — until then it is a finding, which is the
direction this check should fail in.

The fixtures in `observe-tick.ts` are the point of the file. A ghost room, an
adopted Lobby and a deleted generator are states the live guild will not hold
still for, so they are the only way to know a green tick means anything;
`test/unit.avcobserve.test.ts` runs them in CI.
