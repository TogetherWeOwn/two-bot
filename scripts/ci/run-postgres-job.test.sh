#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/ci/run-postgres-job.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TRACE"
if [[ "${FAIL_ON:-}" == "$*" ]]; then
  exit 23
fi
EOF
chmod +x "$WORK/npm"
export TRACE="$WORK/trace"
export PATH="$WORK:$PATH"

expected=$'run test:postgres\nrun migrate\nrun web:views\nrun web:role\nrun verify:web-role'
"$SCRIPT"
actual="$(cat "$TRACE")"
[[ "$actual" == "$expected" ]] || {
  printf 'unexpected command sequence:\n%s\n' "$actual" >&2
  exit 1
}

: > "$TRACE"
export FAIL_ON='run web:views'
set +e
failure_output="$("$SCRIPT" 2>&1)"
rc=$?
set -e
if [[ "$rc" -ne 23 ]]; then
  printf 'workflow script returned %s instead of the failing command status\n' "$rc" >&2
  exit 1
fi
actual="$(cat "$TRACE")"
[[ "$actual" == $'run test:postgres\nrun migrate\nrun web:views' ]] || {
  printf 'commands continued after failure:\n%s\n' "$actual" >&2
  exit 1
}
[[ "$failure_output" == *'::error title=Postgres workflow command failed::npm run web:views exited 23'* ]] || {
  printf 'failure annotation did not name the failed command:\n%s\n' "$failure_output" >&2
  exit 1
}

printf 'run-postgres-job: sequence, fail-fast behavior and annotation verified\n'
