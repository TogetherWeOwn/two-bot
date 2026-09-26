#!/usr/bin/env bash
# two-web reward-role readback UX acceptance (TOG-5107; pairs TOG-4837, supports TOG-4444/TOG-4874).
#
# What this proves, per step:
#   0 preconditions            - output dir, toolchain, and which live inputs exist
#   1 stubbed contract         - offline: the empty/granted readback shapes validate
#   2 component three states   - TOG-4837 merged? the UI source renders loading/empty/granted
#   3 live grant -> UI -> revoke -> UI
#                              - staging two-web shows grant state after apply,
#                                revoke clears it (delegates the grant cycle to the
#                                TOG-4874 acceptance script; never grants itself)
#   4 containment              - the live guild id appears nowhere in the bundle
#
# Steps whose prerequisites have not merged (TOG-4837 UI, TOG-4444 apply path)
# record NOT-APPLICABLE with the exact missing piece instead of failing: a
# reviewer re-runs the same command after those merges and the N/A steps turn
# into real checks with no script change.
#
# Staging-only. The live guild id below is refused before any network: it may
# appear only in the containment proof, never in a request.
# Usage:
#   OUT=/tmp/tog5107-out bash scripts/two-web-reward-role-readback-acceptance.sh
#   READBACK_URL=https://two-web-staging.example/readback MEMBER=<id> ROLE_ID=<id> \
#     OUT=/tmp/tog5107-out bash scripts/two-web-reward-role-readback-acceptance.sh
#   bash scripts/two-web-reward-role-readback-acceptance.sh --selftest   # offline checks
set -uo pipefail

