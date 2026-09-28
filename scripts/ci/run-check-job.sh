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

# Instant and hermetic: every `node scripts/<x>` target in package.json must
# exist on disk (TOG-6810 - the `reconcile` entry pointed at a file that never
# existed). Runs first so a dangling entry fails before the slow suites start.
npm run check:script-targets
# systemd credential wiring must match the code, the bootstrap and the docs
# (TOG-5706). Needs neither node nor the database, so it runs alongside the
# target guard and a PR that drifts a LoadCredential fails in seconds. The
# selftest runs alongside for the same reason as the snowflake selftest: a
# ratchet is only worth its line here if it still refuses things.
npm run check:credentials
npm run check:credentials:selftest
# Deploy guard + mirror-settle + trigger/poll + smoke, each executed per
# configuration with exit codes pinned (TOG-6911). Hermetic: no network, no
# token, no target — the interesting cases are the ones where none exists
# (TOG-913). Runs before the slow suites so a broken guard fails in seconds.
npm run deploy:selftest
# Base-image digest pin is fresh, and the guard that proves it still refuses
# things (TOG-9126). Hermetic: reads only the Dockerfile and the calendar —
# the live-upstream digest comparison is the monthly human step
# (docs/DEPLOY.md §9), not a CI step, so this never reds an offline run.
# Runs before the slow suites so a stale pin fails in seconds.
npm run check:docker-digest
npm run check:docker-digest:selftest
npm run typecheck
# Offline and instant: the golden ambiguous-vs-unknown eval (TOG-5849). It
# scores the fixture split against the real attribution code, so a report or
# prompt change that merges the two buckets reds here, not in review.
npm run eval:funnel-attribution
npm run test:postgres
npm run test:restart-storage -- --provision
npm run verify:grant:selftest
