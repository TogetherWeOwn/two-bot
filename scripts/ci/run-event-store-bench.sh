#!/usr/bin/env bash
# Three independent fixed-workload samples expose runner noise and durability
# differences. Retain every failure; this is not a retry-until-green policy.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0
for sample in 1 2 3; do
  printf '\nevent-store benchmark sample %s/3\n' "$sample"
  if node scripts/event-store-bench.ts --check; then
    :
  else
    result=$?
    # Only a measured budget breach (1) warrants more samples. A setup,
    # connection or runtime failure stops immediately, without a DB retry.
    if (( result != 1 )); then exit "$result"; fi
    status=1
  fi
done
exit "$status"
