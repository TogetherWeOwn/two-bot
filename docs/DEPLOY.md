# Deploying the bot to Coolify

Written for whoever has the Coolify panel open. TOG-13.

The bot runs on the owner's existing VPS, which already runs Coolify. It is
**not** deployed from the Paperclip host, and it does not need a new machine or
any new subscription.

There are two supported ways to run this bot and they are both current:

| | Container (this document) | systemd (`deploy/`, docs/RUNBOOK.md) |
|---|---|---|
| Where | The owner's Coolify VPS | A plain host you have root on |
| Token arrives as | Environment variable | systemd credential (`LoadCredential`) |
| Health | `GET /readyz` | `systemctl status` |

Use this document. `deploy/*.service` stays in the repo because it is the right
answer on a plain host. In production, backups run through Coolify's scheduled
database backups to R2 (see §8), not through the host timer.

---

## 1. What the operator must have first

Two things, and neither is an agent's to obtain:

1. **The Coolify panel URL** and an account that can create a project.
2. **A Postgres database** the bot can reach, and its connection string.
   Coolify can create one ("New Resource → PostgreSQL"), or point at the
   existing instance on the box. It must **not** be declared in
   `docker-compose.yml` — see the comment in that file for why.

The Discord bot token is already provisioned. It is the `discord_bot_token`
secret in this company; do not mint a second one and do not reset the existing
one — the same application backs the website's OAuth client.

## 2. Create the application

> **Already deployed.** The live application is `two-bot-dk`
> (`cangagerae31txrk2vfvzzyq`) and it is running. This section is for rebuilding
> from nothing — to ship a change to the running bot, skip to §6.1.

**New Resource → Docker Compose**, pointed at the **mirror**, not GitHub.

| Field | Value |
|---|---|
| Repository | `git@135.148.42.223:/srv/git/two-bot.git` |
| Branch | `main` |
| Compose file | `docker-compose.yml` |
| Build context | `/` (repo root) |

**Do not point this at `github.com`.** Coolify on this box cannot clone from
GitHub: a deploy key is refused by the GitHub *enterprise* policy (TOG-1175), an
embedded `x-access-token` clone URL 500s, and `private_key_uuid` 422s. The box
keeps a mirror of the GitHub repo at the path above and re-mirrors every 2
minutes; Coolify clones from that over SSH.

The failure mode if you get this wrong is quiet: the deploy ends in a few
seconds with a **zero-byte build log**, which looks like a broken server rather
than a repository it cannot read.

There is **no build command and no build pack**. Node 24 runs the TypeScript
directly, so the image has no compile step — if Coolify offers to auto-detect a
Nixpacks build, decline it and keep the Dockerfile.

## 3. Environment variables

Set these in the application's **Environment Variables** tab. The three marked
**required** have no default: the container refuses to start without them,
deliberately, because every default that could be wrong here is one that
silently writes real data somewhere nobody looks.

| Variable | Required | Value | Notes |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | **yes** | the `discord_bot_token` secret | **Mark as secret** in Coolify so it is masked in build logs |
| `DISCORD_GUILD_ID` | **yes** | `326474832151838730` | TogetherWeOwn |
| `TWO_DATABASE_URL` | **yes** | `postgres://…` | **Not** `DATABASE_URL` — see below |
| `DISCORD_STAFF_ALERT_CHANNEL_ID` | recommended | `1138590808715571300` | Settled on TOG-412. Staff-only: the alert lists member ids |
| `DISCORD_LANDING_CHANNEL_IDS` | no | empty | Onboarding does not run while empty. Set it only when you want the picker posted |
| `TWO_ONBOARDING_MODE` | no | `legacy` | Set `session` for roleless routing; requires the next three settings, removes `role.assign` from internal actions, stops leveling reward roles, and refuses to boot with a non-empty `TWO_SELF_ROLE_PANELS` or an armed `TWO_ANTI_NUKE` (see [ANTI-NUKE.md](ANTI-NUKE.md)) |
| `DISCORD_GOODBYE_CHANNEL_IDS` | session only | empty | Comma-separated, guild-scoped goodbye targets |
| `DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID` | session only | empty | Per-guild destination for “Find people to play with” |
| `DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID` | session only | empty | Per-guild destination for “Join voice now” |
| `TWO_ONBOARDING_DRY_RUN` | no | `1` | Leave at `1` for the first deploy: onboarding records but grants no roles |
| `LOG_LEVEL` | no | `info` | |
| `TWO_RAID_JOIN_THRESHOLD` / `TWO_RAID_WINDOW_SECONDS` | no | `5` / `60` | Fires on all three raids in this server's history and on no other day in nine years |
| `TWO_INACTIVITY_DAYS` | no | `14` | |
| `TWO_DB_POOL_MAX` | no | `5` | |
| `TWO_HEALTH_PORT` | no | `8080` | Set by the image; only change it if 8080 collides |

