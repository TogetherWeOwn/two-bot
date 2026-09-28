# GitHub: branches and merging (maintainer note)

Nothing lands on `main` except through a pull request. Branch protection on
`main` requires the CI checks green; see [CONTRIBUTING.md](../CONTRIBUTING.md)
for the contributor workflow (fork, branch `type/short-description`, PR).

The detailed org runbook that used to live in this file — org membership,
token provisioning (`GH_TOKEN`/`setup-github.sh`), plan history, and the
pre-launch hardening log — was internal operations history. It was removed
from the public tree on the 2026-09-28 public-readiness pass ([TOG-8963]).
Maintainers who need it: it is in git history before that commit.

Live facts, briefly:

- Org: `TogetherWeOwn`. Repos: `two-bot` (this one), `two-web`, `two-design`.
- Default branch: `main`. Required checks are the CI jobs plus `gitleaks`.
- `npm ci` installs the repo's git hooks (`.githooks/`), which refuse a direct
  push to `main` and refuse to commit secrets. `main-guard` flags any direct
  push that gets through within a minute.
- Vulnerability reports: see [SECURITY.md](../SECURITY.md) — do not open
  public issues for them.
