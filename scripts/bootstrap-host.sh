#!/usr/bin/env bash
# Take a Debian/Ubuntu box from nothing to a running two-bot under systemd.
#
#   bash scripts/inventory-host.sh          # FIRST. read-only. what is already here?
#   sudo apt-get install -y git rsync curl
#   git clone <repo> two-bot && cd two-bot
#   sudo bash scripts/bootstrap-host.sh
#
# Run the inventory first and mean it. This was written assuming a fresh
# single-purpose VM. The box the bot is actually landing on is the founder's
# existing OVH VPS-4, shared with the website, Postgres and staging (TWO-11,
# TWO-21). Everything below is namespaced - its own user, /opt/two-bot,
# /etc/two-bot, units prefixed two-bot - with exactly one exception, the Node
# install, which is system-wide and is guarded accordingly.
#
# This is the "Deploy" section of docs/RUNBOOK.md, as one idempotent command.
# The runbook stays the reference for what each step means and how to undo it;
# this script exists so the first deploy is not a person typing nine commands
# in order at the end of a long day.
#
# Safe to re-run: it is how you ship an update. Second and later runs sync the
# code, reinstall dependencies, and restart the service. It never overwrites an
# existing secrets file and never prints one.
#
# It deliberately refuses to start the service if scripts/preflight.ts fails.
# A bot that is "active (running)" while silently recording every join as
# `unknown` is worse than one that did not start, because nobody looks again.

set -euo pipefail

APP_USER="${TWO_APP_USER:-twobot}"
APP_DIR="${TWO_APP_DIR:-/opt/two-bot}"
ENV_DIR="${TWO_ENV_DIR:-/etc/two-bot}"
BACKUP_DIR="${TWO_BACKUP_DIR:-/var/backups/two-bot}"
# Where deploy/two-backup-upload lands. This is the value TWO_BACKUP_UPLOAD_CMD
# takes in backup.env; the two must agree, so both are named from here.
UPLOAD_CMD="${TWO_UPLOAD_CMD:-/usr/local/bin/two-backup-upload}"
NODE_MAJOR=24

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n== %s\n' "$*"; }
fail() { printf '\nbootstrap: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run me with sudo - I create a system user and write to $ENV_DIR"
command -v systemctl >/dev/null || fail "no systemd on this box; see docs/RUNBOOK.md for the manual path"

# --- Prerequisites ---------------------------------------------------------
# A stock cloud image has neither rsync nor curl. Install them rather than
# failing halfway through with a bare "command not found".
say "Prerequisites"
missing=()
for c in rsync curl ca-certificates; do
  case "$c" in
    ca-certificates) [ -e /etc/ssl/certs/ca-certificates.crt ] || missing+=("$c") ;;
    *) command -v "$c" >/dev/null || missing+=("$c") ;;
  esac
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "installing: ${missing[*]}"
  apt-get update -qq
  apt-get install -y "${missing[@]}"
else
  echo "rsync, curl, ca-certificates - ok"
fi

# --- Node ------------------------------------------------------------------
# The bot runs TypeScript directly on Node's built-in stripping, which needs 24+.
say "Node"
need_node=1
if command -v node >/dev/null; then
  have="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$have" -ge "$NODE_MAJOR" ]; then
    echo "node v$(node -p 'process.versions.node') - ok"
    need_node=0
  else
    echo "node v$(node -p 'process.versions.node') is too old (need >= $NODE_MAJOR)"
  fi