**`TWO_DATABASE_URL`, not `DATABASE_URL`.** Coolify injects a `DATABASE_URL` of
its own when you attach a database resource. The bot deliberately ignores it —
silently writing the funnel log into somebody else's database is not a failure
mode worth having. Copy the value across by hand.

### Do not set these unless you mean it

`TWO_INTERNAL_ACTIONS=1` turns on the internal actions endpoint, which is a
remote control for the Discord server. Inside a container it binds loopback
*within that container*, so nothing else — including the website — can reach it
without a shared network. If the website needs it, that is a deliberate change,
not a variable flip. See docs/INTERNAL_ACTIONS.md §1.

## 4. Health checks — the part that decides whether a deploy passes

The bot exposes two endpoints on `TWO_HEALTH_PORT`, and they mean different
things on purpose:

| Endpoint | Meaning | Used by |
|---|---|---|
| `GET /healthz` | The process is up. Checks nothing else, ever. | Docker `HEALTHCHECK` → container restarts |
| `GET /readyz` | Gateway connected **and** database answering. | Coolify's deploy gate |

`/readyz` returns `503` with a one-word reason (`gateway_disconnected` or
`database_unreachable`) — never a `500`, because a platform treats "broken" and
"not yet" differently.

**Liveness is deliberately dumb.** A bot that is still connecting has a live
process and no gateway session. If the platform restarts it during that window
it never finishes connecting, and Discord's identify budget pays for the loop.
That is why the restart probe is `/healthz` and the deploy gate is `/readyz`.

Coolify health check settings, if you set them by hand rather than letting it
read the compose file:

```
Path:          /readyz
Port:          8080
Interval:      30s
Timeout:       5s
Start period:  60s      # a cold start connects to the gateway and migrates
Retries:       3
```

Do not shorten the start period. Migrations run at boot.

## 5. Before the first deploy

Run preflight against the live server. It is read-only and takes seconds, and it
catches the failures that otherwise appear as a permanent hole in the numbers:

```bash
DISCORD_TOKEN=... DISCORD_GUILD_ID=326474832151838730 node scripts/preflight.ts
```

`Ready to deploy.` means the funnel will collect. A `FAIL` on the **Server
Members** privileged intent means every join records as `unknown` — fix it in
the Discord developer portal first. Invite attribution and first-message timing
are lost for good for any gap in coverage; join dates are not (see
docs/RUNBOOK.md, "Recover the history").

Preflight also resolves whether the bot can actually post in
`DISCORD_STAFF_ALERT_CHANNEL_ID`, because a raid alert that cannot be delivered
is not an error — `makeRaidAnnouncer()` logs `raid_alert_undeliverable` and
carries on, so the first sign of trouble is a join burst nobody was told about.

**Known warning, live server, 2026-09-05.** `#🔧〢updates-and-changes` denies
`View Channel` to `@everyone` and allows it back to `Staff`. The bot's roles are
`Prospect` and `Owen`, neither of which is `Staff`, so the only reason alerts are
deliverable today is that `Owen` still carries **Administrator**. When TOG-64
trims that bit, `View` goes false while `Send` stays true — the channel keeps
looking healthy to anything that checks `Send` alone, and alerts silently stop.
Before the trim lands, add a channel overwrite allowing `View Channel` to the
`Owen` role (`1539718644953514087`). Preflight reports this as a `WARN`, not a
`FAIL`, because it is correct today; `src/discord/channelAccess.ts` does the
overwrite arithmetic and `test/unit.channelaccess.test.ts` pins the live shape.

