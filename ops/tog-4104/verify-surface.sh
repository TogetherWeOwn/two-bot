#!/usr/bin/env bash
# Verify the running staging container's bytes carry the reviewed
# settings-wiring surface, without pinning the whole runtime commit.
#
# Inputs (all validated, none trusted on declaration):
#   $1  container ID (immutable, already resolved by exact name in run-proof.sh)
#   $2  reviewed surface baseline (full SHA, must equal the packet's baseline)
#   $3  packet source commit (full SHA, byte-checked by run-proof.sh)
#
# Method: read the expected surface (baseline commit + per-file blob IDs) from
# the packet source commit's fixture object — never the moving checkout, so a
# locally edited fixture cannot bless drifted container bytes. Copy the
# surface files out of the container through the immutable container ID, hash
# each, and compare. A file whose bytes differ — even by one line outside the
# excerpts — refuses. Newer-than-baseline SHAs with a byte-identical surface
# pass; any touched surface refuses. No secrets are read, printed or forwarded.
set -euo pipefail
CID="${1:-}"
BASELINE="${2:-}"
SOURCE="${3:-}"
refuse() { printf '%s\n' 'REFUSED: wiring-surface precondition failed.' >&2; exit 2; }
[[ "$CID" =~ ^[a-f0-9]{64}$ ]] || refuse
[[ "$BASELINE" =~ ^[a-f0-9]{40}$ ]] || refuse
[[ "$SOURCE" =~ ^[a-f0-9]{40}$ ]] || refuse
PACKET_DIR="$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(git -C "$PACKET_DIR" rev-parse --show-toplevel)"
FIXTURE_OBJECT="$SOURCE:test/fixtures/tog4104-runtime-source.json"
FIXTURE="$(git -C "$ROOT" show "$FIXTURE_OBJECT" 2>/dev/null)" || refuse
# The baseline must be this packet's reviewed surface baseline — read from the
# packet source object, not the checkout.
PACKET_BASELINE="$(FIXTURE="$FIXTURE" node -e "process.stdout.write(JSON.parse(process.env.FIXTURE).baseline)")" || refuse
[[ "$BASELINE" == "$PACKET_BASELINE" ]] || refuse
# Distinct surface files, in stable order, from the packet source object.
mapfile -t FILES < <(FIXTURE="$FIXTURE" node -e "
const blocks = JSON.parse(process.env.FIXTURE).blocks;
process.stdout.write([...new Set(Object.values(blocks).map((b) => b.path))].sort().join('\n'));") || refuse
[[ "${#FILES[@]}" -ge 1 ]] || refuse
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for path in "${FILES[@]}"; do
  # No traversal: fixture paths are repo-relative source files.
  [[ "$path" =~ ^[A-Za-z0-9_./-]+\.ts$ ]] || refuse
  [[ "$path" != *".."* ]] || refuse
  expected="$(FIXTURE="$FIXTURE" P="$path" node -e "
const blocks = JSON.parse(process.env.FIXTURE).blocks;
const blobs = Object.values(blocks).filter((b) => b.path === process.env.P).map((b) => b.blob);
if (new Set(blobs).size !== 1) throw new Error('split-blob');
process.stdout.write(blobs[0]);")" || refuse
  docker cp "$CID:/app/$path" "$TMP/file.ts" >/dev/null || refuse
  actual="$(git hash-object "$TMP/file.ts")" || refuse
  [[ "$actual" == "$expected" ]] || refuse
  rm -f "$TMP/file.ts"
done
printf '%s\n' "SURFACE OK container=$CID baseline=$BASELINE files=${#FILES[@]}" >&2
