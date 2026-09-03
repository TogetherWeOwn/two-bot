#!/usr/bin/env bash
#
# Tests for ci/verify-codeowners.sh.
#
# A checker that always passes and a checker that works look identical from the
# outside. This one guards a file that changes rarely and fails silently, which
# is the combination where a broken check goes unnoticed longest — so its own
# ability to fail is asserted on every CI run rather than the day somebody
# remembers to look.
#
# Every fixture is a real shape of the `codeowners/errors` response. The
# `dead-team` case is the two-web file as it actually stood before TOG-128; the
# `unknown-user` case is the recorded answer from the mutation probe on
# two-design. Both were captured from the live endpoint, not invented, so a case
# passing here means the script handles an answer GitHub really gives.
#
# No network, no gh, no credential.
#
# Usage: ./ci/verify-codeowners-selftest.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/ci/verify-codeowners.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/codeowners-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass() { printf '\033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2; }

rc=0
n=0

command -v jq >/dev/null || { printf 'jq is required\n' >&2; exit 1; }
[ -x "$SCRIPT" ] || { printf '%s is not executable\n' "$SCRIPT" >&2; exit 1; }

# expect <slug> <expected exit> <expected substring in output> <response json>
expect() {
  local slug="$1" want_rc="$2" want_text="$3" body="$4"
  n=$((n + 1))
  local f="$WORK/$slug.json"
  printf '%s' "$body" > "$f"

  local out got_rc
  out="$("$SCRIPT" "$f" 2>&1)"; got_rc=$?

  if [ "$got_rc" -ne "$want_rc" ]; then
    fail "$slug: expected exit $want_rc, got $got_rc"
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    rc=1
    return
  fi
  if ! printf '%s' "$out" | grep -qF "$want_text"; then
    fail "$slug: exit $got_rc was right, but the output never said '$want_text'"
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    rc=1
    return
  fi
  pass "$slug (exit $got_rc)"
}

# --- the answer for a healthy file -------------------------------------------

expect clean 0 "resolves every owner" '{"errors":[]}'

# --- unknown team: the shape that actually rotted, from two-web pre-TOG-128 ---

expect dead-team 1 "cannot resolve 1 owner reference" '{
  "errors": [
    {
      "line": 9, "column": 31,
      "source": "*                             @two-gaming/web-lead\n",
      "kind": "Unknown owner",
      "suggestion": "make sure the team @two-gaming/web-lead exists, is publicly visible, and has write access to the repository",
      "message": "Unknown owner on line 9",
      "path": ".github/CODEOWNERS"
    }
  ]
}'

# --- unknown user: the @phanan class, from the two-design mutation probe ------
#
# This case is why the script does not use the collaborator endpoint. That
# endpoint cannot tell this apart from a healthy handle with the token CI holds.

expect unknown-user 1 "cannot resolve 1 owner reference" '{
  "errors": [
    {
      "line": 41, "column": 30,
      "source": "/tools/probe/                @phanan\n",
      "kind": "Unknown owner",
      "suggestion": "make sure @phanan exists and has write access to the repository",
      "message": "Unknown owner on line 41",
      "path": ".github/CODEOWNERS"
    }
  ]
}'

# --- several at once ---------------------------------------------------------

expect many 1 "cannot resolve 3 owner reference" '{
  "errors": [
    {"line": 9,  "column": 31, "source": "* @a/b\n",  "kind": "Unknown owner", "suggestion": "s", "message": "m", "path": ".github/CODEOWNERS"},
    {"line": 13, "column": 31, "source": "/x/ @c/d\n", "kind": "Unknown owner", "suggestion": "s", "message": "m", "path": ".github/CODEOWNERS"},
    {"line": 14, "column": 31, "source": "/y/ @e\n",   "kind": "Syntax",        "suggestion": "s", "message": "m", "path": ".github/CODEOWNERS"}
  ]
}'

# --- "could not check" must never read as "checked, and it is fine" ----------
#
# These are the cases that turn a checker into a rubber stamp. Each one is a
# response that a naive `.errors | length == 0` reads as a clean bill of health.
# All three must exit 2 — undetermined — and none of them may exit 0.

expect not-json      2 "not valid JSON"              '<html>502 Bad Gateway</html>'
expect no-errors-key 2 "not a codeowners/errors"     '{"message":"Not Found","status":"404"}'
expect errors-wrong  2 "not a codeowners/errors"     '{"errors":"none"}'

# A truncated body is the sneakiest of the three: it is valid JSON, it has the
# key, and it is still not an answer.
expect errors-null   2 "not a codeowners/errors"     '{"errors":null}'

