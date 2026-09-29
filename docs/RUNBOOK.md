# Runbook

Written for whoever is on the box, not necessarily an engineer.

> **Deploying to Coolify? Read docs/DEPLOY.md instead.** This runbook covers the
> systemd deployment on a plain host, which is still supported and is how the
> backup timer runs. The bot itself now ships to the owner's Coolify VPS as a
> container (TOG-13), where the token is an environment variable rather than a
> systemd credential and health is `GET /readyz` rather than `systemctl status`.
> Everything below about preflight, backfill, backups and restores applies to
> both.

## Before you deploy

Check the credential and the server permissions first. This takes seconds and
catches the failures that otherwise show up as a permanent hole in the numbers:

```bash
DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/preflight.ts
```

`Ready to deploy.` means the funnel will collect. Anything marked `FAIL` means
it will not, or will record every join as `unknown` — fix that in the Discord
developer portal before starting the service.

What a gap in coverage actually costs, precisely: **invite attribution and
first-message timing are lost for good**, because Discord keeps no per-member
record of either. **Join dates are not lost** — see the next section.

## Staging checks cadence: staging-doctor + preflight

Two scripts, two different questions. Run the right one:

| Script | Question it answers | Needs | Side effects |
|---|---|---|---|
| `node scripts/staging-doctor.ts` | "Can I run the integration suite yet?" | the staging trio below, plus the staging DB reachable | none — writes nothing, never contacts Discord, never prints a token |
| `node scripts/preflight.ts` | "Will the funnel actually collect data?" | live bot token + network to Discord | read-only against Discord; writes nothing to the DB |

The staging trio (see `docs/STAGING.md` for where each comes from):
`TWO_STAGING_DATABASE_URL`, `DISCORD_STAGING_GUILD_ID`,
`DISCORD_STAGING_BOT_TOKEN`. These names are deliberately different from the
live ones — a staging run must not be one forgotten variable away from writing
into the real funnel.

When to run each:

- **doctor, at the start of every staging session.** Then again after every
  `staging-reset.ts` and after every suite run — a suite that leaves state
  behind is the normal way fixtures drift, and the doctor is how you notice.
- **doctor, before opening a staging PR.** Green doctor output is the
  "reproduced on the known state" half of the evidence.
- **preflight, before every deploy.** `bootstrap-host.sh` already runs it and
  refuses to start the service on a FAIL — a bot that is `active (running)`
  while recording every join as `unknown` is worse than one that never started.
- **preflight, after any portal change** (intents, roles, channels) and any
  time joins start recording as `unknown`.

What green looks like (both verified 2026-09-27, TOG-7192):

```bash
node scripts/staging-doctor.ts
#   ok      staging bot token      Owen QA Test (1469137636663758888).
#   ok      staging Discord server guild 1545644954272137297.
#   ok      staging database       two_staging_test.
#   ok      schema                 NN migration(s) applied.  (the count grows
#                                  with migrations/ — green means zero pending)
#   ok      fixtures               the known state.
# Ready. `node scripts/staging-reset.ts` then run the suite.
# exit 0 — five oks, then reset and run your suite.
```

```bash
DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/preflight.ts
# Ready to deploy.  0 fail, 3 warn
# exit 0 — WARNs are fine (Administrator over-grant, unused Message Content
# Intent, alert-channel-via-Administrator). Only FAIL blocks a deploy.
```

What red looks like, and whose job it is:

- doctor exit `1` — a `FIX` line, yours. It carries the command, usually
  `node scripts/staging-reset.ts` (a previous suite left state behind) or the
  `TWO_DATABASE_URL="$TWO_STAGING_DATABASE_URL" node scripts/migrate.ts`
  mapping. Run it, re-run the doctor. Proven: deleting the 7
  `first_message` rows prints
  `FIX fixtures 1 funnel count(s) off: first_message 0/7`, and a reset
  recovers to green.
- doctor exit `3` — `WAITING`, someone else's. The line names the owner and
  the issue (e.g. founder, TWO-21). Raise it on TWO-25; do not work around it.
- preflight exit `2` — no token at all
  (`Missing bot token. Set DISCORD_TOKEN ...`). Nothing ran; supply it.
- preflight exit `1` — a `FAIL` line. The funnel is broken or silently lying
  (intents off, missing Manage Server, unreadable invite list). Fix it in the
  developer portal before starting the service.

Where to log it:

- Green: one line on the card you are working —
  `doctor exit 0 (5 ok) / preflight 0 fail 3 warn`. That is the whole record.
- Red that you fixed: the FIX line plus the command that cleared it, same card.
- Red that blocks: keep the card `blocked` against the real blocker, with the
  red output quoted. Neither script prints a token — keep it that way and
  never paste one alongside.

## Recover the history (one-off, no host needed)

```bash
DISCORD_TOKEN=... DISCORD_GUILD_ID=... TWO_DATABASE_URL=postgres://... node scripts/backfill.ts --dry-run
DISCORD_TOKEN=... DISCORD_GUILD_ID=... TWO_DATABASE_URL=postgres://... node scripts/backfill.ts
```

Runs once and exits — this does **not** need the service installed, but it does
need access to the intended Postgres database. It is read-only against Discord.
It recovers:

- every current member's real join date, from Discord's own `joined_at`;
- joins, leaves and voice sessions from the log channels TWO's older logging
  bots have been writing for years — including members who have since **left**,
  who are invisible in the member list and whose absence would otherwise
  flatter every retention number we print;
- the current invite use counts, stored as the attribution baseline so the
  *first* live join after deploy is attributable instead of `unknown`.

Always read the `--dry-run` output first. Re-running is safe: every write is
idempotent, so a second run reports `already on file` and changes nothing.

If it prints `INCOMPLETE: hit the N-page cap`, there is older history it did not
reach — re-run with a larger `--max-pages`. Do not quote numbers from a
truncated run as if they were the whole picture.

## Wave 0 pre-flight for the server redesign (one-off, read-only)

**Run this before Wave 1 of the TOG-34 redesign, and read the verdict before
touching the server.** Wave 6 deletes 159 roles. A recreated role gets a new id
and no members, so the two holder CSVs this writes are the *only* record that
will exist afterwards — there is no way to reconstruct them later.

Needs the `DISCORD_BOT_TOKEN` secret, which is bound to the Founding Engineer
and to nobody else. Two commands, in this order:

```bash
DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/preflight.ts   # 1. intents
DISCORD_TOKEN=... npm run wave0                                    # 2. the exports
```

Run `preflight.ts` **first and read it**. Wave 0 reads the full member list, and
`GET /guilds/{id}/members` returns 403 unless the **Server Members** privileged
intent is on in the developer portal. That toggle is the single most likely
reason a first attempt wastes a run.

Nothing here can change the server. The script reaches Discord only through
`DiscordRest.get`, which hardcodes GET and has no write sibling — the same
construction as `scripts/audit-collect.ts`.

### What the exit code means

`npm run wave0` exits non-zero in three quite different situations, and only one
of them is a failure to re-run:

| Exit | Meaning | What to do |
|---|---|---|
| `0` | No drift; all artefacts written. | Proceed to the Wick check below. |
| `1` | **Both holder CSVs and the report were written**, but drift was found. | Not a crash. Read the drift list and explain every line before Wave 1 — this is the §7 stop rule doing its job. |
| `2` | No token in the environment. | Nothing ran. Supply the credential. |
| `3` | The member list came back empty. | **Nothing was written, deliberately.** An empty read is not an empty server; zero-row CSVs here would destroy the data Wave 6 cannot recover. Fix the intent, re-run. |

Exit `1` is the one that gets misread. If you wrap this in `set -e` or a CI
step, a drift result will look like a failed job when in fact it produced
everything it was asked to and is telling you to go and think.

### Where the output lands

Four files in `data/wave0/`:

```
game-role-holders.csv     Shooter / Survival / Horror Games holders
bankick-holders.csv       Officer, Game Master, Staff, SySOp — with the Wave 6 action per role
voice-baseline.csv        unique members in voice per week, last 90 days
wave0-report.md           the full run, including the verdict
```

`voice-baseline.csv` is the one file that may legitimately be missing: it is not
written at all when `#voice-log` cannot be read, rather than being written empty.
The other three are always present on any exit except `2` and `3`.

