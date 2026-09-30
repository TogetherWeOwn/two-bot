#!/usr/bin/env bash
# TWO leveling reward-role acceptance (TOG-4874; supports TOG-4444 / TOG-3510).
#
# One QA-run driver around the exact staging commands built in TOG-4444:
# preconditions -> staging roles snapshot -> probe mapping -> dry run ->
# pre-state readback -> apply (grant/readback/revoke/readback inside the one
# TOG-4444 command) -> INDEPENDENT post-state readback -> audit record ->
# containment -> evidence bundle.
#
# Cleanup is not a second command: the TOG-4444 apply revokes inside the same
# operation, and this script re-verifies absence through a separate API read
# so the grant path never self-attests the cleanup.
#
# Spec only: this script changes no bot behavior and touches only TWO Staging
# guild 1545644954272137297. The live TWO server is refused before any network.
# Usage:
#   MEMBER=<disposable staging user id> ROLE_ID=<disposable reward role id> \
#   OUT=/tmp/tog4874-out bash scripts/levels-reward-role-acceptance.sh
#   bash scripts/levels-reward-role-acceptance.sh --selftest   # offline checks
set -uo pipefail

for arg in "$@"; do
  if [[ "$arg" == "--help" ]]; then
    printf '%s\n' 'Usage: bash scripts/levels-reward-role-acceptance.sh [--selftest]'
    printf '%s\n' 'Live run: MEMBER=<staging-user-id> ROLE_ID=<staging-role-id> OUT=<evidence-directory> bash scripts/levels-reward-role-acceptance.sh'
    exit 0
  fi
done

STAGING_GUILD_ID='1545644954272137297'
LIVE_GUILD_ID='326474832151838730'
STAGING_APP_ID='1469137636663758888'
STAGING_APP_NAME='Owen QA Test'
API_BASE="${DISCORD_API_BASE:-https://discord.com/api/v10}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY_BIN="${APPLY_BIN:-$ROOT/scripts/levels-reward-role-apply.ts}"
PROBE_BIN="${PROBE_BIN:-$ROOT/scripts/levels-import-rewards-probe.ts}"
AUDIT_REASON='TOG-4874 acceptance readback (read-only)'

LEVEL="${LEVEL:-5}"
READBACK_URL="${READBACK_URL:-}"

fail() { printf 'acceptance: %s\n' "$*" >&2; exit "${2:-1}"; }
refuse() { printf 'acceptance: %s\n' "$1" >&2; exit 2; }

if [[ "${1:-}" == "--selftest" ]]; then
  SELFTEST=1
else
  SELFTEST=0
  # Explicit emptiness checks (not ${VAR:?}) so every precondition refusal exits 2.
  [[ -n "${MEMBER:-}" ]] || refuse "set MEMBER to the disposable staging test account user id"
  [[ -n "${ROLE_ID:-}" ]] || refuse "set ROLE_ID to a disposable reward role id in TWO Staging, BELOW the bot role"
  [[ -n "${OUT:-}" ]] || refuse "set OUT to an output dir for the evidence bundle"
fi

is_snowflake() { [[ "$1" =~ ^[0-9]{17,20}$ ]]; }

