#!/usr/bin/env bash
# Install (or roll back) the two-bot staging deploy broker on the Coolify host.
#
# OPERATOR-ONLY. Agents never run this: it writes to /opt, /etc and systemd,
# and it handles the scoped staging credential. Source changes stay with
# agents; the operator deploys the reviewed artifact and provisions only its
# scoped staging credential through TOG-8272 (TOG-6911 hand-back, 2026-09-28).
#
# WHAT IT INSTALLS. ops/staging-deploy-broker/server.mjs at a PINNED reviewed
# commit, as the twobot user under /opt/two-staging-broker, fronted by the
# two-staging-broker.service unit (loopback :8091). The panel bearer and the
# scoped staging credential arrive as systemd credentials (0400, twobot-only),
# never as Actions secrets and never on a command line.
#
# INSTALL:
#   git fetch origin && git rev-parse <sha>   # confirm the reviewed commit exists
#   sudo bash ops/staging-deploy-broker/install.sh \
#     --source /path/to/two-bot/checkout --commit <40-hex-sha> \
#     --panel-url https://<coolify-panel>
#
# The script verifies the source checkout's HEAD equals --commit, copies
# server.mjs, writes broker.env (COOLIFY_URL only), provisions EMPTY
# credential files, installs the unit, and REFUSES to start until the operator
# fills both credentials (a broker that starts unauthenticated authenticates
# nobody — install fails loudly instead, TOG-913):
#
#   sudo $EDITOR /etc/two-staging-broker/credentials/staging_broker_token  # scoped staging credential, >=16 chars
#   sudo $EDITOR /etc/two-staging-broker/credentials/coolify_token         # panel bearer (existing token)
#   sudo systemctl enable --now two-staging-broker
#   curl -s http://127.0.0.1:8091/healthz   # {"ok":true,"service":"two-staging-broker"}
#
# ROLLBACK:
#   sudo bash ops/staging-deploy-broker/install.sh --rollback
# Stops and disables the unit. Staging deploys then go red naming the missing
# broker (TOG-913) — nothing silently deploys. Production was never reachable
# through this unit. To restore a prior reviewed commit, re-run INSTALL with
# --commit <prior-sha>.
#
# Exit codes: 0 done, 2 usage/precondition/refusal. Never prints secret values.

set -euo pipefail

ROLLBACK=0
SOURCE=""
COMMIT=""
PANEL_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rollback) ROLLBACK=1; shift ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --panel-url) PANEL_URL="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) printf 'install: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

UNIT="two-staging-broker"
APP_DIR="/opt/two-staging-broker"
ENV_DIR="/etc/two-staging-broker"
CRED_DIR="$ENV_DIR/credentials"

fail() { printf '\ninstall: %s\n' "$*" >&2; exit 2; }
say() { printf '  %-5s %s\n' "$1" "$2"; }

if [[ "$ROLLBACK" -eq 1 ]]; then
  [[ "$(id -u)" -eq 0 ]] || fail "run me with sudo - rollback stops and disables $UNIT"
  systemctl stop "$UNIT" 2>/dev/null || say WARN "$UNIT was not running"
  systemctl disable "$UNIT" 2>/dev/null || say WARN "$UNIT was not enabled"
  say OK "broker stopped and disabled. Staging deploys now fail naming the missing broker (TOG-913); production was never reachable here."
  say OK "to restore: re-run install with --commit <prior-reviewed-sha>"
  exit 0
fi