**These name individual members, and they must never reach GitHub.** `data/*`
is gitignored precisely so they cannot be committed by accident — verified: all
four paths are ignored, while `data/server-audit-*.json` is explicitly
un-ignored because the drift check needs it as its base. Do not paste holder
rows into an issue, a PR or a chat channel either. `docs/PRIVACY.md` permits
storing member ids; it does not permit publishing them.

An unreadable `#voice-log` is reported as **UNKNOWN**, never as a zero baseline
— an empty channel and a channel we cannot read are different facts, and only
one of them is good news.

### The step no script can do

Section 1 of the report prints what the API knows about Wick and then states
that the whitelist itself is **UNVERIFIED**. That is not a bug to fix. Wick's
anti-nuke whitelist lives inside Wick, and Discord exposes no endpoint for
another application's private configuration.

Someone with dashboard access must open **Wick → anti-nuke → whitelist** and
confirm our bot is on it **before Wave 1**. If anti-nuke is armed and we are not
whitelisted, the likely outcome is Wick banning our own bot midway through Wave
5 or 6 while behaving exactly as configured. The script will never report this
as passing, no matter how green everything else is.

## Keep attribution alive before there is a host

```bash
DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... TWO_DATABASE_URL=postgres://... node scripts/capture.ts --dry-run
DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... TWO_DATABASE_URL=postgres://... node scripts/capture.ts
```

Runs once and exits, read-only against Discord. Run it **as often as you can**
until the service is deployed — every few hours is plenty at TWO's current
inflow.

The reason it exists: *who* joined and *when* is never lost (Discord stamps
`joined_at`, and `scripts/backfill.ts` can rebuild that at any point later).
*Which invite they came through* is lost forever unless somebody read the invite
counters on both sides of the join. That does not require an always-on bot — it
requires reading the counters more often than people join.

Each run reads the invite counters, compares them to the previous run's, finds
the members who joined in between, and records those joins with the code that
moved. One code moved → that is the code. Several moved → recorded as
`ambiguous:a+b`, never a guess. None moved → `vanity` or `unknown`.

Two things it cannot do, and no amount of running fixes either:

- somebody who joins **and leaves** inside one window is invisible to this and
  to the member list. Shorter windows shrink the hole; only a connected bot
  closes it;
- `first_voice_session` needs the gateway. Not attempted here, and not
  recoverable afterwards either - Discord will not serve voice history over
  REST. The message milestones are the one exception to "no amount of running
  fixes it": this script does not attempt them, but `npm run backfill:messages`
  reads them back out of the channels, which is what makes AM7's text half
  exact instead of an upper bound.

Once the service is live this stops being necessary — the bot does the same
diff per join, at full precision. Leaving it on a cron afterwards is harmless
(every write is idempotent) but redundant.

## Deploy

### Step 0: look at the box first

```bash
bash scripts/inventory-host.sh          # read-only; sudo for the full picture
```

Not optional, and not the same question as "is the box healthy". Everything in
this section was written assuming a fresh single-purpose VM. The bot is landing
on the founder's existing **OVH VPS-4**, shared with the website, Postgres and
staging. So the first question is not *how do I set this box up*, it is **what
is already here that I can break**.

The script writes nothing — no installs, no `systemctl`, no config. Every
command in it is a read. It reports the machine, what is already running, port
conflicts on 8099, 8787 and 5432, the state of SSH and the firewall, and
existing Postgres databases. It exits `0` if nothing is alarming and `1` with a
list if something is.

Of those three ports, **8787** is the one to actually stop on. It is the
internal actions endpoint the website calls, it only binds when
`TWO_INTERNAL_ACTIONS=1`, and it binds on loopback — so it reads as harmless.
It is not: `src/index.ts` awaits that bind during start-up, so if something on
the box already holds 8787 the bot does not lose an endpoint, it fails to boot
and crash-loops until systemd gives up. Set `TWO_INTERNAL_PORT` to something
free before deploying, not after.

It also refuses to say "clean" when it could not actually look — without root
or without systemd the verdict is `unknown`, not a pass.

The one thing to read closely is the **Node** section. Everything this deploy
installs is namespaced — its own user, `/opt/two-bot`, `/etc/two-bot`, units
prefixed `two-bot` — with a single exception: Node is installed system-wide. On
a box where something else already runs on Node, that is an in-place upgrade of
somebody else's runtime as a side effect of deploying a Discord bot.
`bootstrap-host.sh` now refuses to do it and exits `4`; if the other services
must stay put, install Node 24 alongside and point `ExecStart` in
`deploy/two-bot.service` at it.

### The short way

```bash
git clone <repo> two-bot && cd two-bot
sudo bash scripts/bootstrap-host.sh
```

Does everything in the long version below, in order. Idempotent — re-running it
is also how you ship an update.

It stops rather than guessing in five places: an existing system Node it would
have to replace (exit `4`), an app directory with files in it that this script
did not put there (exit `5`), empty secrets files (exit `3`), the bot token
found sitting in `two-bot.env` (exit `6`), and a failed preflight.

Exit `6` is the one that looks like bureaucracy and is not. The token is a
systemd credential now, and the credential wins over the environment — so a box
with the token in *both* places runs perfectly while a second live copy of it
sits in a file that gets read into a process environment. Nothing ever breaks,
so nobody ever notices. The same stop catches a rotation where the old line was
never deleted. Delete the `DISCORD_TOKEN` / `DISCORD_BOT_TOKEN` line from
`/etc/two-bot/two-bot.env`, leave every other key alone, re-run.

Exit `5` guards the one genuinely destructive line in the script. Deploying
runs `rsync -a --delete` into `TWO_APP_DIR`, which erases anything there that
is not in the repo. `TWO_APP_DIR` is an environment variable, so a typo or a
stale shell aims that at somebody else's directory. The script therefore only
`--delete`s into a directory carrying `.two-bot-deploy`, a marker it writes
itself after the first successful sync. If you hit exit `5`, look at the
directory before you adopt it — that is the entire point of the stop.

It stops and tells you what to do in two places: after creating the (empty)
secrets files, and if `scripts/preflight.ts` fails. It will not start the
service on a failed preflight, because a bot that is `active (running)` while
recording every join as `unknown` is worse than one that never started.

Read the long version anyway the first time. When something breaks at 11pm you
want to know what the script did, not just that it did it.

### The long way

```bash
sudo useradd -r -s /usr/sbin/nologin twobot
sudo mkdir -p /opt/two-bot /etc/two-bot /var/backups/two-bot
sudo rsync -a --exclude node_modules --exclude data ./ /opt/two-bot/
cd /opt/two-bot && sudo -u twobot npm ci --omit=dev
sudo chown -R twobot:twobot /opt/two-bot /var/backups/two-bot

# The Discord token is a systemd credential, not an environment variable. On a
# box we share with the website that is the difference between "the web user
# cannot read the token" being a fact and being a hope. See docs/SECRETS.md.
sudo install -d -m 0700 -o root -g root /etc/two-bot/credentials
sudo install -m 600 /dev/null /etc/two-bot/credentials/discord_token
sudo editor /etc/two-bot/credentials/discord_token   # the token, on one line, nothing else

# Non-secret configuration: guild ID, channel IDs, log level, flags.
# Root-owned, readable only by root (systemd reads it before dropping privileges).
# Do NOT put DISCORD_TOKEN in here any more.
sudo install -m 600 /dev/null /etc/two-bot/two-bot.env
sudo editor /etc/two-bot/two-bot.env     # see .env.example for the keys

# Backup credentials: separate file, so the backup timer does not need the Discord token.
# On the production Coolify host, use Coolify's scheduled database backups instead.
# This manual path is only for a plain systemd host.
sudo install -o twobot -g twobot -m 600 /dev/null /etc/two-bot/backup.env
sudo editor /etc/two-bot/backup.env      # TWO_DATABASE_URL, TWO_RESTORE_URL, TWO_BACKUP_UPLOAD_CMD,
                                         # and the TWO_BACKUP_S3_* destination — see "Off-box destination"
# The upload wrapper TWO_BACKUP_UPLOAD_CMD points at. Only needed on this manual
# path — scripts/bootstrap-host.sh installs it for you.
sudo install -m 755 deploy/two-backup-upload /usr/local/bin/two-backup-upload

sudo cp deploy/two-bot.service deploy/two-bot-backup.service deploy/two-bot-backup.timer \
        deploy/two-bot-restore-drill.service deploy/two-bot-restore-drill.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now two-bot two-bot-backup.timer two-bot-restore-drill.timer
```