# --- offline guards: guild, token identity, inputs, files. No network yet. ---
preconditions() {
  is_snowflake "$MEMBER" || refuse "--member $MEMBER is not a Discord user id."
  is_snowflake "$ROLE_ID" || refuse "ROLE_ID $ROLE_ID is not a Discord role id."
  [[ "$LEVEL" =~ ^[1-9][0-9]*$ ]] || refuse "LEVEL $LEVEL is not a positive integer."
  [[ "$ROLE_ID" == "$STAGING_GUILD_ID" ]] &&
    refuse "ROLE_ID is the @everyone role (id equals the guild). Pick a disposable reward role."

  local guild="${DISCORD_STAGING_GUILD_ID:-}";
  [[ "$guild" == "$STAGING_GUILD_ID" ]] ||
    refuse "DISCORD_STAGING_GUILD_ID must be the TWO Staging guild ($STAGING_GUILD_ID); got '${guild:-<unset>}'. Refusing to continue."

  local token="${DISCORD_STAGING_BOT_TOKEN:-}";
  [[ -n "$token" ]] || refuse "DISCORD_STAGING_BOT_TOKEN is not set. See docs/SECRETS.md."
  local appid;
  appid="$(python3 -c 'import base64,os,sys
t = os.environ["DISCORD_STAGING_BOT_TOKEN"].strip().split(".")[0]
try: print(base64.b64decode(t + "=" * (-len(t) % 4)).decode())
except Exception: print("")')" || appid=""
  [[ "$appid" == "$STAGING_APP_ID" ]] &&
    printf '  token      %s (%s)\n' "$STAGING_APP_NAME" "$appid" ||
    refuse "token belongs to application '${appid:-unknown}', not $STAGING_APP_NAME ($STAGING_APP_ID). Refusing to run."

  [[ -n "${TWO_STAGING_DATABASE_URL:-}${TWO_DATABASE_URL:-}" ]] ||
    refuse "TWO_STAGING_DATABASE_URL (or TWO_DATABASE_URL) is not set. The TOG-4444 apply records its grant after the revoke; check upfront rather than failing after Discord writes."
  [[ -f "$APPLY_BIN" ]] ||
    refuse "apply path $APPLY_BIN is absent. TOG-4444 has not merged yet; this script cannot run until it has."
  [[ -f "$PROBE_BIN" ]] ||
    refuse "probe $PROBE_BIN is absent. The two-bot checkout is incomplete."
  command -v node >/dev/null || refuse "node is not on PATH (need Node 24+)."
  command -v python3 >/dev/null || refuse "python3 is not on PATH (needed for evidence checks)."

  mkdir -p "$OUT"
  {
    printf 'node: %s\n' "$(node --version)"
    printf 'repo head: %s\n' "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    printf 'guild: TWO Staging (%s)\n' "$STAGING_GUILD_ID"
    printf 'bot: %s (%s)\n' "$STAGING_APP_NAME" "$STAGING_APP_ID"
    printf 'member: %s\nlevel: %s\nrole: %s\n' "$MEMBER" "$LEVEL" "$ROLE_ID"
    printf 'db: %s\n' "$([[ -n "${TWO_STAGING_DATABASE_URL:-}" ]] && echo TWO_STAGING_DATABASE_URL || echo TWO_DATABASE_URL)"
  } >"$OUT/env.txt"
}

# GET a Discord path into a file; prints the HTTP status. Token never echoed.
api_get() {
  local path="$1" outfile="$2"
  local code;
  code="$(curl -sS -w '%{http_code}' -o "$outfile" \
    -H "Authorization: Bot ${DISCORD_STAGING_BOT_TOKEN}" \
    -H "X-Audit-Log-Reason: $AUDIT_REASON" \
    "$API_BASE$path")"
  printf '%s' "$code"
}

