#!/usr/bin/env bash
# Deploy the TWO bot to Coolify (TOG-13).
#
# Why this is a script and not a panel walkthrough: docs/DEPLOY.md is written for
# a human with the panel open, and every value in it that could be wrong is one
# that silently points the bot at the wrong guild or the wrong database. This
# does the same steps through the API so the same input gives the same result
# every time, and so the preconditions FAIL LOUDLY instead of being deployed
# past.
#
# It is idempotent: run it twice and the second run updates the existing
# application rather than creating a second one.
#
# Exit codes are the contract - CI and the operator card both read them:
#
#   0  deployed, /readyz returned 200
#   2  a precondition is not met (server not usable, no database, missing env,
#      migration drift)
#   3  the deploy was triggered but never went healthy
#   1  an API call failed unexpectedly
#
# Before anything is created or queued, the preflight asks
# scripts/migrate.ts --status (read-only) what the database looks like.
# Pending migrations are reported and otherwise normal - the bot applies them
# at startup under an advisory lock. Drift (a CHANGED or ORPHAN line: an
# applied migration edited or deleted underneath the database) aborts the run
# with exit 2, because rolling new code onto a drifted database is how two
# environments quietly desynchronise. When the database is unreachable from
# here the check says so and continues; boot-time migration stays the safety
# net (docs/RUNBOOK.md).
#
# Usage:
#   scripts/coolify-deploy.sh --check     # preconditions only, changes nothing
#   scripts/coolify-deploy.sh             # check, then create/update and deploy
#   scripts/coolify-deploy.sh --selftest  # offline gate tests, changes nothing
#
# Required in the environment:
#   COOLIFY_URL COOLIFY_TOKEN     the panel and a token with write+deploy
#   DISCORD_BOT_TOKEN             the discord_bot_token secret
#   TWO_DATABASE_URL              Postgres. NOT DATABASE_URL - see docs/DEPLOY.md §3
# Optional:
#   DISCORD_GUILD_ID              defaults to the live TWO server
#   COOLIFY_SERVER_UUID           defaults to the box Coolify runs on
#   TWO_ONBOARDING_DRY_RUN        defaults to 1 - observes, grants no roles

set -euo pipefail

CHECK_ONLY=0
SELFTEST=0
case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  --selftest) SELFTEST=1 ;;
  "") ;;
  *) echo "usage: scripts/coolify-deploy.sh [--check|--selftest]" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- migration-gate helpers (testable without network) ---------------------
# The preflight parses scripts/migrate.ts --status output through this
# function so the selftest below can pin the decision table without a
# database: 0 = clean-or-pending, 2 = drift (abort), anything else = output
# the caller did not understand.
#
# Prints the human line for the preflight to report.
migration_gate_decide() { # migration_gate_decide STATUS_OUTPUT MIGRATE_EXIT
  local output="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    local pending
    pending="$(printf '%s\n' "$output" | grep -c '^pending' || true)"
    if [[ "$pending" -gt 0 ]]; then
      printf '%s pending migration(s) - the bot applies them at startup\n' "$pending"
    else
      printf 'database schema up to date\n'
    fi
    return 0
  fi
  if [[ "$rc" -eq 1 ]] && printf '%s\n' "$output" | grep -qE '^(CHANGED|ORPHAN)'; then
    printf 'migration drift detected (a CHANGED or ORPHAN line above) - refusing to roll\n'
    return 2
  fi
  printf 'could not read migration status (exit %s)\n' "$rc"
  return 1
}

if [[ "$SELFTEST" -eq 1 ]]; then
  selftest_fails=0
  selftest_case() { # selftest_case NAME WANT_RC WANT_SUBSTR HAVE_RC HAVE_SUBSTR...
    local name="$1" want_rc="$2" want_sub="$3"; shift 3
    local have_rc="$1" have_sub="$2"
    local out rc=0
    out="$(migration_gate_decide "$have_sub" "$have_rc")" || rc=$?
    if [[ "$rc" -ne "$want_rc" ]]; then
      printf 'selftest FAIL %s: want rc %s, got %s (%s)\n' "$name" "$want_rc" "$rc" "$out" >&2
      selftest_fails=$((selftest_fails + 1)); return
    fi
    if [[ "$out" != *"$want_sub"* ]]; then
      printf 'selftest FAIL %s: want %q in %q\n' "$name" "$want_sub" "$out" >&2
      selftest_fails=$((selftest_fails + 1)); return
    fi
    printf 'selftest ok %s\n' "$name"
  }
  selftest_case "clean reports up to date" 0 "up to date" 0 "applied  0001_init
