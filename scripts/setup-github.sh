#!/usr/bin/env bash
#
# One-shot setup for the two-gaming GitHub org: repos, history, branch
# protection, secret scanning.
#
# Safe to re-run. Every step checks the current state first and skips or
# updates rather than failing, so if it stops half way you fix the cause and
# run it again.
#
#   ./scripts/setup-github.sh                 # do it
#   ./scripts/setup-github.sh --dry-run       # print what it would do
#   ./scripts/setup-github.sh --verify        # only check the end state
#
# Needs: gh CLI, authenticated as a user with `admin:org` and `repo` on the
# two-gaming org. See docs/GITHUB.md.

set -euo pipefail

ORG="${TWO_GITHUB_ORG:-two-gaming}"
BOT_REPO="two-bot"
WEB_REPO="two-web"
DEFAULT_BRANCH="main"

# Required status check contexts, per repo.
#
# These are GitHub JOB names - the `jobs.<id>` key in a workflow file, or that
# job's `name:` if it sets one. They are NOT workflow names. A context that
# matches nothing leaves the PR waiting forever on a check that never arrives,
# which reads as a hang rather than a misconfiguration.
#
#   two-bot   ci.yml          -> job `check`
#             secret-scan.yml -> job `gitleaks`   (workflow is named secret-scan,
#                                                  the job is not)
#   two-web   ci.yml          -> jobs `static` `tests` `dusk` `budgets` `ci`
#             secret-scan.yml -> job `gitleaks`
#
# Every leaf job is listed, not just the `ci` aggregate. A job that is *skipped*
# counts as PASSED for branch protection, and an aggregate declared with plain
# `needs:` is skipped - not failed - when something it needs goes red. Requiring
# only the aggregate would therefore let a red PR merge. Requiring the leaves
# closes that hole; requiring the aggregate as well means a future job added to
# its `needs:` list is covered without touching protection.
BOT_CHECKS=(check gitleaks)
WEB_CHECKS=(ci tests static dusk budgets gitleaks)

# Where each repo's working copy is. Override if yours are elsewhere.
BOT_PATH="${TWO_BOT_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WEB_PATH="${TWO_WEB_PATH:-}"

DRY_RUN=0
VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --verify)  VERIFY_ONLY=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m    %s\n' "$*"; }
skip() { printf '   \033[90mskip\033[0m  %s\n' "$*"; }
warn() { printf '   \033[33mwarn\033[0m  %s\n' "$*"; }
bad()  { printf '   \033[31mFAIL\033[0m  %s\n' "$*"; }

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '   \033[90mwould run:\033[0m %s\n' "$*"; return 0; fi
  "$@"
}

FAILED=0
ADVISORY_MAIN=0

# ---------------------------------------------------------------------------
say "Preflight"

command -v gh >/dev/null || { bad "gh CLI not installed"; exit 1; }
gh auth status >/dev/null 2>&1 || {
  bad "gh is not authenticated. Run: gh auth login --scopes 'repo,admin:org,workflow'"
  exit 1
}
ok "gh authenticated as $(gh api user --jq .login)"

gh api "orgs/$ORG" >/dev/null 2>&1 || {
  bad "org '$ORG' not reachable. Either it does not exist yet, or this account is not a member."
  bad "This is the TWO-21 blocker. Stop here."
  exit 1
}
ok "org '$ORG' reachable"