# --- step 1: staging roles snapshot (always fetch staging fresh: the archived
# --- audit dump is the LIVE guild, so mapping against it silently maps nothing). ---
fetch_roles() {
  echo "== step 1: staging roles snapshot =="
  local code;
  code="$(api_get "/guilds/$STAGING_GUILD_ID/roles" "$OUT/roles.json")"
  [[ "$code" == "200" ]] || { printf 'roles snapshot failed: HTTP %s\n' "$code" >&2; return 1; }
  python3 - "$OUT/roles.json" "$OUT/roles.txt" "$ROLE_ID" "$STAGING_APP_ID" <<'PY'
import json, sys
roles = json.load(open(sys.argv[1]))
rows = [(r.get('position', -1), r.get('id',''), r.get('name',''), bool(r.get('managed'))) for r in roles]
with open(sys.argv[2], 'w') as f:
    for pos, rid, name, managed in sorted(rows):
        f.write(f'{pos:>4}  {rid}  {name}{"  [managed]" if managed else ""}\n')
by_id = {r.get('id'): r for r in roles}
target, appid = sys.argv[3], sys.argv[4]
assert target in by_id, f'ROLE_ID {target} does not exist in TWO Staging'
assert not by_id[target].get('managed'), f'ROLE_ID {target} is managed by an integration; no bot can grant it'
bot_roles = [r for r in roles if (r.get('tags') or {}).get('bot_id') == appid]
assert bot_roles, 'staging bot has no managed role; re-invite it before exercising reward roles'
top = max(r.get('position', -1) for r in bot_roles)
assert by_id[target].get('position', -1) < top, (
    f'ROLE_ID {target} sits at/above the bot top role; a bot grants only strictly below itself')
print(f'  role below bot top ({by_id[target].get("position")} < {top}), not managed')
PY
}

# --- step 2: probe mapping (offline, --no-db) + live-guild refusal. ---
run_probe() {
  echo "== step 2: probe mapping =="
  python3 - "$OUT/roles.json" "$OUT/export.json" "$ROLE_ID" "$LEVEL" <<'PY'
import json, sys
roles = json.load(open(sys.argv[1]))
name = next(r.get('name', '') for r in roles if r.get('id') == sys.argv[3])
json.dump({"role_rewards": [{"rank": int(sys.argv[4]), "role_id": sys.argv[3], "name": name}]},
          open(sys.argv[2], 'w'), indent=2)
PY
  (cd "$ROOT" && node "$PROBE_BIN" --guild "$STAGING_GUILD_ID" \
    --file "$OUT/export.json" --roles "$OUT/roles.json" \
    --bot-id "$STAGING_APP_ID" --report "$OUT/probe-report.json" --no-db) 2>&1 | tee "$OUT/probe.log"
  [[ "${PIPESTATUS[0]}" == "0" ]] || return 1
  python3 - "$OUT/probe-report.json" <<'PY'
import json, sys
rep = json.load(open(sys.argv[1]))
assert rep.get('guildId') == '1545644954272137297', 'probe report is for the wrong guild'
mapped = rep.get('mapped') or []
assert len(mapped) >= 1, 'probe mapped zero rewards: nothing to exercise'
print(f"  mapped {len(mapped)} / unmapped {len(rep.get('unmapped') or [])}")
PY
}

# Containment evidence 1: the live guild is refused with zero mutations.
prove_live_refusal() {
  echo "== step 2b: live-guild refusal =="
  local rc=0;
  (cd "$ROOT" && node "$PROBE_BIN" --guild "$LIVE_GUILD_ID" \
    --file "$OUT/export.json" --roles "$OUT/roles.json" \
    --bot-id "$STAGING_APP_ID" --no-db) >"$OUT/live-refusal.log" 2>&1 || rc=$?
  [[ "$rc" == "2" ]] || { printf 'live probe exited %s, want 2\n' "$rc" >&2; return 1; }
  grep -q "Refusing live guild $LIVE_GUILD_ID" "$OUT/live-refusal.log" || return 1
  echo "  live guild refused, exit 2, nothing opened"
}

# --- step 3: dry run (plan only, changes nothing). ---
dry_run() {
  echo "== step 3: dry run =="
  (cd "$ROOT" && node "$APPLY_BIN" --report "$OUT/probe-report.json" \
    --member "$MEMBER" --level "$LEVEL") 2>&1 | tee "$OUT/dryrun.log"
  [[ "${PIPESTATUS[0]}" == "0" ]] || return 1
}

# --- steps 4/6: member readbacks, saved for the independent comparison. ---
read_member() {
  local outfile="$1"
  local code;
  code="$(api_get "/guilds/$STAGING_GUILD_ID/members/$MEMBER" "$outfile")"
  [[ "$code" == "200" ]] || { printf 'member readback failed: HTTP %s\n' "$code" >&2; return 1; }
  python3 -c 'import json,sys; print("  roles:", sorted(json.load(open(sys.argv[1])).get("roles", [])))' "$outfile"
}

