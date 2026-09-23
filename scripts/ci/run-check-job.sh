#!/usr/bin/env bash
set -euo pipefail

report_failure() {
  local rc=$? command=$BASH_COMMAND
  command="${command//'%'/'%25'}"
  command="${command//$'\r'/'%0D'}"
  command="${command//$'\n'/'%0A'}"
  printf '::error title=Required check command failed::%s exited %s\n' "$command" "$rc"
  exit "$rc"
}
trap report_failure ERR

npm run typecheck
npm run test:postgres
npm run test:restart-storage -- --provision
npm run verify:grant:selftest
