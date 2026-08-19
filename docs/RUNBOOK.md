# Runbook

Written for whoever is on the box, not necessarily an engineer.

## Deploy

```bash
sudo useradd -r -s /usr/sbin/nologin twobot
sudo mkdir -p /opt/two-bot /etc/two-bot /var/backups/two-bot
sudo rsync -a --exclude node_modules --exclude data ./ /opt/two-bot/
cd /opt/two-bot && sudo -u twobot npm ci --omit=dev
sudo chown -R twobot:twobot /opt/two-bot /var/backups/two-bot

# Secrets: root-owned, readable only by root (systemd reads it before dropping privileges).
sudo install -m 600 /dev/null /etc/two-bot/two-bot.env
sudo editor /etc/two-bot/two-bot.env     # see .env.example for the keys

sudo cp deploy/two-bot.service deploy/two-bot-backup.service deploy/two-bot-backup.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now two-bot two-bot-backup.timer
```

## Is it alive?

```bash
systemctl status two-bot          # should say active (running)
journalctl -u two-bot -n 50       # recent logs, one JSON object per line
journalctl -u two-bot -f          # follow
```

A healthy start logs `{"msg":"ready","user":"...","guilds":1}` within a few
seconds. If you see `ready` you are connected to Discord.

## What are the numbers?

```bash
cd /opt/two-bot
sudo -u twobot TWO_DB_PATH=/opt/two-bot/data/two.db node scripts/funnel.ts 7
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

Nightly at 04:17 UTC, to `/var/backups/two-bot`, 14 kept, each verified after
writing (it is opened, integrity-checked and row-counted - a backup nobody has
opened is a guess).

```bash
systemctl list-timers two-bot-backup     # when it next runs
sudo systemctl start two-bot-backup      # run one now
ls -lh /var/backups/two-bot
```

**Restore:**

```bash
sudo systemctl stop two-bot
sudo -u twobot gunzip -c /var/backups/two-bot/two-<stamp>.db.gz > /opt/two-bot/data/two.db
sudo rm -f /opt/two-bot/data/two.db-wal /opt/two-bot/data/two.db-shm
sudo systemctl start two-bot
```

> These snapshots live on the same box as the database. That protects against
> corruption and mistakes, **not** against losing the machine. Getting them off
> the box needs somewhere to put them, which needs a spend decision — see
> "Open items" in the README.

## Common problems

**`Missing required env var DISCORD_TOKEN`** — `/etc/two-bot/two-bot.env` is
missing, empty, or unreadable. Check `sudo ls -l /etc/two-bot/two-bot.env`.

**`invite_snapshot_failed` in the logs** — the bot lacks the *Manage Server*
permission, so it cannot list invites. Joins are still recorded, but every one
of them is attributed `unknown`. Fix the bot's role permissions in Discord.

**Logs say `ready` but joins are not recorded** — the *Server Members Intent*
is off. Turn it on in the Discord developer portal under Bot → Privileged
Gateway Intents, then restart.

**Disk full** — the database and 14 gzipped snapshots are small (megabytes),
but check `du -sh /var/backups/two-bot /opt/two-bot/data`.

## Things this bot deliberately does not do

- It never sends a DM or messages a member. The inactivity job writes an event
  and produces a list; acting on that list is a human decision that needs CEO
  sign-off first.
- It never reads message content. It records that a message happened, not what
  it said. The `MessageContent` intent is not requested.