## The database

The funnel log lives in Postgres. The bot and the website both write to it.

Connection details come from `TWO_DATABASE_URL` in `/etc/two-bot/two-bot.env`.
That URL contains a password: it is never logged, never printed by a script, and
must never be pasted into an issue or a Discord message.

**Schema changes** are numbered SQL files in `migrations/`. The bot applies any
pending ones automatically at boot, so a normal deploy needs nothing extra. To
apply them ahead of a deploy, or to check what is outstanding:

```bash
cd /opt/two-bot
sudo -u twobot --preserve-env=TWO_DATABASE_URL node scripts/migrate.ts --status
sudo -u twobot --preserve-env=TWO_DATABASE_URL node scripts/migrate.ts
```

Migrations take a lock, so it is safe to start the bot and the website at the
same time — one applies them, the other waits and then finds nothing to do.

**Pool size** is `TWO_DB_POOL_MAX` (default 5). Raise it only if you actually see
connection waits; every idle connection costs the server memory. To see who is
connected:

```sql
SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2;
```

`two-bot` is the bot. `two-bot-backup`, `two-bot-migrate`, `two-bot-restore` are
the scripts. Anything else is the website or a human.

## Is it alive?

```bash
systemctl status two-bot          # should say active (running)
journalctl -u two-bot -n 50       # recent logs, one JSON object per line
journalctl -u two-bot -f          # follow
```

A healthy start logs `{"msg":"ready","user":"...","guilds":1}` within a few
seconds. If you see `ready` you are connected to Discord.

The same checks run automated, against the mock-Discord harness rather than
the host (TOG-5689):

```bash
TWO_DATABASE_URL=postgres://... node scripts/health-check.ts
```

It boots the real bot, asserts the `ready` line shape, the health-before-ready
ordering and one-JSON-object-per-line logs, and reports pass/fail per check.
`systemctl status` and `journalctl` are listed as skipped with their mock-side
equivalents, because there is no systemd or journal under the mock.

## Stop the audit mirror right now (kill switch)

When the audit mirror is misbehaving — posting to the wrong place, spamming,
or mirroring something it should not — you do not have to redeploy or restart
anything. The switch is one durable row the bot re-reads before every single
Discord send and once per pending row, so it takes effect within one message:

```bash
docker exec two-bot npm run audit:halt     # stop all mirror sends + retries now
docker exec two-bot npm run audit:switch   # show state and what is being held
docker exec two-bot npm run audit:resume   # undo: held rows deliver on the next sweep (<= 30s)
```

What it does, precisely:

* **Stops sends, keeps evidence.** Durable audit rows are never touched. New
  events still land in `operational_audit_log`; they are held as `pending`
  with `delivery_last_error = 'audit_kill_switch_held'` and deliver after
  `audit:resume`. Nothing is dropped, skipped, or quarantined by the switch.
* **Survives a restart.** The switch is a database row, not memory — if the
  container restarts while engaged, it comes up still engaged.
* **Logs its own classification.** Engaging is visible as
  `operational_audit_kill_switch_engaged`, each held row as
  `operational_audit_delivery_held` (`classification:
  'audit_kill_switch_held'`) — greppable, and distinct from every delivery
  error.

The halt is a lever, not a diagnosis: after the bleeding stops, find the
actual defect before resuming. Both directions are idempotent, and
`npm run audit:halt -- --by <who>` records who pulled it (`audit:switch`
shows it).

## Rotate the bot token

**Due once at first deploy, then any time the token has been somewhere it should
not have been.** There is one outstanding rotation: `DISCORD_BOT_TOKEN` was
bound into the website agent's environment, which never needs it. That has been
unbound, but unbinding is not rotation — the value was still readable by
something that had no business holding it, so it gets reset. Background on
TWO-76 / TWO-77; the instruction to do it at deploy time is on TWO-11.

Rotation takes the bot offline from the moment of the reset until the new value
is in place, so it is a sequenced maintenance action, not an errand. Budget five
minutes and do it when nobody is mid-event.

1. Discord Developer Portal → application **`Owen`** (`1539711683898118154`) →
   **Bot** → **Reset Token**. The old token is dead the instant you click.
2. The founder stores the new value as the Paperclip secret and binds it to the
   **Founding Engineer** — and to nobody else.
3. Put it on the box, in the credential file, not the environment:

   ```bash
   sudo editor /etc/two-bot/credentials/discord_token   # new token, one line
   sudo ls -l /etc/two-bot/credentials/discord_token    # root:root, 0600, non-empty
   ```

4. **Delete any `DISCORD_TOKEN` / `DISCORD_BOT_TOKEN` line from
   `/etc/two-bot/two-bot.env` at the same moment.** The credential wins, so a
   stale copy there would never break anything and would never be noticed —
   which is the exposure this whole step exists to remove.
   `bootstrap-host.sh` refuses to deploy (exit `6`) if it finds one.
5. Restart and confirm it actually reconnected — `active (running)` alone only
   means the process has not exited yet:

   ```bash
   sudo systemctl restart two-bot
   journalctl -u two-bot --since '-2 min' | grep '"msg":"ready"'
   ```

   No `ready` line means it is up without a Discord session. The likely cause is
   a truncated paste into the credential file.

6. Anything else holding the old token now has a dead one: the agent runtime's
   `DISCORD_BOT_TOKEN`, and any shell you left `scripts/capture.ts` running in.
   Both pick the new value up on their next start; neither loses data, because
   `capture.ts` is idempotent and the bot re-reads the invite counters at boot.

### Rotating everything else (all manual)

The portal Reset above covers `discord_token` only. Every other credential is a
**manual** rotation — there is no portal button, so each step below is done by
hand on the box, and each ends with `sudo systemctl restart` of the unit that
reads it. Nothing here is automatic; the check
`scripts/ci/check-systemd-credentials.sh` only asserts these steps are written
down, not that they ran.

- `database_url` (`/etc/two-bot/credentials/database_url`, fallback
  `TWO_DATABASE_URL`): manual. Change the Postgres password / role, write the
  new URL into the credential file, restart `two-bot`. The backup and dashboard
  units read `TWO_DATABASE_URL` from `backup.env` / `two-bot.env` — update those
  copies in the same window or the nightly backup keeps the old password.
- `internal_keys` (`/etc/two-bot/credentials/internal_keys`, fallback
  `TWO_INTERNAL_KEYS`): manual. Mint the replacement key id, append it to the
  credential file alongside the old key, roll the website to the new id, then
  delete the old key and restart `two-bot`. Overlap-then-remove keeps
  in-flight signed actions verifying throughout.
- `discord_staging_token`
  (`/etc/two-bot/credentials/discord_staging_token`, fallback
  `DISCORD_STAGING_BOT_TOKEN`): manual. Reset in the **Owen QA Test**
  application (never the live `Owen` one), write the new value into the
  credential file, restart `two-bot-guild-config-backup`.
- `moderation_audit_secret` (env-only, `TWO_MODERATION_AUDIT_SECRET`, no
  credential file by design): manual. Set a fresh random value in
  `/etc/two-bot/two-bot.env`, restart `two-bot`. Old MAC markers stop verifying
  — that is expected; markers are convergence hints, not durable proof.
- `two_e2e_user_token` (env-only, `TWO_E2E_USER_TOKEN`, never under systemd):
  manual and human-only. Log in as the throwaway account, reset its token,
  re-provision the secret store; nothing in this repository can rotate a Discord
  user credential. See `docs/SECRETS.md` TOG-3978 section.
- `TWO_BACKUP_S3_*` (`TWO_BACKUP_S3_ENDPOINT`, `TWO_BACKUP_S3_BUCKET`,
  `TWO_BACKUP_S3_ACCESS_KEY_ID`, `TWO_BACKUP_S3_SECRET_ACCESS_KEY` in
  `/etc/two-bot/backup.env`): manual. Rotate in the R2 dashboard, update
  `backup.env`, run one `systemctl start two-bot-backup` and confirm the upload
  succeeded before the next nightly run.
