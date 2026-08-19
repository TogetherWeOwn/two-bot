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
DESIGN_REPO="two-design"
DEFAULT_BRANCH="main"

# Required status check contexts, per repo.
#
# These are GitHub JOB names - the `jobs.<id>` key in a workflow file, or that
# job's `name:` if it sets one. They are NOT workflow names. A context that
# matches nothing leaves the PR waiting forever on a check that never arrives,
# which reads as a hang rather than a misconfiguration.
#
#   two-bot    ci.yml          -> job `check`
#              secret-scan.yml -> job `gitleaks`  (workflow is named secret-scan,
#                                                  the job is not)
#   two-web    ci.yml          -> jobs `static` `pest` `dusk` `budgets`, and the
#                                aggregate `tests` that needs the other four
#              secret-scan.yml -> job `gitleaks`
#   two-design ci.yml          -> job `tests`     (QA, TWO-22)
#              secret-scan.yml -> job `gitleaks`
#
# `ci` is the WORKFLOW name in two-web, not a job. It is deliberately absent
# here. GitHub is asymmetric in both directions and only one of the two is
# obvious:
#   - a *skipped* required check counts as PASSED, so a naively-declared
#     aggregate lets a red PR merge;
#   - an *absent* required check blocks the PR forever with no error anywhere.
# Requiring `ci` would have made two-web's main unmergeable from the moment
# protection went on, presenting as slow CI rather than as a broken rule.
# (QA, TWO-36 / TWO-22.)
#
# Every leaf job is listed as well as the aggregate. two-web's `tests` does
# carry `if: always()` with a guard covering failure, cancelled AND skipped, so
# the aggregate alone would be sound - but naming the leaves means protection
# does not depend on that guard staying correct. The cost is that this list has
# to be updated when a job is added or renamed; verify_check_jobs below fails
# on a required check that matches no job, and warns on a job that reports but
# is not required, so the drift is caught rather than discovered.
BOT_CHECKS=(check gitleaks)
WEB_CHECKS=(tests static pest dusk budgets gitleaks)
DESIGN_CHECKS=(tests gitleaks)

# Files every repo must have on the default branch before we call it set up.
# Per repo, because they genuinely differ: two-design has no runtime and no
# configuration, so demanding a .env.example there would be asking for an empty
# file whose only purpose is to satisfy this list.
BOT_FILES=(.github/CODEOWNERS CONTRIBUTING.md README.md .env.example .gitignore)
WEB_FILES=(.github/CODEOWNERS CONTRIBUTING.md README.md .env.example .gitignore)
DESIGN_FILES=(.github/CODEOWNERS CONTRIBUTING.md README.md .gitignore)

# Teams.
#
# CODEOWNERS in both repos addresses `@two-gaming/<slug>`, never an individual,
# so a review request never dies because one account is asleep. That only works
# if the team is really there.
#
# The failure mode is the quiet one: a CODEOWNERS rule naming a team that does
# not exist is NOT an error. GitHub drops the rule, the settings page shows
# nothing wrong, and reviews simply stop being requested while everybody assumes
# the routing works. Same outcome if the team exists but has no write access to
# the repo, or has no members. All three are checked in Verify.
#
# slug|display name|description
TEAMS=(
  "founding-engineer|Founding Engineer|Bot, deploy, secrets and privacy posture"
  "web-lead|Web Lead|Laravel application: backend, schema, policies, routes"
  "frontend|Frontend|Blade views, JS, CSS, asset build"
  "qa|QA|Tests and CI across all three repos"
  "design|Design|Design tokens, brand assets, accessibility"
)

