# GitHub org, repos, and branch protection

Everything TWO writes lives in one org so that access, review, and secrets are
decided once rather than per repo.

| | |
|---|---|
| Org | `two-gaming` |
| Repos | `two-bot` (this one), `two-web` (the Laravel site) |
| Visibility | **Private**, both, until the launch hardening pass has cleared secrets and history |
| Default branch | `main` |
| Setup | [`scripts/setup-github.sh`](../scripts/setup-github.sh) — idempotent, re-runnable, `--dry-run` and `--verify` supported |

## The thing to know before you start

**On GitHub Free, branch protection does nothing on a private repository.**

Rulesets and classic branch protection are enforced on public repos on every
plan, but on private repos only from **GitHub Team** upward. The API call to
protect a branch on a free org *succeeds* and the rule is then simply not
applied — which is the worst possible failure mode, because the settings page
looks correct.

That leaves three options and only one of them is good:

| Option | Cost | Verdict |
|---|---|---|
| **GitHub Team** | $4 / committer / month (~$16–20/mo for this team) | **Recommended.** Private repos and enforced protection, which is what TWO-22's pipeline depends on. |
| Make repos public now | free | **No.** History and secrets have not been cleared yet. Private → public is easy; the reverse is not. |
| Stay free + private, protection advisory only | free | Works right up until the day somebody is in a hurry. This is the situation the issue was written to prevent. |

This is a spend decision, so it is the CEO's, not mine. The setup script
detects a free plan and warns rather than pretending it worked.

Verified again on 2026-08-19: GitHub's docs still scope both classic protected
branches and rulesets to "public repositories with GitHub Free… public and
private repositories with GitHub Pro, Team, and Enterprise Cloud." Push
rulesets on private repos are Team and up. Nothing has changed in our favour.

## Plan B, if the answer is no

Built and tested, so "no spend" is a survivable answer rather than a quiet one.
It is two controls: one that stops the accident, one that catches the bypass.

| | |
|---|---|
| [`.githooks/pre-push`](../.githooks/pre-push) | Refuses a direct push to `main`, a non-fast-forward push to `main`, and deleting `main`. The initial import is allowed, because that is how history gets in. Escape hatch is `TWO_ALLOW_MAIN_PUSH=1` — deliberate, documented, and it prints a warning. |
| [`.githooks/pre-commit`](../.githooks/pre-commit) | Refuses `.env`, `.pem`, `.p12`, ssh keys, `.npmrc`, service-account JSON, by filename. Filenames only, so it costs no measurable time and does not get uninstalled out of irritation. |
| [`main-guard.yml`](../.github/workflows/main-guard.yml) | On every push to `main`, asks GitHub whether that commit is attached to a merged PR. If not, the run fails with the actor's name in it. |

Install is automatic — `npm ci` runs `npm run hooks:install`, which sets
`core.hooksPath` to the versioned `.githooks/` directory. `setup-github.sh`
sets it on both working copies too.

**Be honest about what this is.** A client-side hook lives in one clone and
`--no-verify` walks past it. It stops the tired-Friday accident, which is the
common case. It does not stop somebody who means it, and it does not stop a web
UI commit. `main-guard` covers the gap by making any bypass visible within a
minute — detection, not prevention. GitHub Team is still the answer; this is
what we have until then.

On a free plan `setup-github.sh --verify` will not report success for an
unguarded `main` unless you set `TWO_ACCEPT_UNPROTECTED_MAIN=1`. That is on
purpose: the weaker posture should be something somebody chose, not something
that happened because nobody made the call.

## Teams

`CODEOWNERS` points at teams, not people, so a review request never blocks on
one account being asleep. Create these once in the org:

| Team | Members | Reviews |
|---|---|---|
| `founding-engineer` | Founding Engineer | the bot, deploy, secrets, privacy |
| `web-lead` | Web Lead | Laravel backend, schema, policies |
| `frontend` | Frontend Engineer | Blade views, JS, CSS |
| `qa` | QA Engineer | tests and CI in both repos |

Everyone gets **Write**. Nobody needs Admin for day-to-day work; org owner
stays with the founder.

## What protection is set to

Applied to `main` in both repos by the setup script:

- No direct pushes — everything arrives by pull request.
- 1 approving review, from a code owner.
- **No self-approval** (`require_last_push_approval`), and stale reviews are
  dismissed when new commits land.
- **Admins included.** A rule I can bypass is not a rule.
- No force pushes, no branch deletion, conversations must be resolved.
- Required status checks must be green — the full list is below.

### Required status checks

Set in one place, `BOT_CHECKS` / `WEB_CHECKS` at the top of
[`setup-github.sh`](../scripts/setup-github.sh). Confirmed against the real
workflows on 2026-08-19.

