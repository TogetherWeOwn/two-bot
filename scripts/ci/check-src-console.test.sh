#!/usr/bin/env bash
#
# Self-test for the console ban (TOG-8693).
#
# It works by copying the real src/ into a scratch tree and mutating the copy,
# so the fixture is always in lockstep with the codebase and this file never
# has to restate the violation list. `cp -r`, never `cp -al`: a hardlink farm
# would let a mutation write straight through into the tree under review.
#
# Every case asserts the ANNOTATION TEXT, not just a non-zero exit. A guard
# with one way to fail is less subtle than the snowflake ratchet, but an
# exit-code-only assertion would still pass if a mutation tripped the wrong
# failure (missing src/, missing perl) - which is exactly how a guard goes
# vacuous without anybody noticing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/ci/check-src-console.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FIXTURE="$WORK/tree"
mkdir -p "$FIXTURE"
cp -r "$ROOT/src" "$FIXTURE/src"

# Reset the fixture to pristine before each case, so mutations never stack.
reset_fixture() {
  rm -rf "$FIXTURE/src"
  cp -r "$ROOT/src" "$FIXTURE/src"
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
  printf 'baseline: the unmutated tree does not pass. Every case below would be meaningless.\n%s\n' "$output" >&2
  exit 1
fi
[[ "$output" == *'no live console.* calls'* ]] || {
  printf 'baseline: passed without the expected summary line:\n%s\n' "$output" >&2
  exit 1
}
printf '  ok  baseline passes\n'

# ---------------------------------------------------------------------------
# 1. The acceptance case straight from TOG-8693: a reviewer adds a console.log
#    to src/, the guard refuses; remove it, the guard is green again.
# ---------------------------------------------------------------------------
reset_fixture
printf '\nconsole.log("retrying");\n' >> "$FIXTURE/src/discord/rateLimit.ts"
expect_fail_saying 'an added console.log is refused' \
  'src/discord/rateLimit.ts'
reset_fixture
if ! output="$(run_guard)"; then
  printf 'removal: the tree does not pass after removing the console.log:\n%s\n' "$output" >&2
  exit 1
fi
printf '  ok  removing the console.log is green again\n'

# ---------------------------------------------------------------------------
# 2. Every console method, not just log: the ban is on the object, so
#    console.error/warn/debug/table must trip it too, and the annotation must
#    name the exact live call for each one.
# ---------------------------------------------------------------------------
reset_fixture
cat > "$FIXTURE/src/internal/consoleProbe.ts" <<'FIXTURE_EOF'
export function probe(): void {
  console.error('boom');
}
FIXTURE_EOF
expect_fail_saying 'console.error is refused' \
  'live console.error call'
reset_fixture
cat > "$FIXTURE/src/internal/consoleProbe.ts" <<'FIXTURE_EOF'
export function probe(): void {
  console.warn('careful');
}
FIXTURE_EOF
expect_fail_saying 'console.warn is refused' \
  'live console.warn call'
reset_fixture
cat > "$FIXTURE/src/internal/consoleProbe.ts" <<'FIXTURE_EOF'
export function probe(): void {
  console.debug('detail');
}
FIXTURE_EOF
expect_fail_saying 'console.debug is refused' \
  'live console.debug call'
reset_fixture

# ---------------------------------------------------------------------------
# 3. A brand new src/ file with a call. Without scanning every file rather
#    than a budget table, the whole guard is bypassed by `git add` of a new
#    file - the exact gap the snowflake ratchet's case 3 closes.
# ---------------------------------------------------------------------------
reset_fixture
cat > "$FIXTURE/src/onboarding/brandNew.ts" <<'FIXTURE_EOF'
export function greet(): void {
  console.log('hello');
}
FIXTURE_EOF
expect_fail_saying 'a new file with a call is refused' \
  'src/onboarding/brandNew.ts'

# ---------------------------------------------------------------------------
# 4. The documented carve-outs, asserted rather than trusted: the word
#    "console" in prose comments and inside string literals must not trip the
#    guard. If either ever starts failing, the ban has silently become a
#    comment-editing rule and people will strip the explanations that say
#    where operator-visible text goes.
# ---------------------------------------------------------------------------
reset_fixture
cat >> "$FIXTURE/src/e2e/session.ts" <<'FIXTURE_EOF'
// The refusal is printed to the operator console, again and again.
FIXTURE_EOF
printf '\n// Explains why %s must stay in the transcript and the console.\n' \
  'the short reason' >> "$FIXTURE/src/e2e/guard.ts"
printf '\nexport const DO_NOT = %s;\n' "'use console.log, not the logger'" \
  >> "$FIXTURE/src/internal/consoleProbe.ts"
if ! output="$(run_guard)"; then
  printf 'carve-outs: prose or a string literal tripped the guard:\n%s\n' "$output" >&2
  exit 1
fi
printf '  ok  prose and string literals do not trip it\n'

# ---------------------------------------------------------------------------
# 5. *.test.ts files are out of scope: the ban is on shipped code, not on
#    assertions about it. If this ever starts failing, the guard is policing
#    the test suite instead of src/.
# ---------------------------------------------------------------------------
reset_fixture
printf '\nconsole.log("fixture noise");\n' >> "$FIXTURE/src/e2e/session.test.ts"
if ! output="$(run_guard)"; then
  printf 'test-file carve-out: a *.test.ts call tripped the guard:\n%s\n' "$output" >&2
  exit 1
fi
printf '  ok  *.test.ts files stay out of scope\n'

printf 'check-src-console: baseline, red-green, every method, new files and all carve-outs verified\n'
