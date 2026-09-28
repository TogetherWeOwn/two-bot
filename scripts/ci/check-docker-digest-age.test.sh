#!/usr/bin/env bash
#
# Self-test for the digest-age guard (TOG-9126).
#
# It works by copying the real Dockerfile into a scratch tree and mutating the
# copy, so the pin and the refresh record stay in lockstep with the guard and
# this file never has to restate the digest. `cp`, never `cp -al`: a hardlink
# farm would let a mutation write straight through into the tree under review.
#
# Every red case asserts the ANNOTATION TEXT, not just a non-zero exit. The
# script has five separate ways to fail, and an exit-code-only assertion would
# pass just as happily if a mutation tripped the wrong one - which is exactly
# how a guard goes vacuous without anybody noticing.
#
# The clock is pinned at 2026-09-28 via --now, so the cadence arithmetic is
# deterministic: today's real refresh record reads 0 days old, a date 36 days
# back is stale, and a date 35 days back is still fresh.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/ci/check-docker-digest-age.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FIXTURE="$WORK/tree"
mkdir -p "$FIXTURE"
cp "$ROOT/Dockerfile" "$FIXTURE/Dockerfile"

# The real refresh record is 2026-09-28, so every case runs against a fixed
# clock on that day. A moving clock would make the stale-boundary case fail
# one day without any code changing.
NOW=2026-09-28

# Reset the fixture to pristine before each case, so mutations never stack.
reset_fixture() {
  cp "$ROOT/Dockerfile" "$FIXTURE/Dockerfile"
}

# Runs the guard against the fixture. Prints combined output, returns its exit.
run_guard() {
  local rc=0
  "$SCRIPT" --root "$FIXTURE" --now "$NOW" "$@" > "$WORK/out" 2>&1 || rc=$?
  cat "$WORK/out"
  return "$rc"
}

expect_fail_saying() {
  local case_name="$1" needle="$2" rc=0 output
  shift 2
  output="$(run_guard "$@")" || rc=$?
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
  printf 'baseline: the real Dockerfile does not pass. Every case below would be meaningless.\n%s\n' "$output" >&2
  exit 1
fi
[[ "$output" == *'digest pin fresh'* ]] || {
  printf 'baseline: passed without the expected summary line:\n%s\n' "$output" >&2
  exit 1
}
printf '  ok  baseline passes\n'

# ---------------------------------------------------------------------------
# 1. Stale: the record is one day past the 35-day cadence.
# ---------------------------------------------------------------------------
reset_fixture
sed -i 's/Digest refreshed: 2026-09-28/Digest refreshed: 2026-08-23/' "$FIXTURE/Dockerfile"
expect_fail_saying 'a 36-day-old pin is refused' \
  'digest pin is 36 days old'

# ---------------------------------------------------------------------------
# 2. Boundary: exactly 35 days is still fresh, not stale. Without this the
#    next person cannot tell whether `>` or `>=` is the rule.
# ---------------------------------------------------------------------------
reset_fixture
sed -i 's/Digest refreshed: 2026-09-28/Digest refreshed: 2026-08-24/' "$FIXTURE/Dockerfile"
if ! output="$(run_guard)"; then
  printf 'boundary: a 35-day-old pin should still pass:\n%s\n' "$output" >&2
  exit 1
fi
printf '  ok  a 35-day-old pin still passes\n'

# ---------------------------------------------------------------------------
# 3. Unpinned: the tag drifts again. The refresh record alone must not satisfy
#    the guard — a fresh date on a floating tag is exactly the silent drift
#    TOG-8680 was pinned to stop.
# ---------------------------------------------------------------------------
reset_fixture
sed -i -E 's|^(FROM node:24-bookworm-slim)@sha256:[0-9a-f]{64}|\1|' "$FIXTURE/Dockerfile"
expect_fail_saying 'an unpinned FROM is refused' \
  'FROM line is not digest-pinned'

# ---------------------------------------------------------------------------
# 4. No record: a pinned image with no refresh date. Without this branch the
#    whole guard is bypassed by deleting the comment the guard reads.
# ---------------------------------------------------------------------------
reset_fixture
sed -i 's/Digest refreshed: 2026-09-28/Digest refreshed: someday-never/' "$FIXTURE/Dockerfile"
expect_fail_saying 'a missing refresh record is refused' \
  "no 'Digest refreshed: YYYY-MM-DD' record"

# ---------------------------------------------------------------------------
# 5. Future date: a typo today becomes a free pass for months, because every
#    age computed against it reads young. A date in the future is a broken
#    record, not a fresh pin.
# ---------------------------------------------------------------------------
reset_fixture
sed -i 's/Digest refreshed: 2026-09-28/Digest refreshed: 2026-10-28/' "$FIXTURE/Dockerfile"
expect_fail_saying 'a future refresh date is refused' \
  'is in the future'

# ---------------------------------------------------------------------------
# 6. Missing Dockerfile: exit 2 (never-ran), not a red verdict. A missing
#    file means nothing was checked, per the CLI exit-code contract.
# ---------------------------------------------------------------------------
reset_fixture
rm "$FIXTURE/Dockerfile"
rc=0
output="$(run_guard)" || rc=$?
if [[ "$rc" -ne 2 ]]; then
  printf 'missing Dockerfile: expected exit 2, got %s:\n%s\n' "$rc" "$output" >&2
  exit 1
fi
[[ "$output" == *'not found'* ]] || {
  printf 'missing Dockerfile: expected a not-found message:\n%s\n' "$output" >&2
  exit 1
}
printf '  ok  a missing Dockerfile exits 2, not 1\n'

printf 'check-docker-digest-age: baseline, staleness, boundary, unpinned, missing record, future date and missing file all verified\n'
