#!/usr/bin/env bash
#
# Self-test for the fork-PR refusal.
#
# The script has two refusal paths - "came from a fork" and "cannot tell where
# it came from" - and they want different fixes. Asserting only on the exit
# code would let either one stand in for the other, so every case here matches
# the annotation text.
#
# The last case is the one that matters most and it is the easiest to lose:
# a workflow that stops passing PR_HEAD_REPO must be refused, not waved
# through. That is the shape a guard goes vacuous in.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/ci/refuse-fork-pr.sh"

run_case() {
  # run_case <name> <expect pass|fail> <needle> ENV=VALUE...
  local name="$1" expect="$2" needle="$3"; shift 3
  local output rc=0
  output="$(env -u GITHUB_EVENT_NAME -u GITHUB_REPOSITORY -u PR_HEAD_REPO "$@" "$SCRIPT" 2>&1)" || rc=$?

  if [[ "$expect" == 'pass' && "$rc" -ne 0 ]]; then
    printf '%s: expected to pass, exited %s:\n%s\n' "$name" "$rc" "$output" >&2
    exit 1
  fi
  if [[ "$expect" == 'fail' && "$rc" -eq 0 ]]; then
    printf '%s: expected a refusal, but it passed:\n%s\n' "$name" "$output" >&2
    exit 1
  fi
  if [[ "$output" != *"$needle"* ]]; then
    printf '%s: right verdict, wrong reason.\nwanted substring: %s\ngot:\n%s\n' \
      "$name" "$needle" "$output" >&2
    exit 1
  fi
  printf '  ok  %s\n' "$name"
}

run_case 'a same-repo pull request runs' pass \
  'same repository, safe to run here' \
  GITHUB_EVENT_NAME=pull_request \
  GITHUB_REPOSITORY=TogetherWeOwn/two-bot \
  PR_HEAD_REPO=TogetherWeOwn/two-bot

run_case 'a fork pull request is refused' fail \
  'this pull request comes from stranger/two-bot' \
  GITHUB_EVENT_NAME=pull_request \
  GITHUB_REPOSITORY=TogetherWeOwn/two-bot \
  PR_HEAD_REPO=stranger/two-bot

# The refusal has to name the fix, because the person who hits it is usually
# an outside contributor who has done nothing wrong.
run_case 'the refusal tells the contributor what to do instead' fail \
  'A maintainer should push the branch to TogetherWeOwn/two-bot' \
  GITHUB_EVENT_NAME=pull_request \
  GITHUB_REPOSITORY=TogetherWeOwn/two-bot \
  PR_HEAD_REPO=stranger/two-bot

run_case 'pull_request_target is checked too' fail \
  'this pull request comes from stranger/two-bot' \
  GITHUB_EVENT_NAME=pull_request_target \
  GITHUB_REPOSITORY=TogetherWeOwn/two-bot \
  PR_HEAD_REPO=stranger/two-bot

run_case 'a push to main is not a pull request' pass \
  'push is not a pull request' \
  GITHUB_EVENT_NAME=push \
  GITHUB_REPOSITORY=TogetherWeOwn/two-bot

run_case 'a scheduled run is not a pull request' pass \
  'schedule is not a pull request' \
  GITHUB_EVENT_NAME=schedule \
  GITHUB_REPOSITORY=TogetherWeOwn/two-bot

run_case 'a missing head repo fails closed' fail \
  'cannot tell where this pull request came from' \
  GITHUB_EVENT_NAME=pull_request \
  GITHUB_REPOSITORY=TogetherWeOwn/two-bot

run_case 'a missing repository fails closed' fail \
  'cannot tell where this pull request came from' \
  GITHUB_EVENT_NAME=pull_request \
  PR_HEAD_REPO=TogetherWeOwn/two-bot

# --------------------------------------------------------------------------
# Coverage. A correct guard nobody calls is worse than no guard, because the
# workflows now look protected. This asserts the wiring, not the script:
#
#   - every workflow that a pull request can trigger has a `fork-gate` job
#   - that job runs this script, and checks out the BASE commit rather than
#     the pull request, so a fork cannot supply its own copy of the guard
#   - every other job in that workflow declares `needs:` on fork-gate, so a
#     fork's code is never reached when the gate refuses
#
# Skipping is the right dependent behaviour here and failing is the right gate
# behaviour: a skipped job counts as a green required check, so the merge is
# blocked by fork-gate going red, while the fork's code simply never runs.
# --------------------------------------------------------------------------
node "$ROOT/scripts/ci/check-fork-gate-coverage.mjs"

printf 'refuse-fork-pr: both refusal reasons, both fail-closed cases, the non-PR events and workflow coverage all verified\n'