fi
if [ "$need_node" -eq 1 ]; then
  # Installing Node is the one thing here that reaches outside our own
  # directories. If a Node is already present, something else on the box may be
  # running on it, and `apt-get install nodejs` is an in-place major upgrade of
  # that runtime - performed silently, as a side effect of deploying a Discord
  # bot. On a shared host that is how you take the website down at 11pm.
  #
  # No Node at all: nothing to break, just install it.
  if command -v node >/dev/null && [ "${TWO_ALLOW_NODE_REPLACE:-0}" != "1" ]; then
    # `|| true`: every stage of this pipeline exits non-zero when it finds
    # nothing, and under `set -euo pipefail` that would abort the script here
    # with a bare exit 1 - swallowing the whole explanation below, which is the
    # only reason this branch exists.
    users="$(grep -sl 'node' /etc/systemd/system/*.service 2>/dev/null \
             | xargs -r -n1 basename | grep -v '^two-bot' | paste -sd' ' - || true)"
    cat >&2 <<EOF

  Refusing to replace the system Node.

  Found:    v$(node -p 'process.versions.node')  ($(command -v node))
  Need:     v$NODE_MAJOR or newer
  Also using node: ${users:-nothing else that I can see, but I can only see systemd units}

  Upgrading in place would change the runtime under anything in that list.
  Check it, then choose one:

    bash scripts/inventory-host.sh              # what else is on this box
    sudo TWO_ALLOW_NODE_REPLACE=1 bash scripts/bootstrap-host.sh

  If the other services must stay on their Node version, do not force this -
  install Node $NODE_MAJOR side-by-side (nvm/fnm under $APP_USER, or a distro
  package that coexists) and point ExecStart in deploy/two-bot.service at it.
  Nothing else in this script needs the system Node.

EOF
    exit 4
  fi
  echo "installing Node $NODE_MAJOR from nodesource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

# --- User and directories --------------------------------------------------
say "User and directories"
if id -u "$APP_USER" >/dev/null 2>&1; then
  echo "user $APP_USER exists"
else
  useradd -r -s /usr/sbin/nologin "$APP_USER"
  echo "created system user $APP_USER (no shell, no login)"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$BACKUP_DIR"
install -d -o root -g root -m 750 "$ENV_DIR"

