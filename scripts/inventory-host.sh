#!/usr/bin/env bash
# Read-only report on a candidate host, before anybody deploys anything to it.
#
#   bash scripts/inventory-host.sh              # works without root, sees less
#   sudo bash scripts/inventory-host.sh         # sees ports, units and Postgres
#
# Why this exists
# ---------------
# The bot was always going to land on a fresh single-purpose VM that nobody
# else was using. It is not. It is landing on the founder's existing OVH VPS-4,
# which already has things running on it, alongside the website, Postgres and
# staging (TWO-11, TWO-21, TWO-37).
#
# That changes the first question from "how do I set this box up" to "what is
# already here that I can break". scripts/bootstrap-host.sh answers the first.
# This answers the second, and it answers it without touching anything.
#
# Nothing here writes, installs, enables, starts, stops or configures. Every
# command is a read. It is safe to hand to the person who owns the box and ask
# them to paste the output back, which is the point: the deploy is blocked on
# an Infrastructure Engineer who does not have the box yet, and this is the one
# step that can happen before they do.
#
# Exit codes:  0 nothing alarming   1 conflicts found   2 could not inspect

set -uo pipefail

APP_USER="${TWO_APP_USER:-twobot}"
APP_DIR="${TWO_APP_DIR:-/opt/two-bot}"
ENV_DIR="${TWO_ENV_DIR:-/etc/two-bot}"
NODE_MAJOR=24

# Ports the TWO stack wants. A conflict here is not fatal - it just has to be
# known before two services fight over the same socket at deploy time.
#
# 8787 was missing from this list until now, and it is the expensive one. The
# internal actions endpoint is optional (TWO_INTERNAL_ACTIONS=1) and binds
# 127.0.0.1, so it looks harmless - but src/index.ts awaits that bind during
# start-up, so EADDRINUSE is not a degraded endpoint, it is the whole bot
# failing to boot and crash-looping until systemd gives up. It is also the port
# the website reaches the bot on, so it is exactly the one a shared box is
# likely to have already taken.
declare -a WANT_PORTS=(8099 8787 5432)
declare -A PORT_OWNER=(
  [8099]="two-dashboard"
  [8787]="two-bot internal actions endpoint (TWO_INTERNAL_PORT, website -> bot)"
  [5432]="Postgres (bot + website)"
)

is_root=0
[ "$(id -u)" -eq 0 ] && is_root=1

conflicts=()
notes=()

hdr()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
row()  { printf '  %-22s %s\n' "$1" "$2"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; conflicts+=("$*"); }
note() { printf '  - %s\n' "$*"; notes+=("$*"); }

printf '\033[1mTWO host inventory\033[0m   %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if [ "$is_root" -eq 0 ]; then
  printf '  running unprivileged - listening ports and some unit detail will be incomplete.\n'
  printf '  re-run with sudo for the full picture.\n'
fi

# --- Machine ---------------------------------------------------------------
hdr "Machine"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  row "os" "${PRETTY_NAME:-unknown}"
else
  row "os" "unknown (no /etc/os-release)"
fi
row "kernel" "$(uname -sr)"
row "arch" "$(uname -m)"
row "hostname" "$(hostname -f 2>/dev/null || hostname)"
row "uptime" "$(uptime -p 2>/dev/null || echo unknown)"
row "timezone" "$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"

cpus="$(nproc 2>/dev/null || echo '?')"
memkb="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
memgb="$(awk -v k="$memkb" 'BEGIN{printf "%.1f", k/1048576}')"
row "cpu" "$cpus vCPU"
row "memory" "${memgb} GB total"

# The VPS-4 is quoted at 8 vCore / 24 GB / 200 GB. Say so if the box disagrees,
# because "the founder's VPS-4" may not be the box somebody actually hands over.
if [ "$cpus" != "?" ] && [ "$cpus" -lt 4 ]; then
  warn "only $cpus vCPU - smaller than the VPS-4 this was planned against; confirm this is the right box"
fi
if [ "${memkb:-0}" -gt 0 ] && [ "$memkb" -lt 3500000 ]; then
  warn "only ${memgb} GB RAM - the bot fits, but Postgres + website + staging on one box will not"
fi

hdr "Disk"
df -h -x tmpfs -x devtmpfs -x overlay 2>/dev/null | sed 's/^/  /'
for p in /opt /var; do
  avail_kb="$(df -Pk "$p" 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "${avail_kb:-}" ] && [ "$avail_kb" -lt 2097152 ]; then
    warn "$p has under 2 GB free - backups and npm installs will fail here"
  fi
