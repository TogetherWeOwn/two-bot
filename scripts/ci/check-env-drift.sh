#!/usr/bin/env bash
#
# Env drift audit: deploy/*.service vs .env.example (TOG-9986).
#
# WHY THIS EXISTS. Production config lives in two places that must agree:
# deploy/*.service pins non-secret runtime keys as `Environment=KEY=value`
# literals, and .env.example documents every key an operator may set. They rot
# silently in opposite directions: somebody adds PORT=8099 to
# two-dashboard.service and never documents it (the next operator copies
# .env.example and wonders why their port setting does nothing), or somebody
# deletes the last consumer of a key and leaves its paragraph in the example
# (the next operator sets a variable nothing reads). Both failures stay quiet
# for months. This script is the ratchet that notices.
#
# WHAT IT ASSERTS (each rule names the file it failed on):
#   R1. Every active `Environment=KEY=...` literal in deploy/*.service names
#       a KEY defined in .env.example (active `KEY=` or documented `# KEY=`).
#       `EnvironmentFile=` paths are not keys and are ignored, as are
#       `#`-commented lines.
#   R2. Every key defined in .env.example (active or `# `-documented) is
#       referenced somewhere under src/, scripts/, deploy/ or test/. A key
#       nothing reads is either a leftover or documentation for a variable the
#       code never honored.
#
# Repo-local only: no values are read, only key names grepped. Safe on
# production hosts and in CI alike.

set -euo pipefail

for arg in "$@"; do
  if [[ "$arg" == "--help" ]]; then
    printf '%s\n' 'Usage: bash scripts/ci/check-env-drift.sh [--root <directory>]'
    exit 0
  fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    # The self-test points this at a fixture tree. Nothing else should.
    --root) ROOT="$2"; shift 2 ;;
    *) printf 'check-env-drift: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

DEPLOY="$ROOT/deploy"
EXAMPLE="$ROOT/.env.example"

fail=0
annotate() {
  # GitHub renders this next to the file; outside CI it is just a line.
  printf '::error file=%s,title=env drift::%s\n' "$1" "$2" >&2
  fail=1
}

if [ ! -f "$EXAMPLE" ]; then
  annotate ".env.example" "R0: .env.example is missing; deploy/*.service Environment= keys have nothing to drift against."
  printf 'check-env-drift: FAILED - .env.example is missing.\n' >&2
  exit 1
fi

# Keys defined in .env.example: active `KEY=` lines and documented `# KEY=`
# lines (prose mentions without `=` do not count).
example_keys() {
  grep -hE '^[[:space:]]*#?[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$EXAMPLE" \
    | sed -E 's/^[[:space:]]*#?[[:space:]]*//; s/=.*//' \
    | sort -u
}

# Active Environment= keys in one unit file. Comment lines excluded;
# `EnvironmentFile=` lines never match `^Environment=` and are excluded.
# Handles quoted multi-assignments (`Environment="A=1" "B=2"`); a `=` inside a
# value is never preceded by start/space, so it is never taken as a key.
unit_keys() {
  grep -hE '^[[:space:]]*Environment=' "$1" 2>/dev/null \
    | sed -E 's/^[[:space:]]*Environment[[:space:]]*=[[:space:]]*//' \
    | grep -oE '(^|[[:space:]])"?[A-Za-z_][A-Za-z0-9_]*=' \
    | grep -oE '[A-Za-z_][A-Za-z0-9_]*' \
    | sort -u || true
}

# --- R1: every service literal is documented ---------------------------------

documented="$(example_keys)"
for unit in "$DEPLOY"/*.service; do
  [ -e "$unit" ] || continue
  name="$(basename "$unit")"
  keys="$(unit_keys "$unit")"
  for key in $keys; do
    if ! printf '%s\n' "$documented" | grep -qxF "$key"; then
      annotate "deploy/$name" "R1: $name sets Environment=$key=... but $key is not defined in .env.example. Document it there (active or \`# \`-commented) or remove the literal; a rename in either file must fail here naming both files."
    fi
  done
done

# --- R2: every example key is consumed ---------------------------------------
# One tree scan for every UPPER_SNAKE token, then set membership per key, so
# ~100 keys do not cost ~100 tree walks. This guard and its self-test are
# excluded from the scan: they name keys in comments and mutation strings,
# so without the exclusion an orphan key would "pass" by matching this file.

tokens="$(grep -rhoE --exclude-dir=node_modules --exclude-dir=.git --exclude='check-env-drift*' '[A-Z_][A-Z0-9_]*' \
  "$ROOT/src" "$ROOT/scripts" "$ROOT/deploy" "$ROOT/test" 2>/dev/null | sort -u || true)"
for key in $documented; do
  if ! printf '%s\n' "$tokens" | grep -qxF "$key"; then
    annotate ".env.example" "R2: .env.example defines $key but nothing under src/, scripts/, deploy/ or test/ references it. Remove the paragraph or land its consumer; an example key nothing reads teaches operators to set dead variables."
  fi
done

if [ "$fail" -ne 0 ]; then
  printf 'check-env-drift: FAILED - service units and .env.example disagree about env keys. Annotations above name each break.\n' >&2
  exit 1
fi
printf 'check-env-drift: every service Environment= key is documented and every example key is consumed\n'
