#!/usr/bin/env bash
#
# systemd credential-file wiring audit (TOG-5706).
#
# WHY THIS EXISTS. docs/SECRETS.md rule 3 says production secrets are systemd
# credentials, not environment variables, because the bot shares a box with the
# website: an env var is visible in /proc/<pid>/environ and inherited by every
# child, while a LoadCredential file is 0400 for exactly one Unix user. That
# practice rots silently whenever a unit, the bootstrap, or the docs change
# without the other two: the bot keeps working through the env fallback in
# src/core/credentials.ts, so nobody notices the credential stopped being the
# path in use. This script is the ratchet that notices.
#
# WHAT IT ASSERTS (each rule names the file it failed on):
#   R1. No deploy/*.service hardcodes a secret in an `Environment=` literal.
#       `EnvironmentFile=` is the current mechanism for the env-file secrets
#       and is allowed; baking `Environment=DISCORD_TOKEN=...` into a unit is
#       the failure TOG-5688's check also refuses for the token. This rule
#       generalizes it to every known secret name.
#   R2. Every ACTIVE `LoadCredential=name:...` in deploy/* is consumed by a
#       `readSecret('name'` call in src/ or scripts/. A wired credential that
#       nothing reads is either a typo or a leftover, and on a real box it is
#       worse than nothing: a missing source file fails the unit at start.
#   R3. two-bot.service actively wires every credential the bot boot path
#       reads (src/core/config.ts, src/internal/config.ts,
#       src/moderation/config.ts), except the named UNWIRED exceptions below.
#       A credential the code reads but the unit only has commented out is the
#       exact drift this card found: `database_url` and `internal_keys` were
#       commented out while requiredDatabaseUrl() and loadInternalActionsConfig()
#       already preferred them.
#   R4. docs/SECRETS.md documents every credential in the registry: wired or
#       not, a credential nobody wrote down is one nobody rotates.
#   R5. docs/RUNBOOK.md "Rotate the bot token" references the live credential
#       path from the units and explicitly marks every other credential's
#       rotation manual (or links its procedure). Acceptance on TOG-5706 allows
#       manual steps; it does not allow silent ones.
#   R6. scripts/bootstrap-host.sh provisions every credential actively wired
#       in deploy/*.service. Wiring a LoadCredential without provisioning the
#       source file breaks the next fresh deploy at first start.
#
# UNWIRED EXCEPTIONS (R3). `moderation_audit_secret` is read by
# loadModerationConfig() but stays env-only on purpose: the MAC markers are
# not minted unless the secret is provisioned, null is the safe default, and
# wiring it is deferred until MAC enforcement lands. `two_e2e_user_token` never
# runs under systemd (staging-only on-demand harness, owner conditions in
# docs/SECRETS.md TOG-3978 section). `discord_staging_token` is wired in
# two-bot-guild-config-backup.service, not two-bot.service, by design.
#
# Repo-local only: no credentials are read, only names grepped.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    # The self-test points this at a fixture tree. Nothing else should.
    --root) ROOT="$2"; shift 2 ;;
    *) printf 'check-systemd-credentials: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

DEPLOY="$ROOT/deploy"
BOOTSTRAP="$ROOT/scripts/bootstrap-host.sh"
SECRETS="$ROOT/docs/SECRETS.md"
RUNBOOK="$ROOT/docs/RUNBOOK.md"

# Every credential name the repo knows about. Adding a new readSecret() name
# without adding it here fails R4 on purpose: the docs row is part of the
# change, not a follow-up.
REGISTRY='discord_token database_url internal_keys discord_staging_token moderation_audit_secret two_e2e_user_token'

# Bot boot-path files whose readSecret() names two-bot.service must wire.
BOOT_FILES='src/core/config.ts src/internal/config.ts src/moderation/config.ts'
# Of those, the ones deliberately left env-only (see header).
R3_UNWIRED='moderation_audit_secret'

