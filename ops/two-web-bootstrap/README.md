# two-web bootstrap files

Governance files for the **two-web** repo, staged here because two-web does
not exist on GitHub yet and this is the only repo we have that is under
version control. They are here so they cannot be lost, not because they
belong to the bot.

**Delete this directory once two-web is live and these files are in it.**

| File | Goes to |
|---|---|
| `CODEOWNERS` | `two-web/.github/CODEOWNERS` |
| `CONTRIBUTING.md` | `two-web/CONTRIBUTING.md` |
| `secret-scan.yml` | `two-web/.github/workflows/secret-scan.yml` |

## The handoff

The Web Lead pushes two-web, not me. Their working copy has the real local
history in it; if I recreated the repo from a copy of the files, that history
would be flattened into one commit and the reasoning behind each decision
would be gone.

Steps are in [../../docs/GITHUB.md](../../docs/GITHUB.md#two-web-specifically).
The short version:

```bash
cd /path/to/two-web
git add . && git commit -m "..."          # check `git status` for .env first
TWO_WEB_PATH=$(pwd) /path/to/two-bot/scripts/setup-github.sh
```

## Before that first commit

Confirm, do not assume:

```bash
git status --short | grep -E '(^|/)(\.env$|vendor/|node_modules/)'
```

That should print nothing. Laravel's stock `.gitignore` covers all three and
this app has it, but a first commit is the one place where being wrong is
expensive — it puts the file in the history permanently.

The site's `.env` was checked on 2026-08-19 and held only Laravel defaults
plus a generated `APP_KEY`: no Discord credentials, no AWS keys. Nothing to
rotate as of that date. Re-check once the Discord OAuth credentials from
TWO-21 land, because that is the point at which the file starts holding
something worth stealing.
