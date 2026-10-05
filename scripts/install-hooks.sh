#!/usr/bin/env bash
#
# Point git at the hooks that live in the repo.
#
# .git/hooks is not versioned, so a hook committed there reaches nobody. This
# sets core.hooksPath to .githooks/ instead, which is versioned, so everyone
# gets the same hooks and updates arrive with a pull.
#
# Runs automatically from `npm install` via the `prepare` script. Safe and
# silent if this is not a git checkout (CI tarballs, Docker builds).
#
set -euo pipefail

for arg in "$@"; do
  if [[ "$arg" == "--help" ]]; then
    printf '%s\n' 'Usage: bash scripts/install-hooks.sh'
    exit 0
  fi
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."

git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "not a git checkout - skipping hook install"
  exit 0
}

chmod +x .githooks/* 2>/dev/null || true
git config core.hooksPath .githooks

echo "git hooks installed (core.hooksPath=.githooks)"
echo "  pre-commit  refuses .env, keys and certificates"
echo "  pre-push    refuses a direct or force push to main"
