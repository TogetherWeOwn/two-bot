#!/usr/bin/env bash
#
# One-shot setup for the TWO GitHub org: repos, history, branch protection,
# secret scanning.
#
# Safe to re-run. Every step checks the current state first and skips or
# updates rather than failing, so if it stops half way you fix the cause and
# run it again.
#
#   ./scripts/setup-github.sh                 # do it
#   ./scripts/setup-github.sh --dry-run       # print what it would do, and
#                                             # prove the token can do it
#   ./scripts/setup-github.sh --verify        # only check the end state
#
# CREDENTIAL: a GitHub *fine-grained* personal access token scoped to the org,
# in the environment as GH_TOKEN. gh reads that variable directly - there is no
# `gh auth login` step and you should not do one. Permissions the token needs
# (TWO-81, `github-access`):
#
#   Organization  Administration: write   Members: write
#   Repository    Metadata: read          Administration: write
#                 Contents: write         Workflows: write
#                 Actions: write          Secrets: write
#                 Environments: write     Pull requests: write
#                 Issues: write
#
# These are fine-grained permission names, NOT the classic-PAT scopes
# (`repo,admin:org,workflow`) an older version of this file told you to ask
# for. --dry-run probes the token against the org and reports what it can
# actually do before anything is created. See docs/GITHUB.md.
#
# ENVIRONMENT:
#   TWO_GITHUB_ORG          org login (default below)
#   TWO_REPO_VISIBILITY     private (default) | public - see create_repo
#   TWO_ACCEPT_PUBLIC_REPOS 1 to confirm a public creation is intended
#   TWO_SKIP_TOKEN_PROBE    1 to skip the dry-run token probe
#   TWO_BOT_PATH / TWO_WEB_PATH / TWO_DESIGN_PATH   local working copies

set -euo pipefail

# The org was created as `TWO-Gaming`. GitHub org logins are case-insensitive
# and both forms resolve to the same org id (318830450), so the lowercase
# default here matches the bot's systemd unit and the CODEOWNERS files without
# anything needing renaming. Set TWO_GITHUB_ORG=TWO-Gaming if you want the
# canonical casing to appear in the git remotes.
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
    # Print the header comment block: everything from line 2 up to the line
    # before `set -euo pipefail`. Computed rather than hardcoded, so editing
    # the header cannot silently truncate --help (it used to say 2,20p and the
    # header outgrew it).
    -h|--help)
      sed -n "2,$(($(grep -n '^set -euo pipefail' "${BASH_SOURCE[0]}" | head -1 | cut -d: -f1) - 1))p" "${BASH_SOURCE[0]}"
      exit 0 ;;
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
  bad "gh has no credential."
  bad ""
  bad "Expected: a fine-grained personal access token for the org in GH_TOKEN."
  bad "  export GH_TOKEN=<token>   # gh reads it directly; do NOT 'gh auth login'"
  bad ""
  bad "The token's permissions are listed at the top of this file and on TWO-81"
  bad "as the 'github-access' document. They are fine-grained permission names,"
  bad "not the classic scopes 'repo,admin:org,workflow'."
  exit 1
}
# A fine-grained token is not attached to a human, so `gh api user` can return
# the token owner rather than anything meaningful. Report it, but do not depend
# on it.
ok "gh authenticated as $(gh api user --jq .login 2>/dev/null || echo '<token, no user>')"

# Classic PATs advertise their scopes in a response header; fine-grained tokens
# send the header empty or not at all. That is the only reliable way to tell
# which kind we were handed, and it changes what every 403 below means.
TOKEN_KIND=unknown
TOKEN_SCOPES="$(gh api -i rate_limit 2>/dev/null \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="x-oauth-scopes"{print $2}' | head -1)"
if [ -n "${TOKEN_SCOPES// /}" ]; then
  TOKEN_KIND=classic
  ok "token type: classic PAT, scopes: $TOKEN_SCOPES"
else
  TOKEN_KIND=fine-grained
  ok "token type: fine-grained (no x-oauth-scopes header)"
fi

gh api "orgs/$ORG" >/dev/null 2>&1 || {
  bad "org '$ORG' not reachable. Either it does not exist yet, or this account is not a member."
  bad "This is the TWO-21 blocker. Stop here."
  exit 1
}
ok "org '$ORG' reachable"

