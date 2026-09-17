#!/usr/bin/env bash
# TOG-3143 — tests for ./status-patch.sh, the Discord-status patch.
#
# The thing under test is the shipped file itself: this runs `status-patch.sh`
# directly, with no extraction and no copy, so the test cannot drift from what
# deploys. Extraction WOULD be needed if the script still lived inside
# `docker-compose.yml`; it does not, for the licence reason in README.md §1.1.
#
# Because the script and the compose file can now disagree with each other, G9
# below asserts the wiring between them: the mount, the entrypoint path, and the
# restated upstream CMD.
#
# The fixture reproduces upstream's emitted
# `bot/dist/gateway/client.js` at the pinned commit
# 8fab5e8d78aa252195dcea1bcd3d313cb1ba0802. The declaration line below is
# byte-for-byte what `pnpm run build` produces there (verified 2026-09-17,
# including the U+00B7 MIDDLE DOT), and byte-for-byte what the operator edited
# in the live container at 01:46Z.
#
# To run against a REAL build instead of the fixture:
#   AVC_REAL_DIST=/path/to/Auto-Voice-Channels/bot/dist/gateway/client.js ./test-status-patch.sh
#
# Requires: bash, node.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$HERE/docker-compose.yml"
SCRIPT="$HERE/status-patch.sh"
# The path status-patch.sh is mounted at inside the container. G9 checks that the
# compose file agrees with this on both the volume and the entrypoint.
MOUNT="/opt/avc/status-patch.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; printf '       %s\n' "$2"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

[ -s "$SCRIPT" ] || { echo "FATAL: $SCRIPT is missing or empty"; exit 1; }

# --- the fixture -------------------------------------------------------------
ANCHOR="const SETUP_STATUS = 'auto-voice.io "$'\xc2\xb7'" /setup';"
make_root() { # $1=dest root, $2=client.js body override ("" = default fixture)
  local r="$1"
  mkdir -p "$r/bot/dist/gateway"
  if [ -n "${AVC_REAL_DIST:-}" ] && [ -z "$2" ]; then
    cp "$AVC_REAL_DIST" "$r/bot/dist/gateway/client.js"
  elif [ -n "$2" ]; then
    printf '%s\n' "$2" > "$r/bot/dist/gateway/client.js"
  else
    { echo "import { ActivityType, Client } from 'discord.js';"
      echo "/** doc comment mentioning SETUP_STATUS in prose */"
      echo "$ANCHOR"
      echo "export function buildGatewayClient(o) {"
      echo "    return new Client({ presence: { status: 'online',"
      echo "        activities: [{ type: ActivityType.Custom, name: SETUP_STATUS, state: SETUP_STATUS }] } });"
      echo "}"
    } > "$r/bot/dist/gateway/client.js"
  fi
  # stub for upstream's CMD so `exec node bot/dist/index.js` is exercised for real
  echo 'console.log("BOOTED");' > "$r/bot/dist/index.js"
}

run() { # $1=root  rest=env assignments; echoes output, returns rc
  local r="$1"; shift
  # `/bin/sh <script> node bot/dist/index.js` is exactly how the compose file
  # invokes it: entrypoint + the restated upstream CMD as arguments. G9 pins
  # that correspondence.
  ( cd "$r" && env AVC_STATUS_TARGET="$r/bot/dist/gateway/client.js" "$@" \
      /bin/sh "$SCRIPT" node bot/dist/index.js 2>&1 )
}
decl() { grep -c '^const SETUP_STATUS' "$1/bot/dist/gateway/client.js"; }
line_of() { grep '^const SETUP_STATUS' "$1/bot/dist/gateway/client.js"; }

echo "== cases =="

# G1 positive: the advert is replaced and the bot is then started.
R="$WORK/g1"; make_root "$R" ""
out="$(run "$R" AVC_STATUS_TEXT=/setup)"; rc=$?
check "G1 rc=0"                       "$rc" "0"
check "G1 booted after patching"      "$(echo "$out" | grep -c BOOTED)" "1"
check "G1 one declaration remains"    "$(decl "$R")" "1"
check "G1 declaration rewritten"      "$(line_of "$R")" 'const SETUP_STATUS = "/setup";'
check "G1 advert gone"                "$(grep -c 'auto-voice\.io' "$R/bot/dist/gateway/client.js")" "0"
check "G1 file is valid ESM"          "$(cp "$R/bot/dist/gateway/client.js" "$R/c.mjs"; node --check "$R/c.mjs" >/dev/null 2>&1 && echo ok)" "ok"