# Plan matters: on GitHub Free, branch protection and rulesets are enforced on
# PUBLIC repos only. Our repos must stay private until the launch hardening
# pass, so a free org cannot give us a main that actually rejects a push.
PLAN="$(gh api "orgs/$ORG" --jq '.plan.name // "unknown"' 2>/dev/null || echo unknown)"
ok "org plan: $PLAN"
PROTECTION_AVAILABLE=1
case "$PLAN" in
  free)
    PROTECTION_AVAILABLE=0
    warn "GitHub Free: branch protection on PRIVATE repos is not enforced."
    warn "Protection will be written but GitHub will ignore it until the org is"
    warn "on Team (\$4/user/month) or the repos go public. See docs/GITHUB.md."
    warn ""
    warn "Plan B applies instead: the .githooks/pre-push hook refuses a direct"
    warn "push locally, and .github/workflows/main-guard.yml reports one loudly"
    warn "after the fact. Together that is a speed bump and an alarm, not a lock."
    if [ "${TWO_ACCEPT_UNPROTECTED_MAIN:-0}" != "1" ]; then
      warn ""
      warn "Set TWO_ACCEPT_UNPROTECTED_MAIN=1 to say out loud that this is the"
      warn "accepted posture. Without it --verify will fail, on purpose: an"
      warn "unguarded main should never become true by default."
    fi
    ;;
  *) ok "plan supports branch protection on private repos" ;;
esac

# ---------------------------------------------------------------------------
# repo_exists <name>
repo_exists() { gh api "repos/$ORG/$1" >/dev/null 2>&1; }

# create_repo <name> - private, no auto-init (we push real history into it)
create_repo() {
  local name="$1"
  if repo_exists "$name"; then
    skip "$ORG/$name already exists"
  else
    run gh api --method POST "orgs/$ORG/repos" \
      -f "name=$name" \
      -F "private=true" \
      -F "has_issues=false" \
      -F "has_wiki=false" \
      -F "has_projects=false" \
      -F "auto_init=false" \
      -F "allow_squash_merge=true" \
      -F "allow_merge_commit=true" \
      -F "allow_rebase_merge=false" \
      -F "delete_branch_on_merge=true" >/dev/null
    ok "created $ORG/$name (private)"
  fi

  # Private, always. Never flip this until TWO-35 has cleared history.
  local vis
  vis="$(gh api "repos/$ORG/$name" --jq .private 2>/dev/null || echo true)"
  if [ "$vis" != "true" ]; then
    bad "$ORG/$name is PUBLIC. It must be private until TWO-35 clears secrets and history."
    FAILED=1
  fi
}

# push_history <local-path> <repo-name>
# Pushes the full history. Never force, never squash - if the remote already
# has commits we do not own, this stops rather than overwriting them.
push_history() {
  local path="$1" name="$2"
  if [ -z "$path" ] || [ ! -d "$path/.git" ]; then
    warn "no git repo at '${path:-<unset>}' - skipping push for $name"
    return 0
  fi

  local url="git@github.com:$ORG/$name.git"
  local current
  current="$(git -C "$path" remote get-url origin 2>/dev/null || true)"
  if [ -z "$current" ]; then
    run git -C "$path" remote add origin "$url"
    ok "$name: added origin -> $url"
  elif [ "$current" != "$url" ]; then
    run git -C "$path" remote set-url origin "$url"
    ok "$name: origin re-pointed $current -> $url"
  else
    skip "$name: origin already $url"
  fi

  # Default branch must be `main`. CI triggers on `main`; a repo left on
  # `master` silently runs no push-CI at all.
  local branch
  branch="$(git -C "$path" symbolic-ref --short HEAD)"
  if [ "$branch" != "$DEFAULT_BRANCH" ]; then
    run git -C "$path" branch -m "$branch" "$DEFAULT_BRANCH"
    ok "$name: renamed $branch -> $DEFAULT_BRANCH"
  fi

  # Hooks live in .githooks/ so they are versioned; git only looks there if
  # told to. Do it here so the first clone of each repo is already guarded.
  if [ -d "$path/.githooks" ]; then
    run git -C "$path" config core.hooksPath .githooks
    run chmod +x "$path/.githooks/pre-push" "$path/.githooks/pre-commit"
    ok "$name: local hooks active (core.hooksPath=.githooks)"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    printf '   \033[90mwould run:\033[0m git -C %s push -u origin %s (full history, %s commits)\n' \
      "$path" "$DEFAULT_BRANCH" "$(git -C "$path" rev-list --count HEAD)"
  else
    # --force is deliberately absent.
    git -C "$path" push -u origin "$DEFAULT_BRANCH"
    ok "$name: pushed $(git -C "$path" rev-list --count HEAD) commits with full history"
  fi
}