# ---------------------------------------------------------------------------
# Repo visibility.
#
# Private is the default and should stay that way until TWO-35 has cleared
# secrets out of the history. The switch exists because the founder is being
# asked, on TWO-81, to choose between Team+private and Free+public - and if the
# answer is Free+public, this script has to be able to act on it without a code
# change.
#
# Public needs TWO_ACCEPT_PUBLIC_REPOS=1 as well as TWO_REPO_VISIBILITY=public.
# Two variables for one decision is deliberate: making a repo public is the one
# step here that cannot be taken back. Flipping it private again does not
# un-clone it, un-fork it, or remove it from anyone's search index.
VISIBILITY="${TWO_REPO_VISIBILITY:-private}"
case "$VISIBILITY" in
  private) ok "repo visibility: private" ;;
  public)
    if [ "${TWO_ACCEPT_PUBLIC_REPOS:-0}" != "1" ]; then
      bad "TWO_REPO_VISIBILITY=public but TWO_ACCEPT_PUBLIC_REPOS is not 1."
      bad ""
      bad "Creating these repos public publishes their full history to the world"
      bad "in one step, and TWO-35 has not yet cleared that history. Going back to"
      bad "private later does not un-clone or un-index what was published."
      bad ""
      bad "If the founder has chosen Free+public with eyes open, set both:"
      bad "  TWO_REPO_VISIBILITY=public TWO_ACCEPT_PUBLIC_REPOS=1"
      exit 1
    fi
    warn "repo visibility: PUBLIC - history goes public on creation (TWO-35 risk accepted)"
    ;;
  *) bad "TWO_REPO_VISIBILITY must be 'private' or 'public', got '$VISIBILITY'"; exit 1 ;;
esac

# Plan matters: on GitHub Free, branch protection and rulesets are enforced on
# PUBLIC repos only. So protection is real in two of the three combinations,
# and the one that fails silently is free + private:
#
#             private          public
#   free      NOT enforced     enforced
#   team+     enforced         enforced
#
# That is why $VISIBILITY is resolved above this block rather than below it.
PLAN="$(gh api "orgs/$ORG" --jq '.plan.name // "unknown"' 2>/dev/null || echo unknown)"
ok "org plan: $PLAN"
PROTECTION_AVAILABLE=1
case "$PLAN" in
  free)
    if [ "$VISIBILITY" = public ]; then
      ok "GitHub Free + public repos: branch protection IS enforced"
      warn "The trade is that everything in these repos is world-readable from"
      warn "the moment it is pushed, including history TWO-35 has not cleared."
    else
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
    fi
    ;;
  *) ok "plan supports branch protection on $VISIBILITY repos" ;;
esac

# ---------------------------------------------------------------------------
# Does this token actually have the permissions we were promised?
#
# GitHub has no dry-run for a write. The mapping from a fine-grained permission
# to an endpoint is documented but easy to get wrong by one permission, and the
# way you find out is a 403 half way through setup, with some teams created and
# some not. So on --dry-run we prove the two writes that gate everything else,
# by doing them and then undoing them.
#
# Specifically this answers QA's question on TWO-40: does org `Members: write`
# satisfy POST /orgs/{org}/teams for a fine-grained token? It creates a
# throwaway team and deletes it again. Nothing else in the org is touched.
#
# TWO_SKIP_TOKEN_PROBE=1 turns it off.
probe_token() {
  say "Token probe (dry run only - creates and deletes a throwaway team)"

  local probe_name="zz-preflight-token-check-$$"
  local body slug http

  # Read side first. If org read fails we already exited above, so this is
  # about the writes.
  if gh api "orgs/$ORG/teams" >/dev/null 2>&1; then
    ok "can LIST teams (org Members: read)"
  else
    bad "cannot list teams - org 'Members' permission is missing entirely"
    FAILED=1
    return 0
  fi

  if ! body="$(gh api --method POST "orgs/$ORG/teams" \
      -f "name=$probe_name" \
      -f "description=Temporary permission probe from setup-github.sh --dry-run. Delete me." \
      -f "privacy=closed" 2>&1)"; then
    bad "cannot CREATE a team. POST /orgs/$ORG/teams was refused:"
    printf '         %s\n' "$body" | head -5
    bad ""
    if [ "$TOKEN_KIND" = fine-grained ]; then
      bad "For a fine-grained token this endpoint needs organization"
      bad "'Members: write'. Add it to the token on TWO-81 and re-run --dry-run."
    else
      bad "For a classic PAT this endpoint needs the 'admin:org' scope."
    fi
    FAILED=1
    return 0
  fi

  slug="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("slug",""))' 2>/dev/null || true)"
  if [ -z "$slug" ]; then
    warn "team created but the response had no slug; cannot clean up automatically."
    warn "  Check for a team called '$probe_name' in $ORG and delete it by hand."
    return 0
  fi

  ok "CAN create a team (org Members: write is sufficient) - created @$ORG/$slug"

  if gh api --method DELETE "orgs/$ORG/teams/$slug" >/dev/null 2>&1; then
    ok "CAN delete a team - probe team @$ORG/$slug removed, org is back as it was"
  else
    # Never leave this behind quietly. A stray team in CODEOWNERS-adjacent
    # space is confusing, and it means the token can create but not clean up.
    bad "created @$ORG/$slug but could NOT delete it. Remove it by hand:"
    bad "  gh api --method DELETE orgs/$ORG/teams/$slug"
    FAILED=1
  fi

  # Repo-level permissions (Administration, Contents, Workflows) cannot be
  # probed before a repo exists, and creating a throwaway repo to test them is
  # a worse trade than finding out on the real run - repo creation is
  # idempotent here and every step reports its own failure.
  skip "repo-level permissions are exercised on the real run, step by step"
}