| Repo | Context | Comes from | What it is |
|---|---|---|---|
| `two-bot` | `check` | `ci.yml`, job `check` | typecheck + tests |
| `two-bot` | `gitleaks` | `secret-scan.yml`, job `gitleaks` | full-history secret scan |
| `two-web` | `static` | `ci.yml`, job `static` | Pint + PHPStan level 8 |
| `two-web` | `tests` | `ci.yml`, job `tests` | Pest unit + feature, real Postgres |
| `two-web` | `dusk` | `ci.yml`, job `dusk` | Laravel Dusk, real Chrome |
| `two-web` | `budgets` | `ci.yml`, job `budgets` | Lighthouse budget + WCAG 2.2 AA |
| `two-web` | `ci` | `ci.yml`, job `ci` | aggregate of the four above |
| `two-web` | `gitleaks` | `secret-scan.yml`, job `gitleaks` | full-history secret scan |

**A context is a job name, not a workflow name.** The workflow file is called
`secret-scan.yml` and its `name:` is `secret-scan`, but the check GitHub reports
is the job — `gitleaks`. Requiring `secret-scan` would wait forever on a check
that never arrives, which looks like a hang rather than a misconfiguration. When
you rename a CI job, update the protection.

**Why every leaf job is listed and not just the `ci` aggregate.** For branch
protection, a *skipped* check counts as passed. A job declared with plain
`needs: [static, tests, dusk, budgets]` is **skipped**, not failed, when one of
those goes red — so requiring only `ci` would let a red PR merge. Two things fix
it and we do both: the aggregate should be `if: always()` and explicitly fail on
any non-success result, and protection requires the leaves directly. Listing
`ci` as well still buys the original benefit — a job added to its `needs:` later
is covered without touching protection.

`--verify` now fails if any expected context is missing from the live rule, so a
check quietly dropped from the list gets caught instead of discovered during an
incident.

`strict` is on: a branch must be up to date with `main` before it can merge. With
`dusk` in the required set that means a merge behind `main` costs a full browser
run. Correct, but if merges start queueing, this is the knob — not the check list.

### Deploy environment

`setup-github.sh` creates a `production` environment on `two-web` with
`prevent_self_review`. TWO-22's deploy job targets it. **It is created without
reviewers** — those are org account IDs that do not exist until the org does —
and `--verify` warns while it has none. That warning must be cleared *before*
`FORGE_PRODUCTION_DEPLOY_HOOK` is set, or the release gate is decorative.
Deploys themselves are TWO-37 and not approved; both deploy jobs skip green
while their hook secret is unset, which is deliberate — a missing deploy target
must never look like a broken build.

Secrets and variables that TWO-37 will need, once approved:
`FORGE_STAGING_DEPLOY_HOOK` (secret), `FORGE_PRODUCTION_DEPLOY_HOOK` (secret),
`STAGING_URL` (variable). Actions secrets, never the repo.

## Secrets

- Real secrets live in **GitHub Actions secrets** and, in production, in
  `/etc/two-bot/two-bot.env`. Never in the repo. See [SECRETS.md](SECRETS.md).
- `.env.example` is committed and holds names with empty values. `.env` is
  gitignored in both repos.
- **Scanning:** GitHub's own secret scanning and push protection are free on
  public repos and a paid add-on ($19/committer/month) on private ones. Until
  that is bought — if ever — [`.github/workflows/secret-scan.yml`](../.github/workflows/secret-scan.yml)
  runs gitleaks on every PR and on `main`, with full history, as a required
  check. The setup script tries to turn the native feature on and falls back
  quietly if the plan does not include it.
- **A secret that reaches a branch is leaked.** Rotate it in the provider's
  portal. Deleting the line does not help; it is in the history from the
  moment you push.

### History audit, 2026-08-19

Every blob in every commit of `two-bot` was scanned for Discord bot and MFA
tokens, webhook URLs, AWS keys, GitHub PATs, Slack tokens, and private key
headers. **Clean — nothing to rotate.** `.env` has never been tracked, and
`audit/raw/` holds aggregate counts and public server metadata, not member
personal data.

## Moving a repo in

Full history, always. No squash-into-a-fresh-repo — the reasoning behind a
decision lives in its commits, and a flattened import throws that away.

```bash
./scripts/setup-github.sh --dry-run   # read what it will do
./scripts/setup-github.sh
```

The script never uses `--force`. If the remote has commits it does not
recognise it stops instead of overwriting them.

### two-web specifically

The Laravel app's working copy belongs to the Web Lead, so they run the push
rather than me — that way their local history goes up intact instead of being
recreated from a snapshot of the files.

```bash
cd /path/to/two-web
git init && git branch -m main        # only if it is not already a repo
git add . && git commit -m "Laravel 12 scaffold, schema, and local dev setup"
TWO_WEB_PATH=$(pwd) /path/to/two-bot/scripts/setup-github.sh
```

Before that first commit, check `git status` for `.env`, `/vendor`, and
`/node_modules`. Laravel's stock `.gitignore` covers all three; confirm it is
present rather than assuming.

## Verifying it actually works

```bash
./scripts/setup-github.sh --verify
```

That checks visibility, default branch, protection, required checks,
self-approval, and that `README`, `CONTRIBUTING`, `CODEOWNERS`, `.env.example`
and `.gitignore` exist and `.env` does not.

It cannot check the one that matters most. Do this by hand, once, per repo:

```bash
git commit --allow-empty -m "protection check"
git push origin main     # must be REJECTED
```

If that push succeeds, protection is not working — most likely the free-plan
problem above. A protection setting nobody has tried to violate is a guess.
