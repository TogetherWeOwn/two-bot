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