if [ "$DRY_RUN" = 1 ] && [ "${TWO_SKIP_TOKEN_PROBE:-0}" != "1" ]; then
  probe_token
elif [ "$DRY_RUN" = 1 ]; then
  skip "token probe skipped (TWO_SKIP_TOKEN_PROBE=1) - permissions unverified"
fi

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
    if [ "$TOKEN_KIND" = classic ]; then
      bad "could not create team '$slug' - the classic token needs admin:org on $ORG"
    else
      bad "could not create team '$slug' - the token needs organization"
      bad "  'Members: write' on $ORG. Run --dry-run to confirm before retrying."
    fi
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

# create_repo <name> - no auto-init (we push real history into it).
# Visibility comes from $VISIBILITY, resolved and gated in Preflight.
create_repo() {
  local name="$1"
  local want_private=true
  [ "$VISIBILITY" = public ] && want_private=false

  if repo_exists "$name"; then
    skip "$ORG/$name already exists"
  else
    run gh api --method POST "orgs/$ORG/repos" \
      -f "name=$name" \
      -F "private=$want_private" \
      -F "has_issues=false" \
      -F "has_wiki=false" \
      -F "has_projects=false" \
      -F "auto_init=false" \
      -F "allow_squash_merge=true" \
      -F "allow_merge_commit=true" \
      -F "allow_rebase_merge=false" \
      -F "delete_branch_on_merge=true" >/dev/null
    if [ "$DRY_RUN" = 1 ]; then
      printf '   \033[90mwould create\033[0m %s/%s (%s)\n' "$ORG" "$name" "$VISIBILITY"
      # Nothing exists to inspect, and claiming it does would make a dry run
      # read like a real one. This is the visibility the real run would use.
      return 0
    fi
    ok "created $ORG/$name ($VISIBILITY)"
  fi

  # Confirm what GitHub actually made, not what we asked for. An org can have a
  # policy that forces one or the other, in which case the request quietly
  # yields the opposite of the plan the founder chose.
  local vis
  vis="$(gh api "repos/$ORG/$name" --jq .private 2>/dev/null || echo "$want_private")"
  if [ "$vis" != "$want_private" ]; then
    if [ "$want_private" = true ]; then
      bad "$ORG/$name is PUBLIC. It must be private until TWO-35 clears secrets and history."
    else
      bad "$ORG/$name is PRIVATE, but public was requested. On a Free org that means"
      bad "  branch protection will not be enforced - the exact thing going public was for."
    fi
    FAILED=1
  fi
}