# --- step 5: the apply. Grant/revoke live inside this one command. ---
run_apply() {
  echo "== step 5: apply (grant/readback/revoke/readback) =="
  (cd "$ROOT" && node "$APPLY_BIN" --report "$OUT/probe-report.json" \
    --member "$MEMBER" --level "$LEVEL" --apply) 2>&1 | tee "$OUT/apply.log"
  local rc="${PIPESTATUS[0]}"
  if [[ "$rc" != "0" ]]; then
    printf 'apply exited %s. If apply.log says the role may still be on the member, remove it by hand in Server Settings > Members, then re-run.\n' "$rc" >&2
    return 1
  fi
  grep -q 'Positive readback: role .* present after grant' "$OUT/apply.log" || return 1
  grep -q 'Negative readback: role absent after revoke' "$OUT/apply.log" || return 1
  grep -q 'Residue restored: true' "$OUT/apply.log" || return 1
  grep -q "Zero writes to the live guild: every Discord path in this run carried guild $STAGING_GUILD_ID" "$OUT/apply.log" || return 1
}

# --- step 7: audit record (psql when present, else an exact MANUAL query). --
check_audit() {
  echo "== step 7: audit record =="
  local runid;
  runid="$(grep -o 'tog-4444-reward-role:[0-9a-f\-\"]*' "$OUT/apply.log" | head -1 | tr -d '"')"
  printf '  run: %s\n' "${runid:-<unparsed>}"
  local dburl="${TWO_STAGING_DATABASE_URL:-${TWO_DATABASE_URL:-}}"
  if ! command -v psql >/dev/null; then
    cat >"$OUT/audit-MANUAL.txt" <<EOF
psql is not installed here. Run this against the two_bot_staging database:
  SELECT entry_id, action, target_id, metadata_json FROM operational_audit_log
   WHERE target_id = '$MEMBER' AND action = 'level_reward_role_exercised'
   ORDER BY created_at DESC LIMIT 3;
Pass: one row, entry_id tog-4444-reward-role:<runId>, metadata positiveReadback
and negativeReadback both true.
EOF
    echo "  MANUAL: query written to audit-MANUAL.txt"
    return 2
  fi
  psql "$dburl" -At -c \
    "SELECT entry_id || ' | ' || action || ' | ' || target_id || ' | ' || metadata_json FROM operational_audit_log WHERE target_id = '$MEMBER' AND action = 'level_reward_role_exercised' ORDER BY created_at DESC LIMIT 3;" \
    >"$OUT/audit-row.txt" || return 1
  grep -q 'level_reward_role_exercised' "$OUT/audit-row.txt" || return 1
  cat "$OUT/audit-row.txt"
}

# --- step 8: containment sweep over the evidence bundle. ---
check_containment() {
  echo "== step 8: containment =="
  local hits;
  hits="$(grep -rl "$LIVE_GUILD_ID" "$OUT" || true)"
  hits="$(printf '%s\n' "$hits" | grep -v 'live-refusal.log' | grep -v '^$' || true)"
  [[ -z "$hits" ]] || { printf 'live guild id appears outside the refusal proof:\n%s\n' "$hits" >&2; return 1; }
  echo "  live guild id appears only in live-refusal.log; all writes carried guild $STAGING_GUILD_ID"
}

# --- step 9: TOG-4837 readback UX, conditional on the endpoint existing. ---
check_ux() {
  echo "== step 9: readback UX (TOG-4837) =="
  if [[ -z "$READBACK_URL" ]]; then
    printf 'two-web exposes no reward-role endpoint yet (TOG-4837 blocked): step NOT APPLICABLE.\n' >"$OUT/ux-NOT-APPLICABLE.txt"
    echo "  NOT APPLICABLE: no endpoint to observe; see TOG-4837"
    return 3
  fi
  curl -sS -w '\nHTTP %{http_code}\n' "$READBACK_URL" >"$OUT/ux-readback.txt" || return 1
  echo "  MANUAL: compare ux-readback.txt against member-after.json"
  return 2
}

