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
if "$SCRIPT"; then
  echo 'workflow script ignored a failed step' >&2
  exit 1
fi
actual="$(cat "$TRACE")"
[[ "$actual" == $'run test:postgres\nrun migrate\nrun web:views' ]] || {
  printf 'commands continued after failure:\n%s\n' "$actual" >&2
  exit 1
}

printf 'run-postgres-job: sequence and fail-fast behavior verified\n'
