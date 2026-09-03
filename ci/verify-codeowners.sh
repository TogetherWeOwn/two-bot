#!/usr/bin/env bash
#
# Proves every owner named in .github/CODEOWNERS still resolves to somebody
# GitHub will actually ask for a review.
#
# A CODEOWNERS rule naming an account or team without write access to this repo
# is silently dropped. No warning, no reviewer, no invalid-file marker on the
# file in most surfaces. The rule stays in the file looking correct and simply
# stops doing anything. That is not a hypothetical: this org's four CODEOWNERS
# files named @two-gaming/* teams that do not exist in TogetherWeOwn — 35 dead
# rules across two-web, two-bot and two-design — and nntune named @phanan, the
# upstream author, who is not a collaborator. Nobody found out for months.
#
# TOG-128 corrected the contents. It did not stop the next drift, and membership
# changes: the day somebody's access is removed, every rule naming them goes
# quiet the same way, and the file still reads as though review is covered.
#
# WHAT THIS ASKS, AND WHY IT IS NOT THE OBVIOUS THING
#
# The obvious check is the one the ticket suggested: extract each @handle and
# call `GET /repos/{owner}/{repo}/collaborators/{username}`, which documents 204
# for a collaborator and 404 for a stranger. Measured on this org, that check is
# vacuous. With a GitHub App installation token holding contents:read +
# metadata:read, the collaborator endpoint returns **404 for everyone** — for
# @Rick7C2, who is a real collaborator, exactly as for @phanan, who is not. The
# collaborator *list* returns 200 and an empty array for the same reason: our App
# is not an org member and cannot enumerate or test human collaborators. A check
# built on it would fail every handle, get diagnosed as broken, and be disabled
# within a day — or, if somebody "fixed" it by treating 404 as inconclusive, it
# would pass everything forever. Both failure modes are worse than no check.
#
# So this reads GitHub's own answer instead:
#
#   GET /repos/{owner}/{repo}/codeowners/errors
#
# That is the same resolver that decides whether a reviewer gets requested when a
# PR opens, which makes it the authoritative source rather than a reconstruction
# of it. It needs contents:read and nothing else — no members:read, no
# administration, no org membership — and it reports unknown *users* and unknown
# *teams* alike, with the line and column. Both classes are verified below, not
# assumed; see the control note.
#
# CONTROLS (run 2026-09-03, recorded so the next person does not have to redo it)
#
#   Positive, teams:  `codeowners/errors?ref=339ed30d0fd6` on two-web — the commit
#                     before the TOG-128 fix — returns 35 `Unknown owner` errors
#                     naming the dead @two-gaming/* teams.
#   Positive, users:  a throwaway branch on two-design adding `/tools/probe/
#                     @phanan` returns exactly 1 error on that line. Branch
#                     deleted after the probe.
#   Negative:         the same endpoint on each repo's current main returns 0.
#
# A check that has never been watched fail is a check nobody knows works, so
# ci/verify-codeowners-selftest.sh re-proves the script's own logic offline
# against saved responses on every run of this workflow.
#
# Usage:
#   ./ci/verify-codeowners.sh                 # read live, at HEAD
#   ./ci/verify-codeowners.sh --ref <sha>     # read live, at a ref
#   ./ci/verify-codeowners.sh <saved.json>    # assert against a saved response
#
# The file form takes no network and no credential, which is what the self-test
# uses and what lets anyone re-check a recorded answer after the fact.
#
# Exits:
#   0  the file was read, every owner resolves
#   1  the file was read and an owner does not resolve, or the file is gone — a finding
#   2  the answer could not be read — no verdict either way
#
# 2 is not a softer 1. A caller that collapses them is back to reporting a verdict
# about something nobody read. Both fail closed; only 1 is evidence.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEOWNERS="$REPO_ROOT/.github/CODEOWNERS"

fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; }
pass() { printf '\033[32mPASS: %s\033[0m\n' "$*"; }
log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# Could not check. Never a verdict about the file — see the exit codes above.
undetermined() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 2; }

REF=""
SAVED=""
case "${1:-}" in
  --ref) REF="${2:-}"; [ -n "$REF" ] || undetermined "--ref needs a value." ;;
  "")    ;;
  -*)    undetermined "unknown option: $1" ;;
  *)     SAVED="$1"; [ -f "$SAVED" ] || undetermined "no such file: $SAVED" ;;
esac

command -v jq >/dev/null || undetermined "jq is not installed, so nothing here can read the response."

# --- which ref gets checked --------------------------------------------------
#
# This is load-bearing, and it is the one thing about this script that was wrong
# in review. `codeowners/errors` with no `?ref` resolves against the repository's
# **default branch**, not against whatever is checked out. On a pull request that
# means the job reads `main`, finds it healthy, and reports success — while the
# broken CODEOWNERS sitting in the PR is never looked at. The check would have
# passed every bad rule forever and looked green doing it.
#
# Caught by a deliberate red control: a branch adding `/tools/probe/ @phanan`
# (not a collaborator) went **green** in CI until this block existed. The
# endpoint answered `errors=0` for no-ref and `errors=1` for `?ref=<branch>` on
# the same commit, which is the whole bug in two numbers.
#
# So the ref is always explicit. On a pull request that must be the PR head, not
# GITHUB_SHA — for a `pull_request` event GITHUB_SHA is the ephemeral merge
# commit, which is not a ref the API will resolve.
if [ -z "$SAVED" ] && [ -z "$REF" ]; then
  if [ -n "${GITHUB_HEAD_REF:-}" ]; then
    REF="$GITHUB_HEAD_REF"          # pull_request: the branch being proposed
  elif [ -n "${GITHUB_SHA:-}" ]; then
    REF="$GITHUB_SHA"               # push: the commit that just landed
  else
    # Local run. Ask about the checked-out commit rather than silently
    # reporting on main from inside a feature branch.
    REF="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
    [ -n "$REF" ] || undetermined \
      "cannot determine which ref to check: not a git checkout and no --ref given."
  fi
