# two-bot

The Discord bot and funnel instrumentation for the TWO gaming community.

Its one job right now: **produce trustworthy numbers about how people find us,
whether they join, and whether they stick around.** Onboarding automation and
notifications come after that, because we cannot tell whether they worked
without the numbers first.

## What it does today

- Records every step of the join funnel: `member_join`, `first_message`,
  `first_voice_session`, `member_inactive`, `member_leave`.
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

Requires **Node 24 or newer** (it runs TypeScript directly and uses the
built-in SQLite).

```bash
npm install
npm test            # unit + full end-to-end, no Discord token needed
```

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
src/store/     SQLite schema and the single write path
src/jobs/      inactivity sweep
scripts/       funnel report, database snapshot, backup
tools/         local mock Discord (dev only, never imported by src/)
deploy/        systemd units
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
| [docs/GITHUB.md](docs/GITHUB.md) | The org, branch protection, and how a repo gets moved in |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup, branch naming, commits, how a PR gets merged |

## Open items needing a decision

- **The live bot token.** Not yet issued to engineering. Needed to point this at
  the real TWO server. Required permissions are in `docs/SECRETS.md` — the only
  notable one is *Manage Server*, without which no join can be attributed to an
  invite.
- **A host.** This needs one small always-on Linux box. That is a spend
  decision.
- **Off-box backups.** Snapshots currently sit on the same machine as the
  database, which protects against corruption but not against losing the
  machine. Somewhere to put them is also a spend decision.
