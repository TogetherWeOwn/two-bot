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
# Offline and instant: the golden ambiguous-vs-unknown eval (TOG-5849). It
# scores the fixture split against the real attribution code, so a report or
# prompt change that merges the two buckets reds here, not in review.
npm run eval:funnel-attribution
npm run test:postgres
npm run test:restart-storage -- --provision
npm run verify:grant:selftest