# G1c POSITIVE CONTROL for G3/G5: the fixture as shipped does contain the anchor,
# so a later red result is caused by the mutation and not by a broken fixture.
R="$WORK/g1c"; make_root "$R" ""
check "G1c control: fixture has the anchor" "$(decl "$R")" "1"

# G2 idempotent: a restart re-runs this; it must converge, not accumulate.
R="$WORK/g2"; make_root "$R" ""
run "$R" AVC_STATUS_TEXT=/setup >/dev/null
out="$(run "$R" AVC_STATUS_TEXT=/setup)"; rc=$?
check "G2 second run rc=0"            "$rc" "0"
check "G2 reports already applied"    "$(echo "$out" | grep -c 'already applied')" "1"
check "G2 still one declaration"      "$(decl "$R")" "1"
check "G2 still the wanted text"      "$(line_of "$R")" 'const SETUP_STATUS = "/setup";'

# G3 fail-closed: anchor missing (simulates an upstream pin bump) -> refuse to boot.
R="$WORK/g3"; make_root "$R" "const OTHER_NAME = 'x';"
out="$(run "$R" AVC_STATUS_TEXT=/setup)"; rc=$?
check "G3 rc=1 when anchor missing"   "$rc" "1"
check "G3 did NOT start the bot"      "$(echo "$out" | grep -c BOOTED)" "0"
check "G3 says the pin moved"         "$(echo "$out" | grep -c 'pin has moved')" "1"

# G4 warn mode: same input, escape hatch engaged -> boot with upstream's status.
R="$WORK/g4"; make_root "$R" "const OTHER_NAME = 'x';"
out="$(run "$R" AVC_STATUS_TEXT=/setup AVC_STATUS_ENFORCE=warn)"; rc=$?
check "G4 rc=0 in warn mode"          "$rc" "0"
check "G4 still starts the bot"       "$(echo "$out" | grep -c BOOTED)" "1"

# G5 ambiguity: two declarations must be refused, not half-patched.
R="$WORK/g5"; make_root "$R" "$(printf '%s\n%s' "$ANCHOR" "$ANCHOR")"
out="$(run "$R" AVC_STATUS_TEXT=/setup)"; rc=$?
check "G5 rc=1 on duplicate anchors"  "$rc" "1"
check "G5 found 2"                    "$(echo "$out" | grep -c 'found 2')" "1"

# G6 injection safety: the text is data, not code. Covers the `$&` replacement
# trap in String.replace and any quote/backslash the owner may pick on TOG-3142.
R="$WORK/g6"; make_root "$R" ""
NASTY='a"b\c$&d`e'"'"'f'
out="$(run "$R" AVC_STATUS_TEXT="$NASTY")"; rc=$?
check "G6 rc=0"                       "$rc" "0"
check "G6 file still valid ESM"       "$(cp "$R/bot/dist/gateway/client.js" "$R/c.mjs"; node --check "$R/c.mjs" >/dev/null 2>&1 && echo ok)" "ok"
got="$(node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const m = readFileSync('$R/bot/dist/gateway/client.js','utf8').match(/^const SETUP_STATUS = (.*);\$/m);
  process.stdout.write(String(JSON.parse(m[1])));
")"
check "G6 literal round-trips exactly" "$got" "$NASTY"

# G7 length: Discord truncates a custom status past 128 chars; catch it at boot.
R="$WORK/g7"; make_root "$R" ""
LONG="$(printf 'x%.0s' $(seq 1 129))"
out="$(run "$R" AVC_STATUS_TEXT="$LONG")"; rc=$?
check "G7 rc=1 at 129 chars"          "$rc" "1"
check "G7 names the limit"            "$(echo "$out" | grep -c '128-character')" "1"
R="$WORK/g7b"; make_root "$R" ""
OK128="$(printf 'x%.0s' $(seq 1 128))"
out="$(run "$R" AVC_STATUS_TEXT="$OK128")"; rc=$?
check "G7b control: 128 chars is fine" "$rc" "0"