# Secret env names that must never appear as `Environment=NAME=` literals.
SECRET_ENV='DISCORD_TOKEN DISCORD_BOT_TOKEN TWO_DATABASE_URL TWO_RESTORE_URL TWO_INTERNAL_KEYS DISCORD_STAGING_BOT_TOKEN TWO_E2E_USER_TOKEN TWO_MODERATION_AUDIT_SECRET TWO_BACKUP_S3_ENDPOINT TWO_BACKUP_S3_BUCKET TWO_BACKUP_S3_ACCESS_KEY_ID TWO_BACKUP_S3_SECRET_ACCESS_KEY'

fail=0
annotate() {
  # GitHub renders this next to the file; outside CI it is just a line.
  printf '::error file=%s,title=systemd credential wiring::%s\n' "$1" "$2" >&2
  fail=1
}

# --- helpers ---------------------------------------------------------------

# Active LoadCredential names in one unit file (comment lines excluded).
wired_in_unit() {
  grep -h '^LoadCredential=' "$1" 2>/dev/null \
    | sed -e 's/^LoadCredential=//' -e 's/[[:space:]].*//' -e 's/:.*//' \
    | sort -u || true
}

# All readSecret('name') literals under src/ and scripts/.
code_consumers() {
  grep -rhoE "readSecret\('[a-z_0-9]+'" "$ROOT/src" "$ROOT/scripts" 2>/dev/null \
    | sed -e "s/.*readSecret('//" -e "s/'.*//" \
    | sort -u || true
}

# --- R1: no hardcoded secret in Environment= literals ----------------------

for unit in "$DEPLOY"/*.service; do
  [ -e "$unit" ] || continue
  name="$(basename "$unit")"
  for var in $SECRET_ENV; do
    if grep -Eq "^Environment=${var}=" "$unit"; then
      annotate "deploy/$name" "R1: $name sets $var as an Environment= literal. Secrets travel as LoadCredential files or EnvironmentFile entries, never baked into the unit (docs/SECRETS.md rule 3)."
    fi
  done
done

# --- R2: every wired credential is consumed --------------------------------

consumers="$(code_consumers)"
for unit in "$DEPLOY"/*.service; do
  [ -e "$unit" ] || continue
  name="$(basename "$unit")"
  wired="$(wired_in_unit "$unit")"
  for cred in $wired; do
    if ! printf '%s\n' "$consumers" | grep -qx "$cred"; then
      # The e2e token is consumed via a constant, not a literal; the literal
      # string still appears in src/e2e/session.ts, so check the raw string too.
      # This guard and its self-test are excluded from that fallback: they name
      # every credential in comments and mutation strings, so without the
      # exclusion a typo'd LoadCredential would "pass" by matching this file.
      if ! grep -rq --exclude='check-systemd-credentials*' "$cred" "$ROOT/src" "$ROOT/scripts" 2>/dev/null; then
        annotate "deploy/$name" "R2: $name wires LoadCredential=$cred but nothing in src/ or scripts/ reads it. A missing source file fails the unit at start; remove the line or land the consumer first."
      fi
    fi
  done
done

# --- R3: two-bot.service wires the boot path --------------------------------

bot_unit="$DEPLOY/two-bot.service"
if [ -f "$bot_unit" ]; then
  bot_wired="$(wired_in_unit "$bot_unit")"
  for f in $BOOT_FILES; do
    [ -f "$ROOT/$f" ] || continue
    needed="$(grep -oE "readSecret\('[a-z_0-9]+'" "$ROOT/$f" 2>/dev/null | sed -e "s/.*readSecret('//" -e "s/'.*//" | sort -u || true)"
    for cred in $needed; do
      case " $R3_UNWIRED " in
        *" $cred "*) continue ;;
      esac
      if ! printf '%s\n' "$bot_wired" | grep -qx "$cred"; then
        annotate "deploy/two-bot.service" "R3: $f reads the \`$cred\` credential but two-bot.service does not actively wire it (commented LoadCredential lines do not count). The env fallback hides this until rotation day. Wire it, or add it to R3_UNWIRED with the reason."
      fi
    done
  done