write_manifest() {
  local overall="$1"
  {
    printf '# TOG-4874 acceptance manifest\n\nQA run %s. Overall: **%s**.\n' "$(date -u +%FT%TZ)" "$overall"
    printf '\nInputs: member %s, level %s, role %s (see env.txt; no secrets recorded).\n' "$MEMBER" "$LEVEL" "$ROLE_ID"
    printf '\n| step | result | evidence |\n|---|---|---|\n'
    printf '| 0 preconditions | %s | env.txt |\n' "${R[0]:-not reached}"
    printf '| 1 roles snapshot | %s | roles.json, roles.txt |\n' "${R[1]:-not reached}"
    printf '| 2 probe mapping | %s | probe.log, probe-report.json, export.json |\n' "${R[2]:-not reached}"
    printf '| 2b live refusal | %s | live-refusal.log |\n' "${R[3]:-not reached}"
    printf '| 3 dry run | %s | dryrun.log |\n' "${R[4]:-not reached}"
    printf '| 4 pre-state readback | %s | member-before.json |\n' "${R[5]:-not reached}"
    printf '| 5 apply | %s | apply.log |\n' "${R[6]:-not reached}"
    printf '| 6 post-state readback | %s | member-after.json |\n' "${R[7]:-not reached}"
    printf '| 7 audit record | %s | audit-row.txt or audit-MANUAL.txt |\n' "${R[8]:-not reached}"
    printf '| 8 containment | %s | sweep over OUT/ |\n' "${R[9]:-not reached}"
    printf '| 9 readback UX | %s | ux-readback.txt or ux-NOT-APPLICABLE.txt |\n' "${R[10]:-not reached}"
    printf '\nTOG-4444 evidence pointers: positive readback line, negative readback line, and the zero-live-writes line are in apply.log; member+role used are in env.txt.\n'
    printf '\nSeven-day metric: this bundle must be produced once in TWO Staging within 7 days of merge; attach it to the QA execution card.\n'
  } >"$OUT/MANIFEST.md"
}

# --- offline self-test: refusal paths only, no network, no token use. ---
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
  local T="${SELFTEST_TOKEN:?selftest harness error: SELFTEST_TOKEN unset}"
  expect_refusal "missing-MEMBER" "set MEMBER" OUT=/tmp/x MEMBER= ROLE_ID=1 LEVEL=1 DISCORD_STAGING_GUILD_ID="$STAGING_GUILD_ID" DISCORD_STAGING_BOT_TOKEN="$T"
  expect_refusal "live-guild" "must be the TWO Staging guild" OUT=/tmp/x MEMBER=111111111111111111 ROLE_ID=222222222222222222 DISCORD_STAGING_GUILD_ID="$LIVE_GUILD_ID" DISCORD_STAGING_BOT_TOKEN="$T"
  expect_refusal "bad-member" "not a Discord user id" OUT=/tmp/x MEMBER=nope ROLE_ID=222222222222222222 DISCORD_STAGING_GUILD_ID="$STAGING_GUILD_ID" DISCORD_STAGING_BOT_TOKEN="$T"
  expect_refusal "bad-token" "not $STAGING_APP_NAME" OUT=/tmp/x MEMBER=111111111111111111 ROLE_ID=222222222222222222 DISCORD_STAGING_GUILD_ID="$STAGING_GUILD_ID" DISCORD_STAGING_BOT_TOKEN="garbage"
  expect_refusal "missing-apply" "TOG-4444 has not merged" OUT=/tmp/x MEMBER=111111111111111111 ROLE_ID=222222222222222222 DISCORD_STAGING_GUILD_ID="$STAGING_GUILD_ID" DISCORD_STAGING_BOT_TOKEN="$T" APPLY_BIN=/nonexistent/apply.ts TWO_STAGING_DATABASE_URL=postgres://x
  [[ "$fails" == "0" ]] || fail "$fails selftest case(s) failed"
  echo "selftest: all refusal paths hold, no network touched"
}