# Which team gets write on which repo. Write is also what makes a team eligible
# to be a code owner there - a team with read cannot own a path.
#
# Derived from the three CODEOWNERS files, not invented here. `frontend` is
# absent from two-bot's CODEOWNERS, so it gets no access to two-bot. Verify
# reads the committed files and will fail if this table has drifted from them.
#
# slug|repo
TEAM_REPOS=(
  "founding-engineer|$BOT_REPO"
  "qa|$BOT_REPO"
  "web-lead|$BOT_REPO"
  "founding-engineer|$WEB_REPO"
  "web-lead|$WEB_REPO"
  "frontend|$WEB_REPO"
  "qa|$WEB_REPO"
  "design|$DESIGN_REPO"
  "frontend|$DESIGN_REPO"
  "qa|$DESIGN_REPO"
  "founding-engineer|$DESIGN_REPO"
)

# Where each repo's working copy is. Override if yours are elsewhere.
BOT_PATH="${TWO_BOT_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WEB_PATH="${TWO_WEB_PATH:-}"
# two-design sits next to two-bot in the shared workspace. Guess that, so the
# common case needs no environment variable; an explicit TWO_DESIGN_PATH wins.
DESIGN_PATH="${TWO_DESIGN_PATH:-}"
if [ -z "$DESIGN_PATH" ] && [ -d "$(dirname "$BOT_PATH")/$DESIGN_REPO/.git" ]; then
  DESIGN_PATH="$(dirname "$BOT_PATH")/$DESIGN_REPO"
fi

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
# create_team <slug> <display name> <description>
create_team() {
  local slug="$1" tname="$2" tdesc="$3"

  if gh api "orgs/$ORG/teams/$slug" >/dev/null 2>&1; then
    skip "team @$ORG/$slug already exists"
    return 0
  fi

  if [ "$DRY_RUN" = 1 ]; then
    printf '   \033[90mwould create\033[0m team @%s/%s ("%s")\n' "$ORG" "$slug" "$tname"
    return 0
  fi

  local got
  if ! got="$(gh api --method POST "orgs/$ORG/teams" \
      -f "name=$tname" -f "description=$tdesc" -f "privacy=closed" \
      --jq .slug 2>/dev/null)"; then
    bad "could not create team '$slug' - the token needs admin:org on $ORG"
    FAILED=1
    return 0
  fi

  # GitHub derives the slug from the display name. If it derived something else,
  # every CODEOWNERS rule pointing at the expected slug is dead on arrival, so
  # say it now rather than letting reviews quietly stop routing.
  if [ "$got" != "$slug" ]; then
    bad "team created as '@$ORG/$got' but CODEOWNERS says '@$ORG/$slug'."
    bad "  Rename the team so the slug matches, or that rule does nothing."
    FAILED=1
    return 0
  fi

  ok "created team @$ORG/$slug"
}

# grant_team_repo <slug> <repo> - write access
grant_team_repo() {
  local slug="$1" name="$2"
  if [ "$DRY_RUN" = 1 ]; then
    printf '   \033[90mwould grant\033[0m @%s/%s write on %s/%s\n' "$ORG" "$slug" "$ORG" "$name"
    return 0
  fi
  if gh api --method PUT "orgs/$ORG/teams/$slug/repos/$ORG/$name" \
      -f permission=push >/dev/null 2>&1; then
    ok "@$ORG/$slug: write on $name"
  else
    bad "@$ORG/$slug: could not grant write on $name"
    FAILED=1
  fi
}

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