# protect <repo-name> <required-check...>
# Classic branch protection: it is the API that reports its own effect
# honestly, which matters because on a free org the call succeeds and the
# rule does nothing.
protect() {
  local name="$1"; shift
  local checks=("$@")

  local contexts_json
  contexts_json="$(printf '%s\n' "${checks[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')"

  local payload
  payload="$(python3 - "$contexts_json" <<'PY'
import json, sys
contexts = json.loads(sys.argv[1])
print(json.dumps({
    "required_status_checks": {"strict": True, "contexts": contexts},
    # No admin bypass. If it does not apply to me it is not a rule.
    "enforce_admins": True,
    "required_pull_request_reviews": {
        "required_approving_review_count": 1,
        # The whole point: you cannot approve your own work.
        "require_last_push_approval": True,
        "dismiss_stale_reviews": True,
        "require_code_owner_reviews": True,
    },
    "restrictions": None,
    "allow_force_pushes": False,
    "allow_deletions": False,
    "required_linear_history": False,
    "required_conversation_resolution": True,
}))
PY
)"

  if [ "$DRY_RUN" = 1 ]; then
    printf '   \033[90mwould protect\033[0m %s/%s:%s with checks %s\n' "$ORG" "$name" "$DEFAULT_BRANCH" "${checks[*]}"
    return 0
  fi

  if printf '%s' "$payload" | gh api --method PUT \
      "repos/$ORG/$name/branches/$DEFAULT_BRANCH/protection" --input - >/dev/null 2>&1; then
    ok "$name: protection written on $DEFAULT_BRANCH (PR required, CI ${checks[*]}, no self-approval, no force-push)"
  else
    bad "$name: could not write branch protection"
    [ "$PROTECTION_AVAILABLE" = 0 ] && bad "  most likely cause: private repo on a Free org"
    FAILED=1
  fi
}

# secret_protection <repo-name>
secret_protection() {
  local name="$1"
  if [ "$DRY_RUN" = 1 ]; then
    printf '   \033[90mwould enable\033[0m secret scanning + push protection on %s\n' "$name"
    return 0
  fi
  if gh api --method PATCH "repos/$ORG/$name" \
      -F 'security_and_analysis[secret_scanning][status]=enabled' \
      -F 'security_and_analysis[secret_scanning_push_protection][status]=enabled' \
      >/dev/null 2>&1; then
    ok "$name: GitHub secret scanning + push protection enabled"
  else
    warn "$name: GitHub-native secret scanning unavailable (paid add-on on private repos)."
    warn "  The gitleaks job in .github/workflows/secret-scan.yml covers this for free."
  fi
}

# deploy_environment <repo-name>
# A GitHub `production` environment with a human reviewer gate. TWO-22's deploy
# job targets it; the job stays inert until TWO-37 is approved and the Forge
# hook secrets exist, so creating the environment early costs nothing and means
# the gate is already there the day deploys turn on.
#
# Reviewers cannot be set here: they are org account/team IDs I do not have
# until the org exists. The environment is created WITHOUT them and --verify
# says so loudly, because an environment with no reviewers is a gate that looks
# shut and is not.
deploy_environment() {
  local name="$1"
  if [ "$DRY_RUN" = 1 ]; then
    printf '   \033[90mwould create\033[0m `production` environment on %s (prevent_self_review)\n' "$name"
    return 0
  fi
  if gh api --method PUT "repos/$ORG/$name/environments/production" \
      -F 'prevent_self_review=true' -F 'wait_timer=0' >/dev/null 2>&1; then
    ok "$name: \`production\` environment exists, self-review prevented"
  else
    warn "$name: could not create the \`production\` environment"
    warn "  Environments on private repos need GitHub Team or above - same plan question as protection."
  fi
}

# ---------------------------------------------------------------------------
if [ "$VERIFY_ONLY" = 0 ]; then
  say "Repositories"
  create_repo "$BOT_REPO"
  create_repo "$WEB_REPO"

  say "History"
  push_history "$BOT_PATH" "$BOT_REPO"
  if [ -n "$WEB_PATH" ]; then
    push_history "$WEB_PATH" "$WEB_REPO"
  else
    warn "TWO_WEB_PATH unset - the Web Lead pushes two-web themselves. See docs/GITHUB.md."
  fi

  say "Branch protection on $DEFAULT_BRANCH"
  protect "$BOT_REPO" "${BOT_CHECKS[@]}"
  protect "$WEB_REPO" "${WEB_CHECKS[@]}"

  say "Secret scanning"
  secret_protection "$BOT_REPO"
  secret_protection "$WEB_REPO"

  say "Deploy environment"
  deploy_environment "$WEB_REPO"
fi

# ---------------------------------------------------------------------------
say "Verify"

verify_repo() {
  local name="$1"; shift
  local expected=("$@")
  if ! repo_exists "$name"; then bad "$name: does not exist"; FAILED=1; return; fi

  local priv; priv="$(gh api "repos/$ORG/$name" --jq .private)"
  [ "$priv" = "true" ] && ok "$name: private" || { bad "$name: PUBLIC - must be private until TWO-35"; FAILED=1; }

  local db; db="$(gh api "repos/$ORG/$name" --jq .default_branch)"
  [ "$db" = "$DEFAULT_BRANCH" ] && ok "$name: default branch is $db" || { bad "$name: default branch is '$db', expected $DEFAULT_BRANCH"; FAILED=1; }

  local p
  if p="$(gh api "repos/$ORG/$name/branches/$DEFAULT_BRANCH/protection" 2>/dev/null)"; then
    local pr checks admins selfapp
    pr="$(printf '%s' "$p"      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("required_pull_request_reviews",{}).get("required_approving_review_count",0))')"
    selfapp="$(printf '%s' "$p" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("required_pull_request_reviews",{}).get("require_last_push_approval",False))')"
    checks="$(printf '%s' "$p"  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(d.get("required_status_checks",{}).get("contexts",[])) or "NONE")')"
    admins="$(printf '%s' "$p"  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("enforce_admins",{}).get("enabled",False))')"

    local stale
    stale="$(printf '%s' "$p"   | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("required_pull_request_reviews",{}).get("dismiss_stale_reviews",False))')"

    [ "$pr" -ge 1 ]           && ok "$name: PR review required ($pr approval)"        || { bad "$name: no review required"; FAILED=1; }
    [ "$selfapp" = "True" ]   && ok "$name: self-approval blocked"                    || { bad "$name: self-approval NOT blocked"; FAILED=1; }
    [ "$stale" = "True" ]     && ok "$name: stale approvals dismissed on new commits" || { bad "$name: stale approvals survive a force-push"; FAILED=1; }
    [ "$checks" != "NONE" ]   && ok "$name: CI required ($checks)"                    || { bad "$name: no required status checks - a red PR can merge"; FAILED=1; }
    [ "$admins" = "True" ]    && ok "$name: admins included, no bypass"               || { bad "$name: admins can bypass"; FAILED=1; }

    # Every expected context must actually be required. A check silently
    # dropped from the list is the failure mode nobody notices: CI still runs
    # and still goes red, and the PR merges anyway.
    local want
    for want in "${expected[@]}"; do
      case ",$checks," in
        *",$want,"*) : ;;
        *) bad "$name: required check '$want' is NOT in the protection rule"; FAILED=1 ;;
      esac
    done
  elif [ "$PROTECTION_AVAILABLE" = 0 ]; then
    # Expected on a free org with a private repo. Report it as what it is, and
    # then check that Plan B is actually in place rather than assumed.
    warn "$name: main is NOT enforced by GitHub (free plan, private repo)"
    ADVISORY_MAIN=1

    if gh api "repos/$ORG/$name/contents/.github/workflows/main-guard.yml" >/dev/null 2>&1; then
      ok "$name: main-guard workflow present - a direct push gets reported"
    else
      bad "$name: main-guard.yml MISSING. Nothing would notice a direct push at all."
      FAILED=1
    fi

    if [ "${TWO_ACCEPT_UNPROTECTED_MAIN:-0}" != "1" ]; then
      bad "$name: unguarded main is not an accepted state."
      bad "  Either put the org on GitHub Team, or re-run with"
      bad "  TWO_ACCEPT_UNPROTECTED_MAIN=1 to record that this is a deliberate choice."
      FAILED=1
    fi
  else
    bad "$name: NO branch protection on $DEFAULT_BRANCH - direct pushes are allowed"
    FAILED=1
  fi

  for f in .github/CODEOWNERS CONTRIBUTING.md README.md .env.example .gitignore; do
    if gh api "repos/$ORG/$name/contents/$f" >/dev/null 2>&1; then ok "$name: $f present"
    else bad "$name: $f MISSING"; FAILED=1; fi
  done

  # A committed .env is the one thing that must never be true.
  if gh api "repos/$ORG/$name/contents/.env" >/dev/null 2>&1; then
    bad "$name: .env IS COMMITTED. Rotate every value in it, then remove it from history."
    FAILED=1
  else
    ok "$name: no .env committed"
  fi
}