else
  annotate "deploy/two-bot.service" "R3: two-bot.service is missing; cannot verify the boot-path wiring."
fi

# --- R4: SECRETS.md documents every registry credential ---------------------

for cred in $REGISTRY; do
  if ! grep -q "$cred" "$SECRETS" 2>/dev/null; then
    annotate "docs/SECRETS.md" "R4: credential \`$cred\` is used in code or units but not documented in docs/SECRETS.md. The docs row (credential name, env fallback, provisioning) is part of landing a credential."
  fi
  if ! grep -rq --exclude='check-systemd-credentials*' "$cred" "$ROOT/src" "$ROOT/scripts" "$DEPLOY" 2>/dev/null; then
    annotate "docs/SECRETS.md" "R4: registry names \`$cred\` but nothing in src/, scripts/ or deploy/ mentions it. Remove the registry line or land the credential."
  fi
done

# --- R5: rotation section names the live path, marks the rest manual --------

rotation="$(sed -n '/^## Rotate the bot token/,/^## /p' "$RUNBOOK" 2>/dev/null || true)"
if [ -z "$rotation" ]; then
  annotate "docs/RUNBOOK.md" "R5: no '## Rotate the bot token' section found; rotation steps must live there."
else
  if ! printf '%s\n' "$rotation" | grep -q '/etc/two-bot/credentials/discord_token'; then
    annotate "docs/RUNBOOK.md" "R5: rotation section does not reference /etc/two-bot/credentials/discord_token, the path deploy/two-bot.service wires. Docs and units must name the same file."
  fi
  for cred in $REGISTRY; do
    [ "$cred" = "discord_token" ] && continue
    if ! printf '%s\n' "$rotation" | grep -q "$cred"; then
      annotate "docs/RUNBOOK.md" "R5: rotation section never mentions \`$cred\`. Token-rotation acceptance allows manual steps but not silent ones: name the credential and mark its rotation manual (or link the procedure)."
      continue
    fi
  done
  # S3/RESTORE secrets have no credential names; they must still be marked.
  for marker in TWO_BACKUP_S3 TWO_RESTORE_URL; do
    if ! printf '%s\n' "$rotation" | grep -q "$marker"; then
      annotate "docs/RUNBOOK.md" "R5: rotation section never mentions $marker. Env-file secrets need a rotation note too."
    fi
  done
  if ! printf '%s\n' "$rotation" | grep -qi 'manual'; then
    annotate "docs/RUNBOOK.md" "R5: rotation section never says which steps are manual. Mark the non-portal rotations manual explicitly."
  fi
fi

# --- R6: bootstrap provisions every wired credential ------------------------

if [ -f "$BOOTSTRAP" ]; then
  for unit in "$DEPLOY"/*.service; do
    [ -e "$unit" ] || continue
    name="$(basename "$unit")"
    wired="$(wired_in_unit "$unit")"
    for cred in $wired; do
      if ! grep -q "$cred" "$BOOTSTRAP" 2>/dev/null; then
        annotate "deploy/$name" "R6: $name wires LoadCredential=$cred but scripts/bootstrap-host.sh never provisions that file. A fresh deploy would fail at first start. Provision it (empty + fill-in instructions) before wiring."
      fi
    done
  done
else
  annotate "scripts/bootstrap-host.sh" "R6: bootstrap-host.sh is missing; cannot verify credential provisioning."
fi

if [ "$fail" -ne 0 ]; then
  printf 'check-systemd-credentials: FAILED - units, bootstrap and docs disagree about credential files. Annotations above name each break.\n' >&2
  exit 1
fi
printf 'check-systemd-credentials: every wired credential is consumed, provisioned, documented, and rotation-marked\n'
