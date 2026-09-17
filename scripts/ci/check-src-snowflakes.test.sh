#!/usr/bin/env bash
#
# Self-test for the snowflake ratchet.
#
# It works by copying the real src/ into a scratch tree and mutating the copy,
# so the fixture is always in lockstep with the budget table and this file
# never has to restate 185. `cp -r`, never `cp -al`: a hardlink farm would let
# a mutation write straight through into the tree under review.
#
# Every case asserts the ANNOTATION TEXT, not just a non-zero exit. The script
# has four separate ways to fail, and an exit-code-only assertion would pass
# just as happily if a mutation tripped the wrong one - which is exactly how a
# guard goes vacuous without anybody noticing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/ci/check-src-snowflakes.sh"
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
# 0. Baseline. A mutation harness with no green baseline scores 100%% and
#    proves nothing, so this runs first and a failure here stops everything.
# ---------------------------------------------------------------------------
reset_fixture
if ! output="$(run_guard)"; then
  printf 'baseline: the unmutated tree does not pass. Every case below would be meaningless.\n%s\n' "$output" >&2
  exit 1
fi
[[ "$output" == *'at or under every budget'* ]] || {
  printf 'baseline: passed without the expected summary line:\n%s\n' "$output" >&2
  exit 1
}
printf '  ok  baseline passes\n'

# ---------------------------------------------------------------------------
# 1. Over budget: somebody hardcodes one more id in a file that already has some.
# ---------------------------------------------------------------------------
reset_fixture
printf "\nexport const ADDED_BY_SELFTEST = '1546777858200965121';\n" >> "$FIXTURE/src/onboarding/catalog.ts"
expect_fail_saying 'over budget is refused' \
  '28 hardcoded snowflakes, budget is 27'

# ---------------------------------------------------------------------------
# 2. Under budget: somebody removes ids and leaves the number alone. This is
#    the direction a ceiling would tolerate and a ratchet must not.
# ---------------------------------------------------------------------------
reset_fixture
grep -vE "'[0-9]{17,20}'" "$FIXTURE/src/onboarding/session.ts" > "$FIXTURE/session.tmp"
mv "$FIXTURE/session.tmp" "$FIXTURE/src/onboarding/session.ts"
expect_fail_saying 'under budget is refused' \
  'Lower the budget in scripts/ci/check-src-snowflakes.sh to 0'

# ---------------------------------------------------------------------------
# 3. A brand new src/ file full of ids, mentioned by no budget line. Without
#    this branch the whole guard is bypassed by `git add` of a new file.
# ---------------------------------------------------------------------------
reset_fixture
cat > "$FIXTURE/src/onboarding/brandNew.ts" <<'FIXTURE_EOF'
export const NEW_CHANNEL_IDS = [
  '1546777861199896589',
  '1546777862952976455',
] as const;
FIXTURE_EOF
expect_fail_saying 'an unbudgeted file is refused' \
  '2 hardcoded Discord snowflakes in a file with no budget'

# ---------------------------------------------------------------------------
# 4. A budgeted file disappears and its line is left behind. Otherwise the
#    table rots into a list of paths that no longer exist, and a later reader
#    has no way to tell a real budget from a fossil.
# ---------------------------------------------------------------------------
reset_fixture
rm "$FIXTURE/src/redesign/wave2.ts"
expect_fail_saying 'a stale budget line is refused' \
  'but the file is gone'

# ---------------------------------------------------------------------------
# 5. The documented carve-out, asserted rather than trusted: a bare snowflake
#    in prose is not configuration and must not trip the guard. If this ever
#    starts failing, the ratchet has silently become a comment-editing rule.
# ---------------------------------------------------------------------------
reset_fixture
printf '\n// Explains what happened to channel 1546777861199896589 on 2026-09-16.\n' \
  >> "$FIXTURE/src/redesign/wave2.ts"
if ! output="$(run_guard)"; then
  printf 'prose carve-out: a bare snowflake in a comment tripped the guard:\n%s\n' "$output" >&2
  exit 1
fi
printf '  ok  a bare snowflake in prose does not trip it\n'

printf 'check-src-snowflakes: baseline, both budget directions, unbudgeted files, stale lines and the prose carve-out all verified\n'