# remote_protocol
#
# Which URL form the `origin` remotes get. This used to be hardcoded to SSH,
# which was wrong: the credential we are actually given is a fine-grained PAT,
# and there is no SSH key on the machine that runs this. Every repo would have
# been created, protected and then failed at the push - the worst place to stop,
# because the org looks finished and contains nothing.
#
# So: ask, do not assume. `ssh -T git@github.com` answers 1 for a recognised key
# and 255 for "Permission denied (publickey)". If a key works we prefer SSH,
# because it needs no credential helper. Otherwise HTTPS, authenticated by
# GH_TOKEN through gh's credential helper. Override with TWO_REMOTE_PROTOCOL.
#
# The token is NEVER written into a remote URL. A URL with a PAT in it lands in
# .git/config, and from there into every `git remote -v` and every bug report.
REMOTE_PROTOCOL=""
remote_protocol() {
  [ -n "$REMOTE_PROTOCOL" ] && { printf '%s' "$REMOTE_PROTOCOL"; return 0; }

  if [ -n "${TWO_REMOTE_PROTOCOL:-}" ]; then
    REMOTE_PROTOCOL="$TWO_REMOTE_PROTOCOL"
  elif timeout 20 ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
         -T git@github.com >/dev/null 2>&1 || [ $? -eq 1 ]; then
    REMOTE_PROTOCOL="ssh"
  else
    REMOTE_PROTOCOL="https"
  fi
  printf '%s' "$REMOTE_PROTOCOL"
}

# remote_url <repo-name>
remote_url() {
  if [ "$(remote_protocol)" = "ssh" ]; then
    printf 'git@github.com:%s/%s.git' "$ORG" "$1"
  else
    printf 'https://github.com/%s/%s.git' "$ORG" "$1"
  fi
}

