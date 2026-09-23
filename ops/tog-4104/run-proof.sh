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
# This exact source never passes settings to startInternalActions. Both settings
# actions are denied even with flags enabled. No deployable replacement has been
# reviewed/pinned by this packet. Do not turn this HOLD into an override flag.
printf 'HOLD: runtime %s has no internal settings wiring; container %s is not invoked.\n' "$RUNTIME" "$C" >&2
printf '%s\n' 'Separately authorized wiring, image provenance and a freshly reviewed runtime pin are required; see SOURCE_IDENTITY.md.' >&2
exit 2