- `TWO_RESTORE_URL` (in `/etc/two-bot/backup.env`, scratch database only):
  manual. Rotate the scratch role's password, update `backup.env`, run one
  `systemctl start two-bot-restore-drill` to prove the new value restores.

**If the reset would add risk to a first production bring-up, bring it up first
and rotate the same day.** A working deploy carrying a token that had a bad
neighbour for a week beats a broken deploy. What is not acceptable is the
rotation quietly never happening.

## What are the numbers?

```bash
cd /opt/two-bot
sudo -u twobot --preserve-env=TWO_DATABASE_URL node scripts/funnel.ts 7
```

## When should we run the community event?

Off the voice session log, not off a guess:

```bash
cd /opt/two-bot
# last 90 days, hours bucketed in UTC
sudo -u twobot --preserve-env=TWO_DATABASE_URL node scripts/voice-sessions.ts 90
# ...or in the timezone most members are actually in
sudo -u twobot --preserve-env=TWO_DATABASE_URL node scripts/voice-sessions.ts 90 --offset=-5
```

Two things to read before the recommendation:

* **The coverage block.** It prints the span the listener actually observed. If
  that span is under 28 days the report says so and the day-of-week result is
  not yet evidence - one unusual week would be the whole signal.
* **A zero.** `0 sessions` does **not** mean nobody uses voice. It much more
  likely means no bot with the gateway listener has been running. The report
  prints both causes and refuses to pick one, because it cannot tell. Check the
  service is up before drawing any conclusion from an empty report.

Voice history cannot be backfilled - Discord serves none over REST. Every hour
the listener is down is an hour of this data that does not exist later.

## It restarted on its own

Expected and fine - `Restart=always` handles crashes and reboots. Check how
often:

```bash
journalctl -u two-bot | grep -c 'Started'
```

If it is restarting in a tight loop, systemd gives up after 10 restarts in 5
minutes and leaves it stopped. That is deliberate: a crash-loop should page
someone rather than silently burn Discord's connection budget. Look at the last
error, fix it, then `sudo systemctl reset-failed two-bot && sudo systemctl start two-bot`.

## Backups

Nightly at 04:17 UTC to `/var/backups/two-bot`, 14 kept, then copied off-box.

```bash
systemctl list-timers two-bot-backup     # when it next runs
sudo systemctl start two-bot-backup      # run one now
journalctl -u two-bot-backup -n 30       # what it did
ls -lh /var/backups/two-bot
```

Each run prints a row count per table. A backup that reports zero events is a
failure, not an empty database — the script exits non-zero so systemd marks it
failed rather than letting it pass quietly for six months.

The dump runs in a single `REPEATABLE READ` transaction, so it is a snapshot of
one instant. You do **not** need to stop the bot to take one.

`TWO_BACKUP_KEEP` must be a positive whole number. Leave it unset for the
default of 14; set it to anything that is not a number and the run aborts
before it dumps, rather than pruning. This is deliberate and worth knowing why:
`Number('')` is `0`, `Number('fourteen')` is `NaN`, and `Array.slice()` treats
both as `0` — so a typo here used to mean *delete every backup on the box*,
including the one written seconds earlier. It is pinned by
`test/unit.backupretention.test.ts`.

### Is a backup file any good?

`--dry-run` reads a dump end to end and checks it against its own manifest —
format version, table names, the end marker that a full disk would have cut
off, and the row count. It writes nothing, runs no migrations and opens no
transaction, and `TWO_RESTORE_URL` is optional, so you can point it at an
off-box copy from wherever that copy landed:

```bash
node scripts/pg-restore.ts ./two-funnel-<stamp>.ndjson.gz --dry-run
```

`DRY RUN VERIFIED` and exit 0 means the file is internally consistent. It does
**not** mean the restore will succeed — only a real restore into the scratch
database proves that. Set `TWO_RESTORE_URL` as well to also see the row counts
the restore would be overwriting.

### Restore

```bash
# 1. Rehearse into the scratch database first. Never restore straight to prod.
cd /opt/two-bot
sudo -u twobot --preserve-env=TWO_RESTORE_URL \
  node scripts/pg-restore.ts /var/backups/two-bot/two-funnel-<stamp>.ndjson.gz --force

# 2. If that says RESTORE VERIFIED, do it for real.
sudo systemctl stop two-bot
sudo -u twobot TWO_RESTORE_URL="$TWO_DATABASE_URL" \
  node scripts/pg-restore.ts /var/backups/two-bot/two-funnel-<stamp>.ndjson.gz --force
sudo systemctl start two-bot

# 3. Confirm the numbers came back.
sudo -u twobot --preserve-env=TWO_DATABASE_URL node scripts/funnel.ts 7
```

The restore script takes `TWO_RESTORE_URL`, deliberately not `TWO_DATABASE_URL`.
Restoring wipes the target, and the one mistake you must not be able to make by
accident is aiming it at production because the variable happened to be in your
shell. You have to name it explicitly *and* pass `--force`.

`RESTORE VERIFIED` means every table's row count matched the backup's manifest.
Anything else means treat that backup as lost and try the previous one.

### Restore drill

`two-bot-restore-drill.timer` does the rehearsal automatically on the 1st of
each month into the scratch database. If it fails, the backups are not real:

```bash
systemctl status two-bot-restore-drill
journalctl -u two-bot-restore-drill -n 40
```

**Last drill: 2026-08-24 (TOG-37), against a synthetic database, not
production.** 4,009 events / 1,874 members / 5 invite snapshots were loaded
into SQLite through the bot's own write path, migrated with
`scripts/migrate-sqlite-to-postgres.ts`, dumped with `scripts/pg-backup.ts`,
copied off-box by `TWO_BACKUP_UPLOAD_CMD`, and restored from *that off-box
copy* into a scratch database. What was checked:

- row counts matched per table against the dump manifest — `RESTORE VERIFIED`
- the MD5 of every `events` row, all columns, was identical before and after;
  likewise `members`. Counts alone would not have caught one row dropped and
  one duplicated
- the set of `events.idempotency_key` hashed identically, so a re-delivered
  join is still recognised as a duplicate after a restore
- `scripts/funnel.ts` produced byte-identical output from the original SQLite
  file, the migrated Postgres database, and the restored copy
- the `events` id sequence resumed at 4010, so the first write after the
  restore did not collide

> **Not yet drilled against production data.** No box is running this build
> yet, so there is no production database to dump. The first real drill happens
> when the bot is live on Postgres in staging — tracked on TOG-45. Until then,
> the procedure is proven and the data it has been proven on is synthetic.

**Re-verified 2026-08-25 (TOG-37, after review TOG-342).** Not a new drill —
no off-box copy was involved — but the scripts changed, so the parts that could
be re-run were. Against an ephemeral PostgreSQL 18.4: the full suite (284 tests)
passed; `migrate-sqlite-to-postgres.ts` copied a 54-event / 40-member SQLite
database and reported `MIGRATION VERIFIED` with the id sequence at 55; the same
migration re-run over its own output with `--allow-nonempty` also verified,
which it could not do before; and with the id sequence deliberately detached it
reported `MIGRATION FAILED` and exited 1, where it previously reported `ok`.
`pg-restore.ts --dry-run` verified a good dump and rejected both a truncated one
and one naming a table the bot does not own.

**Drilled 2026-09-03 (TOG-69), through the real off-box upload path.** Against
an ephemeral PostgreSQL 18.4: 60 events / 40 members / 1 invite snapshot written
through `EventStore`, dumped by `scripts/pg-backup.ts` with
`TWO_BACKUP_UPLOAD_CMD` set to `deploy/two-backup-upload`, uploaded as a signed
S3 `PUT` to a bucket named `paperclip-backups`, and then — with **the local dump
deleted first**, so nothing but the uploaded object remained — restored into a
scratch database. Counts matched per table, 60/40/1. The receiving store
re-derived the SigV4 signature itself and refused to store anything it could not
verify, so the object arriving is evidence the signature was right rather than
evidence the receiver was lenient. As a control, flipping one byte of the
uploaded object made the same drill fail at the dry run and restore 0 rows.

