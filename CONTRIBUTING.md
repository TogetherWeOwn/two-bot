# Contributing to two-bot

## Local setup, start to finish

Requires **Node 24 or newer** plus a running **Postgres 17+** with a scratch
database for the suite (e.g. `createdb two_bot_test` — CI provides its own
throwaway service). No Docker, no build step.

All three repos are **private**, so authenticate git first (once per machine —
`gh` reads `GH_TOKEN` from the environment, and this hands the same token to
git), then:

```bash
gh auth setup-git
git clone https://github.com/TogetherWeOwn/two-bot.git
cd two-bot
npm ci --include=dev
TWO_TEST_DATABASE_URL=postgres://localhost:5432/two_bot_test npm test
```

Without `TWO_TEST_DATABASE_URL` the suite fails fast with
`TWO_TEST_DATABASE_URL is required` — dozens of test files, including many
`unit.*` ones, run against isolated Postgres schemas.

`npm ci` also installs the repo's git hooks, which refuse a direct push to
`main` and refuse to commit a `.env` or a private key. If you ever need to
reinstate them: `npm run hooks:install`.

If the suite passes you have a working environment. It needs no Discord token,
because `tools/mock-discord/` stands in for Discord — but the bot itself still
needs a database URL at runtime (see the mock-harness path in the
[README](README.md): `TWO_DATABASE_URL=... DISCORD_TOKEN=mock ...`).

`--include=dev` is not optional padding. Some environments set
`NODE_ENV=production`, and npm then skips devDependencies without saying so.
The symptom is `npm run typecheck` failing with `tsc: not found`, which looks
like a broken machine rather than a missing flag.

To run the bot for real, copy `.env.example` to `.env`, put a token in it, and
`npm run dev`. See [docs/SECRETS.md](docs/SECRETS.md) for where tokens come
from. **Never** put a real token anywhere but `.env` or the production
environment file.

## The commands

| Command | What it does |
|---|---|
| `npm test` | Unit + end-to-end. Needs `TWO_TEST_DATABASE_URL` (running Postgres 17+). Must pass before you open a PR. |
| `npm run test:postgres` | Same suite through the CI wrapper: fails if any required Postgres-backed suite (`POSTGRES_SUITES` in `scripts/require-suites.ts`) skips or comes back short. Needs `TWO_TEST_DATABASE_URL`. |
| `npm run typecheck` | Node strips types, it does not check them. CI runs this; run it too. |
| `npm run dev` | Runs against real Discord using `.env`. |
| `npm run funnel` | Prints the current funnel numbers. |
| `npm run preflight` | Checks credentials and bot permissions before a deploy. |

## Branches

Nothing lands on `main` except through a pull request. That applies to me too.

How strongly that is enforced depends on the org's GitHub plan, and it is worth
knowing which one you are working under, because the failure looks different:

| | What stops you |
|---|---|
| **GitHub Team** | The server rejects the push. There is no way around it. |
| **GitHub Free** (private repos) | GitHub enforces nothing. The `pre-push` hook in your clone refuses, and `main-guard` turns any push that gets through into a red X on `main` within a minute. |

On the free plan the rule is real but the wall is not, so treat a `main-guard`
failure as something to go and talk about, not a flaky job to re-run.

Name branches `type/short-description`:

```
feat/invite-click-tracking
fix/duplicate-join-events
docs/runbook-restore-steps
chore/bump-discord-js
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`.

## Commits

Subject line in the imperative, under 72 characters, no trailing period:

```
Add invite click redirect and attribution
Fix double-counting when a member rejoins
```

Prefix with the type when it helps (`fix: ...`); it is not enforced. What is
enforced: the subject says what changed, not what file you touched. If you
cannot describe a commit in one line, it is probably two commits.

Reference the issue in the body when there is one (`TWO-9`).

## Pull requests

1. Branch off `main`.
2. Open the PR. CI runs the check job (`npm run typecheck`, the
   `npm run test:postgres` wrapper, restart-storage provisioning, grant
   self-test) and the postgres job (`test:postgres` again, then `migrate`,
   `web:views`, `web:role`, `verify:web-role`), plus a secret scan. All must
   be green — the wrappers are checked-in scripts (`scripts/ci/run-check-job.sh`,
   `scripts/ci/run-postgres-job.sh`), so reproduce a red run locally with those.
