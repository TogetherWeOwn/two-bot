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
#   3  WATCHER BROKEN - the org or repo this watcher points at does not exist.
#                       Nothing is being watched. See "MISSING TARGET" below.
#
# An "I could not tell" outcome exits 0 with a loud warning, never silently.
# A watcher that reports all-clear when it is actually broken is worse than
# no watcher, so unknown is always spoken out loud but never treated as an
# alarm - a weekly red X nobody can act on gets muted, and then the real one
# gets muted with it.
#
# MISSING TARGET (TOG-131)
#
# The exception to that rule. "I could not tell because my token is thin" is
# expected weekly and must stay quiet. "I could not tell because the org I
# probe no longer exists" is neither expected nor fixable by waiting, and it
# used to land in the same quiet exit-0 bucket - green check, nobody watching.
# Those two are now separated, because only one of them has an action.
#
# Telling them apart needs care: GitHub answers 404, not 403, for a private
# resource a token cannot see, so a bare 404 on the protection endpoint is
# genuinely ambiguous. So existence is established with a SEPARATE pair of
# probes that need no privilege at all - `orgs/$ORG` and `repos/$ORG/$REPO`,
# reachable with metadata:read, which is the floor for any token that can run
# this script. A 404 from those is a structural fact, not a permission
# accident, and that is the only thing that exits 3.
#
# CREDENTIAL (rewritten 2026-08-25, TOG-313)
#   GH_TOKEN. A plain repo-scoped token - `contents: read` + `metadata: read`,
#   which the workflow GITHUB_TOKEN already has - is now enough to reach a
#   real verdict. It cannot read `branches/{b}/protection` (403 "Resource not
#   accessible by integration"), so probe 1 falls back to two endpoints that
#   are NOT gated on `administration`:
#
#     repos/{o}/{r}/branches/{b}  -> .protected   is protection enforced?
#     repos/{o}/{r}/rulesets      -> 200 vs 403   does the plan allow it?
#
#   Together those reconstruct the answer the admin-gated endpoint used to
#   give. See probe_protection_thin() for the truth table.
#
#   THIS REPLACES THE PREVIOUS DESIGN, WHICH HAD STOPPED WORKING. The header
#   here used to say the armed caller was the weekly Paperclip watcher
#   (TOG-313), minting a GitHub App token scoped
#   `organization_administration=read,administration=read,metadata=read` -
#   verified 2026-08-24. On 2026-08-25 the App token broker refuses both of
#   those outright: "Permission \"administration\" is not in this project's
#   profile (contents, pull_requests, issues, metadata, checks, statuses,
#   workflows)." No agent can mint them any more.
#
#   That mattered because the old failure was SILENT: with both probes
#   unreadable the script reported two unknowns and exited 0, and the armed
#   watcher's runbook read exit 0 as "still the Free posture, all clear". The
#   alarm was blind and green at the same time - precisely the failure mode
#   TOG-131 and TOG-307 were about.
#
#   Consequence worth noticing: because the surviving probes need no
#   privilege, this script no longer needs a credential that only Paperclip
#   can mint, and PLAN_WATCH_TOKEN is no longer required for it to be armed.
#   plan-watch.yml can therefore become the alarm rather than a self-test.
#   See the CREDENTIAL header in .github/workflows/plan-watch.yml, and
#   TOG-307 for why the App private key is not stored in Actions secrets -
#   that reasoning still stands, it is just no longer load-bearing.
#
#   The org-plan probe (probe 2) still needs an org-scoped token and is still
#   expected to come back unknown. It is now purely corroborating; probe 1
#   alone reaches a verdict.

set -euo pipefail

# All three repos were transferred to TogetherWeOwn; two-gaming is an empty
# org we keep only so its 301 redirects stay alive (TOG-131 decided that, and
# decided never to recreate a repo of the same name inside it).
#
# Do not point this back at two-gaming to "use the redirect". The redirect
# carries repos/two-gaming/two-bot, so probe 1 would keep working and look
# fine - but orgs/two-gaming resolves to the EMPTY org, whose plan is not ours
# and which we hold no admin on. Probe 2 would then read unknown forever and
# could never fire, which is half this watcher dead with a green check on it.
ORG="${TWO_GITHUB_ORG:-TogetherWeOwn}"
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
# Probe 1a: is protection actually ENFORCED on the default branch?
#
# `repos/{o}/{r}/branches/{b}` needs only contents+metadata read - no
# `administration` - and reports `.protected` as a plain boolean. That makes it
# the one probe here that keeps working under a thin token, which is why it is
# the fallback for probe 1 rather than a nice-to-have (TOG-313, 2026-08-25).
#
# On its own it cannot tell you WHY main is unprotected: `false` is the answer
# both when the plan forbids protection and when the plan allows it but nobody
# switched it on. probe_capability() is what separates those two.
probe_enforcement() {
  local out rc
  set +e
  out="$(gh api "repos/$ORG/$WATCH_REPO/branches/$DEFAULT_BRANCH" --jq '.protected' 2>&1)"
  rc=$?
  set -e

  if [ $rc -ne 0 ]; then echo "unknown"; return; fi
  case "$out" in
    true)  echo "protected" ;;
    false) echo "unprotected" ;;
    *)     echo "unknown" ;;
  esac
}