This ran against a local S3-speaking store, not R2 itself: the credentials are
host-side by design and are not reachable from a build container. What it proves
is the path — dump, sign, upload, lose the local copy, restore from the remote
one. What it does not prove is that the R2 bucket accepts our key, which the
first real `systemctl start two-bot-backup` on the host will show.

An earlier revision of this file recorded a drill on 2026-08-19 with different
numbers (4,947 / 1,874 / 16). That drill was performed against a different
deployment of this codebase and the scripts it describes were never committed
to this repository, so the claim could not be reproduced here. It has been
replaced rather than kept, because a runbook entry that cannot be re-run is
worse than none.

**Drilled 2026-09-27 (TOG-5711), backup→restore→verify unattended on a local
database.** Against an ephemeral PostgreSQL 17.11 (user-space binaries, no
system install): 180 events / 120 members / 1 invite snapshot plus moderation
(5 warnings, 5 audit rows, 1 pending unban), 1 automation command and 1 ticket,
all written through `EventStore` and the bot's own tables — then
`scripts/pg-backup.ts` dumped `two-funnel-<stamp>.ndjson.gz`, `--dry-run`
verified it both file-only (no URL) and against the scratch target, and the
restore into an empty scratch database (migrations applied first, as the
dry-run's "no such table" probe predicted) ended `RESTORE VERIFIED`. Checked:

- all 22 tables row-count `ok` against the dump manifest
- order-independent MD5 of the full row sets identical for `events` and
  `members`; the `events.idempotency_key` set hashed identically
- the `events` id sequence resumed at 181, and a replayed join still recorded
  `inserted=false`
- `scripts/funnel.ts 30` byte-identical on source vs restored
- `test/e2e.backup.test.ts` 11/11 and `test/unit.dumpread.test.ts` 14/14 on the
  same ephemeral Postgres

No script fixes: the backup, restore and drill units needed no change, so none
was made. Full log attached as the work product on TOG-5711.

### Off-box destination

> **Production path:** the Coolify VPS runs scheduled database backups through
> the Coolify panel to Cloudflare R2 bucket `paperclip-backups`. The wrapper,
> timer and variables below remain the right answer for a plain systemd host,
> but they are **not** what the production container uses.

`scripts/pg-backup.ts` splits `TWO_BACKUP_UPLOAD_CMD` on whitespace and appends
the dump path as the **last** argument. Two consequences, and they bite:

1. **The dump ends up as the last positional.** That is what `cp -t DIR FILE`
   wants. It is the opposite of what `rclone copy SRC DST`, `aws s3 cp SRC DST`
   and `scp SRC DST` want — those would read the dump as the *destination*.
2. **No argument can contain a space**, because the split has no notion of
   quoting.

So use a wrapper. `deploy/two-backup-upload` is the one we ship, and it is
already pointed at the destination below. `scripts/bootstrap-host.sh` installs it
on every run, so on a bootstrapped host there is nothing to do here. Installing
it by hand is only for the manual path above:

```bash
sudo install -m 755 deploy/two-backup-upload /usr/local/bin/two-backup-upload
```

```
TWO_BACKUP_UPLOAD_CMD=/usr/local/bin/two-backup-upload
```

pg-backup.ts appends the dump path, the wrapper takes it as `"$1"` and puts it
where the real tool wants it. The env var stays a single bare word, so neither
problem above can come back when the destination changes.

The only form safe to inline is one where the file genuinely belongs last and
nothing needs quoting — which in practice means a same-box staging copy, and
that is not an off-box backup:

```
TWO_BACKUP_UPLOAD_CMD=/bin/cp -t /srv/backup-staging
```

If it is unset the backup still runs, and warns that it is sitting on the same
disk as the database — which protects against corruption and mistakes but not
against losing the machine.

#### Where it goes: Cloudflare R2, bucket `paperclip-backups`

Chosen and provisioned by the owner on 2026-09-02 (TOG-69, account and bucket
details on TOG-782). The wrapper `exec`s `scripts/backup-upload-s3.ts`, which
does one signed S3 `PUT` per dump in plain Node — `src/store/s3Sign.ts` is the
SigV4 signing, `node:crypto` is the only dependency.

**Why not `rclone` or the `aws` CLI.** Neither is installed and
`scripts/bootstrap-host.sh` does not install them — it installs `git`, `rsync`,
`curl` and `nodejs`. Either would fail at 04:17 with `ENOENT`, which is the same
objection this file already raises against `pg_dump` further down: a backup
procedure that only works on a machine we do not have is not a backup procedure.
The repo also carries no AWS SDK, and one signed PUT does not justify adding one.

Nothing about the destination is baked into the wrapper. It all comes from
`/etc/two-bot/backup.env` (root-owned, `0600`), so moving buckets is an env edit:

| variable | required | meaning |
| --- | --- | --- |
| `TWO_BACKUP_S3_ENDPOINT` | yes | R2 S3 endpoint, `https://<account>.r2.cloudflarestorage.com`. Must be `https` unless it is localhost. |
| `TWO_BACKUP_S3_BUCKET` | yes | `paperclip-backups` |
| `TWO_BACKUP_S3_ACCESS_KEY_ID` | yes | R2 access key id |
| `TWO_BACKUP_S3_SECRET_ACCESS_KEY` | yes | R2 secret access key |
| `TWO_BACKUP_S3_REGION` | no | defaults to `auto`, which is what R2 wants |
| `TWO_BACKUP_S3_PREFIX` | no | key prefix, e.g. `two-bot`. Unset means the dump sits at the bucket root. |

The four required ones are refused **by name** when missing or blank, before any
network call — a misconfigured destination fails the backup loudly rather than
writing the night's dump somewhere nobody looks.

Never put the two credential values anywhere but that file: not in a ticket, not
in a comment, not in a log line. The uploader prints the bucket, the key and the
byte count, and never the credential.

Check it landed:

```bash
sudo systemctl start two-bot-backup
journalctl -u two-bot-backup -n 20     # look for `backup-upload-s3: stored ...`
```

A failed upload exits non-zero, and `pg-backup.ts` treats that as a failed
backup, so systemd surfaces it rather than the night passing quietly.

### Why not `pg_dump`

`pg_dump` is the better tool and is what we should use the moment
`postgresql-client` is installed on the host:

```bash
pg_dump --format=custom --no-owner "$TWO_DATABASE_URL" > two-funnel-<stamp>.dump
pg_restore --clean --no-owner --dbname "$TWO_RESTORE_URL" two-funnel-<stamp>.dump
```

It is not installed today, and a backup procedure that only works on a machine
we do not have is not a backup procedure. `scripts/pg-backup.ts` does the same
job in plain Node with no system dependency, and has actually been restored.

## New-member roster, presence trend, levels, AutoMod export, community scorecard

These are the ops scripts added since the last runbook pass (TOG-7208). Each
entry: what it is for, the command, and what "green" looks like.

### The new-member roster

One line per member who joined recently: which invite brought them, and how
far into the community they actually got (first message, first voice, or left).
This is the question TWO-5 exists to answer, printed directly rather than
inferred from a funnel total.

```bash
cd /opt/two-bot
sudo -u twobot --preserve-env=TWO_DATABASE_URL node scripts/roster.ts 7    # last 7 days
sudo -u twobot --preserve-env=TWO_DATABASE_URL node scripts/roster.ts 30   # last 30 days
sudo -u twobot --preserve-env=TWO_DATABASE_URL node scripts/roster.ts 7 --names  # + display names
```

Green: a table prints and the exit code is `0`. Needs `TWO_DATABASE_URL` (and
`DISCORD_GUILD_ID` for guild scoping). `--names` additionally needs
`DISCORD_TOKEN`/`DISCORD_BOT_TOKEN`, fetches names from Discord at print time,
and never writes them to the database (see `docs/PRIVACY.md`). Without a token
it warns and prints ids instead of failing.

### Presence trend (TOG-469)

Reads the internal presence series and prints a verdict on the web-presence
question. This prints to a terminal and that is the ONLY way anyone sees these
numbers — no view, no endpoint, no page.

```bash
cd /opt/two-bot
sudo -u twobot --preserve-env=TWO_DATABASE_URL npm run presence:trend              # whole series + verdict
sudo -u twobot --preserve-env=TWO_DATABASE_URL npm run presence:trend -- --days 14 # last 14 days in the table
sudo -u twobot --preserve-env=TWO_DATABASE_URL npm run presence:trend -- --json    # same verdict, machine readable
```

Green: exit `0` means nothing to do (including "not enough data"). Exit `2`
means the trigger fired. Without `--web-live` the trigger reports `armed` at
most, never `fires` — a human asserts the live site with `--web-live` because a
number alone must not reopen the decision. Needs Postgres `TWO_DATABASE_URL`
plus `DISCORD_GUILD_ID`.

### Levels: MEE6 import, role rewards, probe, apply, acceptance

The leveling migration chain, in the order an operator runs it. Every step
refuses the live guild by default; `--allow-live-guild` exists only for an
owner-approved rollout.

```bash
# 1. What XP is in the MEE6 export? (dry run is the default; --apply is the only write)
node scripts/levels-import-mee6.ts import --guild <snowflake> --file <export.json>
node scripts/levels-import-mee6.ts import --guild <snowflake> --file <export.json> --apply
npm run levels:inventory -- --guild <snowflake>   # reconciliation manifest without importing

# 2. Which MEE6 level roles could Owen actually grant? (zero writes, always)
node scripts/levels-import-rewards-probe.ts --guild <snowflake> --file <export.json> \
  --roles <roles-snapshot.json> --bot-id <snowflake>
# ... --require-all-mapped exits 1 when any reward is unmapped (CI gate); --no-db needs no database

# 3. Current reward configuration (print; --set replaces the whole config)
npm run levels:roles -- --guild <snowflake>
npm run levels:roles -- --guild <snowflake> --set 5:<roleId>,10:<roleId>

# 4. Exercise one reward against one disposable STAGING member (staging only, no live override exists)
node scripts/levels-reward-role-apply.ts --report <probe-output.json> --member <user-id>   # plan only
node scripts/levels-reward-role-apply.ts --report <probe-output.json> --member <user-id> --apply

# 5. Full QA driver around step 4 (TOG-4874)
MEMBER=<staging-user-id> ROLE_ID=<disposable-role-id> OUT=/tmp/tog4874-out \
  bash scripts/levels-reward-role-acceptance.sh
bash scripts/levels-reward-role-acceptance.sh --selftest   # offline checks, no network
```

Green: import exits `0` (reconciled), `1` (export or write did not
reconcile), `2` (usage / refused guild). The probe balances and prints the
mapping report. The apply prints `Done. Positive readback: role ... present
after grant. Negative readback: role absent after revoke.` — grant, both
readbacks and revoke happen inside the one operation, and the grant is
recorded in the operational audit log after both readbacks. The acceptance
script writes an evidence bundle to `$OUT` and re-verifies absence through a
separate API read, so the grant path never self-attests the cleanup.

### Automations staging proof (TOG-1648)

Exercises custom commands, scheduled messages and sticky messages through the
real service + store against TWO Staging, in `#bot-log` — never
member-facing. Every artefact the run creates it also removes: proof
command/scheduled/sticky rows are deleted and any pre-proof definitions
restored row-for-row, proof messages posted to `#bot-log` deleted, and the
automation audit log is the only trace left — which is the point of the audit
log. A concurrent admin edit made mid-run is left untouched (a
`cleanup.*.concurrent` line) rather than overwritten.

The script takes exactly one flag:

```bash
node scripts/staging-automations-proof.ts --help   # usage, exit 0, needs no token or database
```

A full run needs the staging token and the staging database, and nothing else:

```bash
DISCORD_STAGING_BOT_TOKEN=... TWO_DATABASE_URL=<staging> \
  node scripts/staging-automations-proof.ts
```

Without both it refuses before touching anything (exit `2`, `need
DISCORD_STAGING_BOT_TOKEN and TWO_DATABASE_URL`). Point `TWO_DATABASE_URL` at
the staging database — the proof writes and deletes automation rows in
whatever database it is given. Guild and channel are pinned in the script
(`scripts/staging-automations-proof.ts:34-35`); there is no flag that
retargets them, so a full run cannot be aimed at the live guild by typo.

Green: `N/N pass, 0 fail`, exit `0`. Any `FAIL` line means not proven — do not
relabel an interrupted run as a pass.

`scripts/staging-automations-proof-state.ts` is the cleanup/restore library
the proof imports (`cleanupDecision`, `restoredStickyRow` — also covered by
`test/unit.automations.test.ts`). It is not run directly: invoked without
`--help` it exits `2`; with `--help` it prints usage and exits `0`, touching
nothing.

### Running the proof check offline (no token, no database, no Discord)

The reviewer path. Run `npm ci` first (the proof script imports `discord.js`,
so `--help` needs installed dependencies — but nothing else). Everything below
runs with no credentials set and makes no network calls:

```bash
npm ci                                             # once per checkout
npm run staging:automations-proof -- --help        # usage names the script, exit 0
npm run staging:automations-state -- --help        # usage names the script, exit 0
node --test test/unit.automationsproofhelp.test.ts # 4/4, exit 0
```

Green: each `--help` prints a `usage:` line naming its script file and exits
`0` even with every `DISCORD_*`/`TOKEN`/`DATABASE` variable unset; the test
passes `4/4` (both registry entries exist and target real files; both boot on
`--help` under a scrubbed environment). That proves both entries are wired
and boot — not that staging is green. The full proof above still needs the
staging token and staging database.

### AutoMod export (staging)

Exports the staging guild's AutoMod rules to a JSON file (default
`audit/staging-automod-rules.json`, mode `0600`).

