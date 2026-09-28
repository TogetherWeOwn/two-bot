#!/usr/bin/env bash
# Host-side operator wrapper for the staging-only signed settings proof.
# No deployment, restart, flag or secret writes.
#
# Resolves the running staging container exactly once by exact name, records
# the immutable container and image IDs, then copies and executes only through
# the container ID. Forwarded into the container are only values already
# validated below against the packet pin: the app UUID (exact container name),
# the pinned runtime, the writer-exclusion declaration, the measured listener
# URL and the validated packet source SHA. Signing keys stay inside the
# container: this script never reads or passes TWO_INTERNAL_KEYS. None of the
# forwarded values is a secret.
set -euo pipefail
APP=uy4d9ndeygjcem6lgayhxgub
RUNTIME=47c48197d46647e34132544523e863e3c92d82ff
C="bot-$APP"
MODE="${1:-}"
SOURCE="${2:-}"
refuse() { printf '%s\n' 'REFUSED: source, runtime, or exclusive-window precondition failed.' >&2; exit 2; }
[[ "$MODE" == run || "$MODE" == recover ]] || refuse
[[ "$SOURCE" =~ ^[a-f0-9]{40}$ ]] || refuse
[[ "${PROOF_EXCLUSIVE_WINDOW:-}" == staging-writers-quiesced ]] || refuse
# The operator-declared runtime must equal this packet's reviewed pin before
# any Docker operation. Any other runtime refuses here; see SOURCE_IDENTITY.md.
[[ "${PROOF_RUNTIME_REVISION:-}" == "$RUNTIME" ]] || refuse
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
[[ "$(git -C "$ROOT" rev-parse "$SOURCE^{commit}")" == "$SOURCE" ]] || refuse
# Refuse edited/mismatched packet bytes, not just a claimed commit in an env var.
git -C "$ROOT" diff --quiet "$SOURCE" -- ops/tog-4104 || refuse
[[ -z "$(git -C "$ROOT" ls-files --others --exclude-standard -- ops/tog-4104)" ]] || refuse
# Resolve the running staging container exactly once by name. Everything after
# this point addresses the immutable container ID, never the mutable name.
IDENTITY="$(docker inspect --format '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.State.Running}}|{{.Image}}' "$C")" || refuse
CID="${IDENTITY%%|*}"; REST="${IDENTITY#*|}"
NAME="${REST%%|*}"; REST="${REST#*|}"
IMAGE_REF="${REST%%|*}"; REST="${REST#*|}"
RUNNING="${REST%%|*}"; IMAGE_ID="${REST##*|}"
[[ "$CID" =~ ^[a-f0-9]{64}$ ]] || refuse
[[ "$NAME" == "/$C" ]] || refuse
[[ "$RUNNING" == true ]] || refuse
# The immutable image ID must equal the operator-supplied build receipt for the
# exact pinned runtime. Tags and revision labels alone are not attestation.
[[ -n "${PROOF_IMAGE_ID:-}" ]] || refuse
[[ "$IMAGE_ID" == "$PROOF_IMAGE_ID" ]] || refuse
# The engine runs inside the container netns, so it reaches the listener at the
# container's own interface address — never loopback-by-assumption. Derive the
# address from the inspected container (first non-internal interface, Docker
# lists them in the container's own network namespace) and the port from the
# container's own environment. Both are measured, not operator-declared: an
# operator-supplied URL could point the proof at an impostor that always
# passes. The engine still refuses anything that is not loopback or one of its
# own private interface addresses.
CONTAINER_IP="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.IPAddress}} {{end}}' "$CID" | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1)" || refuse
[[ "$CONTAINER_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse
CONTAINER_PORT="$(docker exec "$CID" printenv TWO_INTERNAL_PORT 2>/dev/null || true)"
[[ -z "$CONTAINER_PORT" ]] && CONTAINER_PORT=8787
[[ "$CONTAINER_PORT" =~ ^[0-9]+$ ]] && (( CONTAINER_PORT >= 1 && CONTAINER_PORT <= 65535 )) || refuse
URL="http://$CONTAINER_IP:$CONTAINER_PORT"
printf '%s\n' "PROOF TARGET app=$APP container=$CID image=$IMAGE_ID ref=$IMAGE_REF runtime=$RUNTIME source=$SOURCE mode=$MODE url=$URL" >&2
docker exec "$CID" mkdir -p /tmp/tog-4104-proof
docker cp "$ROOT/ops/tog-4104/settings-signed-proof.mjs" "$CID:/tmp/tog-4104-proof/settings-signed-proof.mjs"
# Forward only values already validated above against the packet pin: the app
# (exact container name), the pinned runtime, the writer-exclusion declaration
# and the measured listener URL. Signing keys stay inside the container: this
# script never reads or passes TWO_INTERNAL_KEYS. None of these is a secret.
docker exec \
  -e "PROOF_SOURCE_SHA=$SOURCE" \
  -e "STAGING_APP_UUID=$APP" \
  -e "PROOF_RUNTIME_REVISION=$RUNTIME" \
  -e "PROOF_EXCLUSIVE_WINDOW=staging-writers-quiesced" \
  -e "INTERNAL_ACTIONS_URL=$URL" \
  "$CID" node /tmp/tog-4104-proof/settings-signed-proof.mjs "$MODE"