done

# --- Is this box already in use? ------------------------------------------
# The single most important question on this page. A dedicated VM and a box the
# founder already runs things on need different deploys, and bootstrap-host.sh
# assumes the first.
hdr "Already in use?"
occupied=0
inspectable=1   # cleared if we could not actually look, so we never claim "clean" blind

# Enabled units that are not part of a stock cloud image. Crude on purpose:
# a false positive costs a glance, a false negative costs an outage.
if command -v systemctl >/dev/null 2>&1; then
  mapfile -t other < <(systemctl list-unit-files --type=service --state=enabled --no-legend --no-pager 2>/dev/null \
    | awk '{print $1}' \
    | grep -vE '^(systemd-|dbus|getty|serial-getty|cron|rsyslog|ssh|sshd|networking|systemd|apparmor|unattended-upgrades|e2scrub|multipathd|open-iscsi|qemu-guest-agent|cloud-|snapd|man-db|ua-|ubuntu-|packagekit|polkit|irqbalance|chrony|ntp|acpid|atd|lvm2|blk-availability|console-setup|keyboard-setup|plymouth|rescue|emergency|two-bot|two-dashboard)' \
    | sort)
  if [ "${#other[@]}" -gt 0 ]; then
    occupied=1
    printf '  non-stock services already enabled:\n'
    printf '    %s\n' "${other[@]}"
  else
    row "other services" "none found - looks like a clean box"
  fi
else
  inspectable=0
  warn "no systemctl - the deploy path in docs/RUNBOOK.md assumes systemd"
fi
[ "$is_root" -eq 0 ] && inspectable=0

# Web servers and databases are the ones that actually collide with us.
for svc in nginx apache2 caddy postgresql postgresql@ mysql mariadb docker redis-server; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    occupied=1
    note "$svc is running"
  fi
done

# Existing TWO install - a re-deploy, not a first deploy.
if id -u "$APP_USER" >/dev/null 2>&1; then note "system user '$APP_USER' already exists"; occupied=1; fi
[ -d "$APP_DIR" ] && { note "$APP_DIR already exists"; occupied=1; }
[ -d "$ENV_DIR" ] && { note "$ENV_DIR already exists (secrets may already be in place)"; occupied=1; }
if systemctl list-unit-files 2>/dev/null | grep -q '^two-bot\.service'; then
  note "two-bot.service is already installed - this is an update, not a first deploy"
  occupied=1
fi

if [ "$occupied" -eq 1 ]; then
  printf '\n  \033[1mVERDICT: shared box.\033[0m Read the "Node" section below before running bootstrap-host.sh.\n'
elif [ "$inspectable" -eq 0 ]; then
  # Absence of evidence is not evidence of absence. Without systemd or root we
  # cannot see what is enabled, so saying "clean" here would be a guess that
  # reads like a fact.
  printf '\n  \033[1mVERDICT: unknown.\033[0m Could not inspect enough to tell. Re-run with sudo on the real box.\n'
  occupied=1
else
  printf '\n  \033[1mVERDICT: looks unused.\033[0m bootstrap-host.sh can run as written.\n'
fi

# --- Node ------------------------------------------------------------------
# The sharp edge. bootstrap-host.sh installs Node 24 system-wide from
# nodesource. On a box where something else already depends on the system Node,
# that is an upgrade of somebody else's runtime, done silently, as a side
# effect of deploying a Discord bot.
hdr "Node"
if command -v node >/dev/null 2>&1; then
  nv="$(node -p 'process.versions.node' 2>/dev/null || echo '?')"
  nmaj="${nv%%.*}"
  row "node" "v$nv  ($(command -v node))"
  if [ "$nmaj" != "?" ] && [ "$nmaj" -lt "$NODE_MAJOR" ]; then
    if [ "$occupied" -eq 1 ]; then
      warn "node v$nv is older than the required v$NODE_MAJOR, and this box is in use."
      warn "  bootstrap-host.sh would REPLACE the system node. Check what else depends on it first:"
      warn "  grep -rl 'node' /etc/systemd/system/*.service"
    else
      note "node v$nv will be upgraded to v$NODE_MAJOR by bootstrap-host.sh"
    fi
  fi
else
  row "node" "not installed - bootstrap-host.sh will install v$NODE_MAJOR"
fi
command -v npm >/dev/null 2>&1 && row "npm" "v$(npm -v 2>/dev/null)"