```bash
DISCORD_STAGING_BOT_TOKEN=... npm run automod:export [output-path]
```

Green: `wrote N staging AutoMod rule(s) to <path>`. A payload with
unidentifiable rules is refused before anything is written (exit `1`,
"Refusing a partial AutoMod export - nothing was written") — a partial file
that looks complete is worse than no file. Needs the staging token, which must
pass the staging-token check (a live token is refused).

### Community scorecard

Scores the previous closed community week as JSON (coverage, classifier
version, recommendations unless `TWO_COMMUNITY_RECOMMENDATIONS=0`).

```bash
cd /opt/two-bot
sudo -u twobot --preserve-env=TWO_DATABASE_URL npm run community:scorecard
```

Green: JSON prints and the exit code is `0`. Exit `2` means
`coverageState: "incomplete"` — the numbers printed are not the whole picture.
Needs `TWO_DATABASE_URL` and `DISCORD_GUILD_ID`.

## Script index: every npm script

Acceptance for TOG-7208: each row names the purpose, the runnable command,
and the green signal. Entries already covered in full sections above point
back to them instead of repeating.

### Bot lifecycle and deploy checks

| script | purpose | green signal |
|---|---|---|
| `start` | Run the bot (`node src/index.ts`). | `{"msg":"ready",...}` in logs; see "Is it alive?" |
| `dev` | Run the bot with `.env` file. | Same as `start`, local only. |
| `preflight` | Pre-deploy credential/permission check; run before starting on a new box and whenever joins go `unknown`. | `Ready to deploy.`; any `FAIL` blocks deploy. See "Before you deploy". |
| `health:check` | Automated "Is it alive?" against the mock-Discord harness (TOG-5689). | Pass per check; `systemctl`/`journalctl` listed as skipped. |
| `verify:grant`, `verify:grant:selftest` | Prove the LIVE permission grant equals exactly the intended bit set (catches over-applied grants preflight cannot). Run after any human grant edit; `--selftest` offline. | Grant matches exactly, exit `0`. |
| `migrate` | Apply pending migrations (`--status` to preview). Bot also migrates at boot; this is belt-and-braces. | Nothing pending; see "The database". |
| `web:views` | Apply `sql/web_v1.sql` contract views (`--status` lists, changes nothing). | All views present, exit `0`. |
| `internal-actions:host`, `internal-actions:host-real` | Standalone internal-actions host for the TOG-463 acceptance harness: mock-Discord variant, and real staging-token variant. | Serves `/internal/actions`; harness passes against it. |
| `redirect` | go.two.gg redirect service (separate process, no credential, default `127.0.0.1:8088`). | Binds and answers one public GET. |
| `moderation:disable-preflight` | "Can I turn moderation off right now?" — same read the boot preflight performs, on demand (`--json` available). | Exit `0` (nothing blocking); `1` lists blockers; `2` usage. |

