#!/usr/bin/env bash
#
# No live console.* calls in src/ (TOG-8693).
#
# WHY THIS EXISTS. src/discord/rateLimit.ts:45 used console.log for a retry
# notice, which is how this card was found. console.* writes bypass the
# structured logger in src/core/log.ts, so anything they print skips
# redaction, level gating and the one-JSON-object-per-line format every log
# shipper expects. That call is fixed (70dfce18, now log.debug); this script
# is the ratchet that stops the next one. The fix for a failure is always
# the same: use log.debug/info/error from src/core/log.ts instead.
#
# WHAT IT CHECKS: every src/**/*.ts and src/**/*.js file, after blanking
# comments and string literals, for a live `console.<method>` call. Test
# files (*.test.ts, __tests__/) are out of scope on purpose: the ban is on
# shipped code, not on assertions about it ("outside tests" in TOG-8693).
#
# WHAT IT IGNORES ON PURPOSE:
# - the word "console" in prose ("printed to the operator console") and in
#   string literals ('do not use console.log') - blanking handles both, and
#   the self-test pins both carve-outs so the guard never becomes a
#   comment-editing rule;
# - code inside ${} of a template literal (the blanker is single-level).
#   Hiding a call in an interpolation to dodge the guard is sabotage, not
#   an accident; review catches intent, this catches habit.
#
# Pure bash + perl, like check-src-snowflakes.sh, so it runs before `npm ci`
# in the check job and a violating PR fails in seconds.

set -euo pipefail

for arg in "$@"; do
  if [[ "$arg" == "--help" ]]; then
    printf '%s\n' 'Usage: bash scripts/ci/check-src-console.sh [--root <directory>]'
    exit 0
  fi
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    # The self-test points this at a fixture tree. Nothing else should.
    --root) root="$2"; shift 2 ;;
    *) printf 'check-src-console: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v perl >/dev/null 2>&1 || {
  printf 'check-src-console: FAIL - perl is required to blank comments/strings before matching.\n' >&2
  exit 1
}

if [[ ! -d "$root/src" ]]; then
  printf '::error file=scripts/ci/check-src-console.sh,title=Live console call in src::no src/ directory under %s; refusing to pass a tree with nothing to scan.\n' "$root" >&2
  printf 'check-src-console: FAIL - no src/ directory under %s\n' "$root" >&2
  exit 1
fi

fail=0
annotate() {
  # GitHub renders this next to the file; outside CI it is just a line.
  printf '::error file=%s,title=Live console call in src::%s\n' "$1" "$2" >&2
  fail=1
}

# Print the file with comments and string literals blanked. Newlines are
# kept, so grep -n line numbers still point at the real lines.
strip_code() {
  perl -0777 -ne '
    my $out = "";
    my ($i, $n, $state, $q) = (0, length($_), "code", "");
    while ($i < $n) {
      my $c = substr($_, $i, 1);
      my $nx = $i + 1 < $n ? substr($_, $i + 1, 1) : "";
      if ($state eq "code") {
        if ($c eq "/" && $nx eq "/") { $state = "line"; $i += 2; next; }
        if ($c eq "/" && $nx eq "*") { $state = "block"; $i += 2; next; }
        if ($c eq "\"" || $c eq chr(39) || $c eq "`") { $state = "str"; $q = $c; $out .= " "; $i++; next; }
        $out .= $c; $i++; next;
      } elsif ($state eq "line") {
        if ($c eq "\n") { $state = "code"; $out .= $c; }
        $i++; next;
      } elsif ($state eq "block") {
        if ($c eq "*" && $nx eq "/") { $state = "code"; $i += 2; }
        else { $out .= "\n" if $c eq "\n"; $i++; }
        next;
      } else {
        if ($c eq "\\") { $i += 2; next; }
        if ($c eq $q) { $state = "code"; $out .= " "; $i++; next; }
        $out .= "\n" if $c eq "\n"; $i++; next;
      }
    }
    print $out;
  ' "$1"
}

CONSOLE_RE='\bconsole[[:space:]]*\.[[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*'

scanned=0
while IFS= read -r -d '' file; do
  scanned=$(( scanned + 1 ))
  rel="${file#"$root"/}"
  hits="$(strip_code "$file" | grep -nE "$CONSOLE_RE" || true)"
  if [[ -n "$hits" ]]; then
    while IFS= read -r hit; do
      [[ -n "$hit" ]] || continue
      lineno="${hit%%:*}"
      code="${hit#*:}"
      method="$(printf '%s' "$code" | grep -oE "$CONSOLE_RE" | head -n 1 | tr -d '[:space:]')"
      annotate "$rel" "line $lineno: live $method call. console.* bypasses the structured redaction-safe logger - use log.debug/info/error from src/core/log.ts instead."
    done <<< "$hits"
  fi
done < <(find "$root/src" -type f \( -name '*.ts' -o -name '*.js' \) -not -name '*.test.ts' -not -path '*__tests__/*' -print0)

if [[ "$fail" -ne 0 ]]; then
  printf 'check-src-console: FAIL - live console.* calls in src/ (annotations above name each one)\n' >&2
  exit 1
fi

printf 'check-src-console: no live console.* calls in %s src files (comments and string literals excluded)\n' \
  "$scanned"