3. A code owner reviews it — see [.github/CODEOWNERS](.github/CODEOWNERS).
   You cannot approve your own PR. That is deliberate and it applies to
   everyone.
4. Squash or merge commit, your choice. Keep the history readable.

A red PR does not merge. If CI is wrong, fix CI in its own PR rather than
routing around it.

## Things that will get a PR sent back

- A secret in the diff. Rotate it, do not just delete the line — it is in the
  history the moment you push.
- Member personal data stored where the feature does not need it. Read
  [docs/PRIVACY.md](docs/PRIVACY.md) before adding a column.
- Anything that DMs or mass-messages members. That needs sign-off from the CEO
  before it is written, not after.
- A new runtime dependency without a sentence in the PR saying why the standard
  library will not do.

## CLI exit-code contract (scripts/*)

Every `scripts/*.ts` and `scripts/*.sh` an operator or CI step scripts
against uses the same four codes, so a wrapper can act without parsing text.
Full operator reference: `scripts/coolify-deploy.sh` header (the original
contract). Summary:

| Exit | Meaning | Operator action |
|---|---|---|
| `0` | Success / green / ready. | Proceed. |
| `1` | Ran, verdict is red: a check failed, drift found, verification refused. Artefacts may still be written (e.g. wave0 drift report). | Read the output, fix the thing checked, re-run. |
| `2` | Never ran: bad usage or unmet environment precondition (bad flags, missing/invalid env, missing token, wrong DB shape, refused live guild). Nothing was checked or written. | Fix the invocation, not the thing checked. |
| `3` | Blocked on someone/something else: waiting on a human, an empty-read safety stop, a tampered backup, a deploy that never went healthy. Retrying the same command changes nothing. | Escalate to the named owner, do not re-run. |

Rules for new scripts: usage/env guards exit `2`, check verdicts exit `0`/`1`,
waiting-on-a-human exits `3`. Never use `2` for a verdict — see grandfathered
variances below.

Five most operator-facing scripts (aligned, TOG-9127):

- `scripts/coolify-deploy.sh` — the reference: `0` deployed, `2` precondition unmet, `3` triggered-but-unhealthy, `1` unexpected API failure.
- `scripts/preflight.ts` — `0` ready, `1` FAIL, `2` missing token.
- `scripts/health-check.ts` — `0` all pass, `1` a check failed, `2` usage/env.
- `scripts/migrate.ts` — `2` missing/non-Postgres URL, `1` drift (`CHANGED`/`ORPHAN`) on `--status`.
- `scripts/staging-doctor.ts` — `0` ready, `1` fixable, `3` waiting on someone.

Also aligned: `scripts/staging-verify.ts` (`2` usage/env, `1` FAIL), `scripts/web-views.ts`
(`2` missing/non-Postgres URL, `1` missing views), `scripts/staging-reset.ts` and
`scripts/guild-config-restore.ts` (guard refusals exit `2`, tampered backup exits `3`).

Grandfathered variances (do not copy into new scripts):

- `scripts/bootstrap-host.sh` exits `4` (system Node), `5` (foreign app dir),
  `6` (token in env file) — host-setup stops documented in `docs/RUNBOOK.md` §Deploy.
- `scripts/presence-trend.ts` and `scripts/community-scorecard.ts` exit `2` on a
  firing/incomplete verdict. That predates this contract and cron reads it
  literally; changing it breaks callers. New verdict-carrying scripts use `1`.
- `scripts/wave0-export.ts` exits `1` with artefacts written on drift — correct
  per this contract, but callers under `set -e`/CI must not read it as a crash.
  See `docs/RUNBOOK.md` §Wave 0.

## Where things live

`src/core/` has no Discord dependency and is where the funnel rules are. If you
can put logic there instead of in `src/discord/`, do — it is the part that can
be tested without a network.

Full layout is in the [README](README.md).
