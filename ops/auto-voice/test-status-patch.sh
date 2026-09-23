#!/usr/bin/env bash
# TOG-3143 — tests for ./status-patch.sh, the Discord-presence patch.
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
# THE FIXTURE reproduces upstream's emitted `bot/dist/gateway/client.js` at the
# pinned commit 8fab5e8d78aa252195dcea1bcd3d313cb1ba0802. The two anchor lines —
# the `SETUP_STATUS` declaration and the `activities:` line, including its
# 12-space indent and the U+00B7 MIDDLE DOT — are byte-for-byte what
# `tsc --build` emits there, verified 2026-09-17 by compiling
# `bot/src/gateway/client.ts` at that commit. The declaration is also byte-for-byte
# what the operator edited in the live container at 01:46Z.
#
# The fixture diverges from upstream in exactly one way, and only so that it can
# be IMPORTED: it declares `ActivityType` locally and returns the options object
# instead of `new Client(...)`, because discord.js is not installed here. That
# buys the strongest assertion available — several cases below import the patched
# module and read the presence it would actually hand to the gateway, rather than
# grepping the file and hoping that text implies behaviour.
#
# To run against a REAL build instead of the fixture:
#   AVC_REAL_DIST=/path/to/Auto-Voice-Channels/bot/dist/gateway/client.js ./test-status-patch.sh
# (the import-based cases skip themselves there, since a real build needs
# discord.js on the module path.)
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
ACT_ANCHOR="            activities: [{ type: ActivityType.Custom, name: SETUP_STATUS, state: SETUP_STATUS }],"
make_root() { # $1=dest root, $2=client.js body override ("" = default fixture)
  local r="$1"
  mkdir -p "$r/bot/dist/gateway"
  if [ -n "${AVC_REAL_DIST:-}" ] && [ -z "$2" ]; then
    cp "$AVC_REAL_DIST" "$r/bot/dist/gateway/client.js"
  elif [ -n "$2" ]; then
    printf '%s\n' "$2" > "$r/bot/dist/gateway/client.js"
  else
    { echo "const ActivityType = { Custom: 4 }; // stub: see the fixture note above"
      echo "/** doc comment mentioning SETUP_STATUS in prose */"
      echo "$ANCHOR"
      echo "export function buildGatewayClient(options) {"
      echo "    const clientOptions = {"
      echo "        shards: options.shardIds,"
      echo "        presence: {"
      echo "            status: 'online',"
      echo "$ACT_ANCHOR"
      echo "        },"
      echo "    };"
      echo "    return clientOptions;"
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
act_line() { grep '^ *activities:' "$1/bot/dist/gateway/client.js"; }
esm_ok() { cp "$1/bot/dist/gateway/client.js" "$1/c.mjs"; node --check "$1/c.mjs" >/dev/null 2>&1 && echo ok; }
# THE BEHAVIOURAL ASSERTION: import the patched module and report the presence it
# hands the gateway, as JSON. This is what Discord would render.
rendered() {
  node --input-type=module -e "
    const m = await import('file://$1/bot/dist/gateway/client.js');
    const p = m.buildGatewayClient({ shardIds: [0], totalShards: 1 }).presence;
    process.stdout.write(JSON.stringify(p.activities));
  " 2>/dev/null
}
IMPORTABLE=1; [ -n "${AVC_REAL_DIST:-}" ] && IMPORTABLE=0
behaves(){ # name expected root — skipped against a real build (needs discord.js)
  if [ "$IMPORTABLE" = "0" ]; then printf '  \033[33mSKIP\033[0m %s (real build)\n' "$1"; return; fi
  check "$1" "$(rendered "$3")" "$2"
}

NO_STATUS='[]'
WITH_SETUP='[{"type":4,"name":"/setup","state":"/setup"}]'
ADVERT="$(printf '[{"type":4,"name":"auto-voice.io \xc2\xb7 /setup","state":"auto-voice.io \xc2\xb7 /setup"}]')"

echo "== cases =="

# --- the property the card is named for --------------------------------------
# G0 DEFAULT IS REMOVAL. No AVC_* variable set at all — the state a redeploy that
# passes nothing would produce — must yield NO custom status. This is the case
# the previous revision could not express at any setting, and it is the owner's
# instruction of 01:48Z ("REMOVE THE WHOLE STATUS"). Env is scrubbed, not
# overridden, so `set -eu` in the script is exercised too.
R="$WORK/g0"; make_root "$R" ""
out="$(cd "$R" && env -u AVC_STATUS_MODE -u AVC_STATUS_TEXT -u AVC_STATUS_ENFORCE \
        AVC_STATUS_TARGET="$R/bot/dist/gateway/client.js" \
        /bin/sh "$SCRIPT" node bot/dist/index.js 2>&1)"; rc=$?
check "G0 rc=0 with no AVC_ variable set"   "$rc" "0"
check "G0 starts the bot"                   "$(echo "$out" | grep -c BOOTED)" "1"
check "G0 activities array emptied"         "$(act_line "$R")" "            activities: [],"
check "G0 file is valid ESM"                "$(esm_ok "$R")" "ok"
behaves "G0 renders NO activity at all"     "$NO_STATUS" "$R"

# G0c POSITIVE CONTROL for G0: the untouched fixture really does render the
# advert, so G0's green is caused by the patch and not by an inert fixture.
R="$WORK/g0c"; make_root "$R" ""
behaves "G0c control: unpatched fixture renders the advert" "$ADVERT" "$R"
check "G0c control: fixture has both anchors" \
  "$(decl "$R")$(grep -cF -- "$ACT_ANCHOR" "$R/bot/dist/gateway/client.js")" "11"

# G0b THE ADVERT IS UNREACHABLE except by asking for it. No MODE/TEXT pair other
# than MODE=upstream may leave upstream's advert rendering.
R="$WORK/g0b"; make_root "$R" ""
run "$R" AVC_STATUS_MODE=none >/dev/null
check "G0b none: advert not rendered"  "$(grep -c 'name: SETUP_STATUS' "$R/bot/dist/gateway/client.js")" "0"
R="$WORK/g0b2"; make_root "$R" ""
run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT=/setup >/dev/null
check "G0b2 text: advert string gone"  "$(grep -c 'auto-voice\.io' "$R/bot/dist/gateway/client.js")" "0"

# G13 removal is idempotent: a restart re-runs this on the same writable layer.
R="$WORK/g13"; make_root "$R" ""
run "$R" AVC_STATUS_MODE=none >/dev/null
out="$(run "$R" AVC_STATUS_MODE=none)"; rc=$?
check "G13 second run rc=0"              "$rc" "0"
check "G13 reports already applied"      "$(echo "$out" | grep -c 'already applied - no custom status')" "1"
check "G13 still exactly one activities line" "$(grep -c '^ *activities:' "$R/bot/dist/gateway/client.js")" "1"
behaves "G13 still renders nothing"      "$NO_STATUS" "$R"

# G14 mode switching on ONE writable layer, both directions. `docker restart`
# keeps the layer, so none->text must repair the array it emptied or the text
# would be set and nothing would render.
R="$WORK/g14"; make_root "$R" ""
run "$R" AVC_STATUS_MODE=none >/dev/null
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT=/setup)"; rc=$?
check "G14 none->text rc=0"              "$rc" "0"
check "G14 says it restored the activity" "$(echo "$out" | grep -c 'restored the presence activity')" "1"
behaves "G14 none->text renders the text" "$WITH_SETUP" "$R"
out="$(run "$R" AVC_STATUS_MODE=none)"; rc=$?
check "G14 text->none rc=0"              "$rc" "0"
behaves "G14 text->none renders nothing" "$NO_STATUS" "$R"

# G15 our own misconfiguration is ALWAYS fatal, warn mode included. `warn` exists
# to survive upstream moving; it must never boot the advert because a mode was
# mistyped — that is the silent regression this card exists to stop.
R="$WORK/g15"; make_root "$R" ""
out="$(run "$R" AVC_STATUS_MODE=nonw AVC_STATUS_ENFORCE=warn)"; rc=$?
check "G15a bad mode rc=1 even in warn"  "$rc" "1"
check "G15a names the legal modes"       "$(echo "$out" | grep -c 'none|text|upstream')" "1"
check "G15a did NOT start the bot"       "$(echo "$out" | grep -c BOOTED)" "0"
out="$(run "$R" AVC_STATUS_MODE=none AVC_STATUS_TEXT=hello AVC_STATUS_ENFORCE=warn)"; rc=$?
check "G15b none+text rc=1 even in warn" "$rc" "1"
check "G15b points at MODE=text"         "$(echo "$out" | grep -c 'set AVC_STATUS_MODE=text')" "1"
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT= AVC_STATUS_ENFORCE=warn)"; rc=$?
check "G15c text+empty rc=1 even in warn" "$rc" "1"
check "G15c says it needs a text"        "$(echo "$out" | grep -c 'needs a non-empty')" "1"
check "G15 fixture untouched throughout" "$(grep -c 'auto-voice\.io' "$R/bot/dist/gateway/client.js")" "1"