# --- Code ------------------------------------------------------------------
# --delete keeps the deployed tree honest: a file removed from the repo goes
# away here too, so nobody debugs a script that no longer exists upstream.
#
# On the founder's shared box that same flag is the single most destructive
# command in this file. TWO_APP_DIR is an environment variable, so one typo or
# one stale shell and `rsync -a --delete` empties somebody else's directory
# instead. So: we only ever --delete into a directory we can prove we created.
# The marker is written after the first successful sync and excluded from the
# sync itself, so it survives every later run.
say "Code"
MARKER="$APP_DIR/.two-bot-deploy"
if [ ! -e "$MARKER" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
  cat >&2 <<EOF

  Refusing to sync into $APP_DIR.

  It already has files in it and no $MARKER, so this
  script did not put them there. The next command would be:

      rsync -a --delete "$SRC/" "$APP_DIR/"

  which deletes everything in that directory that is not in the repo. On a
  box shared with the website and Postgres that is not a recoverable typo.

  Look first:

      ls -la "$APP_DIR"
      bash scripts/inventory-host.sh

  Then choose one:

    * wrong directory  -> set TWO_APP_DIR to the right one and re-run
    * a previous deploy this script did not mark (installed by hand, or from
      before this guard existed) -> adopt it, having looked:
          sudo touch "$MARKER" && sudo bash scripts/bootstrap-host.sh

EOF
  exit 5
fi
rsync -a --delete \
  --exclude node_modules --exclude data --exclude .git --exclude .env \
  --exclude .two-bot-deploy \
  "$SRC/" "$APP_DIR/"
printf 'written by scripts/bootstrap-host.sh - this directory is managed by two-bot, rsync --delete runs here\n' > "$MARKER"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR/data"

say "Dependencies"
sudo -u "$APP_USER" sh -c "cd '$APP_DIR' && npm ci --omit=dev"

# --- Secrets ---------------------------------------------------------------
# Created empty and never touched again, and never printed.
#
# Two different kinds of file, deliberately not one:
#
#   credentials/discord_token   the bot token. A systemd credential, so it is
#                               a 0400 file readable by exactly one Unix user
#                               and it never enters any process environment.
#   two-bot.env                 non-secret configuration only - guild ID,
#                               channel IDs, log level, flags.
#
# On a box shared with the website that split is the whole point: an
# environment variable is visible in /proc/<pid>/environ and inherited by every
# child process. See deploy/two-bot.service and docs/SECRETS.md.
say "Secrets"
CRED_DIR="$ENV_DIR/credentials"
TOKEN_FILE="$CRED_DIR/discord_token"
DATABASE_URL_FILE="$CRED_DIR/database_url"
INTERNAL_KEYS_FILE="$CRED_DIR/internal_keys"
STAGING_TOKEN_FILE="$CRED_DIR/discord_staging_token"
install -d -o root -g root -m 700 "$CRED_DIR"
new_secrets=0
for cred_file in "$TOKEN_FILE" "$DATABASE_URL_FILE" "$INTERNAL_KEYS_FILE"; do
  if [ -e "$cred_file" ]; then
    echo "$cred_file present - left alone"
  else
    install -o root -g root -m 600 /dev/null "$cred_file"
    new_secrets=1
  fi
done
# Only the bot token must be nonempty on every run. Optional credentials are
# checked against the service's effective configuration below.
[ -s "$TOKEN_FILE" ] || new_secrets=1
if [ -s "$STAGING_TOKEN_FILE" ]; then
  echo "$STAGING_TOKEN_FILE present - left alone"
else
  install -o root -g root -m 600 /dev/null "$STAGING_TOKEN_FILE"
fi
if [ -e "$ENV_DIR/two-bot.env" ]; then
  echo "$ENV_DIR/two-bot.env present - left alone"
else
  install -o root -g root -m 600 /dev/null "$ENV_DIR/two-bot.env"
fi
if [ -s "$ENV_DIR/backup.env" ]; then
  echo "$ENV_DIR/backup.env present - left alone"
else
  install -o "$APP_USER" -g "$APP_USER" -m 600 /dev/null "$ENV_DIR/backup.env"
  new_secrets=1
fi

# A token in two-bot.env is the failure this whole split exists to prevent, and
# it is invisible once the bot is running: the credential wins, so the bot works
# perfectly while a second copy of the live token sits in a file that is read
# into an environment. Rotating and leaving the old line behind looks like it
# worked, too. So: stop, and say which of the two cases this is.
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(DISCORD_TOKEN|DISCORD_BOT_TOKEN)[[:space:]]*=[[:space:]]*[^[:space:]]' \
     "$ENV_DIR/two-bot.env" 2>/dev/null; then
  if [ -s "$TOKEN_FILE" ]; then
    cat >&2 <<EOF

  Refusing to deploy: the bot token is in two files.

  $TOKEN_FILE has a value, and
  $ENV_DIR/two-bot.env also sets DISCORD_TOKEN / DISCORD_BOT_TOKEN.

  The credential wins, so the bot would run fine and you would never notice -
  which is exactly why this stops. Delete the token line from

      sudo editor $ENV_DIR/two-bot.env

  leaving the non-secret keys, then re-run me. If the two values differ, the
  one in $TOKEN_FILE is the one in use.

EOF
  else
    cat >&2 <<EOF

  The bot token is in $ENV_DIR/two-bot.env.

  That is the old layout. It now goes in a systemd credential file instead:

      sudo editor $TOKEN_FILE          # the token, one line, no quotes
      sudo editor $ENV_DIR/two-bot.env # delete the DISCORD_TOKEN line

  Everything else in two-bot.env stays where it is. docs/SECRETS.md says why.

EOF
  fi
  exit 6
fi

# An empty DB credential requires the env fallback; empty signing keys are
# allowed only while actions are disabled or their fallback is set. Let systemd
# read EnvironmentFile (quoting, escapes and last assignment win), never source
# it as root or print its values. This transient check only reads configuration:
# no Discord preflight, database connection or bot service is started here.
if [ "$new_secrets" -eq 0 ]; then
  if ! systemd-run --quiet --pipe --wait --collect \
    --uid="$APP_USER" \
    --property=LoadCredential="${DATABASE_URL_FILE##*/}:$DATABASE_URL_FILE" \
    --property=LoadCredential="${INTERNAL_KEYS_FILE##*/}:$INTERNAL_KEYS_FILE" \
    --property=EnvironmentFile="$ENV_DIR/two-bot.env" \
    --working-directory="$APP_DIR" \
    /usr/bin/node --input-type=module -e '
      import { readSecret } from "./src/core/credentials.ts";
      if (!readSecret(process.argv[1], ["TWO_DATABASE_URL"])) process.exit(3);
      if (process.env.TWO_INTERNAL_ACTIONS === "1" &&
          !readSecret(process.argv[2], ["TWO_INTERNAL_KEYS"])?.trim()) process.exit(3);
    ' "${DATABASE_URL_FILE##*/}" "${INTERNAL_KEYS_FILE##*/}"; then
    new_secrets=1
  fi
fi

if [ "$new_secrets" -eq 1 ]; then
  cat <<EOF

  Secrets files are empty. Fill them in before this can start, then re-run me:

    sudo editor $TOKEN_FILE              # the live bot token, one line, nothing else
    sudo editor $DATABASE_URL_FILE       # Postgres URL (carries the DB password); empty falls back to TWO_DATABASE_URL
    sudo editor $INTERNAL_KEYS_FILE      # internal-actions signing keys; empty until TWO_INTERNAL_ACTIONS=1
    sudo editor $STAGING_TOKEN_FILE      # Owen QA Test token; required only for guild-config snapshots
    sudo editor $ENV_DIR/two-bot.env     # DISCORD_GUILD_ID, DISCORD_STAGING_GUILD_ID, TWO_DATABASE_URL - no token
    sudo editor $ENV_DIR/backup.env      # TWO_DATABASE_URL, TWO_RESTORE_URL, TWO_BACKUP_UPLOAD_CMD

  Keys and what each one does: .env.example and docs/SECRETS.md.
EOF
  exit 3
fi

# An off-box copy is the only part of this deploy whose absence is invisible.
# scripts/pg-backup.ts warns and exits 0 when TWO_BACKUP_UPLOAD_CMD is unset, so
# the timer goes green every night while every dump stays on the disk it is meant
# to survive. Say so here, once, while someone is watching - but do not refuse:
# a box with local-only backups is worse than one with off-box backups and better
# than one with none, and this script also has to bring up hosts before the
# destination exists.
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?TWO_BACKUP_UPLOAD_CMD[[:space:]]*=[[:space:]]*[^[:space:]]' \
     "$ENV_DIR/backup.env" 2>/dev/null; then
  echo "backup.env sets TWO_BACKUP_UPLOAD_CMD - nightly dumps go off-box"
else
  cat >&2 <<EOF

  WARNING: TWO_BACKUP_UPLOAD_CMD is not set in $ENV_DIR/backup.env.

  Nightly backups will be written to $BACKUP_DIR and go nowhere else. That
  survives corruption and mistakes, not the loss of this machine - and it fails
  silently, because the timer still succeeds. To send them off-box:

      sudo editor $ENV_DIR/backup.env
        TWO_BACKUP_UPLOAD_CMD=$UPLOAD_CMD
        TWO_BACKUP_S3_ENDPOINT, TWO_BACKUP_S3_BUCKET,
        TWO_BACKUP_S3_ACCESS_KEY_ID, TWO_BACKUP_S3_SECRET_ACCESS_KEY

  docs/RUNBOOK.md, "Off-box destination", has the full list.

EOF
fi

# --- Upload wrapper --------------------------------------------------------
# TWO_BACKUP_UPLOAD_CMD must be a single bare word (src/store/uploadCmd.ts splits
# on whitespace and appends the dump path last), so it points at this wrapper
# rather than at a command line. Installing it here is the point: it used to be a
# `sudo install` a person typed from the runbook, which meant a host could come up
# with the timer enabled, backup.env filled in, and no /usr/local/bin/two-backup-upload
# for it to run - a backup that fails on the first night nobody is watching.
say "upload wrapper"
# /usr/local/bin exists on a stock Debian/Ubuntu image, but TWO_UPLOAD_CMD can
# point anywhere, and under `set -e` a missing parent would abort the deploy here
# rather than say what was wrong.
install -d -o root -g root -m 755 "$(dirname "$UPLOAD_CMD")"
install -m 755 "$SRC/deploy/two-backup-upload" "$UPLOAD_CMD"
echo "$UPLOAD_CMD installed"

# --- Units -----------------------------------------------------------------
say "systemd units"
install -m 644 \
  "$SRC/deploy/two-bot.service" \
  "$SRC/deploy/two-bot-backup.service" \
  "$SRC/deploy/two-bot-backup.timer" \
  "$SRC/deploy/two-bot-guild-config-backup.service" \
  "$SRC/deploy/two-bot-guild-config-backup.timer" \
  "$SRC/deploy/two-bot-rules-gate-timeout.service" \
  "$SRC/deploy/two-bot-rules-gate-timeout.timer" \
  "$SRC/deploy/two-bot-restore-drill.service" \
  "$SRC/deploy/two-bot-restore-drill.timer" \
  /etc/systemd/system/
systemctl daemon-reload

# --- Preflight -------------------------------------------------------------
# Against the real token and the real config, as the real user, before anything
# starts. The token arrives the same way the service gets it - as a credential,
# not an environment variable - so this also proves the credential file itself
# is readable and non-empty before systemd tries to start the unit.
say "Preflight"
set +e
systemd-run --quiet --pipe --wait --collect \
  --uid="$APP_USER" \
  --property=LoadCredential="discord_token:$TOKEN_FILE" \
  --property=EnvironmentFile="$ENV_DIR/two-bot.env" \
  --working-directory="$APP_DIR" \
  /usr/bin/node "$APP_DIR/scripts/preflight.ts"
pf=$?
set -e
[ "$pf" -eq 0 ] || fail "preflight failed (exit $pf) - fix the Discord settings it named, then re-run me. Nothing was started."

# --- Start -----------------------------------------------------------------
say "Start"
systemctl enable --now two-bot two-bot-backup.timer two-bot-rules-gate-timeout.timer two-bot-restore-drill.timer
if [ -s "$STAGING_TOKEN_FILE" ] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?DISCORD_STAGING_GUILD_ID[[:space:]]*=[[:space:]]*1545644954272137297[[:space:]]*$' "$ENV_DIR/two-bot.env"; then
  systemctl enable --now two-bot-guild-config-backup.timer
  echo "two-bot-guild-config-backup.timer enabled for TWO Staging"
else
  systemctl disable --now two-bot-guild-config-backup.timer >/dev/null 2>&1 || true
  cat >&2 <<EOF

  WARNING: TWO Staging guild-configuration snapshots are disabled.

  The unit is installed, but it will not run until both are true:

    $STAGING_TOKEN_FILE contains the Owen QA Test token
    $ENV_DIR/two-bot.env sets DISCORD_STAGING_GUILD_ID=1545644954272137297

  Fill those exact staging-only values and re-run this bootstrap. The live bot
  token and live guild id are deliberately not accepted for this timer.

EOF
fi
systemctl restart two-bot          # re-runs land the new code
sleep 5

systemctl is-active --quiet two-bot || {
  journalctl -u two-bot -n 30 --no-pager >&2
  fail "two-bot is not active - logs above"
}

# `ready` is the bot's own word for "connected to Discord". systemd calling the
# process active only means it has not exited yet.
if journalctl -u two-bot --since '-2 min' --no-pager | grep -q '"msg":"ready"'; then
  echo "two-bot is active and connected to Discord."
else
  journalctl -u two-bot -n 30 --no-pager >&2
  fail "started, but no 'ready' in the log - it is up without a Discord session. Logs above."
fi

cat <<EOF

Done. What to look at next:

  systemctl status two-bot
  journalctl -u two-bot -f
  sudo -u $APP_USER --preserve-env=TWO_DATABASE_URL node $APP_DIR/scripts/funnel.ts 7

The funnel will read zero new joins until somebody actually joins. That is
expected - Discord does not replay past joins to a bot. History already in the
database came from scripts/backfill.ts.
EOF