# ensure_git_credentials
#
# On HTTPS, git needs to be told how to answer GitHub's password prompt. gh
# ships a credential helper that reads GH_TOKEN, so nothing is stored on disk
# and nothing expires behind our back. Configured on the repo, not globally -
# this script should not reach outside the repos it was pointed at.
ensure_git_credentials() {
  local path="$1"
  [ "$(remote_protocol)" = "https" ] || return 0
  run git -C "$path" config credential."https://github.com".helper '!gh auth git-credential'
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

  local url; url="$(remote_url "$name")"
  ensure_git_credentials "$path"
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
#
# WHY NO REQUIRED APPROVALS (TOG-240, re-measured TOG-111 2026-08-25)
#
# This function used to write `required_approving_review_count: 1` with
# `require_code_owner_reviews: True`. Measured against the real org, that
# combination does not gate merges - it stops them completely:
#
#   - Every agent-authored PR is opened by ONE shared App identity. Verified on
#     two-bot: PRs #6 through #14 are all `togetherweown[bot]`.
#   - GitHub refuses to let an author approve their own pull request, so that
#     identity can never clear its own gate. It 422s.
#   - `.github/CODEOWNERS` names exactly one account, `@Rick7C2`, a human. Its
#     own header says the org "has one member with write access".
#
# So every PR the fleet opens would wait on one person hand-approving it, and
# `require_last_push_approval` means that approval dies on the next push - so it
# has to be the LAST event before merge, every time. That is a deadlock, not a
# control, and the reviewer pool is agents that may be asleep. TOG-240 recorded
# that decision; this function contradicted it until TOG-111.
#
# What actually enforces quality here does not need anyone awake: a PR is still
# required, required status checks (CI + gitleaks) must be green, admins get no
# bypass, and force-push and deletion are refused. Human sign-off is required
# where it is affordable and where it matters - the `production` environment
# reviewer gate at DEPLOY time, not at merge time.
#
# Raise the count to 1 when a second human has write access. Nothing else in
# this payload needs to change.
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
    # Present (not None) so a pull request is still REQUIRED before merging -
    # that is what this key controls. The approval count below is a separate
    # sub-setting, and it is deliberately 0. See the block comment above.
    "required_pull_request_reviews": {
        "required_approving_review_count": 0,
        # Both are inert at count 0 and both are kept on purpose: the day a
        # second human gets write access, raising the count to 1 is the only
        # edit needed and self-approval is already refused.
        "require_last_push_approval": True,
        "dismiss_stale_reviews": True,
        # Left False deliberately. GitHub only enforces code-owner review when
        # the approval count is >= 1, so True here would be decorative today
        # and would silently become a second gate the day the count is raised.
        "require_code_owner_reviews": False,
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

  local err
  if err="$(printf '%s' "$payload" | gh api --method PUT \
      "repos/$ORG/$name/branches/$DEFAULT_BRANCH/protection" --input - 2>&1 >/dev/null)"; then
    ok "$name: protection written on $DEFAULT_BRANCH (PR required, CI ${checks[*]}, 0 approvals by design, no force-push)"
    return 0
  fi

  # Measured 2026-08-20 against the real org: GitHub answers 403 "Upgrade to
  # GitHub Pro or make this repository public to enable this feature." It does
  # NOT accept-and-ignore the rule. Nothing is stored - GET protection and GET
  # rulesets are 403 too. That matters in two directions:
  #
  #   good  there is no silent failure mode. A settings page cannot lie to you
  #         about being protected, because there is no rule to display.
  #   bad   moving to Team later does NOT switch protection on by itself. The
  #         rules have to be written again, by re-running this script.
  #
  # Under TWO_ACCEPT_UNPROTECTED_MAIN=1 this refusal is the recorded plan
  # (TWO-81, Free + private), so it is a warning, not a failure. A run that
  # always ends in red teaches everyone to ignore red.
  if [ "${TWO_ACCEPT_UNPROTECTED_MAIN:-0}" = "1" ] && [ "$PROTECTION_AVAILABLE" = 0 ]; then
    warn "$name: GitHub refused branch protection - private repo on a Free org, as expected."
    warn "  This is the TWO-81 plan choice, not a regression. main-guard.yml is the guard."
    warn "  On a later move to GitHub Team, re-run this script to write the rules for real."
  else
    bad "$name: could not write branch protection"
    [ "$PROTECTION_AVAILABLE" = 0 ] && bad "  most likely cause: private repo on a Free org"
    [ -n "$err" ] && bad "  GitHub said: ${err%%$'\n'*}"
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

  local priv want_priv=true
  [ "$VISIBILITY" = public ] && want_priv=false
  priv="$(gh api "repos/$ORG/$name" --jq .private)"
  if [ "$priv" = "$want_priv" ]; then
    ok "$name: $VISIBILITY"
  elif [ "$want_priv" = true ]; then
    bad "$name: PUBLIC - must be private until TWO-35"; FAILED=1
  else
    bad "$name: PRIVATE, but TWO_REPO_VISIBILITY=public was chosen"; FAILED=1
  fi

  local db; db="$(gh api "repos/$ORG/$name" --jq .default_branch)"
  [ "$db" = "$DEFAULT_BRANCH" ] && ok "$name: default branch is $db" || { bad "$name: default branch is '$db', expected $DEFAULT_BRANCH"; FAILED=1; }

  local p
  if p="$(gh api "repos/$ORG/$name/branches/$DEFAULT_BRANCH/protection" 2>/dev/null)"; then
    local pr checks admins selfapp prreq
    # Presence of the whole block is the "require a pull request before merging"
    # toggle. It is a separate thing from how many approvals that PR needs.
    prreq="$(printf '%s' "$p"   | python3 -c 'import json,sys; d=json.load(sys.stdin); print("required_pull_request_reviews" in d)')"
    pr="$(printf '%s' "$p"      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("required_pull_request_reviews",{}).get("required_approving_review_count",0))')"
    selfapp="$(printf '%s' "$p" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("required_pull_request_reviews",{}).get("require_last_push_approval",False))')"
    checks="$(printf '%s' "$p"  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(d.get("required_status_checks",{}).get("contexts",[])) or "NONE")')"
    admins="$(printf '%s' "$p"  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("enforce_admins",{}).get("enabled",False))')"

    local stale
    stale="$(printf '%s' "$p"   | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("required_pull_request_reviews",{}).get("dismiss_stale_reviews",False))')"

    # A pull request must be REQUIRED. That is `required_pull_request_reviews`
    # being present at all, which is what `prreq` reads - NOT the approval
    # count. Asserting the count is >= 1 is what used to be here and it asserted
    # the deadlock described above protect(): one shared bot identity that
    # cannot approve itself, one human code owner. Zero approvals is the
    # recorded posture (TOG-240 / TOG-111), so it is checked as such.
    [ "$prreq" = "True" ]     && ok "$name: pull request required before merge"       || { bad "$name: direct pushes to $DEFAULT_BRANCH allowed - no PR required"; FAILED=1; }
    if [ "$pr" -ge 1 ]; then
      ok "$name: PR review required ($pr approval)"
      [ "$selfapp" = "True" ] && ok "$name: self-approval blocked"                    || { bad "$name: self-approval NOT blocked"; FAILED=1; }
      [ "$stale" = "True" ]   && ok "$name: stale approvals dismissed on new commits" || { bad "$name: stale approvals survive a force-push"; FAILED=1; }
    else
      ok "$name: 0 required approvals - deliberate (TOG-240), CI is the gate"
    fi
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