# G16 fail-closed on the REMOVAL anchor. MODE=none does not need the constant, so
# only the activities line is required — and its absence must stop the boot.
R="$WORK/g16"; make_root "$R" "$(printf '%s\n%s' "$ANCHOR" "    somethingElse: [1],")"
out="$(run "$R" AVC_STATUS_MODE=none)"; rc=$?
check "G16 rc=1 when activities anchor missing" "$rc" "1"
check "G16 did NOT start the bot"        "$(echo "$out" | grep -c BOOTED)" "0"
check "G16 says the pin moved"           "$(echo "$out" | grep -c 'pin has moved')" "1"
# G16b and it tolerates the constant being gone, since it does not use it.
R="$WORK/g16b"; make_root "$R" "$(printf '%s' "$ACT_ANCHOR")"
out="$(run "$R" AVC_STATUS_MODE=none)"; rc=$?
check "G16b rc=0 without the constant"   "$rc" "0"
check "G16b still empties the array"     "$(act_line "$R")" "            activities: [],"

# --- the text mode, carried over from the previous revision -------------------
# G1 positive: the advert is replaced and the bot is then started.
R="$WORK/g1"; make_root "$R" ""
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT=/setup)"; rc=$?
check "G1 rc=0"                       "$rc" "0"
check "G1 booted after patching"      "$(echo "$out" | grep -c BOOTED)" "1"
check "G1 one declaration remains"    "$(decl "$R")" "1"
check "G1 declaration rewritten"      "$(line_of "$R")" 'const SETUP_STATUS = "/setup";'
check "G1 advert gone"                "$(grep -c 'auto-voice\.io' "$R/bot/dist/gateway/client.js")" "0"
check "G1 file is valid ESM"          "$(esm_ok "$R")" "ok"
behaves "G1 renders exactly that text" "$WITH_SETUP" "$R"