# Probe 1b: does this plan permit branch rules at all?
#
# Same trick, same thin token: `repos/{o}/{r}/rulesets` answers 200 (usually an
# empty array) on a plan that supports rules, and 403 with GitHub's literal
# upgrade message on Free-with-private. It is the capability half of the old
# `administration`-gated protection probe, obtained without `administration`.
#
# Strict in the same direction as probe 1: only the literal upgrade message
# counts as "refused". Anything else is unknown, so a permission failure can
# never be mistaken for a quiet all-clear.
probe_capability() {
  local out rc
  set +e
  out="$(gh api "repos/$ORG/$WATCH_REPO/rulesets" 2>&1)"
  rc=$?
  set -e

  if [ $rc -eq 0 ]; then echo "available"; return; fi
  case "$out" in
    *"Upgrade to GitHub"*) echo "refused" ;;
    *)                     echo "unknown" ;;
  esac
}

# Reconstruct probe 1's answer from the two thin-token probes.
#
# The truth table is the whole point, so it is written out rather than implied:
#
#   enforcement  capability   ->  verdict
#   protected    (any)            protected     someone did the work
#   unprotected  refused          refused       Free posture, nothing to do
#   unprotected  available        unprotected   ACTION NEEDED - this fires
#   unprotected  unknown          unknown       stay loud, do not guess
#   unknown      (any)            unknown
#
# Note the asymmetry: an unknown capability with main unprotected reports
# unknown rather than firing. Being unable to read the plan is not evidence
# that the plan changed, and a weekly alarm nobody can act on gets muted -
# taking the real one with it.
probe_protection_thin() {
  local enforcement capability
  enforcement="$(probe_enforcement)"
  capability="$(probe_capability)"

  case "$enforcement" in
    protected) echo "protected"; return ;;
    unknown)
      echo "unknown:the token can read neither branch protection nor $DEFAULT_BRANCH itself"
      return ;;
  esac

  case "$capability" in
    refused)   echo "refused" ;;
    available) echo "unprotected" ;;
    *)         echo "unknown:$DEFAULT_BRANCH is unprotected, but this token cannot tell whether the plan allows protection (rulesets unreadable)" ;;
  esac
}

# Probe 1: does the branch protection endpoint work on this repo?
#
# Classification is deliberately strict. "refused" - the quiet, nothing-to-do
# answer - is only returned for GitHub's literal upgrade message. Every other
# 403 is a token or permission problem and comes back unknown, because a
# permission 403 misread as a plan 403 is exactly how this watcher would go
# blind without anyone noticing.
#
# When the token cannot read the protection endpoint at all, we no longer stop
# at "unknown" - we reconstruct the same answer from probes 1a and 1b, which
# need no `administration`. That combination is what keeps the alarm alive
# under a repo-scoped token (TOG-313).
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
    *"Resource not accessible by integration"*|*"Must have admin rights"*)
      probe_protection_thin ;;
    *"Branch not found"*)
      echo "unknown:$DEFAULT_BRANCH does not exist on $WATCH_REPO" ;;
    # Deliberately still "unknown" and not "missing". A 404 here can mean the
    # token cannot see a private repo just as easily as it can mean the repo
    # is gone. probe_target_exists() is what decides that question, using
    # endpoints where a 404 is unambiguous.
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

# Probe 0: does the thing we are watching still exist at all?
#
# Runs before the other two, because if this fails their answers are noise.
# Both endpoints need only metadata:read - the floor for any token that gets
# this far - so unlike the protection endpoint, a 404 from here is a fact
# about the world and not about our credential. Prints one reason per line;
# empty output means the target is intact.
probe_target_exists() {
  local out

  if ! out="$(gh api "orgs/$ORG" 2>&1)"; then
    case "$out" in
      *"Not Found"*) echo "the org '$ORG' does not exist on GitHub" ;;
      # Anything else - rate limit, network, an outage - is not evidence of
      # absence, and must not trip the alarm.
      *) ;;
    esac
  fi

  if ! out="$(gh api "repos/$ORG/$WATCH_REPO" 2>&1)"; then
    case "$out" in
      *"Not Found"*) echo "the repo '$ORG/$WATCH_REPO' does not exist, or this token cannot see it at all" ;;
      *) ;;
    esac
  fi
}

say "Is branch protection available yet?"
ok "org: $ORG   repo probed: $WATCH_REPO"

MISSING="$(probe_target_exists)"
if [ -n "$MISSING" ]; then
  say "WATCHER BROKEN - it is not pointed at anything"
  while IFS= read -r reason; do act "$reason"; done <<<"$MISSING"
  echo
  warn "This is not the quiet 'could not tell' case. The other two probes are"
  warn "not being run, because against a target that is not there they would"
  warn "return 'unknown' and this job would go green while watching nothing."
  echo
  warn "Branch protection on the real repos is therefore UNWATCHED as of now."
  warn "Fix by pointing the watcher at the right place, then re-run:"
  warn "    TWO_GITHUB_ORG=<org> TWO_WATCH_REPO=<repo> ./scripts/plan-watch.sh"
  warn "and make that the new default in this script. Origin: TWO-85, TOG-131."
  exit 3
fi

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
warn "watching anything. That is the failure worth fixing. Exiting 0 because"
warn "there is nothing to act on - but do NOT read this as all-clear."
warn ""
warn "$ORG/$WATCH_REPO does exist - probe 0 confirmed that - so this is a"
warn "credential problem, not a moved-or-deleted target."
warn ""
warn "Reaching here now means something narrower than it used to. Probe 1's"
warn "fallback needs only contents+metadata read, so a token that cannot"
warn "answer it cannot read the repo at all. Check GH_TOKEN is set and not"
warn "expired before assuming a permissions problem. Do NOT go looking for"
warn "PLAN_WATCH_TOKEN or an administration-scoped token: this script no"
warn "longer uses either, and no agent can mint them (TOG-313)."
exit 0