### Growth and funnel

| script | purpose | green signal |
|---|---|---|
| `funnel` | Crude-but-accurate funnel report (`30` for 30 days, `--json` for schema 1). | Numbers print, exit `0`. See "What are the numbers?" |
| `attribution` | Same funnel split by invite code: click → join → AM7 → AM30 (`-- 30`, `-- all`, `-- 90 --csv`). | Table/CSV prints, exit `0`. |
| `unknown-attribution` | Weekly unknown-attribution report: is the unknown share going down, and what still produces it. | One line per Monday, exit `0`. |
| `eval:funnel-attribution` | Offline golden eval for the ambiguous-vs-unknown split (no network/DB/token). | All golden cases pass, exit `0`. |
| `gate` | Rules-gate conversion report, read-only (`--months 6`). | Cohort table prints, exit `0`. |
| `gate:check` | Friday growth gate: six criteria, all required. Read-only, prints no identities. | All six green (five of six is red), exit `0`. |
| `gate:timeout` | Report members stuck behind the rules gate 14+ days. Report-only unless `--execute --expect N` (circuit breaker). | Report lists exact accounts; execute removes exactly N. |
| `review` | Friday growth review: rank portfolio, kill/scale rules, ledger entry (`--weeks 8`, `--json`, `--force` while gate red). Read-only. | Verdicts print, exit `0`. |
| `dashboard` | Build weekly growth dashboard HTML (`--json`, `--serve`, `--weeks 26`). Same DB the bot writes. | `data/dashboard.html` written, exit `0`. |
| `campaigns` | Manage tracked invite links: list, `--add <slot> <code> <label>`, `--retire <slot>`. No deploy needed. | List reflects the change, exit `0`. |
| `voice` | Voice-session timing report for scheduling the community event (`90 --offset=-5`). See "When should we run the community event?" | Coverage ≥ 28 days, exit `0`. |
| `roster` | New-member roster: source + first message/voice per recent joiner. | Table prints, exit `0`. See above. |
| `presence:trend` | Presence series + web-presence verdict. | Exit `0` (nothing to do) / `2` (fires). See above. |
| `community:scorecard` | Previous closed community week as JSON. | Exit `0`; `2` = incomplete coverage. See above. |
| `event:sunday-squad` | Create/repair the recurring Sunday Squad scheduled event (`--dry-run` needs no token). | Event exists with right schedule, exit `0`. |
| `reengage` | Weekly re-engagement list, Mondays (`--names`, `--csv` → `data/reengagement-<date>.csv`). List only — acting on it needs CEO sign-off. | List prints, exit `0`. |

### History recovery and capture

| script | purpose | green signal |
|---|---|---|
| `backfill` | One-shot history recovery: join dates, log-channel joins/leaves/voice, invite baseline (`--dry-run` first, `--max-pages` for depth). Idempotent. | `already on file` on re-run; no `INCOMPLETE` cap warning. See "Recover the history". |
| `backfill:messages` | Backfill message milestones from channel history (the expensive half; makes AM7 text half exact). | Milestones recorded, exit `0`. |
| `capture` | Host-less join capture between backfill and deploy; run every few hours (`--dry-run` first). Idempotent. | Counters diffed, joins recorded. See "Keep attribution alive". |
| `events:dedupe` | One-off repair: delete joins/leaves double-recorded by parallel logging bots (`--dry-run` counts first). | Dry run then real run agree; `0` remaining duplicates. |

### Levels (see detail above)

| script | purpose | green signal |
|---|---|---|
| `levels:import:mee6` | Import MEE6 XP (dry run default; `--apply` writes). | Exit `0` reconciled / `1` not reconciled / `2` usage. |
| `levels:inventory` | Reconciliation manifest without importing. | Manifest JSON prints, exit `0`. |
| `levels:roles` | Print (`--guild`) or replace (`--set`) reward config. | Config JSON prints, exit `0`. |
| `levels:roles:probe` | Zero-write reward mappability probe (`--require-all-mapped` CI gate, `--no-db` offline). | Report balances, exit `0`. |
| `levels:roles:apply` | Staging-only grant/readback/revoke/readback for one member. | Both readbacks verified, `Done.` line. |
| `levels:roles:acceptance`, `levels:roles:acceptance:selftest` | Full QA driver + evidence bundle (`MEMBER`/`ROLE_ID`/`OUT`); `--selftest` offline. | Evidence bundle in `$OUT`, exit `0`. |

### Roles, channels, members

| script | purpose | green signal |
|---|---|---|
| `roles:consolidation` | Build `audit/role-consolidation.csv` from the TWO-13 snapshot (no network; re-runnable rubric). | CSV written, exit `0`. |
| `channels:game-access` | Light up the three game categories (dry run prints diff; `--apply` / `--revert` only after CEO sign-off). | Diff empty after apply, exit `0`. |
| `self-role:panel` | Render/post one self-role panel (dry run default; `--apply` posts + prints config entry; staging only). | Panel renders; `--apply` prints exact config to persist. |
| `web:role` | Create the website's least-privilege DB role (`two_web_ro`). | Role exists with documented grants, exit `0`. |
| `verify:web-role` | Prove the website role reads contract views and nothing else. | All checks pass, exit `0`. |
| `verify:catalog` | Check the onboarding catalog against the live server, read-only. | Every catalog role resolves, exit `0`. |
| `raid:list` | Raid-account list, read-only (`--ids` for piping, `--verify` re-checks membership, `--scan`). | List prints with safety checks, exit `0`. |
| `raid:remove` | Remove raid accounts; dry run default, `--execute --expect N` from `--ids-from <file\|->`. | Exactly N removed, exit `0`. |

### Audit mirror (see "Stop the audit mirror right now" for the kill switch)

| script | purpose | green signal |
|---|---|---|
| `audit:collect` | Read-only inventory of the live server → `audit/raw/*.json` (GET-only by construction). | Raw files written, exit `0`. |
| `audit:report` | Raw dump → `audit/channels.csv`, `roles.csv`, `invites.csv`, `summary.json` + walkthrough (never calls Discord). | Tables written, exit `0`. |
| `audit:halt`, `audit:resume`, `audit:switch` | Kill switch: stop all mirror sends / resume / show state. DB row, survives restart, idempotent. | `audit:switch` shows expected state, held rows deliver after resume. |

Note: `scripts/audit-scrub.ts` (PII scrubber for the collector) has no npm
entry point; run it as `node scripts/audit-scrub.ts`. Green is a scrubbed dump
with ids preserved and usernames/avatars removed.

### Redesign waves and guild config

| script | purpose | green signal |
|---|---|---|
| `wave0` | Wave 0 pre-flight exports + drift check for the TOG-34 redesign (read-only). | Exits `0` (no drift) / `1` (drift found, artefacts still written). See "Wave 0 pre-flight". |
| `wave2` | Wave 2 additive-only wave (dry run default; `--apply` creates). | Plan empty after apply, exit `0`. |
| `wave6:hierarchy` | Wave 6 hierarchy pre-flight: can Owen's top role reach all 159 doomed roles? Read-only. | `159/159`, exit `0`; anything blocked lists the fix (ours to run). |
| `guild:clean-slate`, `guild:clean-slate-rollback` | Apply the owner-accepted clean-slate structure to the live guild (additive only, never removes); rollback deterministically undoes an applied manifest. | Structure matches manifest; rollback restores prior state. |
| `backup:guild-config` | Sealed snapshot of the staging guild config + drift report → `$TWO_GUILD_CONFIG_BACKUP_DIR`. | Snapshot + drift files written, exit `0`. |
| `restore:guild-config` | Plan (default) or `--confirm-staging-guild --apply` a snapshot restore; refuses tampered backups (exit `3`) and the live guild. | Post-restore plan shows `0` remaining operations. |

### Live cleanup

| script | purpose | green signal |
|---|---|---|
| `cleanup:live`, `cleanup:live-rollback` | Apply the live clean-slate plan (journaled, checkpointed) / undo it in reverse. | Journal shows applied; rollback restores. |
| `cleanup:drift-diff` | Would a drift gate accept snapshot B against A, and on which fields (`<a/pre.json> <b/pre.json>`). | Verdict prints, exit `0` = accepted. |
| `cleanup:derive-pins` | Re-derive the pinned expected-operations fixture after planner changes (never hand-edit). | Fixture regenerated; e2e pin test passes. |
| `cleanup:audit-visibility` | Independent post-plan visibility audit: only Owner, Owen and manifest Administrators still see legacy channels. | Clean run, exit `0`. |

