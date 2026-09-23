#!/usr/bin/env bash
# Host-side identity/provenance gate. No deployment, restart, flag or secret writes.
set -euo pipefail
APP=uy4d9ndeygjcem6lgayhxgub
RUNTIME=f5fd3e1d6d08847589d3bf48ebc0b0e198196e90
C="bot-$APP"
MODE="${1:-}"
SOURCE="${2:-}"
refuse() { printf '%s\n' 'REFUSED: source, runtime, or exclusive-window precondition failed.' >&2; exit 2; }
[[ "$MODE" == run || "$MODE" == recover ]] || refuse
[[ "$SOURCE" =~ ^[a-f0-9]{40}$ ]] || refuse
[[ "${PROOF_EXCLUSIVE_WINDOW:-}" == staging-writers-quiesced ]] || refuse
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
[[ "$(git -C "$ROOT" rev-parse "$SOURCE^{commit}")" == "$SOURCE" ]] || refuse
# Refuse edited/mismatched packet bytes, not just a claimed commit in an env var.
git -C "$ROOT" diff --quiet "$SOURCE" -- ops/tog-4104 || refuse
[[ -z "$(git -C "$ROOT" ls-files --others --exclude-standard -- ops/tog-4104)" ]] || refuse
IDENTITY="$(docker inspect --format '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.State.Running}}|{{.Image}}' "$C")"
IFS='|' read -r ID NAME IMAGE RUNNING DIGEST <<< "$IDENTITY"
[[ "$ID" =~ ^[a-f0-9]{64}$ && "$NAME" == "/$C" && "$RUNNING" == true && "$IMAGE" == *":$RUNTIME" && "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || refuse
# This is an operator assertion, not a distributed lock. Maintain the externally
# exclusive writer window until verified cleanup; see RUNBOOK.md for HOLD cases.
sleep 20
TARGET="/tmp/tog-4104-proof-$SOURCE.mjs"
# Address the immutable ID, never a name that could be reassigned mid-run.
docker cp "$ROOT/ops/tog-4104/settings-signed-proof.mjs" "$ID:$TARGET"
# Recheck the exact image/container before invocation; no keys ever cross here.
[[ "$(docker inspect --format '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.State.Running}}|{{.Image}}' "$ID")" == "$IDENTITY" ]] || refuse
printf 'runtime-container: %s\nruntime-image: %s\nproof-source: %s\n' "$ID" "$DIGEST" "$SOURCE"
docker exec \
  -e "STAGING_APP_UUID=$APP" \
  -e "PROOF_RUNTIME_REVISION=$RUNTIME" \
  -e "PROOF_SOURCE_SHA=$SOURCE" \
  -e 'PROOF_EXCLUSIVE_WINDOW=staging-writers-quiesced' \
  -e 'PROOF_STATE_DIR=/tmp/tog-4104-private' \
  -e 'INTERNAL_ACTIONS_URL=http://127.0.0.1:8787' \
  "$ID" node "$TARGET" "$MODE"