verify_repo "$BOT_REPO" "${BOT_CHECKS[@]}"
verify_repo "$WEB_REPO" "${WEB_CHECKS[@]}"

# The production deploy gate. Warn, do not fail: deploys are TWO-37 and not
# approved yet, and both deploy jobs skip green while their hook secret is
# unset, so there is nothing to gate today.
if env_json="$(gh api "repos/$ORG/$WEB_REPO/environments/production" 2>/dev/null)"; then
  reviewers="$(printf '%s' "$env_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(len(r.get("reviewers",[])) for r in d.get("protection_rules",[]) if r.get("type")=="required_reviewers"))' 2>/dev/null || echo 0)"
  if [ "${reviewers:-0}" -gt 0 ]; then
    ok "$WEB_REPO: production environment has $reviewers required reviewer(s)"
  else
    warn "$WEB_REPO: production environment has NO required reviewers."
    warn "  Harmless while FORGE_PRODUCTION_DEPLOY_HOOK is unset (the deploy job skips green)."
    warn "  Add reviewers in Settings -> Environments -> production BEFORE that secret exists,"
    warn "  or the release sign-off gate is decorative."
  fi
else
  skip "$WEB_REPO: no production environment yet (created on the next non-verify run)"
fi

echo
if [ "$FAILED" = 0 ] && [ "$ADVISORY_MAIN" = 1 ]; then
  say "Passed, with main guarded by convention only"
  echo "   The org is on GitHub Free and the repos are private, so GitHub enforces"
  echo "   nothing on $DEFAULT_BRANCH. What is actually protecting it:"
  echo "     - .githooks/pre-push refuses a direct push, in each clone that installed it"
  echo "     - main-guard.yml turns a direct push into a red X within a minute"
  echo "     - CI and gitleaks still run on every PR and on $DEFAULT_BRANCH"
  echo
  echo "   Prove the hook works, once, per clone:"
  echo "     git -C $BOT_PATH commit --allow-empty -m 'hook check'"
  echo "     git -C $BOT_PATH push origin $DEFAULT_BRANCH   # must be REFUSED locally"
  echo
  echo "   This becomes real protection the day the org moves to GitHub Team."
  exit 0
elif [ "$FAILED" = 0 ]; then
  say "All checks passed"
  echo "   Last step is manual and cannot be skipped - prove it actually blocks:"
  echo "     git -C $BOT_PATH push origin $DEFAULT_BRANCH   # must be REJECTED"
  exit 0
else
  say "Some checks FAILED (see above)"
  exit 1
fi
