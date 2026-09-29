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
# Reviewed settings-wiring surface baseline (TOG-8977): the runtime commit the
# surface excerpts were measured at. The running runtime is NOT pinned to this
# value — staging redeploys on nearly every merge. Instead the wrapper reads
# the running commit from the container and verifies its surface files are
# byte-identical to this baseline (see verify-surface.sh). A touched surface
# refuses; a newer SHA with an identical surface passes.
BASELINE=c2a00876d9772c0e341e7aed643518cf02d100a3
C="bot-$APP"
MODE="${1:-}"
SOURCE="${2:-}"
refuse() { printf '%s\n' 'REFUSED: source, runtime, or exclusive-window precondition failed.' >&2; exit 2; }
[[ "$MODE" == run || "$MODE" == recover ]] || refuse
[[ "$SOURCE" =~ ^[a-f0-9]{40}$ ]] || refuse
[[ "${PROOF_EXCLUSIVE_WINDOW:-}" == staging-writers-quiesced ]] || refuse
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
[[ "$(git -C "$ROOT" rev-parse "$SOURCE^{commit}")" == "$SOURCE" ]] || refuse
# Refuse edited/mismatched packet bytes, not just a claimed commit in an env
# var. Covers the wrapper, the engine, the surface verifier, the excerpt
# fixture and the offline tests: verify-surface.sh reads its expected blobs
# from the $SOURCE fixture object, so test/ is pinned here too.
git -C "$ROOT" diff --quiet "$SOURCE" -- ops/tog-4104 test/fixtures/tog4104-runtime-source.json test/tog4104-offline.test.ts test/tog4104-discovery.test.ts test/tog4104-runtime-wiring.test.ts test/tog4104-settingspoof-offline.test.mjs test/tog4104-wrapper-offline.test.mjs || refuse
[[ -z "$(git -C "$ROOT" ls-files --others --exclude-standard -- ops/tog-4104 test/fixtures/tog4104-runtime-source.json test/tog4104-offline.test.ts test/tog4104-discovery.test.ts test/tog4104-runtime-wiring.test.ts test/tog4104-settingspoof-offline.test.mjs test/tog4104-wrapper-offline.test.mjs)" ]] || refuse
# The operator declares the running commit they measured (SOURCE_COMMIT from
# the Coolify panel, as in the 2026-09-28 hand-back on TOG-8977). It must be a
# full SHA before any Docker operation; the surface check below decides whether
# that commit may run. A newer staging SHA with an untouched surface passes —
# the pin no longer goes stale on every redeploy.
[[ "${PROOF_RUNTIME_REVISION:-}" =~ ^[a-f0-9]{40}$ ]] || refuse
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
# running runtime. Tags and revision labels alone are not attestation.
[[ -n "${PROOF_IMAGE_ID:-}" ]] || refuse
[[ "$IMAGE_ID" == "$PROOF_IMAGE_ID" ]] || refuse
# The engine runs inside the container netns, so it reaches the listener at the
# container's own interface address — never loopback-by-assumption. Derive the
# address from the inspected container (first non-internal interface, Docker
# lists them in the container's own network namespace) and the port from the
# container's own environment. Both are measured, not operator-declared: an
# operator-supplied URL could point the proof at an impostor that always
# passes. Resolved here, before the surface check copies anything, so an
# unresolvable address refuses before any copy or exec.
CONTAINER_IP="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.IPAddress}} {{end}}' "$CID" | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1)" || refuse
[[ "$CONTAINER_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse
CONTAINER_PORT="$(docker exec "$CID" printenv TWO_INTERNAL_PORT 2>/dev/null || true)"
[[ -z "$CONTAINER_PORT" ]] && CONTAINER_PORT=8787
[[ "$CONTAINER_PORT" =~ ^[0-9]+$ ]] && (( CONTAINER_PORT >= 1 && CONTAINER_PORT <= 65535 )) || refuse
URL="http://$CONTAINER_IP:$CONTAINER_PORT"
# The declared running commit is cross-checked, not trusted: verify-surface.sh
# copies the surface files out of this same container and byte-compares them
# against the reviewed baseline. A declared SHA with a touched surface still
# refuses. The declared value is recorded in PROOF TARGET and forwarded to the
# engine receipt.
bash "$(dirname "${BASH_SOURCE[0]}")/verify-surface.sh" "$CID" "$BASELINE" "$SOURCE" || refuse
RUNTIME="${PROOF_RUNTIME_REVISION:-}"
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
