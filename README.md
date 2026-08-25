# two-bot

The Discord bot and funnel instrumentation for the TWO gaming community.

Its one job right now: **produce trustworthy numbers about how people find us,
whether they join, and whether they stick around.** Onboarding automation and
notifications come after that, because we cannot tell whether they worked
without the numbers first.

## What it does today

- Records every step of the join funnel: `member_join`, `first_message`,
  `first_voice_session`, `member_inactive`, `member_leave`.
- Records every voice visit, not just the first: `voice_session_start` /
  `voice_session_end`, with a duration where we saw both halves. That is what
  makes "how often does this person turn up, and when" answerable. Needs a
  running gateway listener; see `docs/EVENTS.md` limit 5.
- Attributes each join to the invite that brought the member in, and says
  `unknown` when it honestly cannot tell.
- Flags members who have gone quiet, and can list everyone who joined and never
  posted. It produces lists; it does not message anyone.
- Prints a funnel report on demand.

## What it does not do yet

- No dashboard. `scripts/funnel.ts` is the stopgap and reads the same data.
- No `invite_click` tracking. Discord cannot report clicks; that needs a
  redirect link we control. The event type and code path exist and are unused.
- No onboarding flow, role self-assignment, or go-live alerts.

## Quick start

Requires **Node 24 or newer** (it runs TypeScript directly).

All three repos are **private**, so git needs the credential before anything
else. Run this once per machine — `gh` reads `GH_TOKEN` from the environment,
and this hands the same token to git:

```bash
gh auth setup-git
git clone https://github.com/TogetherWeOwn/two-bot.git
cd two-bot
```

Without it you get `could not read Username for 'https://github.com'`.
`gh repo clone` gets you past the clone on its own, but **not** the first
`git push` — the clone it leaves behind has no credential helper configured, so
setup-git is the step that actually matters. Do it first.

Then:

```bash
npm ci --include=dev
npm test            # unit + full end-to-end, no Discord token needed
```

Production runs on Postgres. `npm test` needs no database at all - it falls back
to in-memory SQLite so you can clone and run it. To run the same suite against
Postgres, which is what CI does and the only way the two-process concurrency
tests execute:

```bash
TWO_TEST_DATABASE_URL=postgres://localhost:5432/two_bot_test npm test
```

(`--include=dev` matters: if `NODE_ENV=production` is set, npm quietly skips
devDependencies and `npm run typecheck` then fails with `tsc: not found`.)

To run it against a real server, put a bot token in `.env`
(copy `.env.example`) and:

```bash
npm run dev
npm run funnel      # see the numbers
```

## Running it with no Discord token at all

`tools/mock-discord/` is a local stand-in for Discord: the REST endpoints the
bot calls plus a gateway websocket. The **unmodified** bot connects to it,
receives real dispatch frames, and writes real rows. This is how the whole
project was built and verified before the live token existed.

```bash
node tools/mock-discord/run.ts
# prints DISCORD_API_BASE; in another shell:
DISCORD_TOKEN=mock DISCORD_API_BASE=http://127.0.0.1:<port>/api node src/index.ts
```

It exercises everything except Discord's own servers and TLS.

## Layout

```
src/core/      funnel rules, event vocabulary, invite attribution - no discord.js
src/discord/   the discord.js adapter: gateway events -> core calls
src/store/     database drivers, migrations runner, the single write path
src/jobs/      inactivity sweep
scripts/       funnel report, migrations, backup and restore
tools/         local mock Discord (dev only, never imported by src/)
deploy/        systemd units
migrations/    numbered SQL schema changes (bot 0001-0999, website 1000-1999)
docs/          stack decision, event schema, runbook, secrets, privacy
```

The split matters: `src/core/` has no Discord dependency, so the funnel rules
are tested without a network, a token, or a server.

## Docs

| | |
|---|---|
| [docs/STACK.md](docs/STACK.md) | What we chose, why, and when to revisit |
| [docs/EVENTS.md](docs/EVENTS.md) | The event schema and its known limits |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Deploy, health checks, restore, common problems |
| [docs/SECRETS.md](docs/SECRETS.md) | Token handling and the exact bot permissions needed |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What member data we store, and what we refuse to |
| [docs/RAID-RESPONSE.md](docs/RAID-RESPONSE.md) | The three bot raids, what the join-burst detector does, and what stops a fourth |
| [docs/WEBSITE_CONTRACT.md](docs/WEBSITE_CONTRACT.md) | The `web_v1` views the website reads, and the rules around them |
| [docs/GITHUB.md](docs/GITHUB.md) | The org, branch protection, and how a repo gets moved in |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup, branch naming, commits, how a PR gets merged |

## Open items needing a decision

- **The live bot token.** Not yet issued to engineering. Needed to point this at
  the real TWO server. Required permissions are in `docs/SECRETS.md` — the only
  notable one is *Manage Server*, without which no join can be attributed to an
  invite.
- **A host.** This needs one small always-on Linux box. That is a spend
  decision.
- **Off-box backups.** Backups currently sit on the same machine as the
  database, which protects against corruption but not against losing the
  machine. The nightly dump and the restore both work and have been drilled
  (`docs/RUNBOOK.md`); all that is missing is somewhere to put them, which is a
  spend decision. TWO-47.
- **A Postgres for staging and production.** The bot runs on Postgres now
  (TWO-18) and the website writes the same database. Neither environment has a
  TWO-owned Postgres yet — the migration was proven against a development
  database. Spend decision. TWO-46.
- **30 raid accounts still in the server.** Confirmed live on 2026-08-19: 30 of
  the 84 humans Discord counts joined in one of three bot raids, have never
  posted or spoken, and have never accepted the rules. Removing them is a
  moderation decision. `node scripts/raid-list.ts` prints the exact list and
  kicks nobody. TWO-56.
- **A staff channel for join-burst alerts.** The detector ships in this repo and
  goes live with the bot; until `DISCORD_STAFF_ALERT_CHANNEL_ID` names a
  staff-only channel, the alert reaches a log file nobody reads. TWO-56.
