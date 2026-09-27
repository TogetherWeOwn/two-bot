#!/usr/bin/env bash
#
# Self-test for the systemd credential-file wiring audit (TOG-5706).
#
# It works by copying the real credential surface into a scratch tree and
# mutating the copy, so the fixture stays in lockstep with the registry and
# this file never restates the credential names. `cp -r`, never `cp -al`: a
# hardlink farm would let a mutation write straight through into the tree
# under review.
#
# Every case asserts the ANNOTATION TEXT (the R-code), not just a non-zero
# exit. The script has six separate ways to fail, and an exit-code-only
# assertion would pass just as happily if a mutation tripped the wrong one -
# which is exactly how a guard goes vacuous without anybody noticing.
#
# Repo-local only: no credentials are read, only names grepped.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/ci/check-systemd-credentials.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FIXTURE="$WORK/tree"
mkdir -p "$FIXTURE"
cp -r "$ROOT/src" "$FIXTURE/src"
cp -r "$ROOT/scripts" "$FIXTURE/scripts"
cp -r "$ROOT/deploy" "$FIXTURE/deploy"
cp -r "$ROOT/docs" "$FIXTURE/docs"

# Reset the fixture to pristine before each case, so mutations never stack.
reset_fixture() {
  rm -rf "$FIXTURE"
  mkdir -p "$FIXTURE"
  cp -r "$ROOT/src" "$FIXTURE/src"
  cp -r "$ROOT/scripts" "$FIXTURE/scripts"
  cp -r "$ROOT/deploy" "$FIXTURE/deploy"
  cp -r "$ROOT/docs" "$FIXTURE/docs"
}

# Runs the guard against the fixture. Prints combined output, returns its exit.
run_guard() {
  local rc=0
  "$SCRIPT" --root "$FIXTURE" > "$WORK/out" 2>&1 || rc=$?
  cat "$WORK/out"
  return "$rc"
}

expect_fail_saying() {
  local case_name="$1" needle="$2" rc=0 output
  output="$(run_guard)" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    printf '%s: guard PASSED a tree it should have refused\n' "$case_name" >&2
    exit 1
  fi
  if [[ "$output" != *"$needle"* ]]; then
    printf '%s: guard failed, but not for the expected reason.\nwanted substring: %s\ngot:\n%s\n' \
      "$case_name" "$needle" "$output" >&2
    exit 1
  fi
  printf '  ok  %s\n' "$case_name"
}

# ---------------------------------------------------------------------------
# 0. Baseline. A mutation harness with no green baseline scores 100% and
#    proves nothing, so this runs first and a failure here stops everything.
# ---------------------------------------------------------------------------
reset_fixture
if ! output="$(run_guard)"; then
  printf 'baseline: guard FAILS the pristine tree - fix the tree before trusting the cases below.\n%s\n' "$output" >&2
  exit 1
fi
printf '  ok  baseline green\n'

# ---------------------------------------------------------------------------
# 1. R1: a secret baked into an Environment= literal is refused.
# ---------------------------------------------------------------------------
reset_fixture
printf 'Environment=DISCORD_TOKEN=live-value-that-must-never-be-here\n' \
  >> "$FIXTURE/deploy/two-redirect.service"
expect_fail_saying "R1 hardcoded secret" "R1:"

# ---------------------------------------------------------------------------
# 2. R2: a wired credential nothing reads is refused (typo or leftover).
# ---------------------------------------------------------------------------
reset_fixture
printf 'LoadCredential=discord_tokne:/etc/two-bot/credentials/discord_tokne\n' \
  >> "$FIXTURE/deploy/two-bot.service"
expect_fail_saying "R2 unconsumed credential" "R2:"

# ---------------------------------------------------------------------------
# 3. R3: commenting out a boot-path credential is refused (the TOG-5706 drift).
# ---------------------------------------------------------------------------
reset_fixture
sed -i 's|^LoadCredential=database_url:|#LoadCredential=database_url:|' \
  "$FIXTURE/deploy/two-bot.service"
expect_fail_saying "R3 unwired boot credential" "R3:"

# ---------------------------------------------------------------------------
# 4. R4: a registry credential missing from SECRETS.md is refused.
# ---------------------------------------------------------------------------
reset_fixture
sed -i '/two_e2e_user_token/d' "$FIXTURE/docs/SECRETS.md"
expect_fail_saying "R4 undocumented credential" "R4:"

# ---------------------------------------------------------------------------
# 5. R5: a rotation section silent about a credential is refused.
# ---------------------------------------------------------------------------
reset_fixture
python3 - "$FIXTURE/docs/RUNBOOK.md" <<'EOF'
import re, sys
path = sys.argv[1]
text = open(path).read()
start = text.index('### Rotating everything else')
end = text.index('## What are the numbers?')
open(path, 'w').write(text[:start] + text[end:])
EOF
expect_fail_saying "R5 silent rotation" "R5:"

# ---------------------------------------------------------------------------
# 6. R6: a wired credential the bootstrap never provisions is refused.
# ---------------------------------------------------------------------------
reset_fixture
sed -i '/DATABASE_URL_FILE="\$CRED_DIR\/database_url"/d; s/"\$TOKEN_FILE" "\$DATABASE_URL_FILE" "\$INTERNAL_KEYS_FILE"/"$TOKEN_FILE" "$INTERNAL_KEYS_FILE"/' \
  "$FIXTURE/scripts/bootstrap-host.sh"
# The loop above is cosmetic; what must go is the literal the guard greps for.
sed -i '/CRED_DIR\/database_url/d' "$FIXTURE/scripts/bootstrap-host.sh"
expect_fail_saying "R6 unprovisioned credential" "R6:"

printf 'check-systemd-credentials selftest: all cases refused for the right reason\n'
