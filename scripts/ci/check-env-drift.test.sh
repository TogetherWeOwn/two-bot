#!/usr/bin/env bash
#
# Self-test for the env drift audit (TOG-9986).
#
# It works by copying the real env surface into a scratch tree and mutating
# the copy, so the fixture stays in lockstep with deploy/*.service and
# .env.example and this file never restates the key names. `cp -r`, never
# `cp -al`: a hardlink farm would let a mutation write straight through into
# the tree under review.
#
# Every case asserts the ANNOTATION TEXT (the R-code), not just a non-zero
# exit. The script has two separate ways to fail, and an exit-code-only
# assertion would pass just as happily if a mutation tripped the wrong one -
# which is exactly how a guard goes vacuous without anybody noticing.

set -euo pipefail

for arg in "$@"; do
  if [[ "$arg" == "--help" ]]; then
    printf '%s\n' 'Usage: bash scripts/ci/check-env-drift.test.sh'
    exit 0
  fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/ci/check-env-drift.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FIXTURE="$WORK/tree"
mkdir -p "$FIXTURE"
cp -r "$ROOT/deploy" "$FIXTURE/deploy"
cp "$ROOT/.env.example" "$FIXTURE/.env.example"
for dir in src scripts test; do
  mkdir -p "$FIXTURE/$dir"
  cp -r "$ROOT/$dir/." "$FIXTURE/$dir/"
done

# Reset the fixture to pristine before each case, so mutations never stack.
reset_fixture() {
  rm -rf "$FIXTURE/deploy" "$FIXTURE/.env.example" \
    "$FIXTURE/src" "$FIXTURE/scripts" "$FIXTURE/test"
  mkdir -p "$FIXTURE"
  cp -r "$ROOT/deploy" "$FIXTURE/deploy"
  cp "$ROOT/.env.example" "$FIXTURE/.env.example"
  for dir in src scripts test; do
    mkdir -p "$FIXTURE/$dir"
    cp -r "$ROOT/$dir/." "$FIXTURE/$dir/"
  done
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
# 1. R1: a service literal with no example row is refused (undocumented key).
#    This is the card acceptance: rename a key in one file, CI names both.
# ---------------------------------------------------------------------------
reset_fixture
printf 'Environment=TWO_DASHBOARD_PORT_RENAMED=8099\n' \
  >> "$FIXTURE/deploy/two-dashboard.service"
expect_fail_saying "R1 undocumented service key" \
  "R1: two-dashboard.service sets Environment=TWO_DASHBOARD_PORT_RENAMED=..."

# ---------------------------------------------------------------------------
# 2. R1 the other way: a renamed example key orphans the service literal.
# ---------------------------------------------------------------------------
reset_fixture
sed -i 's|^# PORT=8099|# TWO_DASHBOARD_PORT_RENAMED=8099|' \
  "$FIXTURE/.env.example"
expect_fail_saying "R1 renamed example key" \
  "R1: two-dashboard.service sets Environment=PORT=..."

# ---------------------------------------------------------------------------
# 3. R2: an example paragraph nothing reads is refused (orphan key).
# ---------------------------------------------------------------------------
reset_fixture
printf '# TWO_ORPHANED_KEY_FROM_FUTURE=\n' >> "$FIXTURE/.env.example"
expect_fail_saying "R2 orphan example key" \
  "R2: .env.example defines TWO_ORPHANED_KEY_FROM_FUTURE"

# ---------------------------------------------------------------------------
# 4. Commented service lines are inactive: commenting out a literal passes.
# ---------------------------------------------------------------------------
reset_fixture
sed -i 's|^Environment=PORT=8099|#Environment=PORT=8099|' \
  "$FIXTURE/deploy/two-dashboard.service"
if ! run_guard > /dev/null; then
  printf 'commented literal: guard failed a tree where the only new literal is commented out\n' >&2
  exit 1
fi
printf '  ok  commented literal ignored\n'

printf 'check-env-drift self-test: all cases pass\n'