## 6. Deploy, and what to check

Press **Deploy**. Then, in order:

1. **Logs show `health_listening`, then `ready`.** That ordering is correct —
   health comes up before the gateway login so the platform sees `503` rather
   than a refused connection while connecting.
2. **`ready` names the bot and a guild count of 1.**
3. The application goes green when `/readyz` returns 200.

If it never goes green, read the `/readyz` body in the logs:

| Reason | Cause |
|---|---|
| `gateway_disconnected` | Bad or revoked token, or Discord unreachable |
| `database_unreachable` | `TWO_DATABASE_URL` wrong, or the database is not up |

## 6.1 Shipping a change to the running bot

The application is already live. After your change merges to `main`:

1. **Wait for the mirror.** The box re-mirrors GitHub every 2 minutes. Deploying
   sooner just rebuilds the previous commit and looks like your change did
   nothing.
2. **Trigger the deploy:**

   ```sh
   curl -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
     "$COOLIFY_URL/api/v1/deploy?uuid=cangagerae31txrk2vfvzzyq&force=true"
   ```

3. **Confirm it took**, rather than trusting the call returning 200:

   ```sh
   curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" \
     "$COOLIFY_URL/api/v1/applications/cangagerae31txrk2vfvzzyq/logs?lines=20"
   ```

   You want a fresh `ready` line naming the bot, and log timestamps that are
   advancing. `status: running:healthy` alone is not proof — poll the logs twice
   a minute apart and check the newest timestamp actually moved.

There is **no public URL to curl.** `docker-compose.yml` deliberately publishes
no ports (the bot is outbound-only), so the app's sslip.io address returns a
proxy `404 page not found`. That 404 is correct and is not an outage. `/readyz`
is reached by the compose healthcheck *inside* the container, which is what
makes `running:healthy` meaningful: it means the gateway is connected and the
database answered.

## 7. Rollback

Coolify keeps previous deployments. **Deployments → the previous entry →
Redeploy** — that is the rollback, and it is one click.

> **Check this before you need it.** The application tracks branch `main` with
> `git_commit_sha: HEAD`, so a redeploy rebuilds whatever the mirror's `main`
> points at *now*. If the bad commit is still on `main`, redeploying the previous
> entry rebuilds the bad commit. The reliable rollback is therefore to
> **`git revert` on `main`**, wait for the mirror, then deploy as in §6.1.
> `Stop` is the immediate lever if the bot is actively doing harm.

Two things it does not undo, so check them before you assume you are back:

- **Migrations do not roll back.** Every migration in this repo is additive
  (`migrations/README.md`), so an older image runs against a newer schema
  without complaining. If you ever add a destructive one, that stops being true.
- **The `two-bot-data` volume survives.** It holds hand-run exports; the funnel
  log is in Postgres and is untouched by a redeploy.

To stop the bot without deleting anything, **Stop** the application. The bot
handles `SIGTERM`: it closes the gateway and the database rather than being
killed holding them.

## 8. Backups

Backups are **not** part of this container. The production database is backed up
by Coolify's scheduled backup service to Cloudflare R2 bucket `paperclip-backups`
(`r2-paperclip-backups` in the panel, `save_s3=true`, daily 03:00 UTC, 7 local /
30 S3 copies). The operator enabled this on 2026-09-06 (TOG-1189) and confirmed
objects are visible in the bucket.

The repo still ships `deploy/two-bot-backup.*` and `scripts/bootstrap-host.sh`
still installs the wrapper and timer, but that path is for a plain systemd host,
not the Coolify VPS. See docs/RUNBOOK.md, "Off-box destination", for the
host-timer variables if you ever need it.

A backup that lives on the same disk as the database does not survive losing the
machine. Verify the off-box destination in the Coolify panel.
