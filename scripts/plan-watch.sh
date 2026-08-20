#!/usr/bin/env bash
#
# Watch for the day GitHub starts allowing branch protection, and say so.
#
#   ./scripts/plan-watch.sh                 # probe and report
#   ./scripts/plan-watch.sh --runbook       # print the re-apply steps and exit
#   ./scripts/plan-watch.sh --github-issue  # also file/refresh a GitHub issue
#                                           # when action is needed. NOT used by
#                                           # plan-watch.yml: GitHub Issues is
#                                           # disabled on these repos (work is
#                                           # tracked in Paperclip), so it would
#                                           # only ever fail. Kept for the day
#                                           # that changes; it degrades to a
#                                           # warning rather than losing the
#                                           # alarm, since the exit code carries
#                                           # it either way.
#
# WHY THIS EXISTS (TWO-85)
#
# The org is on GitHub Free with private repos. On that combination GitHub
# does not accept-and-ignore a branch protection rule - it refuses the write
# outright with 403 and stores nothing:
#
#   PUT  repos/two-gaming/two-bot/branches/main/protection  -> 403
#   GET  repos/two-gaming/two-design/rulesets               -> 403
#   "Upgrade to GitHub Pro or make this repository public to enable this feature."
#
# Measured against the real org on 2026-08-20, and again by every run of this
# script. The consequence is the whole point: moving to Team later does NOT
# switch protection on. There is no saved rule waiting to start being
# enforced. Somebody has to write the rules again - and the day the plan
# changes is exactly the day nobody is thinking about branch protection.
#
# So this script is the somebody. It runs weekly from plan-watch.yml, and the
# moment GitHub stops refusing, it stops being quiet.
#
# WHAT IT WILL NOT DO
#
# It does not apply protection. Writing rules to the org is a real change to
# how everyone's pushes behave, so a human runs setup-github.sh and reads the
# output. This script only tells you the day has come, and hands you the
# exact commands. See --runbook.
#
# EXIT CODES
#   0  nothing to do  - GitHub still refuses (expected), or protection is
#                       already on (someone did the work)
#   1  ACTION NEEDED  - protection is now possible and main is not protected
#   2  usage error
#
# An "I could not tell" outcome exits 0 with a loud warning, never silently.
# A watcher that reports all-clear when it is actually broken is worse than
# no watcher, so unknown is always spoken out loud but never treated as an
# alarm - a weekly red X nobody can act on gets muted, and then the real one
# gets muted with it.
#
# CREDENTIAL
#   GH_TOKEN. In CI this is the workflow's GITHUB_TOKEN, which needs
#   `administration: read` to read branch protection at all - without it every
#   probe lands in "unknown" and this watcher quietly stops working. The
#   org-plan probe additionally needs an org-scoped token; GITHUB_TOKEN cannot
#   read it and is expected to come back unknown there. Either signal alone is
#   enough to fire.

set -euo pipefail

ORG="${TWO_GITHUB_ORG:-two-gaming}"
DEFAULT_BRANCH="main"
BOT_REPO="two-bot"
WEB_REPO="two-web"
DESIGN_REPO="two-design"

# The repo this watcher probes and files its issue against. Only one repo
# needs probing: the plan is an org-wide fact, so whichever repo answers tells
# us about all three. The runbook it prints covers all three.
WATCH_REPO="${TWO_WATCH_REPO:-$BOT_REPO}"

FILE_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --github-issue) FILE_ISSUE=1 ;;
    --runbook)      RUNBOOK_ONLY=1 ;;
    -h|--help)
      sed -n "2,$(($(grep -n '^set -euo pipefail' "${BASH_SOURCE[0]}" | head -1 | cut -d: -f1) - 1))p" "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '   \033[33mwarn\033[0m  %s\n' "$*"; }
act()  { printf '   \033[31mACT\033[0m   %s\n' "$*"; }

# The exact steps, kept here rather than in the issue tracker so that the
# alert carries its own instructions. Whoever reads the alert should not have
# to go and find TWO-85 to know what to do.
runbook() {
  cat <<'RUNBOOK'
Branch protection is available now. It is NOT on - GitHub stored nothing while
the org was on Free, so it has to be written again. Minutes, not a migration.

1. Apply it. The script is idempotent; it skips everything already done.

     cd /path/to/two-bot
     ./scripts/setup-github.sh

2. Prove it, with the acceptance flag NOT set. This is the check that fails if
   protection is still missing:

     unset TWO_ACCEPT_UNPROTECTED_MAIN
     ./scripts/setup-github.sh --verify

3. The one thing the script cannot check for itself, once per repo - that
   GitHub, not just the local hook, refuses a direct push:

     git commit --allow-empty -m 'protection check'
     git push origin main      # must be REJECTED by GitHub

   If that push succeeds, protection is not really on. Do not stop here.

4. CODEOWNERS starts routing reviews the moment the plan changes. It does
   nothing on Free. Check the review assignment on the next PR actually lands
   on the right owner.

5. two-web only, and BEFORE FORGE_PRODUCTION_DEPLOY_HOOK is ever set: give the
   `production` environment required reviewers. It has none today, so the
   release sign-off gate is decorative until it does.

Required checks are already written and correct - no need to rederive them:
  two-bot     check gitleaks
  two-web     tests static pest dusk budgets gitleaks
  two-design  tests gitleaks

Full reasoning: docs/GITHUB.md. Origin: TWO-85.
RUNBOOK
}

if [ "${RUNBOOK_ONLY:-0}" = 1 ]; then runbook; exit 0; fi