applied  0002_next

2 on disk, 2 applied, 0 pending."
  selftest_case "pending reports count, passes" 0 "2 pending" 0 "applied  0001_init
pending  0037_temp_voice_owner_transition
pending  0038_events_type_member

3 on disk, 1 applied, 2 pending."
  selftest_case "changed migration aborts" 2 "refusing to roll" 1 "CHANGED  0010_leveling  (recorded abc, file def)
applied  0011_next

2 on disk, 2 applied, 0 pending."
  selftest_case "orphan migration aborts" 2 "refusing to roll" 1 "applied  0001_init
ORPHAN   0009_deleted  (in schema_migrations, not in migrations/)

1 on disk, 2 applied, 0 pending."
  selftest_case "unreachable database is known-unknown" 1 "could not read" 2 "migrate: TWO_DATABASE_URL is not set."
  if [[ "$selftest_fails" -ne 0 ]]; then
    printf 'selftest: %s case(s) failed\n' "$selftest_fails" >&2; exit 1
  fi
  echo "selftest: all migration-gate cases hold, no network touched"
  exit 0
fi

: "${COOLIFY_URL:?set COOLIFY_URL}"
: "${COOLIFY_TOKEN:?set COOLIFY_TOKEN}"

SERVER_UUID="${COOLIFY_SERVER_UUID:-kaghbfdj7cjkjjf8eisjfj5c}"
PROJECT_NAME="two-bot"
# The live application is named `two-bot-dk`, NOT `two-bot`. The lookup below
# matches on this name, so getting it wrong does not fail loudly - it silently
# creates a SECOND application beside the running one. See TOG-13.
APP_NAME="${COOLIFY_APP_NAME:-two-bot-dk}"
# NOT github.com. Coolify on this box cannot clone from GitHub: deploy keys are
# forbidden by the GitHub enterprise policy (TOG-1175) and an embedded
# x-access-token clone URL 500s. The box mirrors the GitHub repo every 2 minutes
# and Coolify clones from that mirror over SSH. Re-pointing this at github.com
# breaks every future deploy of a bot that is currently running fine.
GIT_REPO="${COOLIFY_GIT_REPO:-git@135.148.42.223:/srv/git/two-bot.git}"
GIT_BRANCH="${TWO_DEPLOY_BRANCH:-main}"
GUILD_ID="${DISCORD_GUILD_ID:-326474832151838730}"

api() { # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -m 60 -X "$method" \
      -H "Authorization: Bearer $COOLIFY_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body" "$COOLIFY_URL/api/v1/$path"
  else
    curl -sS -m 60 -X "$method" \
      -H "Authorization: Bearer $COOLIFY_TOKEN" \
      "$COOLIFY_URL/api/v1/$path"
  fi
}

jq_get() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null || true; }

fail=0
say() { printf '  %-5s %s\n' "$1" "$2"; }

echo
echo "Coolify deploy preflight - $COOLIFY_URL"
echo

# --- 1. The panel answers, and the token is accepted ------------------------
version="$(api GET version || true)"
if [[ -z "$version" || "$version" == *"Unauthenticated"* ]]; then
  say FAIL "panel unreachable or token rejected"
  exit 2
fi
say PASS "panel $version, token accepted"

# --- 2. The server can actually run a container -----------------------------
# is_reachable/is_usable are the fields the panel sets from its own docker
# check. A deploy against an unusable server does not error - it aborts
# pre-build in about three seconds with empty logs, which reads like a code
# problem and is not one. Gate on it.
srv="$(api GET "servers/$SERVER_UUID")"
usable="$(printf '%s' "$srv" | jq_get "json.dumps(d.get('settings',{}).get('is_usable'))")"
docker_v="$(printf '%s' "$srv" | jq_get "json.dumps(d.get('settings',{}).get('docker_version'))")"
if [[ "$usable" != "true" ]]; then
  say FAIL "server $SERVER_UUID is not usable (is_usable=$usable, docker_version=$docker_v)"
  echo "        Fix on the box, then re-run:  docker ps --filter name=coolify-proxy"
  echo "        then panel: Servers -> localhost -> Validate Server. See TOG-1168."
  fail=1
else
  say PASS "server usable, docker $docker_v"
fi

