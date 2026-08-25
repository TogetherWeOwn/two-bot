# GitHub org, repos, and branch protection

Everything TWO writes lives in one org so that access, review, and secrets are
decided once rather than per repo.

| | |
|---|---|
| Org | `TWO-Gaming` (id `318830450`, created 2026-08-20) |
| Repos | `two-bot` (this one), `two-web` (the Laravel site), `two-design` (tokens and brand) |
| Visibility | **Private**, all three, until the launch hardening pass has cleared secrets and history |
| Default branch | `main` |
| Setup | [`scripts/setup-github.sh`](../scripts/setup-github.sh) — idempotent, re-runnable, `--dry-run` and `--verify` supported |

Org logins are case-insensitive on GitHub, so `two-gaming` and `TWO-Gaming`
resolve to the same org. The scripts, the CODEOWNERS files and the bot's systemd
unit all use the lowercase form and **nothing needs renaming**. Set
`TWO_GITHUB_ORG=TWO-Gaming` if you want the canonical casing in the git remotes.

## The credential

A **fine-grained** personal access token scoped to the org, delivered through
the secrets channel and read from `GH_TOKEN`. `gh` picks that variable up
directly — **do not run `gh auth login`**, and never paste the token into an
issue, a comment, or a chat message.

`gh` having the token does **not** mean `git` does. All three repos are private,
so the very first thing a new agent does — `git clone https://github.com/...` —
fails with `could not read Username for 'https://github.com'`, before any README
step runs. Two ways past it, and each repo's README now says so:

```bash
gh auth setup-git                  # once per machine, then git works everywhere
```

**`gh repo clone` is not a substitute.** It carries the credential through the
clone itself and then leaves a repo with no helper configured, so the first
`git push` from it fails the same way the clone would have. That was measured,
not assumed — the branch carrying this very paragraph failed to push from a
`gh repo clone` checkout. `gh auth setup-git` is the step that matters.

`setup-github.sh` sets the same helper per repo on the working copies it pushes,
which is why this never showed up until someone cloned from scratch. It was
found on 2026-08-20 by doing exactly that.

| Level | Permission | Why |
|---|---|---|
| Organization | `Administration: write` | create repos in the org |
| Organization | `Members: write` | create the five teams |
| Repository | `Metadata: read` | required by every other repo permission |
| Repository | `Administration: write` | branch protection, merge settings, team access |
| Repository | `Contents: write` | push history |
| Repository | `Workflows: write` | push `.github/workflows/` |
| Repository | `Actions`, `Secrets`, `Environments`, `Pull requests`, `Issues`: write | CI, the production environment gate, and review routing |

The full spec is the `github-access` document on TWO-81. These are fine-grained
permission *names* — they are not the classic-PAT scopes (`repo`, `admin:org`,
`workflow`), and an older version of the setup script asked for the wrong thing.

**Remotes are HTTPS, not SSH.** A PAT authenticates HTTPS; it does not
authenticate `git@github.com`, and there is no SSH key on the machine that runs
the setup. The script probes `ssh -T git@github.com` and picks the form that
actually works, so a machine that *does* have a key still gets SSH. Force it
either way with `TWO_REMOTE_PROTOCOL=ssh|https`. On HTTPS it sets
`credential.https://github.com.helper` to gh's helper, per repo — the token is
read from `GH_TOKEN` at push time and is **never** written into a remote URL or
into `.git/config`, where every `git remote -v` would print it.

**Prove the token before using it.** `setup-github.sh --dry-run` reports whether
it was handed a classic or fine-grained token, and then proves the org write by
creating a throwaway team and deleting it again:

```
== Token probe (dry run only - creates and deletes a throwaway team)
   ok    can LIST teams (org Members: read)
   ok    CAN create a team (org Members: write is sufficient) - created @two-gaming/zz-preflight-token-check-1234
   ok    CAN delete a team - probe team removed, org is back as it was
```

If creation is refused, the probe prints GitHub's own error and names the exact
permission to add. That is the whole point: a missing permission should surface
in a dry run, not half way through team creation with three teams made and two
not. `TWO_SKIP_TOKEN_PROBE=1` turns it off. Repo-level permissions cannot be
probed before a repo exists; they are exercised on the real run, step by step,
and each step reports its own failure.

## The thing to know before you start

**On GitHub Free, branch protection does nothing on a private repository.**