# A red X on a scheduled workflow is easy to scroll past, and the person who
# needs to act may not be the person watching Actions. So the alarm also lands
# as an issue on the repo, carrying the runbook with it.
#
# Filed once, not weekly: if the issue is already open, this is a no-op. Close
# the issue and the watcher will file it again next week if the work still has
# not been done - which is the behaviour you want from a reminder.
ISSUE_TITLE="Branch protection is available now - re-apply it (TWO-85)"

file_github_issue() {
  local existing
  if ! existing="$(gh issue list --repo "$ORG/$WATCH_REPO" --state open \
                     --search "in:title \"$ISSUE_TITLE\"" --json number --jq '.[0].number' 2>&1)"; then
    warn "could not search existing issues: $existing"
    warn "not filing, to avoid opening a duplicate every week."
    return 0
  fi

  if [ -n "$existing" ] && [ "$existing" != "null" ]; then
    ok "issue #$existing is already open for this - not filing another"
    return 0
  fi

  local body
  body="$(printf '%s\n\n---\n\nFiled automatically by `scripts/plan-watch.sh` (plan-watch.yml).\nProbe results: protection endpoint `%s`, org plan `%s`.\n' \
            "$(runbook)" "$PROTECTION" "$PLAN")"

  local created
  if created="$(gh issue create --repo "$ORG/$WATCH_REPO" \
                  --title "$ISSUE_TITLE" --body "$body" 2>&1)"; then
    ok "filed: $created"
  else
    warn "could not file the issue: $created"
    warn "the job still fails, so the alarm is not lost."
  fi
}

command -v gh >/dev/null || { echo "gh CLI not installed" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Probe 1: does the branch protection endpoint work on this repo?
#
# Classification is deliberately strict. "refused" - the quiet, nothing-to-do
# answer - is only returned for GitHub's literal upgrade message. Every other
# 403 is a token or permission problem and comes back unknown, because a
# permission 403 misread as a plan 403 is exactly how this watcher would go
# blind without anyone noticing.
probe_protection() {
  local out rc
  set +e
  out="$(gh api "repos/$ORG/$WATCH_REPO/branches/$DEFAULT_BRANCH/protection" 2>&1)"
  rc=$?
  set -e

  if [ $rc -eq 0 ]; then echo "protected"; return; fi

  case "$out" in
    *"Upgrade to GitHub"*)                 echo "refused" ;;
    *"Branch not protected"*)              echo "unprotected" ;;
    *"Resource not accessible by integration"*)
      echo "unknown:the token cannot read branch protection (needs administration: read)" ;;
    *"Must have admin rights"*)
      echo "unknown:the token lacks admin on $WATCH_REPO" ;;
    *"Branch not found"*)
      echo "unknown:$DEFAULT_BRANCH does not exist on $WATCH_REPO" ;;
    *"Not Found"*)
      echo "unknown:$ORG/$WATCH_REPO not visible to this token" ;;
    *) echo "unknown:unrecognised response: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)" ;;
  esac
}

# Probe 2: the org plan, read directly. Independent of probe 1 and gated on a
# different permission, so the two fail in different ways. GITHUB_TOKEN cannot
# read this and will return unknown - that is expected, not a fault.
probe_plan() {
  local plan
  if plan="$(gh api "orgs/$ORG" --jq '.plan.name // empty' 2>/dev/null)" && [ -n "$plan" ]; then
    echo "$plan"
  else
    echo "unknown"
  fi
}

say "Is branch protection available yet?"
ok "org: $ORG   repo probed: $WATCH_REPO"

PROTECTION="$(probe_protection)"
PLAN="$(probe_plan)"

case "$PROTECTION" in
  protected)   ok "branch protection endpoint: reachable, and $DEFAULT_BRANCH IS protected" ;;
  unprotected) act "branch protection endpoint: REACHABLE - GitHub is no longer refusing" ;;
  refused)     ok "branch protection endpoint: 403 upgrade-required - still the Free posture" ;;
  unknown:*)   warn "branch protection endpoint: could not tell - ${PROTECTION#unknown:}" ;;
esac

case "$PLAN" in
  unknown) warn "org plan: could not read it (expected for a repo-scoped GITHUB_TOKEN)" ;;
  free)    ok "org plan: free" ;;
  *)       act "org plan: $PLAN - no longer free" ;;
esac

# ---------------------------------------------------------------------------
# Decide. Fire if either probe says the day has come and nothing says
# protection is already on.
PLAN_UPGRADED=0
case "$PLAN" in unknown|free) ;; *) PLAN_UPGRADED=1 ;; esac

if [ "$PROTECTION" = protected ]; then
  say "Nothing to do"
  ok "$DEFAULT_BRANCH is protected. Run ./scripts/setup-github.sh --verify (with"
  ok "TWO_ACCEPT_UNPROTECTED_MAIN unset) to confirm the required checks match too."
  exit 0
fi

if [ "$PROTECTION" = unprotected ] || [ "$PLAN_UPGRADED" = 1 ]; then
  say "ACTION NEEDED - branch protection is possible and is not on"
  runbook
  if [ "$FILE_ISSUE" = 1 ]; then file_github_issue; fi
  exit 1
fi

if [ "$PROTECTION" = refused ]; then
  say "Nothing to do"
  ok "GitHub still refuses branch protection on a private repo in a Free org."
  ok "main stays guarded by .githooks/pre-push and main-guard.yml - detection,"
  ok "not prevention. This is the recorded TWO-81 choice, not a regression."
  exit 0
fi

say "Could not tell"
warn "Neither probe gave a usable answer, so this watcher is not currently"
warn "watching anything. That is the failure worth fixing: check GH_TOKEN and"
warn "its permissions. Exiting 0 because there is nothing to act on - but do"
warn "not read this as all-clear."
exit 0