# --- 3. A database exists and we were told how to reach it ------------------
# Postgres is deliberately not in docker-compose.yml (the bot's lifecycle must
# not be able to take the funnel log with it), so it has to already exist.
if [[ -z "${TWO_DATABASE_URL:-}" ]]; then
  say FAIL "TWO_DATABASE_URL is unset - the container refuses to start without it"
  echo "        Note the name: TWO_DATABASE_URL, not DATABASE_URL. docs/DEPLOY.md §3."
  fail=1
else
  say PASS "TWO_DATABASE_URL set"
fi

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  say FAIL "DISCORD_BOT_TOKEN is unset"
  fail=1
else
  say PASS "DISCORD_BOT_TOKEN set"
fi

# --- 3b. Migration pre-roll status -------------------------------------------
# Read-only: scripts/migrate.ts --status with skipMigrations, so reporting
# never applies anything. Pending lines are informational - the bot migrates
# at startup under an advisory lock. Drift (CHANGED/ORPHAN) aborts with
# exit 2: rolling onto a drifted database desynchronises environments.
# When the database is unreachable from here (CI runners, offline laptops),
# the status command fails without a drift signature, and the gate says so
# and passes - boot-time migration stays the safety net, and inventing a
# refusal for "could not reach the database from this machine" would turn
# every offline --check red for no additional safety.
if command -v node >/dev/null 2>&1 && [[ -n "${TWO_DATABASE_URL:-}" ]]; then
  migrate_out=""
  migrate_rc=0
  # Bounded: pg has no default connect timeout, so a blackholed database
  # would otherwise hang the preflight. A timeout lands in the WARN branch
  # below (exit 124, no drift signature), never in the abort branch.
  migrate_out="$(timeout 120 node "$ROOT/scripts/migrate.ts" --status 2>&1)" || migrate_rc=$?
  printf '%s\n' "$migrate_out" | sed 's/^/    migrate: /'
  gate_out=""
  gate_rc=0
  gate_out="$(migration_gate_decide "$migrate_out" "$migrate_rc")" || gate_rc=$?
  case "$gate_rc" in
    0) say PASS "migrations: $gate_out" ;;
    2) say FAIL "migrations: $gate_out"
       echo "        Fix with: TWO_DATABASE_URL=... node scripts/migrate.ts --status (docs/RUNBOOK.md)."
       echo "        Migrations are immutable - add a new one, never edit an applied file (migrations/README.md)."
       fail=1 ;;
    *) say "WARN" "migrations: $gate_out - continuing, boot-time migration is the safety net" ;;
  esac
else
  say "SKIP" "migrations: no node or no TWO_DATABASE_URL here - boot-time migration is the safety net"
fi

echo
if [[ "$fail" -ne 0 ]]; then
  echo "Preconditions not met. Nothing was changed."
  exit 2
fi
echo "Preconditions met."

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "--check: stopping before any write."
  exit 0
fi

# --- 4. Project and environment --------------------------------------------
projects="$(api GET projects)"
project_uuid="$(printf '%s' "$projects" | jq_get "next((p['uuid'] for p in d if p['name']=='$PROJECT_NAME'),'')")"
if [[ -z "$project_uuid" ]]; then
  project_uuid="$(api POST projects "{\"name\":\"$PROJECT_NAME\",\"description\":\"TOG-13 Discord bot deploy target\"}" | jq_get "d.get('uuid','')")"
  echo "  created project $project_uuid"
else
  echo "  project $project_uuid (existing)"
fi

env_uuid="$(api GET "projects/$project_uuid" | jq_get "next((e['uuid'] for e in d.get('environments',[]) if e['name']=='production'),'')")"
[[ -n "$env_uuid" ]] || { echo "no production environment on project"; exit 1; }
echo "  environment $env_uuid"

# --- 5. Application ---------------------------------------------------------
# Docker Compose type, pointed at the repo. No build pack: Node 24 runs the
# TypeScript directly, so there is nothing to compile and Nixpacks would only
# get in the way.
apps="$(api GET applications)"
app_uuid="$(printf '%s' "$apps" | jq_get "next((a['uuid'] for a in d if a.get('name')=='$APP_NAME'),'')")"

if [[ -z "$app_uuid" ]]; then
  body="$(python3 -c "