fi

# --- the handles this repo believes in ---------------------------------------
#
# Parsed from the file rather than hand-listed, so there is no second place for
# the list to drift. This is not what gates — GitHub's answer gates — but it is
# what makes a failure actionable, and an empty parse is itself a finding: a
# CODEOWNERS with no owners in it requests nobody, which is the same outcome as
# the rot this script exists to catch, arrived at from the other direction.
owners_in_file() {
  sed 's/#.*//' "$CODEOWNERS" \
    | grep -o '@[A-Za-z0-9][-A-Za-z0-9_]*\(/[-A-Za-z0-9_]*\)\?' \
    | sort -u
}

log "Reading .github/CODEOWNERS"

# A deleted CODEOWNERS is a finding, not a clean run. The API answers 200 with an
# empty error list when the file does not exist — "nothing is broken because
# nothing is there" — and that must never read as green.
if [ ! -f "$CODEOWNERS" ]; then
  fail ".github/CODEOWNERS does not exist. No rule can request a reviewer."
  exit 1
fi

mapfile -t HANDLES < <(owners_in_file)
if [ "${#HANDLES[@]}" -eq 0 ]; then
  fail ".github/CODEOWNERS names no owners at all, so it requests nobody."
  exit 1
fi
printf '    %s owner reference(s): %s\n' "${#HANDLES[@]}" "${HANDLES[*]}"

# --- GitHub's answer ---------------------------------------------------------

RESPONSE="$(mktemp)"
trap 'rm -f "$RESPONSE"' EXIT

if [ -n "$SAVED" ]; then
  log "Asserting against saved response: $SAVED"
  cat "$SAVED" > "$RESPONSE"
else
  command -v gh >/dev/null || undetermined "gh is not installed and no saved response was given."
  : "${GH_REPO:="${GITHUB_REPOSITORY:-}"}"
  [ -n "${GH_REPO:-}" ] || undetermined "GH_REPO/GITHUB_REPOSITORY is unset, so there is no repo to ask about."

  # Never reachable via the block above, which always sets a ref. Kept because
  # the failure it guards against is invisible: a no-ref request succeeds, reads
  # the default branch, and reports green. If a future edit drops the ref, this
  # stops the run instead of quietly checking the wrong commit.
  [ -n "$REF" ] || undetermined \
    "refusing to ask without an explicit ref — a no-ref query silently reports on the default branch."

  ENDPOINT="repos/$GH_REPO/codeowners/errors?ref=$REF"
  log "Asking GitHub: GET $ENDPOINT"
  printf '    ref: %s\n' "$REF"

  err="$(mktemp)"
  if ! gh api "$ENDPOINT" > "$RESPONSE" 2>"$err"; then
    detail="$(tr -d '\n' < "$err" | cut -c1-400)"; rm -f "$err"
    # A failed read is not evidence of a bad file. Exit 2, loudly.
    undetermined "could not read $ENDPOINT — $detail"
  fi
  rm -f "$err"
fi

# The response must actually be a codeowners/errors document. Without this, a
# truncated body, an error page, or a renamed field all parse to "no errors
# found" and this script reports PASS having compared nothing — the exact way a
# check goes quiet while still printing green.
jq -e . "$RESPONSE" >/dev/null 2>&1 \
  || undetermined "the response is not valid JSON, so it says nothing about the file."
jq -e 'has("errors") and (.errors | type == "array")' "$RESPONSE" >/dev/null 2>&1 \
  || undetermined "the response has no 'errors' array — this is not a codeowners/errors document."

COUNT="$(jq '.errors | length' "$RESPONSE")"

if [ "$COUNT" -eq 0 ]; then
  log "Result"
  pass "GitHub resolves every owner in .github/CODEOWNERS (${#HANDLES[@]} reference(s) checked)."
  exit 0
fi

log "Result"
fail "GitHub cannot resolve $COUNT owner reference(s) in .github/CODEOWNERS."
echo >&2
jq -r '.errors[]
       | "  line \(.line), column \(.column): \(.kind)\n" +
         "    \(.source | rtrimstr("\n"))\n" +
         "    \(.suggestion)\n"' "$RESPONSE" >&2

cat >&2 <<'WHY'
Every rule listed above is dead. GitHub drops it silently: no reviewer is
requested for those paths and nothing else warns you. Either correct the handle
to an account or team with write access to this repo, or delete the rule — but do
not leave it, because a rule that names nobody reads exactly like review coverage
that does not exist.
WHY

exit 1
