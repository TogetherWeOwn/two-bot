#!/usr/bin/env bash
#
# Refuse to run a fork's pull request on our own hardware.
#
# WHY THIS EXISTS (TOG-3103). Every `runs-on:` in .github/workflows/ is
# `[self-hosted, two-selfhosted]`, and those runners are persistent - five of
# them share one host and state survives between jobs. Today that is fine: the
# repository is private and has zero forks. The day it goes public, a stranger's
# pull request would execute their code on that host, with whatever the previous
# job left behind.
#
# The settings-level fix is GitHub's "require approval for all outside
# collaborators", and the durable fix is hosted runners. Neither is in this
# repository: the first is a repository setting that needs `administration`
# (our App token is refused with 403, verified 2026-09-17), and the second
# needs somebody to decide about minutes. Both are real and both are filed.
#
# This script is the part that can live in the repo, and it is the part that
# keeps working when somebody forgets. A setting can be toggled back by anyone
# with admin and nothing tells us; a required check that refuses is in the diff
# and in the log.
#
# IT FAILS, IT DOES NOT SKIP. A skipped job counts as a successful required
# check on branch protection, so `if:` on the job would show a fork's PR as
# green - the exact opposite of the intent. A failing first step is loud, is
# unmistakable in the checks list, and blocks the merge.
#
# HOW TO REMOVE IT. When a job moves to a hosted runner, delete its
# refuse-fork-pr step in the same commit - on a hosted runner there is no host
# of ours to protect and this would only reject contributions for no reason.
# The step is per-job on purpose so that migration can happen one job at a time.

set -euo pipefail

event="${GITHUB_EVENT_NAME:-}"
repo="${GITHUB_REPOSITORY:-}"
head_repo="${PR_HEAD_REPO:-}"

annotate() {
  printf '::error title=Fork pull request refused on self-hosted runners::%s\n' "$1" >&2
}

# Anything that is not a pull request cannot come from a fork: push and
# schedule events only ever run our own ref.
if [[ "$event" != 'pull_request' && "$event" != 'pull_request_target' ]]; then
  printf 'refuse-fork-pr: %s is not a pull request, nothing to check\n' "${event:-<unset>}"
  exit 0
fi

# Fail closed. If the workflow stopped passing these through - a typo in the
# expression yields an empty string rather than an error - we must not read
# that as "not a fork". An unknown origin is the case this exists for.
if [[ -z "$repo" || -z "$head_repo" ]]; then
  annotate "cannot tell where this pull request came from (GITHUB_REPOSITORY='${repo}', PR_HEAD_REPO='${head_repo}'). Refusing rather than guessing. The job must set PR_HEAD_REPO from github.event.pull_request.head.repo.full_name."
  exit 1
fi

if [[ "$head_repo" != "$repo" ]]; then
  annotate "this pull request comes from ${head_repo}, and these runners are self-hosted and persistent. Running it here would execute a fork's code on our host. A maintainer should push the branch to ${repo} and open the pull request from there, or move this job to a hosted runner (TOG-3103)."
  exit 1
fi

printf 'refuse-fork-pr: pull request head is %s, same repository, safe to run here\n' "$head_repo"