### Backups (see "Backups" for the full procedure)

| script | purpose | green signal |
|---|---|---|
| `backup`, `backup:pg` | Nightly funnel-log dump (`two-funnel-<stamp>.ndjson.gz`, 14 kept, off-box upload). | Non-zero row counts, exit `0`. |
| `backup:upload-s3` | The uploader `TWO_BACKUP_UPLOAD_CMD` points at (one signed PUT per dump). | `stored ...` with byte count, exit `0`. |
| `restore:pg` | Restore into `TWO_RESTORE_URL` (`--force` required; `--dry-run` verifies only). | `RESTORE VERIFIED`, per-table counts match. |

### Staging and QA (all staging-only unless noted)

| script | purpose | green signal |
|---|---|---|
| `staging:doctor` | "Can I run the integration suite yet?" — env + staging DB read-only, no Discord, writes nothing. Run first, every time. | Exit `0` ready / `1` fixable (line says how) / `3` waiting on someone (line says who). |
| `staging:provision` | Build TWO Staging content (dry run default; `--apply`, `--invite`, `--grant-admin`). Never creates the server itself. | Plan empty after apply, exit `0`. |
| `staging:reset`, `staging:check` | Reset staging DB to fixtures / report-only check. Five guards pin it to staging (name contains staging/test, never the live DB). | Fixtures reseeded; `--check` clean. |
| `staging:verify` | Check staging server against `src/staging/spec.ts` (role positions first — a low bot role fails silently as wrong numbers). | All checks pass, exit `0`. |
| `staging:goodbye-live-verify` | Live-gateway proof `session_goodbye_posted` fires on staging (self-driven, re-runnable). | Exit `0` proved / `1` disproved / `2` precondition unmet (nothing touched). |
| `staging:anti-nuke` | Bounded staging gateway acceptance for TOG-3787 (read-only preflight default; `drive --apply` only command creating fixtures). | Preflight green; drive matches expected incident state. |
| `staging:clean-slate` | Rebuild TWO Staging to the clean-slate layout (read-only unless `--apply`; `--export`, `--invite`). | Layout matches spec, exit `0`. |
| `staging:discord-fetch` | Library: proof-only Discord 429 transport (`--help` only direct use; no token/network/side effects). | `--help` exits `0`. |
| `staging:session-demo` | TOG-1644 demo driver: posts the real welcome panel to #welcome, writes owner invite (`--verify` to check). | Panel renders on the real platform, exit `0`. |
| `staging:temp-voice-demo` | TOG-3052 evidence: `create` / `restart` / `cleanup` as separate processes, assertions re-read Discord over REST. | All three phases pass, exit `0`. |
| `staging:voice-occupant` | Hold a voice state open in staging `<channelId>` until killed (outlives the bot under test; no audio). | State visible in channel member list. |
| `staging:announcements-proof` | TOG-3845 proof run: real REST + isolated staging Postgres (`--output=<report.json>`). | Report written, exit `0`. |
| `staging:announcements-state` | Library: proof config/validators (`--help` only direct use). | `--help` exits `0`. |
| `staging:announcements-verify` | Read-only readback of a proof report (`--proof=<report.json>`; never migrates/posts/repairs). | Proof verifies, exit `0`. |
| `staging:automations-proof` | TOG-1648 proof run: custom commands, scheduled + sticky messages against TWO Staging (`--help` needs no token/DB). | Usage prints, exit `0` on `--help`. |
| `staging:automations-state` | Library: proof cleanup/restore helpers (`--help` only direct use). | `--help` exits `0`. |
| `automod:export` | Staging AutoMod rules export. | `wrote N ... rule(s)`, exit `0`. See above. |
| `e2e:harness`, `e2e:selftest` | Drive end-to-end member flows against TWO Staging (`--dry-run` no credential; `--flow`, `--kill-switch`). | Flows pass; `--dry-run` exits `0` with no network. |
| `onboarding:web:acceptance` | Offline acceptance for the next two-web onboarding slice (`--two-web <path>`). | Slice checks pass, exit `0` (`2` = usage/incomplete checkout). |
| `mutate:tempvoice` | Mutation harness for the temp-voice delete path (`--staging`, needs `TWO_TEST_DATABASE_URL`). Rewrites a file per mutation and runs the unit suite. | Surviving mutants listed; exit `0` when all killed. |
| `bench:temp-voice` | Temp-voice index audit + EXPLAIN harness: seeds 100 guilds × 40 rows through the store in an isolated schema (dropped on exit), prints read timings + plan shapes. Needs `TWO_DATABASE_URL` at a scratch DB, never production. | `VERDICT: INDEXED`, exit `0`. |
| `test:report` | `node:test` reporter writing one JSON object per test point (`--test-reporter` + `--test-reporter-destination`). | Results ndjson written; skips explicit, never silent. |

### Tests, typecheck, repo checks

| script | purpose | green signal |
|---|---|---|
| `test` | Full suite (`node --test test/*.test.ts`). | All green, exit `0`. |
| `test:unit` | Unit tests only. | All green, exit `0`. |
| `test:e2e` | E2E tests only. | All green, exit `0`. |
| `test:postgres` | Postgres-backed suite gate: fails unless critical suites report expected floors with no skips (needs `TWO_TEST_DATABASE_URL`; `--results FILE` checks a run without re-running). | Floors met, no skips, exit `0`. |
| `test:restart-storage` | Owned-cluster restart-storage profile (`--provision`, `--results`). | Report passes, exit `0`. |
| `typecheck` | `tsc --noEmit`. | No output, exit `0`. |
| `check:script-targets` | Every `node scripts/<file>` target in package.json exists on disk (TOG-6810). | All targets resolve, exit `0`. |
| `check:snowflakes`, `check:snowflakes:selftest` | No hardcoded Discord snowflakes in `src/` (selftest proves the check). | No hits, exit `0`. |
| `check:credentials`, `check:credentials:selftest` | Systemd credential wiring documented (selftest proves the check). | Checks pass, exit `0`. |
| `hooks:install`, `prepare` | Install git hooks (prepare runs on `npm install`, failures swallowed). | Hooks present, exit `0`. |

## Common problems

**`Missing bot token`** — the credential is missing. Check
`sudo ls -l /etc/two-bot/credentials/discord_token`; it must exist, be
root-owned, and not be empty. If systemd refuses to start the unit at all with
`Failed to load credential`, the file named in a `LoadCredential=` line does not
exist — comment out the optional ones you have not provisioned yet.

**`invite_snapshot_failed` in the logs** — the bot lacks the *Manage Server*
permission, so it cannot list invites. Joins are still recorded, but every one
of them is attributed `unknown`. Fix the bot's role permissions in Discord.

**Logs say `ready` but joins are not recorded** — the *Server Members Intent*
is off. Turn it on in the Discord developer portal under Bot → Privileged
Gateway Intents, then restart.

**Disk full** — 14 gzipped backups are small (a couple of megabytes each at
current size), but check `du -sh /var/backups/two-bot`.

**`datastore_open` is not in the logs and the bot exits at start** — it could
not reach Postgres. The bot checks the connection at boot on purpose, so this
fails now rather than on the first member join tonight. Check the database is
up, then that `TWO_DATABASE_URL` in `/etc/two-bot/two-bot.env` is right. The
error message will not contain the URL, because the URL contains the password.

**`too many clients already`** — something is opening pools and not closing
them, or `TWO_DB_POOL_MAX` was raised too far. `SELECT application_name,
count(*) FROM pg_stat_activity GROUP BY 1;` will name the culprit.

**The bot exits before `datastore_open` with a missing or invalid database URL**
— set `TWO_DATABASE_URL` to a `postgres://` or `postgresql://` URL. There is no
local-file fallback.

## Things this bot deliberately does not do

- It never sends a DM or messages a member. The inactivity job writes an event
  and produces a list; acting on that list is a human decision that needs CEO
  sign-off first.
- It never reads message content. It records that a message happened, not what
  it said. The `MessageContent` intent is not requested.