import json
print(json.dumps({
  'project_uuid': '$project_uuid',
  'environment_uuid': '$env_uuid',
  'server_uuid': '$SERVER_UUID',
  'name': '$APP_NAME',
  'git_repository': '$GIT_REPO',
  'git_branch': '$GIT_BRANCH',
  'build_pack': 'dockercompose',
  'docker_compose_location': '/docker-compose.yml',
  'instant_deploy': False,
}))")"
  app_uuid="$(api POST applications/public "$body" | jq_get "d.get('uuid','')")"
  [[ -n "$app_uuid" ]] || { echo "application create failed"; exit 1; }
  echo "  created application $app_uuid"
else
  echo "  application $app_uuid (existing)"
  # An existing application already has a clone URL, and this script never
  # rewrites it. If it points somewhere this box cannot clone from, the deploy
  # below fails in a few seconds with an EMPTY build log, which reads like a
  # broken server rather than a bad remote. Say so here instead.
  existing_repo="$(printf '%s' "$apps" | jq_get "next((a.get('git_repository','') for a in d if a.get('name')=='$APP_NAME'),'')")"
  if [[ -n "$existing_repo" && "$existing_repo" != "$GIT_REPO" ]]; then
    say "WARN" "application clone URL is '$existing_repo', not '$GIT_REPO'"
    if [[ "$existing_repo" == *github.com* ]]; then
      say "FAIL" "this box cannot clone from github.com - see TOG-1175 and docs/DEPLOY.md 2"
      exit 2
    fi
  fi
fi

# --- 6. Environment variables ----------------------------------------------
# Secrets go up with is_preview=false and the token marked so the panel masks
# it in build logs. Re-running replaces values rather than appending.
set_env() { # set_env KEY VALUE
  local k="$1" v="$2"
  local b
  b="$(python3 -c "
import json,sys
print(json.dumps({'key':sys.argv[1],'value':sys.argv[2],'is_preview':False}))" "$k" "$v")"
  api POST "applications/$app_uuid/envs" "$b" >/dev/null 2>&1 \
    || api PATCH "applications/$app_uuid/envs" "$b" >/dev/null 2>&1 || true
}

set_env DISCORD_BOT_TOKEN "$DISCORD_BOT_TOKEN"
set_env DISCORD_GUILD_ID "$GUILD_ID"
set_env TWO_DATABASE_URL "$TWO_DATABASE_URL"
set_env DISCORD_STAFF_ALERT_CHANNEL_ID "${DISCORD_STAFF_ALERT_CHANNEL_ID:-}"
set_env TWO_ONBOARDING_DRY_RUN "${TWO_ONBOARDING_DRY_RUN:-1}"
set_env LOG_LEVEL "${LOG_LEVEL:-info}"
echo "  environment variables applied (DISCORD_BOT_TOKEN not echoed)"

# --- 7. Deploy --------------------------------------------------------------
dep="$(api POST "deploy?uuid=$app_uuid&force=false")"
dep_uuid="$(printf '%s' "$dep" | jq_get "d.get('deployments',[{}])[0].get('deployment_uuid','')")"
echo "  deployment $dep_uuid queued"

# --- 8. Wait for it to actually be healthy ----------------------------------
# The deploy gate is /readyz, which means gateway connected AND database
# answering - not merely that a process exists. Cold start connects to the
# gateway and runs migrations, so the start period is generous on purpose.
deadline=$((SECONDS + 600))
status=""
while (( SECONDS < deadline )); do
  sleep 15
  status="$(api GET "deployments/$dep_uuid" | jq_get "d.get('status','')")"
  echo "    deployment status: ${status:-unknown}"
  case "$status" in
    finished) break ;;
    failed|cancelled)
      echo
      echo "Deploy $status. Logs: $COOLIFY_URL/project/$project_uuid"
      exit 3 ;;
  esac
done

if [[ "$status" != "finished" ]]; then
  echo
  echo "Deploy did not finish within 10 minutes (last status: ${status:-unknown})."
  exit 3
fi

app="$(api GET "applications/$app_uuid")"
app_status="$(printf '%s' "$app" | jq_get "d.get('status','')")"
echo
echo "Deployed. application status: $app_status"
case "$app_status" in
  running*|*healthy*) echo "Rollback if needed: Deployments -> previous entry -> Redeploy (docs/DEPLOY.md §7)."; exit 0 ;;
  *) echo "Deployment finished but the application is not reporting healthy."
     echo "Read /readyz in the logs: gateway_disconnected or database_unreachable."
     exit 3 ;;
esac