# G8 disable switch: empty text runs stock upstream, advert and all.
R="$WORK/g8"; make_root "$R" ""
out="$(run "$R" AVC_STATUS_TEXT=)"; rc=$?
check "G8 rc=0 when disabled"         "$rc" "0"
check "G8 starts the bot"             "$(echo "$out" | grep -c BOOTED)" "1"
check "G8 leaves upstream untouched"  "$(grep -c 'auto-voice\.io' "$R/bot/dist/gateway/client.js")" "1"

# G9 wiring. The script is now a separate file, so compose and script can drift
# apart — which the old in-YAML version made impossible. These pin the seam.
# Prints the `- ` list items under a 4-space-indented key in the bot service.
block() {
  awk -v key="$1" '
    $0 == "    " key ":" { grab=1; next }
    grab && /^      - / { sub(/^      - /, ""); print; next }
    grab && (/^      #/ || /^[[:space:]]*$/) { next }
    grab { grab=0 }
  ' "$COMPOSE"
}
check "G9a compose mounts something read-only at the entrypoint path" \
  "$(grep -cF -- ":$MOUNT:ro" "$COMPOSE")" "1"
check "G9a2 and that something defaults to this script" \
  "$(grep -cF -- '${AVC_STATUS_PATCH_PATH:-./status-patch.sh}:' "$COMPOSE")" "1"
check "G9b entrypoint runs the mounted script" \
  "$(block entrypoint | tr '\n' ' ')" "/bin/sh $MOUNT "
check "G9c compose restates upstream's CMD" \
  "$(block command | tr '\n' ' ')" "node bot/dist/index.js "
check "G9d patch is no longer inlined in compose" \
  "$(grep -c 'SETUP_STATUS' "$COMPOSE")" "0"
check "G9d control: the script does carry the anchor" \
  "$(grep -c 'SETUP_STATUS' "$SCRIPT" | awk '{print ($1>0)?"yes":"no"}')" "yes"
check "G9e script is valid POSIX sh" \
  "$(/bin/sh -n "$SCRIPT" >/dev/null 2>&1 && echo ok)" "ok"

# G10 publishability. AGPL §13 obliges us to offer this file as Corresponding
# Source (README.md §1.1), so it must carry nothing about our deployment. This
# is the property that moving the patch out of docker-compose.yml bought, and it
# is cheap to regress by "just adding one variable" later.
check "G10 script names no deployment secret or topology" \
  "$(grep -cE 'POSTGRES|DISCORD_TOKEN|DIAGNOSTICS|WATCHDOG|CLIENT_ID|ADMIN_CHANNEL|[0-9]{17,20}' "$SCRIPT" \
     | awk '{print ($1==0)?"clean":"found "$1}')" "clean"
check "G10 control: compose does carry that detail" \
  "$(grep -cE 'POSTGRES|DISCORD_TOKEN|DIAGNOSTICS|WATCHDOG|CLIENT_ID|ADMIN_CHANNEL|[0-9]{17,20}' "$COMPOSE" \
     | awk '{print ($1>0)?"yes":"no"}')" "yes"

# G11 `set -u` guard. Extracting this into a real script added `set -eu`, which
# aborts on an unset variable — so a run with NO AVC_* variable at all has to be
# proven safe rather than assumed. Env is scrubbed here, not merely overridden.
R="$WORK/g11"; make_root "$R" ""
out="$(cd "$R" && env -u AVC_STATUS_TARGET -u AVC_STATUS_TEXT -u AVC_STATUS_ENFORCE \
        /bin/sh "$SCRIPT" node bot/dist/index.js 2>&1)"; rc=$?
check "G11 rc=0 with no AVC_ variable set" "$rc" "0"
check "G11 starts the bot"                 "$(echo "$out" | grep -c BOOTED)" "1"
check "G11 reports the patch disabled"     "$(echo "$out" | grep -c 'leaving upstream status in place')" "1"

# G12 the no-command guard: compose clears the image CMD, so a missing `command:`
# must be a loud failure and not a container that exits 0 looking successful.
out="$(/bin/sh "$SCRIPT" 2>&1)"; rc=$?
check "G12 rc=1 with no command to exec"   "$rc" "1"
check "G12 says what is missing"           "$(echo "$out" | grep -c 'no command given')" "1"

echo
echo "fixture: ${AVC_REAL_DIST:-synthetic (set AVC_REAL_DIST to use a real build)}"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