if [[ "$SELFTEST" == "1" ]]; then
  SELFTEST_TOKEN="$(python3 -c 'import base64; print(base64.b64encode(b"1469137636663758888").decode())').mock.signature"
  export SELFTEST_TOKEN
  # Token-identity checks need a DB var only after passing identity; refusal
  # cases set their own env. Default the DB var so identity-passing cases
  # reach the file-existence checks.
  TWO_STAGING_DATABASE_URL="${TWO_STAGING_DATABASE_URL:-postgres://selftest}"
  export TWO_STAGING_DATABASE_URL
  selftest
  exit 0
fi

declare -a R=()
main() {
  preconditions
  echo "-- preconditions ok (see $OUT/env.txt) --"
  R[0]=PASS
  fetch_roles && R[1]=PASS || { R[1]=FAIL; write_manifest FAIL; fail "step 1 failed; see $OUT/roles.json"; }
  run_probe && R[2]=PASS || { R[2]=FAIL; write_manifest FAIL; fail "step 2 failed; see $OUT/probe.log"; }
  prove_live_refusal && R[3]=PASS || { R[3]=FAIL; write_manifest FAIL; fail "step 2b failed: live guild was not refused"; }
  dry_run && R[4]=PASS || { R[4]=FAIL; write_manifest FAIL; fail "step 3 failed; see $OUT/dryrun.log"; }
  echo "== step 4: pre-state readback =="
  read_member "$OUT/member-before.json" && R[5]=PASS || { R[5]=FAIL; write_manifest FAIL; fail "step 4 failed"; }
  run_apply && R[6]=PASS || { R[6]=FAIL; write_manifest FAIL; fail "step 5 failed; see $OUT/apply.log for the recovery action"; }
  echo "== step 6: post-state readback (independent) =="
  read_member "$OUT/member-after.json" && R[7]=PASS || { R[7]=FAIL; write_manifest FAIL; fail "step 6 failed"; }
  python3 - "$OUT/member-before.json" "$OUT/member-after.json" "$ROLE_ID" <<'PY'
import json, sys
before = set(json.load(open(sys.argv[1])).get('roles', []))
after = set(json.load(open(sys.argv[2])).get('roles', []))
role = sys.argv[3]
assert role not in after, f'role {role} still on the member after revoke'
assert after == (before - {role}), f'unrelated roles changed: before={sorted(before)} after={sorted(after)}'
print('  role absent; unrelated roles untouched')
PY
  [[ "$?" == "0" ]] || { R[7]=FAIL; write_manifest FAIL; fail "step 6 comparison failed: residue or role still present"; }
  check_audit; case "$?" in 0) R[8]=PASS;; 2) R[8]=MANUAL;; *) R[8]=FAIL; write_manifest FAIL; fail "step 7 failed";; esac
  check_containment && R[9]=PASS || { R[9]=FAIL; write_manifest FAIL; fail "step 8 failed: live-guild id outside refusal proof"; }
  check_ux; case "$?" in 0) R[10]=PASS;; 2) R[10]=MANUAL;; 3) R[10]=N-A;; *) R[10]=FAIL; write_manifest FAIL; fail "step 9 failed";; esac

  local overall=PASS
  for i in 0 1 2 3 4 5 6 7 8 9 10; do [[ "${R[$i]:-}" == FAIL ]] && overall=FAIL; done
  write_manifest "$overall"
  printf '\nacceptance %s. Bundle: %s/MANIFEST.md\n' "$overall" "$OUT"
  [[ "$overall" == PASS ]] || exit 1
}

main
