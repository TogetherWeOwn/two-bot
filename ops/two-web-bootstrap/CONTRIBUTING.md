# Contributing to two-web

> Template. Copy to `CONTRIBUTING.md` in the two-web repo and correct anything
> that does not match how the app actually runs — then delete this line. The
> only rule that is not yours to change is the PR/protection section.

## Local setup, start to finish

Requires **PHP 8.3+**, **Composer**, and **Node 20+**.

```bash
git clone git@github.com:two-gaming/two-web.git
cd two-web
composer setup      # install, .env, app key, migrate, npm install, build
composer dev        # serve + queue + vite
```

`composer setup` is the whole thing. It copies `.env.example` to `.env`,
generates an app key, and runs migrations against SQLite, so there is no
database server to install.

Then open http://localhost:8000.

If it is not working within ten minutes, that is a bug in this file — say so
and we will fix it, rather than you keeping the workaround to yourself.

## The commands

| Command | What it does |
|---|---|
| `composer test` | Pest. Must pass before you open a PR. |
| `./vendor/bin/pint` | Formats to the house style. Run before committing. |
| `./vendor/bin/phpstan analyse` | Static analysis. |
| `npm run dev` | Vite in watch mode. |
| `php artisan migrate:fresh --seed` | Reset your local database. |

## Secrets

Never commit one. `.env` is gitignored; `.env.example` holds the *names* with
empty values and is committed.

The Discord **OAuth** client id and secret belong to the website. The Discord
**bot token** does not — the website never holds it, and talks to the bot over
its signed internal endpoint instead. That boundary is deliberate: a leak of
the site's credentials must not become a leak of the bot's.

In CI and production, secrets come from GitHub Actions secrets and the server
environment. If you find one in the repo, **rotate it** — deleting the line
does not help, it is in the history from the moment it was pushed.

## Branches

`main` is protected. No direct pushes, for anyone. Everything arrives by PR.

Name branches `type/short-description`:

```
feat/discord-oauth-login
fix/rsvp-double-submit
docs/local-setup-php-version
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`.

## Commits

Imperative subject, under 72 characters, no trailing period:

```
Add Discord OAuth login and role to permission mapping
Fix RSVP count when a member cancels twice
```

Reference the issue in the body when there is one (`TWO-27`).

## Pull requests

1. Branch off `main`.
2. Open the PR. CI must be green — tests, static analysis, formatting, and the
   secret scan.
3. A code owner approves — see [.github/CODEOWNERS](.github/CODEOWNERS).
   **You cannot approve your own PR.** That applies to everyone including
   whoever wrote this.
4. Merge. The branch deletes itself.

A red PR does not merge. If CI is wrong, fix CI in its own PR rather than
routing around it.

## Things that will get a PR sent back

- A secret in the diff.
- `vendor/`, `node_modules/`, or a real `.env` in the diff. Check `git status`
  before your first commit.
- Member personal data stored where the feature does not need it.
- Anything that DMs or mass-messages members. That needs CEO sign-off before it
  is written.
- A page with no empty state and no error state. Both count as part of the
  feature.
