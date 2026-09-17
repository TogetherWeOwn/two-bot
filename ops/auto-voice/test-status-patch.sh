#!/usr/bin/env bash
# TOG-3143 — tests for the Discord-status patch embedded in docker-compose.yml.
#
# The thing under test is the shell script inside `services.bot.entrypoint`. This
# file EXTRACTS that script from the compose file and runs it, so the test can
# never drift from what actually ships: edit the compose file and these tests
# re-read it.
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
# Requires: bash, python3 (stdlib only), node.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$HERE/docker-compose.yml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; printf '       %s\n' "$2"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

# --- extract the entrypoint script out of the compose file -------------------
# Dependency-free on purpose: this test must run with nothing installed.
SCRIPT="$WORK/entrypoint.sh"
python3 - "$COMPOSE" > "$SCRIPT" <<'PY'
import sys, re
lines = open(sys.argv[1], encoding='utf-8').read().split('\n')
out, i = [], 0
while i < len(lines) and lines[i].strip() != 'entrypoint:':
    i += 1
if i == len(lines):
    sys.exit('no entrypoint: key found in ' + sys.argv[1])
# find the `- |` block scalar under it
while i < len(lines) and lines[i].strip() != '- |':
    i += 1
if i == len(lines):
    sys.exit('entrypoint has no `- |` block scalar')
i += 1
indent = len(lines[i]) - len(lines[i].lstrip())
while i < len(lines):
    ln = lines[i]
    if ln.strip() and (len(ln) - len(ln.lstrip())) < indent:
        break
    out.append(ln[indent:] if len(ln) >= indent else ln)
    i += 1
sys.stdout.write('\n'.join(out).rstrip('\n') + '\n')
PY
[ -s "$SCRIPT" ] || { echo "FATAL: extracted an empty entrypoint script"; exit 1; }

echo "== extracted entrypoint script =="; sed 's/^/  | /' "$SCRIPT"; echo

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
  ( cd "$r" && env AVC_STATUS_TARGET="$r/bot/dist/gateway/client.js" "$@" \
      /bin/sh -ec "$(cat "$SCRIPT")" 2>&1 )
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

# G9 the compose script must contain no dollar sign: Compose interpolates those
# in values, and a silent mis-expansion here boots the wrong command.
check "G9 no dollar sign in script"   "$(grep -c '\$' "$SCRIPT")" "0"

echo
echo "fixture: ${AVC_REAL_DIST:-synthetic (set AVC_REAL_DIST to use a real build)}"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
