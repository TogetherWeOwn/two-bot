#!/usr/bin/env bash
#
# The Dockerfile base-image digest pin must carry a fresh refresh record.
#
# WHY THIS EXISTS (TOG-9126). TOG-8680 pinned
# `FROM node:24-bookworm-slim@sha256:...` so rebuilds do not drift when the
# rolling tag moves — but nothing re-ran the digest lookup or recorded a
# refresh date, so the pin could age silently for years while the tag moved
# on. This guard fails red when the recorded refresh date is older than the
# monthly cadence, when the FROM line is not digest-pinned at all, or when
# the date record is missing or malformed.
#
# WHAT IT CHECKS: the Dockerfile's FROM line and its `Digest refreshed:`
# comment. It never touches the network. Comparing against the live upstream
# digest is the monthly human step (docs/DEPLOY.md §9), not a CI step — a
# network check here would red every offline run and teach people to ignore it.
#
# CLI exit-code contract (CONTRIBUTING.md): usage/env guards exit 2, check
# verdicts exit 0/1. A missing Dockerfile means nothing was checked (2); an
# unpinned FROM, a missing date or a stale/malformed date is a red verdict (1).
#
# Usage: scripts/ci/check-docker-digest-age.sh [--root DIR] [--now YYYY-MM-DD] [--max-age-days N]
# Exit: 0 pin fresh, 1 stale/unpinned/unrecorded, 2 usage or unreadable tree.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
now=""
max_age_days=35
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root="$2"; shift 2 ;;
    --now) now="$2"; shift 2 ;;
    --max-age-days) max_age_days="$2"; shift 2 ;;
    *) printf 'check-docker-digest-age: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

dockerfile="$root/Dockerfile"
if [[ ! -f "$dockerfile" ]]; then
  printf 'check-docker-digest-age: %s not found. Nothing was checked.\n' "$dockerfile" >&2
  exit 2
fi

fail() {
  printf '::error file=Dockerfile,title=Base-image digest pin::%s\n' "$1" >&2
  printf 'check-docker-digest-age: FAIL: %s\n' "$1" >&2
  exit 1
}

# Every FROM line must pin a digest. The image is single-stage today; the
# loop keeps the guard true if a builder stage is ever added.
while IFS= read -r from_line; do
  [[ -n "$from_line" ]] || continue
  if [[ ! "$from_line" =~ @sha256:[0-9a-f]{64} ]]; then
    fail "FROM line is not digest-pinned: $from_line. Pin it (TOG-8680) so rebuilds do not drift."
  fi
done < <(grep -E '^FROM[[:space:]]+' "$dockerfile" || true)

if ! grep -qE '^FROM[[:space:]]+' "$dockerfile"; then
  fail "no FROM line in Dockerfile. Nothing to refresh against."
fi

date_line="$(grep -Eo 'Digest refreshed:[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}' "$dockerfile" | head -1 || true)"
if [[ -z "$date_line" ]]; then
  fail "no 'Digest refreshed: YYYY-MM-DD' record in the Dockerfile FROM comment. Record the refresh (TOG-9126, docs/DEPLOY.md §9)."
fi
refreshed="${date_line##*: }"
refreshed="$(printf '%s' "$refreshed" | tr -d '[:space:]')"

refresh_epoch="$(date -u -d "$refreshed" +%s 2>/dev/null || true)"
if [[ -z "$refresh_epoch" ]]; then
  fail "recorded refresh date '$refreshed' does not parse. Fix the record, not the pin."
fi

if [[ -z "$now" ]]; then
  now="$(date -u +%F)"
fi
now_epoch="$(date -u -d "$now" +%s 2>/dev/null || true)"
if [[ -z "$now_epoch" ]]; then
  printf 'check-docker-digest-age: --now value %s does not parse\n' "$now" >&2
  exit 2
fi

age_days=$(( (now_epoch - refresh_epoch) / 86400 ))
if [[ "$age_days" -lt 0 ]]; then
  fail "recorded refresh date $refreshed is in the future (now $now). Fix the record."
fi
if [[ "$age_days" -gt "$max_age_days" ]]; then
  fail "digest pin is $age_days days old (refreshed $refreshed, cadence $max_age_days days). Refresh it: docs/DEPLOY.md §9."
fi

printf 'check-docker-digest-age: digest pin fresh (%s days old, refreshed %s, cadence %s days)\n' \
  "$age_days" "$refreshed" "$max_age_days"