# push_extra_branches <local-path> <repo-name>
#
# Any local branch that is not `main`. Unmerged work that only exists in one
# working copy is one lost directory away from gone, and the whole reason for
# this issue is that we have work sitting in exactly that state - two-design's
# CI gates live on `ci/design-gates` and nowhere else.
#
# Pushing them is also how the first pull request happens: the branch is up,
# protection is on, somebody opens a PR, and the rule gets proved by a real
# merge rather than by reading a settings page.
push_extra_branches() {
  local path="$1" name="$2" b
  [ -n "$path" ] && [ -d "$path/.git" ] || return 0

  local branches
  branches="$(git -C "$path" for-each-ref --format='%(refname:short)' refs/heads/ \
              | grep -vx "$DEFAULT_BRANCH" || true)"
  [ -n "$branches" ] || { skip "$name: no branches other than $DEFAULT_BRANCH"; return 0; }

  while read -r b; do
    [ -n "$b" ] || continue
    # Already merged into main - the ref is history, not work. Pushing it would
    # put a dead branch in the repo on day one.
    if git -C "$path" merge-base --is-ancestor "$b" "$DEFAULT_BRANCH" 2>/dev/null; then
      skip "$name: branch $b is already in $DEFAULT_BRANCH"
      continue
    fi
    if [ "$DRY_RUN" = 1 ]; then
      printf '   \033[90mwould run:\033[0m git -C %s push -u origin %s\n' "$path" "$b"
    else
      git -C "$path" push -u origin "$b"
      ok "$name: pushed branch $b"
    fi
  done <<< "$branches"
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
  say "Teams"
  for _entry in "${TEAMS[@]}"; do
    IFS='|' read -r _slug _tname _tdesc <<< "$_entry"
    create_team "$_slug" "$_tname" "$_tdesc"
  done
  warn "Members are added by the org owner in Settings -> Teams. An empty team"
  warn "routes reviews to nobody, which looks exactly like routing working."

  say "Repositories"
  create_repo "$BOT_REPO"
  create_repo "$WEB_REPO"
  create_repo "$DESIGN_REPO"

  say "Repository access"
  for _entry in "${TEAM_REPOS[@]}"; do
    IFS='|' read -r _slug _rname <<< "$_entry"
    grant_team_repo "$_slug" "$_rname"
  done

  say "History"
  push_history "$BOT_PATH" "$BOT_REPO"
  push_extra_branches "$BOT_PATH" "$BOT_REPO"
  if [ -n "$WEB_PATH" ]; then
    push_history "$WEB_PATH" "$WEB_REPO"
    push_extra_branches "$WEB_PATH" "$WEB_REPO"
  else
    warn "TWO_WEB_PATH unset - the Web Lead pushes two-web themselves. See docs/GITHUB.md."
  fi
  if [ -n "$DESIGN_PATH" ]; then
    push_history "$DESIGN_PATH" "$DESIGN_REPO"
    push_extra_branches "$DESIGN_PATH" "$DESIGN_REPO"
  else
    warn "TWO_DESIGN_PATH unset and no two-design next to two-bot - skipping its history."
  fi

  say "Branch protection on $DEFAULT_BRANCH"
  protect "$BOT_REPO" "${BOT_CHECKS[@]}"
  protect "$WEB_REPO" "${WEB_CHECKS[@]}"
  protect "$DESIGN_REPO" "${DESIGN_CHECKS[@]}"

  say "Secret scanning"
  secret_protection "$BOT_REPO"
  secret_protection "$WEB_REPO"
  secret_protection "$DESIGN_REPO"

  say "Deploy environment"
  deploy_environment "$WEB_REPO"
fi

# ---------------------------------------------------------------------------
say "Verify"

# Teams exist and have somebody in them.
verify_teams() {
  local entry slug n
  for entry in "${TEAMS[@]}"; do
    slug="${entry%%|*}"
    if ! gh api "orgs/$ORG/teams/$slug" >/dev/null 2>&1; then
      bad "team @$ORG/$slug does not exist - every CODEOWNERS rule naming it is silently ignored"
      FAILED=1
      continue
    fi
    n="$(gh api "orgs/$ORG/teams/$slug/members" --jq 'length' 2>/dev/null || echo 0)"
    if [ "${n:-0}" -gt 0 ]; then
      ok "team @$ORG/$slug exists, $n member(s)"
    else
      warn "team @$ORG/$slug exists but is EMPTY - a review request to it reaches nobody"
    fi
  done
}

# verify_codeowners <repo>
#
# Reads the CODEOWNERS actually committed in the repo - not the table above -
# and checks every @org/team it names exists and has write there. The file is
# edited in the repo by whoever owns it, so a new handle can appear at any time
# and GitHub will never once complain about it being wrong.
verify_codeowners() {
  local name="$1" body handles slug perm
  if ! body="$(gh api "repos/$ORG/$name/contents/.github/CODEOWNERS" \
        -H 'Accept: application/vnd.github.raw' 2>/dev/null)"; then
    return 0   # the file being missing is already reported by verify_repo
  fi

  # The file arrives as argv, not stdin: the heredoc below IS stdin, and piping
  # the body in as well would silently give python an empty read.
  handles="$(python3 - "$ORG" "$body" <<'PY'
import re, sys
org, text = sys.argv[1].lower(), sys.argv[2]
seen = []
for line in text.splitlines():
    line = line.split('#', 1)[0]
    for owner, team in re.findall(r'@([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)', line):
        if owner.lower() == org and team.lower() not in seen:
            seen.append(team.lower())
print('\n'.join(seen))
PY
)"

  if [ -z "$handles" ]; then
    warn "$name: CODEOWNERS names no @$ORG/<team> handles at all"
    return 0
  fi

  while read -r slug; do
    [ -n "$slug" ] || continue
    if ! gh api "orgs/$ORG/teams/$slug" >/dev/null 2>&1; then
      bad "$name: CODEOWNERS names @$ORG/$slug, which does not exist - that rule is silently ignored"
      FAILED=1
      continue
    fi
    perm="$(gh api "orgs/$ORG/teams/$slug/repos/$ORG/$name" \
              -H 'Accept: application/vnd.github.v3.repository+json' \
              --jq '.permissions | if .admin then "admin" elif .maintain then "maintain" elif .push then "write" else "read" end' \
              2>/dev/null || echo none)"
    case "$perm" in
      write|maintain|admin) ok "$name: code owner @$ORG/$slug has $perm" ;;
      *) bad "$name: @$ORG/$slug owns paths but has '$perm' on the repo - a team without write cannot be a code owner, so the rule does nothing"
         FAILED=1 ;;
    esac
  done <<< "$handles"

  if [ "$PROTECTION_AVAILABLE" = 0 ]; then
    warn "$name: on GitHub Free with a private repo, CODEOWNERS does not route"
    warn "  reviews at all - the file is documentation until the org is on Team."
  fi
}