# --- a missing CODEOWNERS is a finding, not a clean run ----------------------
#
# The live endpoint answers 200 with zero errors when the file is absent, so
# without this the strongest possible failure — no CODEOWNERS at all — is the
# one result that reports green.
n=$((n + 1))
NOFILE_ROOT="$WORK/nofile"
mkdir -p "$NOFILE_ROOT/ci" "$NOFILE_ROOT/.github"
cp "$SCRIPT" "$NOFILE_ROOT/ci/verify-codeowners.sh"
printf '{"errors":[]}' > "$WORK/empty.json"
out="$("$NOFILE_ROOT/ci/verify-codeowners.sh" "$WORK/empty.json" 2>&1)"; got=$?
if [ "$got" -eq 1 ] && printf '%s' "$out" | grep -qF "does not exist"; then
  pass "missing-codeowners (exit 1)"
else
  fail "missing-codeowners: expected exit 1 and a 'does not exist' message, got exit $got"
  printf '%s\n' "$out" | sed 's/^/        /' >&2
  rc=1
fi

# --- a CODEOWNERS with no owners in it requests nobody -----------------------

n=$((n + 1))
EMPTY_ROOT="$WORK/noowners"
mkdir -p "$EMPTY_ROOT/ci" "$EMPTY_ROOT/.github"
cp "$SCRIPT" "$EMPTY_ROOT/ci/verify-codeowners.sh"
printf '# every line here is a comment\n# @not-an-owner is commented out\n' \
  > "$EMPTY_ROOT/.github/CODEOWNERS"
out="$("$EMPTY_ROOT/ci/verify-codeowners.sh" "$WORK/empty.json" 2>&1)"; got=$?
if [ "$got" -eq 1 ] && printf '%s' "$out" | grep -qF "names no owners"; then
  pass "no-owners (exit 1)"
else
  fail "no-owners: expected exit 1 and a 'names no owners' message, got exit $got"
  printf '%s\n' "$out" | sed 's/^/        /' >&2
  rc=1
fi

# --- the parser must not be fooled by a commented-out handle ------------------
#
# `# @ghost` is not an owner. If the parser counted it, the summary line would
# claim coverage this repo does not have.

n=$((n + 1))
CMT_ROOT="$WORK/comments"
mkdir -p "$CMT_ROOT/ci" "$CMT_ROOT/.github"
cp "$SCRIPT" "$CMT_ROOT/ci/verify-codeowners.sh"
printf '# owned by @ghost historically\n*   @real-owner\n' > "$CMT_ROOT/.github/CODEOWNERS"
out="$("$CMT_ROOT/ci/verify-codeowners.sh" "$WORK/empty.json" 2>&1)"; got=$?
if [ "$got" -eq 0 ] && printf '%s' "$out" | grep -qF "@real-owner" \
   && ! printf '%s' "$out" | grep -qF "@ghost"; then
  pass "comments-are-not-owners (exit 0)"
else
  fail "comments-are-not-owners: expected exit 0 listing only @real-owner, got exit $got"
  printf '%s\n' "$out" | sed 's/^/        /' >&2
  rc=1
fi

# --- the ref must always be explicit -----------------------------------------
#
# Regression guard for the bug the red control caught. `codeowners/errors` with
# no `?ref` reports on the *default branch*, so a PR job that omits it reads
# `main`, passes, and never looks at the broken file in the PR. It went green on
# a branch that really did name a non-collaborator.
#
# Asserted by reading the source, because the failure is a missing query
# parameter on a network call this offline suite cannot make. Both halves matter:
# the ref must be built into the URL, and GITHUB_HEAD_REF must be preferred on a
# pull request (GITHUB_SHA there is the ephemeral merge commit, which the API
# will not resolve).
n=$((n + 1))
if grep -q 'codeowners/errors?ref=' "$SCRIPT" \
   && grep -q 'GITHUB_HEAD_REF' "$SCRIPT" \
   && grep -q 'refusing to ask without an explicit ref' "$SCRIPT"; then
  pass "ref-is-always-explicit"
else
  fail "ref-is-always-explicit: the script must pin ?ref=, prefer GITHUB_HEAD_REF, and refuse a no-ref query"
  rc=1
fi

# And the workflow must not defeat it by checking out the merge commit without
# the branch context the script needs.
n=$((n + 1))
WF="$REPO_ROOT/.github/workflows/codeowners.yml"
if [ -f "$WF" ] && grep -q 'GH_REPO' "$WF" && grep -q 'contents: read' "$WF"; then
  pass "workflow-passes-repo-and-least-privilege"
else
  fail "workflow-passes-repo-and-least-privilege: .github/workflows/codeowners.yml must set GH_REPO and contents: read"
  rc=1
fi

printf '\n%s case(s)\n' "$n"
if [ "$rc" -eq 0 ]; then
  printf '\033[32mall good\033[0m\n'
else
  printf '\033[31mci/verify-codeowners.sh does not behave as documented\033[0m\n' >&2
fi
exit "$rc"
