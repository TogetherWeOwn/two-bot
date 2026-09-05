#!/usr/bin/env bash
# TOG-463 real-guild acceptance. Boots the real-Discord host, waits for the
# `acceptance_host_ready` line, runs the acceptance harness against it, then
# tears the host down. One script because the run has a number in it and a
# model retyping these env vars every time is how a green tick stops meaning
# anything.
set -uo pipefail

W="${W:?set W to the worktree}"
QA_DB="${QA_DB:?set QA_DB}"
OUT="${OUT:?set OUT to an output dir}"
CHANNEL_ID="${CHANNEL_ID:?set CHANNEL_ID to a THROWAWAY channel/thread}"
PORT="${PORT:-8791}"
SECRET="${SECRET:-$(openssl rand -hex 24)}"
SCHEMA="${SCHEMA:-qa_tog463_real}"
ROLE_KEY="${ROLE_KEY:-rocketleague}"
# A member who is actually in the guild; role.assign against a stranger is a
# different failure (404) and would mask the one we are measuring.
TARGET="${TARGET:?set TARGET to a discord user id in the guild}"

mkdir -p "$OUT"
cd "$W"

echo "== booting real-Discord host on :$PORT =="
TWO_HOST_DB="$QA_DB" \
TWO_HOST_SECRET="$SECRET" \
TWO_HOST_PORT="$PORT" \
TWO_HOST_CHANNEL_KEYS="qa-throwaway:$CHANNEL_ID" \
TWO_HOST_SCHEMA="$SCHEMA" \
node scripts/internal-actions-host-real.ts >"$OUT/host-boot.log" 2>&1 &
HOST_PID=$!
trap 'kill -TERM $HOST_PID 2>/dev/null; wait $HOST_PID 2>/dev/null' EXIT

for i in $(seq 1 60); do
  grep -q acceptance_host_ready "$OUT/host-boot.log" && break
  kill -0 $HOST_PID 2>/dev/null || { echo "HOST DIED"; cat "$OUT/host-boot.log"; exit 1; }
  sleep 1
done
grep -q acceptance_host_ready "$OUT/host-boot.log" || { echo "host never became ready"; cat "$OUT/host-boot.log"; exit 1; }
echo "-- boot line --"; grep acceptance_host_ready "$OUT/host-boot.log"
echo "-- internal_actions_listening (step 2: durable MUST be true) --"
grep internal_actions_listening "$OUT/host-boot.log" || echo "(no listening line)"

echo
echo "== acceptance harness =="
TWO_ACCEPT_URL="http://127.0.0.1:$PORT/internal/actions" \
TWO_ACCEPT_KEY_ID=web-staging \
TWO_ACCEPT_SECRET="$SECRET" \
TWO_ACCEPT_CHANNEL_KEY=qa-throwaway \
TWO_ACCEPT_ROLE_KEY="$ROLE_KEY" \
TWO_ACCEPT_DISCORD_ID="$TARGET" \
TWO_ACCEPT_DB="$QA_DB" \
TWO_ACCEPT_SCHEMA="$SCHEMA" \
node scripts/internal-actions-acceptance-qa.ts 2>&1 | tee "$OUT/acceptance.log"
RC=${PIPESTATUS[0]}

echo
echo "== host stderr/stdout tail (the endpoint's own view) =="
tail -40 "$OUT/host-boot.log"
echo
echo "acceptance exit code: $RC"
exit $RC