Rulesets and classic branch protection are enforced on public repos on every
plan, but on private repos only from **GitHub Team** upward.

*(An earlier version of this section said the API call succeeds and the rule is
then silently not applied. That was wrong, and it was checked against the real
org on 2026-08-20: the call returns 403 and nothing is stored. See
[the decision](#the-decision-made-2026-08-20-two-81) for what that changes.)*

That leaves three options and only one of them is good:

| Option | Cost | Verdict |
|---|---|---|
| **GitHub Team** | $4 / committer / month (~$20–24/mo for this team) | **Recommended.** Private repos and enforced protection, which is what TWO-22's pipeline depends on. |
| Make repos public now | free | **No.** History and secrets have not been cleared yet. Private → public is easy; the reverse is not. |
| Stay free + private, protection advisory only | free | Works right up until the day somebody is in a hurry. This is the situation the issue was written to prevent. |

Only one of the three combinations fails, and it is the one that fails silently:

| | private | public |
|---|---|---|
| **Free** | protection **not** enforced, silently | protection enforced |
| **Team and up** | protection enforced | protection enforced |

This is a spend decision, so it is the CEO's, not mine. The setup script
detects a free plan and warns rather than pretending it worked.

### The decision, made 2026-08-20 (TWO-81)

**Free plan, private repos, protection advisory.** The founder's words: *"C for
now. Once we start making revenue I might pay for the team."* That is a recorded
choice, not a shortcut, and it is what the org runs on today:

```bash
TWO_REPO_VISIBILITY=private TWO_ACCEPT_UNPROTECTED_MAIN=1 ./scripts/setup-github.sh
```

`TWO_ACCEPT_PUBLIC_REPOS` is **not** set and must not be — the repos stay
private. `TWO_ACCEPT_UNPROTECTED_MAIN=1` is the gate below being answered, which
is exactly what it was built for.

**This is reversible — but not for free, and not by itself.** Measured against
the real org on 2026-08-20, after the repos existed:

```
PUT  repos/two-gaming/two-bot/branches/main/protection  -> 403
GET  repos/two-gaming/two-bot/branches/main/protection  -> 403
GET  repos/two-gaming/two-bot/rulesets                  -> 403
"Upgrade to GitHub Pro or make this repository public to enable this feature."
```

That corrects something this document and TWO-40 both used to say. GitHub does
**not** accept the rule and quietly ignore it. It refuses outright, and stores
nothing. Two consequences, one in each direction:

- **Better than feared.** There is no silent failure mode. A settings page
  cannot show a green padlock that means nothing, because there is no saved
  rule to show. What you see is the truth.
- **Worse than hoped.** Moving to GitHub Team later does **not** switch
  protection on by itself. There is nothing stored to start enforcing. The
  rules have to be written again.

The upgrade path is still short, because writing them again is one command:

```bash
./scripts/setup-github.sh          # idempotent; writes protection, skips the rest
./scripts/setup-github.sh --verify # confirms, with TWO_ACCEPT_UNPROTECTED_MAIN unset
```

That is minutes, not a migration — but it is a step somebody has to remember,
and the day the plan changes is exactly the day nobody is thinking about branch
protection. So it is not left to memory:
[`plan-watch.yml`](../.github/workflows/plan-watch.yml) asks GitHub every Monday
whether it is still refusing. The week it stops refusing, the job fails and puts
the whole re-apply runbook in its own run summary.
`./scripts/plan-watch.sh --runbook` prints those steps at any time. Full
reasoning: TWO-85.

**The watcher is armed, on the default `GITHUB_TOKEN`, with no secret to set.**
It used to need permissions a workflow token cannot be granted —
`administration` is not even a valid `permissions:` key, and the org plan is
only shown to an org admin — so it ran unarmed, reported that it could not see,
and exited 0. `plan-watch.sh` now reconstructs the same verdict from
`branches/{b}` (`.protected`) and `rulesets` (200 vs 403), which need only
`contents: read` + `metadata: read`. The repository secret `PLAN_WATCH_TOKEN`
is obsolete: delete it if it was ever created, and do not add one (TOG-383).

The org-plan probe still comes back unknown and that is expected — it only
corroborates. The branch-protection probe alone reaches a verdict.

The remaining manual step is the one no script can check for itself — that
GitHub, and not just the local hook, rejects a direct push:

```bash
git commit --allow-empty -m 'protection check'
git push origin main    # must be REJECTED by GitHub
```

Two other things start working silently on the day the plan changes, and both
need checking then: `CODEOWNERS` does not route reviews at all on Free, and the
`production` environment on `two-web` has no required reviewers — which must be
fixed *before* `FORGE_PRODUCTION_DEPLOY_HOOK` is ever set, or the release
sign-off gate is decorative.

Until then the guard is [`main-guard.yml`](#plan-b-if-the-answer-is-no) in all
three repos: it cannot refuse a direct push, but it turns one into a red X with
a name on it within a minute.

**If the answer is Free + public**, the script can act on it without a code
change:

```bash
TWO_REPO_VISIBILITY=public TWO_ACCEPT_PUBLIC_REPOS=1 ./scripts/setup-github.sh
```

Both variables are required. Two of them for one decision is deliberate:
publishing is the only step here that cannot be undone. Setting a repo back to
private does not un-clone it, un-fork it, or remove it from anyone's search
index — and TWO-35 has not yet cleared the history that would go out with it.
With `TWO_REPO_VISIBILITY=public` set, the script stops treating a free plan as
a problem, because on public repos protection genuinely is enforced.

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
| [`plan-watch.yml`](../.github/workflows/plan-watch.yml) | Weekly, asks GitHub whether it is still refusing branch protection. Silent while the answer is yes. The week it changes, the job fails with the re-apply runbook in its summary — so Plan B ends deliberately rather than by being forgotten. **Armed**, on the default `GITHUB_TOKEN`; no secret to set (TOG-383). Also runs on any push or PR that touches the watcher, so it cannot rot unnoticed. |

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
one account being asleep. `setup-github.sh` creates all five and grants their
repo access; the org owner only has to **add the members**.

| Team | Members | Reviews | Write on |
|---|---|---|---|
| `founding-engineer` | Founding Engineer | the bot, deploy, secrets, privacy | all three |
| `web-lead` | Web Lead | Laravel backend, schema, policies | `two-bot`, `two-web` |
| `frontend` | Frontend Engineer | Blade views, JS, CSS, design tokens | `two-web`, `two-design` |
| `qa` | QA Engineer | tests and CI everywhere | all three |
| `design` | Product Designer | tokens, brand assets, accessibility | `two-design` |

Access follows the `CODEOWNERS` files, not preference. `frontend` gets no access
to `two-bot` because `two-bot`'s `CODEOWNERS` never names it; it does get
`two-design`, because `resources/css/two.css` in `two-web` is a copy of
`two-design/tokens/two.css` and Frontend is who has to carry a token change
across. Everyone gets **Write**, which is also the minimum that makes a team
eligible to be a code owner. Nobody needs Admin for day-to-day work; org owner
stays with the founder.

`design` is a fifth committer and therefore about **$4/month more** on GitHub
Team than the four-agent estimate in TWO-40. If the founder would rather not add
a fifth seat, the fallback is to drop the `design` team and let
`@two-gaming/frontend` own `two-design` — worse, because the person who wrote
the tokens then cannot be required to review a change to them, but it is not
broken. That is a spend call, not mine.

**Three ways this breaks silently**, all of them checked by `--verify`:

1. **The team does not exist.** A `CODEOWNERS` rule naming a missing team is
   not an error. GitHub drops the rule, the settings page looks fine, and
   reviews stop being requested while everyone assumes routing works.
2. **The team exists but has read, not write.** A team without write cannot own
   a path. Same silence.
3. **The team exists but is empty.** The review request is made and reaches
   nobody. `--verify` warns; only the org owner can fix it.

`--verify` reads the `CODEOWNERS` actually committed in each repo rather than a
list kept here, so a handle added to the file later is checked too.

One thing no amount of setup fixes: on **GitHub Free with private repos,
`CODEOWNERS` does not route reviews at all**, and "require review from Code
Owners" is unavailable. On Free the file is documentation. It becomes a gate on
GitHub Team — the same plan decision as branch protection, above.

## What protection is set to

Applied to `main` in all three repos by the setup script:

- No direct pushes — everything arrives by pull request.
- **Zero required approvals — deliberately.** See below.
- **Admins included.** A rule I can bypass is not a rule.
- No force pushes, no branch deletion, conversations must be resolved.
- Required status checks must be green — the full list is below.

#### Why zero required approvals

This used to read "1 approving review, from a code owner", and the script wrote
exactly that. Measured against the real org on 2026-08-25 (TOG-111), that
setting does not gate merges — it stops them:

- Every agent-authored PR comes from **one shared App identity**. On `two-bot`,
  PRs #6–#14 are all `togetherweown[bot]`.
- GitHub will not let an author approve their own pull request. That identity
  can never clear its own gate; the API returns 422.
- `.github/CODEOWNERS` names exactly one account, `@Rick7C2`, a human — its own
  header notes the org has one member with write access.

So every PR the fleet opens would wait on one person, and
`require_last_push_approval` would make that approval expire on the next push.
That is a deadlock, not a control, and TOG-240 already recorded the decision:
the reviewer pool is agents that may be asleep.

What still gates a merge needs nobody awake: a pull request is **required**,
required status checks (CI + `gitleaks`) must be green, admins get no bypass,
and force-push and deletion are refused. Human sign-off is kept where it is
affordable and where the blast radius justifies it — the `production`
environment reviewer gate, at **deploy** time rather than merge time.

Raise `required_approving_review_count` to 1 the day a second human has write
access. Nothing else in the payload needs to change, and self-approval is
already refused.

### Required status checks

Set in one place, `BOT_CHECKS` / `WEB_CHECKS` / `DESIGN_CHECKS` at the top of
[`setup-github.sh`](../scripts/setup-github.sh). Confirmed against the real
workflows on 2026-08-19.

| Repo | Context | Comes from | What it is |
|---|---|---|---|
| `two-bot` | `check` | `ci.yml`, job `check` | typecheck + tests |
| `two-bot` | `gitleaks` | `secret-scan.yml`, job `gitleaks` | full-history secret scan |
| `two-web` | `static` | `ci.yml`, job `static` | Pint + PHPStan level 8, and `verify-pipeline.sh --lint` |
| `two-web` | `pest` | `ci.yml`, job `pest` | Pest unit + feature, real Postgres |
| `two-web` | `dusk` | `ci.yml`, job `dusk` | Laravel Dusk, real Chrome |
| `two-web` | `budgets` | `ci.yml`, job `budgets` | Lighthouse budget + WCAG 2.2 AA |
| `two-web` | `tests` | `ci.yml`, job `tests` | aggregate of the four above |
| `two-web` | `gitleaks` | `secret-scan.yml`, job `gitleaks` | full-history secret scan |
| `two-design` | `tests` | `ci.yml`, job `tests` | WCAG 2.2 AA contrast over 43 pairings, plus a floor on how many are asserted |
| `two-design` | `gitleaks` | `secret-scan.yml`, job `gitleaks` | full-history secret scan |

**A context is a job name, not a workflow name.** The workflow file is called
`secret-scan.yml` and its `name:` is `secret-scan`, but the check GitHub reports
is the job — `gitleaks`. Requiring `secret-scan` would wait forever on a check
that never arrives, which looks like a hang rather than a misconfiguration. When
you rename a CI job, update the protection.

**`ci` is not in the list, and must never be.** `CI` is the *workflow* name in
`two-web`; no job is called that. GitHub's two failure modes here are asymmetric
and only one of them is loud:

- a **skipped** required check counts as **passed** — a badly declared aggregate
  lets a red PR merge;
- an **absent** required check **blocks the pull request forever** — `main`
  becomes unmergeable the moment protection is applied, and it presents as slow
  CI, not as a broken rule.

`--verify` reads the workflow files on `main`, works out what each job will
actually report as (its `name:` if it sets one, its id otherwise), and **fails**
when a required context matches none of them. It considers only workflows that
trigger on `pull_request`, since a push-only workflow like `main-guard` never
reports on a PR. It stays a warning in the two cases where a miss is not
evidence of a bug: the repo has no workflows on `main` yet (still on a branch
awaiting review), or the parser read nothing at all.

It also warns the other way — a job that reports on PRs but is not required can
go red while the PR merges. Advisory jobs are legitimate; surprises are not.

**Why every leaf job is listed and not just the aggregate.** For branch
protection, a *skipped* check counts as passed. An aggregate declared with plain
`needs:` is **skipped**, not failed, when one of those goes red — so requiring
only the aggregate would let a red PR merge. `two-web`'s `tests` does carry
`if: always()` with a guard covering `failure`, `cancelled` **and** `skipped`
(QA, TWO-22), so the aggregate alone would in fact be sound. Naming the leaves
as well means protection does not depend on that guard staying correct. The cost
is that the list has to be updated when a job is added or renamed — which is
what the two `--verify` checks above are for.

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

**Re-checked 2026-08-20 with gitleaks itself**, rather than the hand-written
regex sweep above — a real scanner has rules the sweep did not. It surfaced 5
hits the first pass missed. All five were read by hand and none is a credential:
a Discord **guild** ID (public — every member can read it), an obviously fake
staging ID in a test fixture, and the literal placeholder `<bot token>` in a
docs example. The conclusion is unchanged: nothing to rotate. The shapes are
allowlisted narrowly in [`.gitleaks.toml`](../.gitleaks.toml), because a
required check that is red for reasons nobody believes gets merged past.

`two-design` was scanned the same way on the same date: 4 commits, no leaks.

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

### two-design specifically

Nothing to do — the script finds it next to `two-bot` in the shared workspace
and pushes it with the rest. `TWO_DESIGN_PATH=/path/to/two-design` if yours is
somewhere else.

It is a real repo, not decoration: `resources/css/two.css` in `two-web` is a
byte-identical copy of `two-design/tokens/two.css`, and the site's WCAG 2.2 AA
contrast guarantee is asserted by `two-design/tools/check-contrast.mjs` against
those tokens. With no repo, that check has nowhere to run and the accessibility
claim on the launch checklist has nothing behind it.

Any local branch that is **not** already merged into `main` goes up too. Work
that exists in one working copy and nowhere else is one lost directory from
gone, and this repo is the reason that rule exists.

## Verifying it actually works

### What was actually proved, 2026-08-20

The org went live on this date. These are measurements, not expectations.

| Claim | How it was proved | Result |
|---|---|---|
| `main-guard` ignores the initial import | pushed a first commit to a throwaway repo | **skipped**, correct |
| `main-guard` catches a direct push | second commit pushed straight to `main`, no PR | **failed**, correct — `94c9759 was pushed to main by Rick7C2 without a pull request` |
| `main-guard` passes a real merge | merged PR #1 in `two-bot` and `two-design` | **success**, correct |
| `gitleaks` is not a paid dependency | ran the pinned binary in CI | **success** on `main` in both repos |
| `two-bot` history is free of credentials | gitleaks 8.30.1 over all 47 commits | no leaks |
| `two-design` history is free of credentials | gitleaks 8.30.1 over all 4 commits | no leaks |
| Branch protection is unavailable, not silent | `PUT`/`GET` protection, `GET` rulesets | 403, nothing stored |
| `two-web` history pushed intact, not flattened | pushed the Web Lead's own clone; counted commits on the remote | 22 on `main`, oldest scaffold commit present |
| `two-web` history is free of credentials | gitleaks 8.30.1 over all commits, before the push | no leaks |
| A fresh clone reaches a running bot | cloned `two-bot` from the org into an empty dir, followed the README only | `npm ci` 1.5s, 247/247 tests in 23s, bot ran against the mock and recorded a full funnel |

The fresh-clone run is the acceptance criterion for TWO-36 ("a fresh clone gets
a new agent to a running local app using only the README"). It passed on the
second attempt: the first died at `git clone` because the repo is private and
the README said nothing about credentials. That is fixed above, and it is the
kind of gap only an actual cold clone finds — everyone who already had a working
copy had the helper set by the setup script.

The `main-guard` proof used a throwaway private repo, `zz-main-guard-proof`,
which was deleted immediately afterwards. Proving a guard by tripping it is the
only proof worth having, and doing it in a real repo would have meant a red mark
on `main` that nobody could explain later.

**The negative case is the one that matters here.** On the Free plan nothing
refuses a bad push, so the only question worth answering is whether anything
notices. It does, within a minute, with the pusher's name in a GitHub error
annotation.

### Re-running the check

```bash
./scripts/setup-github.sh --verify
```

That checks visibility, default branch, protection, required checks, that a
pull request is required at all, and that each repo's required files exist and
`.env` does not.
The file list is per repo: `two-design` has no runtime and no configuration, so
it is not asked for a `.env.example` that would only exist to satisfy a check.

It cannot check the one that matters most. Do this by hand, once, per repo:

```bash
git commit --allow-empty -m "protection check"
git push origin main     # must be REJECTED
```

If that push succeeds, protection is not working — most likely the free-plan
problem above. A protection setting nobody has tried to violate is a guess.
