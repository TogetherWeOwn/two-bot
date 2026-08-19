#!/usr/bin/env bash
# Take a fresh Debian/Ubuntu VM from nothing to a running two-bot under systemd.
#
#   sudo apt-get install -y git rsync curl
#   git clone <repo> two-bot && cd two-bot
#   sudo bash scripts/bootstrap-host.sh
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
say "Code"
rsync -a --delete \
  --exclude node_modules --exclude data --exclude .git --exclude .env \
  "$SRC/" "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR/data"

say "Dependencies"
sudo -u "$APP_USER" sh -c "cd '$APP_DIR' && npm ci --omit=dev"

# --- Secrets ---------------------------------------------------------------
# Created empty and never touched again. systemd reads two-bot.env as root
# before dropping privileges, so the bot's own user cannot read the token.
say "Secrets"
new_secrets=0
if [ -s "$ENV_DIR/two-bot.env" ]; then
  echo "$ENV_DIR/two-bot.env present - left alone"
else
  install -o root -g root -m 600 /dev/null "$ENV_DIR/two-bot.env"
  new_secrets=1
fi
if [ -s "$ENV_DIR/backup.env" ]; then
  echo "$ENV_DIR/backup.env present - left alone"
else
  install -o "$APP_USER" -g "$APP_USER" -m 600 /dev/null "$ENV_DIR/backup.env"
  new_secrets=1
fi
if [ "$new_secrets" -eq 1 ]; then
  cat <<EOF

  Secrets files are empty. Fill them in before this can start, then re-run me:

    sudo editor $ENV_DIR/two-bot.env     # DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, TWO_DATABASE_URL
    sudo editor $ENV_DIR/backup.env      # TWO_DATABASE_URL, TWO_RESTORE_URL, TWO_BACKUP_UPLOAD_CMD

  Keys and what each one does: .env.example and docs/SECRETS.md.
EOF
  exit 3
fi

# --- Units -----------------------------------------------------------------
say "systemd units"
install -m 644 \
  "$SRC/deploy/two-bot.service" \
  "$SRC/deploy/two-bot-backup.service" \
  "$SRC/deploy/two-bot-backup.timer" \
  "$SRC/deploy/two-bot-restore-drill.service" \
  "$SRC/deploy/two-bot-restore-drill.timer" \
  /etc/systemd/system/
systemctl daemon-reload

# --- Preflight -------------------------------------------------------------
# Against the real credential in the real env file, before anything starts.
say "Preflight"
set +e
systemd-run --quiet --pipe --wait --collect \
  --uid="$APP_USER" \
  --property=EnvironmentFile="$ENV_DIR/two-bot.env" \
  --working-directory="$APP_DIR" \
  /usr/bin/node "$APP_DIR/scripts/preflight.ts"
pf=$?
set -e
[ "$pf" -eq 0 ] || fail "preflight failed (exit $pf) - fix the Discord settings it named, then re-run me. Nothing was started."

# --- Start -----------------------------------------------------------------
say "Start"
systemctl enable --now two-bot two-bot-backup.timer two-bot-restore-drill.timer
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
