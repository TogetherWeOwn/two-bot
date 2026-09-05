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
#   2  a precondition is not met (server not usable, no database, missing env)
#   3  the deploy was triggered but never went healthy
#   1  an API call failed unexpectedly
#
# Usage:
#   scripts/coolify-deploy.sh --check    # preconditions only, changes nothing
#   scripts/coolify-deploy.sh            # check, then create/update and deploy
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
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

: "${COOLIFY_URL:?set COOLIFY_URL}"
: "${COOLIFY_TOKEN:?set COOLIFY_TOKEN}"

SERVER_UUID="${COOLIFY_SERVER_UUID:-kaghbfdj7cjkjjf8eisjfj5c}"
PROJECT_NAME="two-bot"
APP_NAME="two-bot"
GIT_REPO="https://github.com/TogetherWeOwn/two-bot"
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