# --- Preconditions -----------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || fail "run me with sudo - I write to $APP_DIR, $ENV_DIR and systemd"
command -v systemctl >/dev/null || fail "no systemd on this box"
command -v node >/dev/null || fail "no node on PATH - the broker needs Node >= 24"
[[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]] || fail "node $(node -p 'process.versions.node') is too old (need >= 24)"
[[ -n "$SOURCE" ]] || fail "missing --source <checked-out-repo>"
[[ -n "$COMMIT" ]] || fail "missing --commit <40-hex reviewed commit>"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "--commit must be a 40-hex SHA, got '$COMMIT'"
[[ -n "$PANEL_URL" ]] || fail "missing --panel-url https://<coolify-panel>"
[[ "$PANEL_URL" == https://* ]] || fail "--panel-url must be https:// (the panel bearer never travels over plaintext)"
[[ -f "$SOURCE/ops/staging-deploy-broker/server.mjs" ]] || fail "$SOURCE has no ops/staging-deploy-broker/server.mjs - wrong checkout?"
[[ -f "$SOURCE/ops/staging-deploy-broker/two-staging-broker.service" ]] || fail "$SOURCE has no unit file - wrong checkout?"

# The pinned commit is the trust anchor: the reviewed artifact, not "whatever
# HEAD happens to be". Refuse anything else.
if [[ -d "$SOURCE/.git" ]]; then
  HEAD="$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
  [[ "$HEAD" == "$COMMIT" ]] || fail "source HEAD is ${HEAD:-unknown}, not the pinned commit $COMMIT - check out the reviewed commit first"
  say PASS "source checkout at pinned commit ${COMMIT:0:12}"
else
  say WARN "no .git in $SOURCE - cannot verify HEAD; proceeding on operator assertion only"
fi
id twobot >/dev/null 2>&1 || fail "no twobot user - provision it first (scripts/bootstrap-host.sh)"

# --- Install -----------------------------------------------------------------
install -d -m 0755 -o twobot -g twobot "$APP_DIR"
install -m 0644 -o twobot -g twobot "$SOURCE/ops/staging-deploy-broker/server.mjs" "$APP_DIR/server.mjs"
say PASS "server.mjs installed at pinned commit ${COMMIT:0:12}"

install -d -m 0755 -o root -g root "$ENV_DIR"
printf 'COOLIFY_URL=%s\n' "$PANEL_URL" > "$ENV_DIR/broker.env"
chmod 0644 "$ENV_DIR/broker.env"
say PASS "broker.env written (panel URL only, never a secret)"

install -d -m 0700 -o root -g root "$CRED_DIR"
for cred in staging_broker_token coolify_token; do
  if [[ ! -f "$CRED_DIR/$cred" ]]; then
    install -m 0600 /dev/null "$CRED_DIR/$cred"
    say PASS "credential file $cred provisioned EMPTY"
  else
    say PASS "credential file $cred already exists - never overwritten"
  fi
done

install -m 0644 -o root -g root "$SOURCE/ops/staging-deploy-broker/two-staging-broker.service" "/etc/systemd/system/$UNIT.service"
systemctl daemon-reload
say PASS "unit installed"

# --- Refuse to start unauthenticated -----------------------------------------
EMPTY=()
for cred in staging_broker_token coolify_token; do
  [[ -s "$CRED_DIR/$cred" ]] || EMPTY+=("$cred")
done
if [[ "${#EMPTY[@]}" -gt 0 ]]; then
  systemctl disable "$UNIT" 2>/dev/null || true
  printf '\ninstall: NOT STARTED - credential files are empty: %s\n' "${EMPTY[*]}" >&2
  printf 'install: fill them (token only, no quotes), then:\n' >&2
  for cred in "${EMPTY[@]}"; do
    printf 'install:   sudo $EDITOR %s/%s\n' "$CRED_DIR" "$cred" >&2
  done
  printf 'install:   sudo systemctl enable --now %s\n' "$UNIT" >&2
  printf 'install:   curl -s http://127.0.0.1:8091/healthz\n' >&2
  printf 'install: (A broker that starts with a placeholder credential cannot authenticate anyone, so install fails loudly instead - TOG-913.)\n' >&2
  exit 2
fi

systemctl enable "$UNIT" >/dev/null
say PASS "unit enabled (start it with: sudo systemctl start $UNIT)"
printf '\ninstall: verify loopback with: curl -s http://127.0.0.1:8091/healthz\n'
printf 'install: then expose the broker to hosted CI per reverse-proxy.Caddyfile.example,\n'
printf 'install: provision STAGING_BROKER_URL=https://<broker-host> as the Actions secret\n'
printf 'install: through TOG-8272, and verify the hosted-runner view:\n'
printf 'install:   curl -s https://<broker-host>/healthz  # {"ok":true,...}\n'
printf 'install: (Deploy jobs run on ubuntu-latest and cannot reach loopback;\n'
printf 'install: without the proxy + origin the staging gate fails red, TOG-913.)\n'