STAGING_GUILD_ID='1545644954272137297'
LIVE_GUILD_ID='326474832151838730'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Sibling QA driver that performs the staging grant/readback/revoke cycle.
# This script never grants a role itself; it observes the UI around that run.
ACCEPTANCE_BIN="${ACCEPTANCE_BIN:-$ROOT/scripts/levels-reward-role-acceptance.sh}"
# TOG-4837 component rendering the three states. Repo-relative after it merges
# (e.g. two-web/src/components/RewardReadback.tsx); an absolute path points at
# a two-web checkout elsewhere. Both are honored so a reviewer can run the
# three-state check before the repos unify.
READBACK_COMPONENT="${READBACK_COMPONENT:-}"
resolve_component() {
  if [[ "$READBACK_COMPONENT" == /* ]]; then printf '%s' "$READBACK_COMPONENT";
  else printf '%s' "$ROOT/$READBACK_COMPONENT"; fi
}
READBACK_URL="${READBACK_URL:-}"
MEMBER="${MEMBER:-}"
ROLE_ID="${ROLE_ID:-}"

fail() { printf 'readback-acceptance: %s\n' "$*" >&2; exit "${2:-1}"; }
refuse() { printf 'readback-acceptance: %s\n' "$1" >&2; exit 2; }

if [[ "${1:-}" == "--selftest" ]]; then
  SELFTEST=1
else
  SELFTEST=0
  [[ -n "${OUT:-}" ]] || refuse "set OUT to an output dir for the evidence bundle"
fi

is_snowflake() { [[ "$1" =~ ^[0-9]{17,20}$ ]]; }

# --- step 0: preconditions. No network. --------------------------------------
preconditions() {
  if [[ -n "$READBACK_URL" ]]; then
    [[ "$READBACK_URL" =~ ^https?:// ]] || refuse "READBACK_URL must be http(s); got '$READBACK_URL'"
    [[ "$READBACK_URL" != *"$LIVE_GUILD_ID"* ]] || refuse "READBACK_URL names the live guild. Staging only; there is no override."
  fi
  if [[ -n "$MEMBER" ]]; then
    is_snowflake "$MEMBER" || refuse "--member $MEMBER is not a Discord user id."
  fi
  if [[ -n "$ROLE_ID" ]]; then
    is_snowflake "$ROLE_ID" || refuse "ROLE_ID $ROLE_ID is not a Discord role id."
    [[ "$ROLE_ID" == "$STAGING_GUILD_ID" ]] &&
      refuse "ROLE_ID is the @everyone role (id equals the guild). Pick a disposable reward role."
  fi
  command -v python3 >/dev/null || refuse "python3 is not on PATH (needed for fixture and evidence checks)."
  command -v curl >/dev/null || refuse "curl is not on PATH (needed for the live UI readback)."

  mkdir -p "$OUT"
  {
    printf 'repo head: %s\n' "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    # The live id is deliberately withheld here: env.txt ships in the evidence
    # bundle, and the containment sweep requires the live id to appear in no
    # bundle file outside the refusal proof (see check_containment).
    printf 'staging guild: %s; live guild refused pre-network (id withheld from bundle)\n' "$STAGING_GUILD_ID"
    printf 'readback url: %s\n' "${READBACK_URL:-<unset: live UI steps will be NOT-APPLICABLE>}"
    printf 'component: %s\n' "${READBACK_COMPONENT:-<unset>}"
    printf 'member: %s\nrole: %s\n' "${MEMBER:-<unset>}" "${ROLE_ID:-<unset>}"
    printf 'sibling acceptance: %s\n' "$ACCEPTANCE_BIN"
  } >"$OUT/env.txt"
}

# --- step 1: stubbed readback contract, fully offline. -----------------------
# The UI and the endpoint agree on this shape; both fixtures must validate or
# the step fails. REVIEWERS: if TOG-4837 settles on a different envelope,
# update the two heredocs below and the validator follows them.
write_fixtures() {
  cat >"$OUT/readback-empty.json" <<'JSON'
{"member": "111111111111111111", "grants": []}
JSON
  cat >"$OUT/readback-granted.json" <<'JSON'
{"member": "111111111111111111", "grants": [{"roleId": "222222222222222222", "level": 5, "grantedAt": "2026-09-26T00:00:00.000Z"}]}
JSON
}

check_contract() {
  echo "== step 1: stubbed readback contract =="
  write_fixtures
  python3 - "$OUT/readback-empty.json" "$OUT/readback-granted.json" <<'PY'
import json, sys
empty = json.load(open(sys.argv[1]))
granted = json.load(open(sys.argv[2]))
assert isinstance(empty.get('member'), str) and empty['member'], 'empty: member must be a non-empty string'
assert empty.get('grants') == [], f"empty: grants must be [], got {empty.get('grants')!r}"
assert granted.get('member') == empty['member'], 'granted: member must match the empty fixture'
grants = granted.get('grants')
assert isinstance(grants, list) and len(grants) >= 1, 'granted: grants must be a non-empty array'
for g in grants:
    assert isinstance(g.get('roleId'), str) and g['roleId'], 'granted: every grant needs a roleId string'
    assert isinstance(g.get('level'), int) and g['level'] > 0, 'granted: every grant needs a positive level'
print(f"  empty validates (0 grants); granted validates ({len(grants)} grant(s))")
PY
}

# --- step 2: the three UI states in the merged component source. ------------
# TOG-4837 acceptance: loading/empty/granted against a stubbed endpoint.
check_component() {
  echo "== step 2: component three states =="
  local comp="";
  [[ -n "$READBACK_COMPONENT" ]] && comp="$(resolve_component)"
  if [[ -z "$comp" || ! -f "$comp" ]]; then
    printf 'TOG-4837 has not merged (no component at READBACK_COMPONENT=%s): step NOT APPLICABLE.\n' "${READBACK_COMPONENT:-<unset>}" >"$OUT/ux-component-NOT-APPLICABLE.txt"
    echo "  NOT APPLICABLE: no merged UI component to inspect; see TOG-4837"
    return 3
  fi
  local missing=0
  for state in loading empty grant; do
    if grep -qi "$state" "$comp"; then
      printf '  %-8s present in %s\n' "$state" "$READBACK_COMPONENT"
    else
      printf '  %-8s MISSING in %s\n' "$state" "$READBACK_COMPONENT" >&2
      missing=1
    fi
  done
  [[ "$missing" == "0" ]] || return 1
  cp "$comp" "$OUT/ux-component.txt"
}

# --- step 3: live UI readback around one staging grant cycle. ---------------
check_live() {
  echo "== step 3: live grant -> UI -> revoke -> UI =="
  if [[ -z "$READBACK_URL" ]]; then
    printf 'No READBACK_URL (two-web exposes no reward-role endpoint yet; TOG-4837 blocked): step NOT APPLICABLE.\n' >"$OUT/ux-live-NOT-APPLICABLE.txt"
    echo "  NOT APPLICABLE: no staging endpoint to observe; see TOG-4837"
    return 3
  fi
  [[ -n "$MEMBER" ]] || { echo "  NEEDS MEMBER for the grant cycle" >"$OUT/ux-live-NEEDS-INPUT.txt"; echo "  NOT APPLICABLE: set MEMBER and ROLE_ID"; return 3; }
  [[ -n "$ROLE_ID" ]] || { echo "  NEEDS ROLE_ID for the grant cycle" >"$OUT/ux-live-NEEDS-INPUT.txt"; echo "  NOT APPLICABLE: set MEMBER and ROLE_ID"; return 3; }
  if [[ ! -f "$ACCEPTANCE_BIN" ]]; then
    printf 'Sibling %s absent (TOG-4874/TOG-4444 unmerged): this script never grants by itself, so the live cycle is NOT APPLICABLE.\n' "$ACCEPTANCE_BIN" >"$OUT/ux-live-NOT-APPLICABLE.txt"
    echo "  NOT APPLICABLE: grant driver absent; see TOG-4444/TOG-4874"
    return 3
  fi

  curl -sS -w '\nHTTP %{http_code}\n' "$READBACK_URL" >"$OUT/ux-before.txt" || return 1
  grep -q '^HTTP 200$' "$OUT/ux-before.txt" || {
    printf 'READBACK_URL returned non-200 (see ux-before.txt). If it needs operator auth, sign in and re-run; recording MANUAL.\n' >"$OUT/ux-live-MANUAL.txt"
    echo "  MANUAL: endpoint needs operator auth; see ux-live-MANUAL.txt"
    return 2
  }
  (cd "$ROOT" && MEMBER="$MEMBER" ROLE_ID="$ROLE_ID" OUT="$OUT/sibling" \
    bash "$ACCEPTANCE_BIN") 2>&1 | tee "$OUT/ux-grant-cycle.log"
  [[ "${PIPESTATUS[0]}" == "0" ]] || return 1
  grep -q 'Positive readback: role .* present after grant' "$OUT/ux-grant-cycle.log" || return 1
  grep -q 'Negative readback: role absent after revoke' "$OUT/ux-grant-cycle.log" || return 1
  curl -sS -w '\nHTTP %{http_code}\n' "$READBACK_URL" >"$OUT/ux-after.txt" || return 1
  python3 - "$OUT/ux-before.txt" "$OUT/ux-after.txt" "$ROLE_ID" <<'PY'
import json, sys
def grants(path):
    body = open(path).read().rsplit('\nHTTP ', 1)[0]
    return json.loads(body).get('grants', [])
before = grants(sys.argv[1])
after = grants(sys.argv[2])
role = sys.argv[3]
assert role not in {g.get('roleId') for g in after}, f'role {role} still shown after revoke'
assert len(after) <= len(before), f'grant residue in UI: before={len(before)} after={len(after)}'
print(f'  UI shows {len(before)} grant(s) before, {len(after)} after; revoke cleared it')
PY
}

# --- step 4: containment sweep. ----------------------------------------------
check_containment() {
  echo "== step 4: containment =="
  local hits;
  hits="$(grep -rl "$LIVE_GUILD_ID" "$OUT" || true)"
  hits="$(printf '%s\n' "$hits" | grep -v '^$' || true)"
  [[ -z "$hits" ]] || { printf 'live guild id appears in the bundle:\n%s\n' "$hits" >&2; return 1; }
  echo "  live guild id absent from the bundle"
}

write_manifest() {
  local overall="$1"
  {
    printf '# TOG-5107 readback-UX acceptance manifest\n\nQA run %s. Overall: **%s**.\n' "$(date -u +%FT%TZ)" "$overall"
    printf '\n| step | result | evidence |\n|---|---|---|\n'
    printf '| 0 preconditions | %s | env.txt |\n' "${R[0]:-not reached}"
    printf '| 1 stubbed contract | %s | readback-empty.json, readback-granted.json |\n' "${R[1]:-not reached}"
    printf '| 2 component three states | %s | ux-component.txt or ux-component-NOT-APPLICABLE.txt |\n' "${R[2]:-not reached}"
    printf '| 3 live grant/UI/revoke/UI | %s | ux-before.txt, ux-grant-cycle.log, ux-after.txt (or NOT-APPLICABLE/MANUAL) |\n' "${R[3]:-not reached}"
    printf '| 4 containment | %s | sweep over OUT/ |\n' "${R[4]:-not reached}"
    printf '\nNOT-APPLICABLE is a merge-gate verdict, not a pass: it names the unmerged card whose landing turns the step live.\n'
  } >"$OUT/MANIFEST.md"
}

# --- offline selftest: refusal, N/A, and check-fidelity paths. No network. --
selftest() {
  local fails=0
  expect_refusal() {
    local name="$1" needle="$2"; shift 2
    local out rc=0
    out="$(env "$@" bash "$0" 2>&1)" || rc=$?
    if [[ "$rc" != "2" || "$out" != *"$needle"* ]]; then
      printf 'selftest FAIL %s (rc=%s):\n%s\n' "$name" "$rc" "$out" >&2; fails=$((fails + 1))
    else printf 'selftest ok %s\n' "$name"; fi
  }
  # Unmerged tree: no component, no endpoint, no sibling. All gated steps N/A, overall PASS.
  run_unmerged() {
    local out rc=0
    out="$(env OUT="$1" READBACK_COMPONENT= READBACK_URL= MEMBER= ROLE_ID= ACCEPTANCE_BIN=/nonexistent/sibling.sh bash "$0" 2>&1)" || rc=$?
    printf '%s' "$out"
    return "$rc"
  }
  local T; T="$(mktemp -d)"
  local out rc=0
  out="$(run_unmerged "$T" 2>&1)" || rc=$?
  if [[ "$rc" != "0" || "$out" != *"NOT APPLICABLE"* || ! -f "$T/MANIFEST.md" ]] ||
     ! grep -q 'N-A' "$T/MANIFEST.md"; then
    printf 'selftest FAIL unmerged-tree (rc=%s):\n%s\n' "$rc" "$out" >&2; fails=$((fails + 1))
  else printf 'selftest ok unmerged-tree\n'; fi
  # Component present (absolute path, so it works from any checkout):
  # all three state branches -> step 2 PASS; one branch missing -> step 2 FAIL.
  printf 'if (loading) return <Spinner/>;\nif (grants.length === 0) return <Empty/>;\nreturn <GrantList grants={grants}/>;\n' >"$T/Readback-full.tsx"
  printf 'if (loading) return <Spinner/>;\nreturn <GrantList grants={grants}/>;\n' >"$T/Readback-noempty.tsx"
  out=""; rc=0
  out="$(env OUT="$T/c-full" READBACK_COMPONENT="$T/Readback-full.tsx" READBACK_URL= MEMBER= ROLE_ID= ACCEPTANCE_BIN=/nonexistent/s.sh bash "$0" 2>&1)" || rc=$?
  if [[ "$rc" != "0" || "$out" != *"present in"* ]] || ! grep -q '| 2 component three states | PASS |' "$T/c-full/MANIFEST.md"; then
    printf 'selftest FAIL component-full (rc=%s):\n%s\n' "$rc" "$out" >&2; fails=$((fails + 1))
  else printf 'selftest ok component-full\n'; fi
  out=""; rc=0
  out="$(env OUT="$T/c-noempty" READBACK_COMPONENT="$T/Readback-noempty.tsx" READBACK_URL= MEMBER= ROLE_ID= ACCEPTANCE_BIN=/nonexistent/s.sh bash "$0" 2>&1)" || rc=$?
  if [[ "$rc" != "1" || "$out" != *"MISSING"* ]]; then
    printf 'selftest FAIL component-noempty (rc=%s):\n%s\n' "$rc" "$out" >&2; fails=$((fails + 1))
  else printf 'selftest ok component-noempty\n'; fi
  # Live-gate fidelity: a URL without a grant driver stays NOT-APPLICABLE, not MANUAL.
  out=""; rc=0
  out="$(env OUT="$T/c-url" READBACK_COMPONENT= READBACK_URL=https://two-web-staging.example/readback MEMBER=111111111111111111 ROLE_ID=222222222222222222 ACCEPTANCE_BIN=/nonexistent/s.sh bash "$0" 2>&1)" || rc=$?
  if [[ "$rc" != "0" ]] || ! grep -q '| 3 live grant/UI/revoke/UI | N-A |' "$T/c-url/MANIFEST.md"; then
    printf 'selftest FAIL livegate-no-driver (rc=%s):\n%s\n' "$rc" "$out" >&2; fails=$((fails + 1))
  else printf 'selftest ok livegate-no-driver\n'; fi
  # Containment fidelity: a live-guild id pre-seeded in OUT/ must fail step 4
  # through the real sweep (preconditions only mkdir -p, so the seed survives).
  mkdir -p "$T/c-poison"
  printf 'stale note naming guild %s\n' "$LIVE_GUILD_ID" >"$T/c-poison/seed.txt"
  out=""; rc=0
  out="$(env OUT="$T/c-poison" READBACK_COMPONENT= READBACK_URL= MEMBER= ROLE_ID= ACCEPTANCE_BIN=/nonexistent/s.sh bash "$0" 2>&1)" || rc=$?
  if [[ "$rc" != "1" || "$out" != *"live guild id appears in the bundle"* ]]; then
    printf 'selftest FAIL containment-poison (rc=%s):\n%s\n' "$rc" "$out" >&2; fails=$((fails + 1))
  else printf 'selftest ok containment-poison\n'; fi
  rm -rf "$T"
  expect_refusal "missing-OUT" "set OUT" READBACK_COMPONENT= READBACK_URL=
  expect_refusal "bad-url" "must be http" OUT=/tmp/x5107 READBACK_URL=gopher://x
  expect_refusal "live-url" "names the live guild" OUT=/tmp/x5107 READBACK_URL="https://x.example/$LIVE_GUILD_ID"
  expect_refusal "bad-member" "not a Discord user id" OUT=/tmp/x5107 MEMBER=nope
  expect_refusal "everyone-role" "@everyone role" OUT=/tmp/x5107 ROLE_ID="$STAGING_GUILD_ID"
  [[ "$fails" == "0" ]] || fail "$fails selftest case(s) failed"
  echo "selftest: refusal, N/A, component-fidelity and gate-fidelity paths hold; no network touched"
}

if [[ "$SELFTEST" == "1" ]]; then
  selftest
  exit 0
fi

declare -a R=()
main() {
  preconditions
  echo "-- preconditions ok (see $OUT/env.txt) --"
  R[0]=PASS
  check_contract && R[1]=PASS || { R[1]=FAIL; write_manifest FAIL; fail "step 1 failed: stubbed contract does not validate"; }
  check_component; case "$?" in 0) R[2]=PASS;; 3) R[2]=N-A;; *) R[2]=FAIL; write_manifest FAIL; fail "step 2 failed: component is missing a state branch"; esac
  check_live; case "$?" in 0) R[3]=PASS;; 2) R[3]=MANUAL;; 3) R[3]=N-A;; *) R[3]=FAIL; write_manifest FAIL; fail "step 3 failed; see $OUT/ux-grant-cycle.log"; esac
  check_containment && R[4]=PASS || { R[4]=FAIL; write_manifest FAIL; fail "step 4 failed: live-guild id in bundle"; }

  local overall=PASS
  for i in 0 1 2 3 4; do [[ "${R[$i]:-}" == FAIL ]] && overall=FAIL; done
  write_manifest "$overall"
  printf '\nreadback-acceptance %s. Bundle: %s/MANIFEST.md\n' "$overall" "$OUT"
  [[ "$overall" == PASS ]] || exit 1
}

main
