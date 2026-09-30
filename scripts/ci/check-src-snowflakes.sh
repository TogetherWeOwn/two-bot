#!/usr/bin/env bash
#
# Hardcoded Discord snowflakes in src/ may only ever go down.
#
# WHY THIS EXISTS (TOG-3103). Opening this repository is blocked partly on the
# fact that `src/` carries 185 literal Discord ids belonging to one specific
# guild. None of them is a secret - a channel or role id is public to every
# member of the server, and .gitleaks.toml says so at length. The problem is
# not disclosure, it is that guild-specific *configuration* is wearing a source
# file, which is what makes the repository useless to anybody who is not us.
#
# Removing them is TOG-3100's job (the `guild_settings` config store). This
# script is the ratchet that stops the number growing while that work runs, and
# that makes each removal visible as a number in a diff instead of a claim in a
# comment.
#
# THE BUDGET GOES DOWN, NEVER UP, AND NEVER SIDEWAYS. Under budget fails too,
# on purpose: if you deleted ids and left the number alone, the next person
# gets that slack for free and the ratchet has quietly become a ceiling nobody
# is standing near. Lowering the number is one line and it is the point.
#
# A file that is not in the table must have zero. That is the half that
# actually fences the repo - without it, a brand new src/ file full of ids
# sails through because no budget line mentions it.
#
# WHAT IT COUNTS: a quoted run of 17-20 digits. That is a snowflake written as
# a literal value. Bare digits in prose are deliberately NOT counted - there
# are 8 of those and every one is a comment or an error message explaining
# what happened on a specific day (`src/store/eventStore.ts:329`,
# `src/staging/provision.ts:164`). Counting those would turn the ratchet into a
# prose-editing rule and teach people to delete the explanation.

set -euo pipefail

for arg in "$@"; do
  if [[ "$arg" == "--help" ]]; then
    printf '%s\n' 'Usage: bash scripts/ci/check-src-snowflakes.sh [--root <directory>]'
    exit 0
  fi
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    # The self-test points this at a fixture tree. Nothing else should.
    --root) root="$2"; shift 2 ;;
    *) printf 'check-src-snowflakes: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

# path<TAB>budget<TAB>what it is and what removes it.
#
# Measured at cb679e8 on 2026-09-17. Total 185.
BUDGET=$(
  printf '%s\n' \
    'src/redesign/live-cleanup.ts	149	one-shot live-guild cleanup. TOG-3103: move to scripts/, it is not the bot.' \
    'src/onboarding/catalog.ts	27	game-picker roles/channels on guild 326474832151838730. TOG-3100 moves these to guild_settings.' \
    'src/staging/spec.ts	5	staging guild pins. Stays until the staging guild is itself configuration.' \
    'src/onboarding/session.ts	2	TOG-3100.' \
    'src/redesign/wave2.ts	1	TOG-3100.' \
    'src/onboarding/anchorEvent.ts	1	TOG-3100.'
)

SNOWFLAKE="['\"][0-9]{17,20}['\"]"

fail=0
annotate() {
  # GitHub renders this next to the file; outside CI it is just a line.
  printf '::error file=%s,title=Hardcoded Discord snowflakes::%s\n' "$1" "$2" >&2
  fail=1
}

# Every src/ file that has at least one, as "path<TAB>count".
actual_counts="$(
  cd "$root" \
    && grep -rEoI --include='*.ts' --include='*.js' --include='*.json' "$SNOWFLAKE" src/ 2>/dev/null \
    | cut -d: -f1 \
    | sort \
    | uniq -c \
    | awk '{ printf "%s\t%s\n", $2, $1 }' \
    || true
)"

count_for() {
  local path="$1"
  printf '%s\n' "$actual_counts" | awk -F'\t' -v p="$path" '$1 == p { print $2; found = 1 } END { if (!found) print 0 }'
}

budgeted_paths=""
total_budget=0
while IFS=$'\t' read -r path budget _reason; do
  [[ -n "$path" ]] || continue
  budgeted_paths+="$path"$'\n'
  total_budget=$(( total_budget + budget ))
  actual="$(count_for "$path")"

  if [[ ! -e "$root/$path" ]]; then
    if [[ "$budget" -gt 0 ]]; then
      annotate "$path" "budgeted for $budget snowflakes but the file is gone. Delete its line from BUDGET in scripts/ci/check-src-snowflakes.sh."
    fi
    continue
  fi
  if [[ "$actual" -gt "$budget" ]]; then
    annotate "$path" "$actual hardcoded snowflakes, budget is $budget. Put the new ids in configuration, not in src/."
  elif [[ "$actual" -lt "$budget" ]]; then
    annotate "$path" "$actual hardcoded snowflakes, budget is still $budget. Lower the budget in scripts/ci/check-src-snowflakes.sh to $actual - the ratchet only works if the number is true."
  fi
done <<< "$BUDGET"

# Anything with ids that no budget line mentions. This is the half that fences
# new files, so it runs over the measured counts rather than over the table.
while IFS=$'\t' read -r path actual; do
  [[ -n "$path" ]] || continue
  if ! printf '%s' "$budgeted_paths" | grep -qxF "$path"; then
    annotate "$path" "$actual hardcoded Discord snowflakes in a file with no budget. src/ is the bot; guild ids belong in configuration (TOG-3100). If this is genuinely unavoidable, add a line to BUDGET in scripts/ci/check-src-snowflakes.sh saying why."
  fi
done <<< "$actual_counts"

total_actual="$(printf '%s\n' "$actual_counts" | awk -F'\t' '{ t += $2 } END { print t + 0 }')"

if [[ "$fail" -ne 0 ]]; then
  printf 'check-src-snowflakes: FAIL (%s in src/, budget %s)\n' "$total_actual" "$total_budget" >&2
  exit 1
fi

printf 'check-src-snowflakes: %s hardcoded snowflakes in src/, at or under every budget (total budget %s)\n' \
  "$total_actual" "$total_budget"
