# Runbook

Written for whoever is on the box, not necessarily an engineer.

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
DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/backfill.ts --dry-run
DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/backfill.ts
```

Runs once and exits — this does **not** need the service installed, and it is
read-only against Discord. It recovers:

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

## Keep attribution alive before there is a host

```bash
DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/capture.ts --dry-run
DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/capture.ts
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
- `first_message` and `first_voice_session` need the gateway. Not attempted.

Once the service is live this stops being necessary — the bot does the same
diff per join, at full precision. Leaving it on a cron afterwards is harmless
(every write is idempotent) but redundant.

## One-off: moving an existing SQLite database to Postgres

Only needed on a box that ran the old SQLite build. Copies the history across
and refuses to report success unless the row counts match per table.

```bash
cd /opt/two-bot
sudo systemctl stop two-bot                      # so nothing writes mid-copy

# Look before you leap - prints the source counts and writes nothing.
sudo -u twobot TWO_SQLITE_PATH=/opt/two-bot/data/two.db \
  node scripts/migrate-sqlite-to-postgres.ts --dry-run

sudo -u twobot --preserve-env=TWO_DATABASE_URL TWO_SQLITE_PATH=/opt/two-bot/data/two.db \
  node scripts/migrate-sqlite-to-postgres.ts
```

`MIGRATION VERIFIED` means every table matched and every event idempotency key
made it across. Anything else: do not start the bot, and do not delete the
SQLite file. It refuses to run against a Postgres that already has rows unless
you pass `--allow-nonempty`.

Keep `data/two.db` until the numbers have looked right for a week.

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
sudo install -o twobot -g twobot -m 600 /dev/null /etc/two-bot/backup.env
sudo editor /etc/two-bot/backup.env      # TWO_DATABASE_URL, TWO_RESTORE_URL, TWO_BACKUP_UPLOAD_CMD

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

**Last drill performed by hand: 2026-08-19.** 4,947 events / 1,874 members /
16 invite snapshots dumped and restored into a scratch database; counts matched
per table, the restored copy produced a byte-identical funnel report, and the
`events` id sequence resumed correctly so new writes did not collide.

### Off-box destination

Set `TWO_BACKUP_UPLOAD_CMD` in `/etc/two-bot/backup.env` to a command that takes
the backup file path as its last argument, for example:

```
TWO_BACKUP_UPLOAD_CMD=/usr/bin/rclone copy --config /etc/two-bot/rclone.conf --to backup:two-funnel
```

If it is unset the backup still runs, and warns that it is sitting on the same
disk as the database — which protects against corruption and mistakes but not
against losing the machine.

> **Not yet configured.** Object storage costs money, so the destination and its
> credentials are a CEO decision. Tracked on TWO-47.

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

**The bot is on SQLite when it should be on Postgres** — `TWO_DATABASE_URL` is
unset or misspelled, so it fell back to `TWO_DB_PATH`. The startup log line
`datastore_open` says which driver it actually chose; trust that over what you
think the env file says.

## Things this bot deliberately does not do

- It never sends a DM or messages a member. The inactivity job writes an event
  and produces a list; acting on that list is a human decision that needs CEO
  sign-off first.
- It never reads message content. It records that a message happened, not what
  it said. The `MessageContent` intent is not requested.
