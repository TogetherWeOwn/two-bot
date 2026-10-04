#!/usr/bin/env python3
"""Conventional-commit PR/conventions check (TOG-9865).

Shared by the pull_request/push path and the workflow_dispatch path in
.github/workflows/pr-lint.yml. Reads its inputs from the environment so both
jobs stay in lockstep:

  EVENT   github.event_name (pull_request | push | workflow_dispatch)
  TITLE   PR title (pull_request / workflow_dispatch only)
  BODY    PR body (pull_request / workflow_dispatch only)
  AUTHOR  PR author login (pull_request / workflow_dispatch only)
  COMMITS JSON list of {id, message} (push only)
  REQUIRE_CARD_REF "true" to require a Refs: TOG-1234 card reference
    (private repos only). This repo is public, so the default is "false":
    no card reference is required, and an internal tracker ID in the
    title, body, commit or branch name is a warning.
"""

import json
import os
import re
import sys

TYPES = "feat|fix|perf|refactor|test|docs|build|ci|chore|revert|style|security"
HEADER = re.compile(rf"^({TYPES})(\([A-Za-z0-9._/,-]+\))?!?: \S.*$")
HELP = ("Expected a Conventional Commits header, e.g. 'fix(auth): refuse expired sudo "
        "sessions' or 'feat(events): shareable event page'. Allowed types: "
        + TYPES.replace("|", ", ") + ".")


def header_errors(text):
    errs = []
    if not HEADER.match(text):
        errs.append("not a Conventional Commits header")
    if len(text) > 100:
        errs.append(f"{len(text)} chars (max 100)")
    if text.rstrip().endswith("."):
        errs.append("ends with a period")
    return errs


def check_pr(title, body, author, require_card_ref):
    failed = False
    if author.endswith("[bot]") and author.startswith(("dependabot", "renovate")):
        if header_errors(title):
            print(f"::warning::{author} title '{title}' is not conventional; set "
                  "commit-message.prefix (e.g. chore(deps)) in the bot config.")
        return False
    errs = header_errors(title)
    if errs:
        failed = True
        print(f"::error title=PR title::'{title}': {'; '.join(errs)}. {HELP}")
    text = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    if len(re.sub(r"\s", "", text)) < 40:
        failed = True
        print("::error title=PR body::The description is empty. Say what changed, why, "
              "and how it was tested (see the PR template).")
    if require_card_ref and not re.search(r"\bTOG-\d+\b", body):
        failed = True
        print("::error title=Card reference::Add 'Refs: TOG-1234' to the PR body.")
    elif not require_card_ref:
        hit = re.search(r"\bTOG-\d+\b", body)
        if hit:
            print(f"::warning title=Internal reference::This repo is public: remove the "
                  f"internal tracker ID {hit.group(0)} from the PR body and link only "
                  f"public GitHub issues.")
    return failed


def main():
    event = os.environ.get("EVENT", "")
    require_card_ref = os.environ.get("REQUIRE_CARD_REF", "false") == "true"
    if event == "push":
        failed = False
        for c in json.loads(os.environ.get("COMMITS") or "[]") or []:
            subject = (c.get("message") or "").splitlines()[0] if c.get("message") else ""
            if subject.startswith(("Merge ", "Revert \"")):
                continue
            errs = header_errors(subject)
            if errs:
                failed = True
                print(f"::error title=Commit on main::{c.get('id', '')[:10]} '{subject}': "
                      f"{'; '.join(errs)}. Merge PRs with squash and the PR title as the "
                      "commit title.")
            if not require_card_ref:
                hit = re.search(r"\bTOG-\d+\b", message)
                if hit:
                    print(f"::warning title=Internal reference::Commit {c.get('id', '')[:10]} holds "
                          f"internal tracker ID {hit.group(0)}. Public history carries no "
                          f"internal references.")
    else:
        title = os.environ.get("TITLE", "").strip()
        body = os.environ.get("BODY", "") or ""
        author = os.environ.get("AUTHOR", "")
        failed = check_pr(title, body, author, require_card_ref)
    if failed:
        sys.exit(1)
    print("PR conventions OK")


if __name__ == "__main__":
    main()