# G2 idempotent: a restart re-runs this; it must converge, not accumulate.
R="$WORK/g2"; make_root "$R" ""
run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT=/setup >/dev/null
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT=/setup)"; rc=$?
check "G2 second run rc=0"            "$rc" "0"
check "G2 reports already applied"    "$(echo "$out" | grep -c 'already applied')" "1"
check "G2 still one declaration"      "$(decl "$R")" "1"
check "G2 still the wanted text"      "$(line_of "$R")" 'const SETUP_STATUS = "/setup";'

# G3 fail-closed: constant missing (simulates an upstream pin bump) -> refuse to boot.
R="$WORK/g3"; make_root "$R" "$(printf '%s\n%s' "const OTHER_NAME = 'x';" "$ACT_ANCHOR")"
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT=/setup)"; rc=$?
check "G3 rc=1 when anchor missing"   "$rc" "1"
check "G3 did NOT start the bot"      "$(echo "$out" | grep -c BOOTED)" "0"
check "G3 says the pin moved"         "$(echo "$out" | grep -c 'pin has moved')" "1"

# G4 warn mode: same input, escape hatch engaged -> boot with upstream's status.
R="$WORK/g4"; make_root "$R" "$(printf '%s\n%s' "const OTHER_NAME = 'x';" "$ACT_ANCHOR")"
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT=/setup AVC_STATUS_ENFORCE=warn)"; rc=$?
check "G4 rc=0 in warn mode"          "$rc" "0"
check "G4 still starts the bot"       "$(echo "$out" | grep -c BOOTED)" "1"

