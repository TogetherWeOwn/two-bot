# two-bot

> **Maintenance mode (2026-09-29, TOG-9788):** bug and security fixes only — new
> development continues in two-bot-next.

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
- Welcomes new members through the onboarding flow (`src/onboarding/`,
  posting via `src/discord/onboarding.ts`).
- Lets members assign themselves roles from maintainer-configured panels
  (`src/selfRoles/`, enabled via `TWO_SELF_ROLE_PANELS`).
- Builds a local growth dashboard: `npm run dashboard` writes
  `data/dashboard.html` from the same database.
- Counts invite clicks, via a redirect we own: `go.two.gg/<campaign>` logs the
  click and 302s to the invite, so we can tell which places actually send
  people. A campaign and a timestamp, nothing about the visitor.
  See `docs/INVITE_TRACKING.md`.

## What it does not do yet

- No hosted dashboard service. `npm run dashboard` builds a static page
  locally (`data/dashboard.html`) from the same data; there is nothing
  deployed to visit.
- Join-burst alerts post to a staff channel the operator configures
  (`DISCORD_STAFF_ALERT_CHANNEL_ID`); there is no paging or external
  alerting beyond that.

## Quick start

Requires **Node 24 or newer** (it runs TypeScript directly).

```bash
git clone https://github.com/TogetherWeOwn/two-bot.git
cd two-bot
```

Then point the suite at an isolated Postgres database. This needs a running
Postgres 17+ with a scratch database of your own (e.g. `createdb two_bot_test`)
— CI supplies its own throwaway service, the repo does not provision one.
Without it the suite fails fast with `TWO_TEST_DATABASE_URL is required`.

```bash
npm ci --include=dev
TWO_TEST_DATABASE_URL=postgres://localhost:5432/two_bot_test npm test
```

CI runs the stricter wrapper below. It executes the same full suite and fails if
any required Postgres-backed suite reports no tests, skips, or comes back short
(the list lives in `scripts/require-suites.ts` as `POSTGRES_SUITES`):

```bash
TWO_TEST_DATABASE_URL=postgres://localhost:5432/two_bot_test npm run test:postgres
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
# prints DISCORD_API_BASE and DISCORD_GUILD_ID; in another shell, with a
# scratch Postgres of your own (same requirement as the suite above):
TWO_DATABASE_URL=postgres://localhost:5432/two_bot_dev DISCORD_TOKEN=mock DISCORD_API_BASE=http://127.0.0.1:<port>/api DISCORD_GUILD_ID=<printed-id> node src/index.ts
```

Without `TWO_DATABASE_URL` the bot exits at boot with `Missing database URL`
— the mock replaces Discord, not Postgres. It exercises everything except
Discord's own servers and TLS.

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
| [docs/CONTRIBUTOR_ONBOARDING.md](docs/CONTRIBUTOR_ONBOARDING.md) | New to the pilot? Start here: joining, hosting, conduct, first contribution |
| [docs/STACK.md](docs/STACK.md) | What we chose, why, and when to revisit |
| [docs/EVENTS.md](docs/EVENTS.md) | The event schema and its known limits |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Deploy, health checks, restore, common problems |
| [docs/SECRETS.md](docs/SECRETS.md) | Token handling and the exact bot permissions needed |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What member data we store, and what we refuse to |
| [docs/RAID-RESPONSE.md](docs/RAID-RESPONSE.md) | The three bot raids, what the join-burst detector does, and what stops a fourth |
| [docs/WEBSITE_CONTRACT.md](docs/WEBSITE_CONTRACT.md) | The `web_v1` views the website reads, and the rules around them |
| [docs/GITHUB.md](docs/GITHUB.md) | Branch protection and merge rules (maintainer note) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup, branch naming, commits, how a PR gets merged |

## License

Licensed under the Business Source License 1.1 (see [LICENSE](LICENSE)).
Licensor: TogetherWeOwn. Each version converts to the Change License —
MIT — on its Change Date (three years after that version is first publicly
released).