# verify_repo <name> "<required check...>" "<required file...>"
#
# Both lists arrive as space-separated strings rather than as arrays, because
# the required files differ per repo and bash cannot pass two arrays.
verify_repo() {
  local name="$1"
  # shellcheck disable=SC2206
  local expected=($2)
  # shellcheck disable=SC2206
  local files=($3)
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

  for f in "${files[@]}"; do
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

# verify_check_jobs <repo> <required-check...>
#
# A required status check is matched by name against a check that actually
# reports. If nothing ever reports that name, the PR does not fail - it sits
# there forever saying "Expected", which reads as a slow CI rather than as a
# rule pointing at nothing. Nobody debugs it for the first hour.
#
# So: read the workflow files on the default branch and work out what each job
# will actually report as - its `name:` if it sets one, otherwise its job id -
# and require every protected context to be one of those. This is a hard
# failure when the workflows parsed, because the alternative is a repo whose
# main branch cannot be merged into and no error message anywhere saying so.
#
# It stays a warning in the two cases where a miss is not evidence of a bug:
# the repo has no workflows on the default branch at all (the workflow is still
# on a branch waiting for review - two-design is in exactly that state until
# QA's `ci/design-gates` merges), or the heuristic below parsed nothing, since
# it is not a YAML engine and should not fail a setup on its own blind spot.
verify_check_jobs() {
  local name="$1"; shift
  local expected=("$@") listing found="" f body want

  listing="$(gh api "repos/$ORG/$name/contents/.github/workflows" \
               --jq '.[].path' 2>/dev/null || true)"
  if [ -z "$listing" ]; then
    warn "$name: no .github/workflows on $DEFAULT_BRANCH - every required check would hang as 'Expected'"
    return 0
  fi

  while read -r f; do
    [ -n "$f" ] || continue
    body="$(gh api "repos/$ORG/$name/contents/$f" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
    [ -n "$body" ] || continue
    found+="$(python3 - "$body" <<'PY'
import re, sys
# Heuristic, not a YAML parser: the job ids of a workflow are the keys nested
# one level under a top-level `jobs:`. A job reports under its `name:` if it
# sets one and under its id otherwise, so emit `id|reported-name` and let the
# caller tell a real match from a near miss.
#
# Only workflows that trigger on `pull_request` count. A push-only workflow
# never reports on a PR, so requiring one of its jobs would hang the PR, and
# listing its jobs as "reports but not required" would be noise - two-bot's
# main-guard is push-only on purpose.
text, out, in_jobs, job = sys.argv[1], [], False, None
head = text.split('\njobs:', 1)[0]
if 'pull_request' not in head:
    print('')
    raise SystemExit(0)
def flush():
    if job:
        out.append('%s|%s' % (job[0], job[1] or job[0]))
for line in text.splitlines():
    if re.match(r'^jobs:\s*$', line):
        in_jobs = True
        continue
    if in_jobs and re.match(r'^\S', line):
        flush(); job = None
        in_jobs = False
    if not in_jobs:
        continue
    m = re.match(r'^  ([A-Za-z0-9_.-]+):\s*$', line)
    if m:
        flush()
        job = [m.group(1), None]
        continue
    m = re.match(r'^    name:\s*["\']?([^"\'#]+?)["\']?\s*$', line)
    if m and job:
        job[1] = m.group(1).strip()
flush()
print('\n'.join(out))
PY
)"$'\n'
  done <<< "$listing"

  local reported ids
  reported="$(printf '%s' "$found" | awk -F'|' 'NF==2 {print $2}')"
  ids="$(printf '%s' "$found" | awk -F'|' 'NF==2 {print $1}')"

  if [ -z "$reported" ]; then
    warn "$name: could not read any job names out of .github/workflows - skipping the check-name audit"
    return 0
  fi

  for want in "${expected[@]}"; do
    if printf '%s\n' "$reported" | grep -qxF "$want"; then
      ok "$name: required check '$want' is defined by a workflow on $DEFAULT_BRANCH"
    elif printf '%s\n' "$ids" | grep -qxF "$want"; then
      bad "$name: required check '$want' is a job id, but that job sets its own 'name:' and reports under that instead."
      bad "  Branch protection matches the reported name. Every PR would wait on '$want' forever."
      FAILED=1
    else
      bad "$name: required check '$want' matches no job on $DEFAULT_BRANCH - every PR would wait on it forever."
      bad "  Reported names on this branch: $(printf '%s\n' "$reported" | paste -sd' ' -)"
      FAILED=1
    fi
  done

  # The other half of the drift: a job that runs on every PR but is not in the
  # required list. It goes red and the PR still merges. Not fatal - a job can be
  # advisory on purpose - but it should never be a surprise.
  local have
  while read -r have; do
    [ -n "$have" ] || continue
    printf '%s\n' "${expected[@]}" | grep -qxF "$have" && continue
    warn "$name: job '$have' reports on PRs but is not required - it can go red and the PR still merges"
  done <<< "$reported"
}

verify_teams
verify_repo "$BOT_REPO" "${BOT_CHECKS[*]}" "${BOT_FILES[*]}"
verify_codeowners "$BOT_REPO"
verify_check_jobs "$BOT_REPO" "${BOT_CHECKS[@]}"
verify_repo "$WEB_REPO" "${WEB_CHECKS[*]}" "${WEB_FILES[*]}"
verify_codeowners "$WEB_REPO"
verify_check_jobs "$WEB_REPO" "${WEB_CHECKS[@]}"
verify_repo "$DESIGN_REPO" "${DESIGN_CHECKS[*]}" "${DESIGN_FILES[*]}"
verify_codeowners "$DESIGN_REPO"
verify_check_jobs "$DESIGN_REPO" "${DESIGN_CHECKS[@]}"

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