# G5 ambiguity: two declarations must be refused, not half-patched.
R="$WORK/g5"; make_root "$R" "$(printf '%s\n%s\n%s' "$ANCHOR" "$ANCHOR" "$ACT_ANCHOR")"
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT=/setup)"; rc=$?
check "G5 rc=1 on duplicate anchors"  "$rc" "1"
check "G5 found 2"                    "$(echo "$out" | grep -c 'found 2')" "1"
# G5b the same ambiguity on the removal anchor, which MODE=none depends on.
R="$WORK/g5b"; make_root "$R" "$(printf '%s\n%s' "$ACT_ANCHOR" "$ACT_ANCHOR")"
out="$(run "$R" AVC_STATUS_MODE=none)"; rc=$?
check "G5b rc=1 on duplicate activities lines" "$rc" "1"
check "G5b did NOT start the bot"     "$(echo "$out" | grep -c BOOTED)" "0"

# G6 injection safety: the text is data, not code. Covers the `$&` replacement
# trap in String.replace and any quote/backslash the owner may pick.
R="$WORK/g6"; make_root "$R" ""
NASTY='a"b\c$&d`e'"'"'f'
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT="$NASTY")"; rc=$?
check "G6 rc=0"                       "$rc" "0"
check "G6 file still valid ESM"       "$(esm_ok "$R")" "ok"
got="$(node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const m = readFileSync('$R/bot/dist/gateway/client.js','utf8').match(/^const SETUP_STATUS = (.*);\$/m);
  process.stdout.write(String(JSON.parse(m[1])));
")"
check "G6 literal round-trips exactly" "$got" "$NASTY"

# G7 length: Discord truncates a custom status past 128 chars; catch it at boot.
R="$WORK/g7"; make_root "$R" ""
LONG="$(printf 'x%.0s' $(seq 1 129))"
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT="$LONG")"; rc=$?
check "G7 rc=1 at 129 chars"          "$rc" "1"
check "G7 names the limit"            "$(echo "$out" | grep -c '128-character')" "1"
R="$WORK/g7b"; make_root "$R" ""
OK128="$(printf 'x%.0s' $(seq 1 128))"
out="$(run "$R" AVC_STATUS_MODE=text AVC_STATUS_TEXT="$OK128")"; rc=$?
check "G7b control: 128 chars is fine" "$rc" "0"

# G8 the opt-in escape hatch: MODE=upstream runs stock upstream, advert and all.
# This is now the ONLY way to get the advert, and it has to be asked for by name.
R="$WORK/g8"; make_root "$R" ""
out="$(run "$R" AVC_STATUS_MODE=upstream)"; rc=$?
check "G8 rc=0 when disabled"         "$rc" "0"
check "G8 starts the bot"             "$(echo "$out" | grep -c BOOTED)" "1"
check "G8 leaves upstream untouched"  "$(grep -c 'auto-voice\.io' "$R/bot/dist/gateway/client.js")" "1"
check "G8 activities line untouched"  "$(act_line "$R")" "$ACT_ANCHOR"
behaves "G8 renders upstream's advert" "$ADVERT" "$R"

# --- wiring, publishability, invocation --------------------------------------
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
# G9f compose must not default the mode back to a status. The owner asked for
# removal; a default of `text` here would reintroduce it one edit at a time.
check "G9f compose defaults the mode to none" \
  "$(grep -cF -- '${AVC_STATUS_MODE:-none}' "$COMPOSE")" "1"
check "G9g compose defaults the text to empty" \
  "$(grep -cE 'AVC_STATUS_TEXT: \$\{AVC_STATUS_TEXT:-\}' "$COMPOSE")" "1"

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

# G12 the no-command guard: compose clears the image CMD, so a missing `command:`
# must be a loud failure and not a container that exits 0 looking successful.
out="$(/bin/sh "$SCRIPT" 2>&1)"; rc=$?
check "G12 rc=1 with no command to exec"   "$rc" "1"
check "G12 says what is missing"           "$(echo "$out" | grep -c 'no command given')" "1"

echo
echo "fixture: ${AVC_REAL_DIST:-synthetic (set AVC_REAL_DIST to use a real build)}"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
