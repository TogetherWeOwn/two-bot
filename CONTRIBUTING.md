# Contributing to two-bot

## Local setup, start to finish

Requires **Node 24 or newer** and nothing else. No database server, no Docker,
no build step.

```bash
git clone git@github.com:two-gaming/two-bot.git
cd two-bot
npm ci --include=dev
npm test
```

`npm ci` also installs the repo's git hooks, which refuse a direct push to
`main` and refuse to commit a `.env` or a private key. If you ever need to
reinstate them: `npm run hooks:install`.

If `npm test` passes you have a working environment. That is the whole setup —
it needs no Discord token, because `tools/mock-discord/` stands in for Discord.
On a clean machine the four commands above take well under a minute.

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
| `npm test` | Unit + end-to-end. Must pass before you open a PR. |
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
2. Open the PR. CI runs `npm ci`, `npm run typecheck`, `npm test`, and a secret
   scan. All four must be green.
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

## Where things live

`src/core/` has no Discord dependency and is where the funnel rules are. If you
can put logic there instead of in `src/discord/`, do — it is the part that can
be tested without a network.

Full layout is in the [README](README.md).