# Anything else on the box pointing at node.
if [ -d /etc/systemd/system ]; then
  mapfile -t nodeunits < <(grep -sl 'node' /etc/systemd/system/*.service 2>/dev/null \
    | xargs -r -n1 basename | grep -v '^two-bot' | sort -u)
  if [ "${#nodeunits[@]}" -gt 0 ]; then
    printf '  other services running node:\n'
    printf '    %s\n' "${nodeunits[@]}"
    warn "the node upgrade above would also affect: ${nodeunits[*]}"
  fi
fi

# --- Ports -----------------------------------------------------------------
hdr "Ports"
if command -v ss >/dev/null 2>&1; then
  listening="$(ss -lntpH 2>/dev/null || ss -lntH 2>/dev/null)"
  if [ -z "$listening" ]; then
    warn "could not read listening sockets"
  else
    printf '  listening now:\n'
    printf '%s\n' "$listening" | awk '{print "    " $4 "  " $NF}' | sort -u
    for p in "${WANT_PORTS[@]}"; do
      if printf '%s\n' "$listening" | awk '{print $4}' | grep -qE "[:.]$p\$"; then
        warn "port $p is already taken - wanted by ${PORT_OWNER[$p]}"
      fi
    done
  fi
else
  warn "no 'ss' - could not check port conflicts"
fi

# --- Postgres --------------------------------------------------------------
hdr "Postgres"
if command -v psql >/dev/null 2>&1; then
  row "psql" "$(psql --version 2>/dev/null | head -1)"
  if [ "$is_root" -eq 1 ] && id -u postgres >/dev/null 2>&1; then
    dbs="$(su - postgres -c "psql -tAc \"select datname from pg_database where not datistemplate\"" 2>/dev/null)"
    if [ -n "$dbs" ]; then
      printf '  existing databases:\n'
      printf '%s\n' "$dbs" | sed 's/^/    /'
      printf '%s\n' "$dbs" | grep -qx 'two' && warn "a database named 'two' already exists - do not migrate onto it blind"
    fi
  else
    note "run with sudo to list existing databases"
  fi
else
  note "psql not installed - Postgres is not on this box yet (bot + website both need one)"
fi

# --- Exposure --------------------------------------------------------------
hdr "Firewall and access"
if command -v ufw >/dev/null 2>&1 && [ "$is_root" -eq 1 ]; then
  row "ufw" "$(ufw status 2>/dev/null | head -1)"
elif command -v nft >/dev/null 2>&1 && [ "$is_root" -eq 1 ]; then
  rules="$(nft list ruleset 2>/dev/null | wc -l)"
  row "nftables" "$rules rule lines"
  [ "$rules" -lt 5 ] && warn "no meaningful firewall ruleset - the box is open to the internet on every listening port"
else
  note "could not read firewall state (needs sudo)"
fi
if [ -r /etc/ssh/sshd_config ]; then
  pw="$(grep -iE '^\s*PasswordAuthentication' /etc/ssh/sshd_config 2>/dev/null | tail -1 | awk '{print $2}')"
  rl="$(grep -iE '^\s*PermitRootLogin' /etc/ssh/sshd_config 2>/dev/null | tail -1 | awk '{print $2}')"
  row "ssh password auth" "${pw:-default (yes on most images)}"
  row "ssh root login" "${rl:-default}"
  [ "${pw,,}" = "yes" ] && warn "SSH password authentication is on - key-only before this box holds a bot token"
  [ "${rl,,}" = "yes" ] && warn "SSH root login is on - disable before this box holds a bot token"
fi
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-enabled --quiet unattended-upgrades 2>/dev/null; then
    row "auto security updates" "enabled"
  else
    note "unattended-upgrades is not enabled - nobody will patch this box on a schedule"
  fi
fi

# --- Verdict ---------------------------------------------------------------
hdr "Summary"
if [ "${#conflicts[@]}" -eq 0 ]; then
  printf '  Nothing blocking found. Deploy path: docs/RUNBOOK.md -> Deploy.\n\n'
  exit 0
fi
printf '  %d thing(s) to resolve before deploying:\n\n' "${#conflicts[@]}"
printf '    * %s\n' "${conflicts[@]}"
cat <<'EOF'

  None of these are necessarily fatal. They are the things that turn a
  ten-minute deploy into an outage of something that was already working.
  Resolve or consciously accept each one, then run bootstrap-host.sh.

EOF
exit 1
