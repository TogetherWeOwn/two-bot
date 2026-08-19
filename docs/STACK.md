# Stack choice for the TWO bot

Short version: **Node 24 + TypeScript + discord.js + SQLite, on one small Linux
box under systemd.** Everything below is the reasoning, and what would make us
change our minds.

## The decisions

| Piece | Choice | Why |
|---|---|---|
| Language | TypeScript on Node 24 | Discord's best-supported library is JavaScript. Types catch schema mistakes at edit time, which matters when the whole point is trustworthy numbers. |
| Build step | None | Node 24 runs `.ts` files directly by stripping types. No bundler, no `dist/`, no build to get wrong. What you read in `src/` is what runs in production. |
| Discord library | discord.js v14 | The default choice for Discord bots in JS. Well maintained, complete gateway coverage, huge amount of public help when we get stuck. |
| Datastore | SQLite via Node's built-in `node:sqlite` | Zero servers to run, zero extra dependencies, and the entire dataset is one file we can copy. At our size (a few thousand members, maybe a few hundred thousand events a year) this is not a compromise - it is faster than a network database would be. |
| Hosting | systemd on one Linux VM | `Restart=always` gets us crash recovery and reboot survival in four lines. No container runtime to maintain. |
| Backups | Nightly `VACUUM INTO` snapshot, gzipped, 14 kept, each one verified | See `docs/RUNBOOK.md`. |

Runtime dependency count: **one** (discord.js). `ws` and `typescript` are dev-only.
Fewer moving parts means fewer things that can be broken at 2am by someone who
is not an engineer.

## Why not the obvious alternatives

- **Python + discord.py** — fine library, but we would be running a second
  language ecosystem for the dashboard anyway. One language for bot, jobs, and
  dashboard is worth more than any per-library preference.
- **Postgres** — the right answer once we have a dashboard with concurrent
  writers or more than one process writing. Today one process writes and one
  script reads, which is exactly SQLite's sweet spot. The migration path is
  real: all writes go through `EventStore`, so swapping the driver is a
  contained change, not a rewrite.
- **Serverless / Cloudflare Workers** — a Discord gateway bot needs a
  long-lived websocket. Serverless is the wrong shape for this.
- **Docker** — adds a runtime to patch and debug for no benefit at one service
  on one box. Worth revisiting when there is a bot *and* a dashboard *and* a
  worker.

## Constraints this choice imposes

Worth knowing before you write code:

1. **No TypeScript parameter properties.** Node strips types, it does not
   compile them, so `constructor(private db: Db) {}` is a syntax error. Declare
   the field and assign it. This is the only ergonomic cost we hit.
2. **Type-only imports must say `import type`.** A plain
   `import { AddressInfo } from 'node:net'` fails at runtime because stripping
   leaves a real import of a type that does not exist.
3. **`npm run typecheck` is not optional.** Node does not check types, only
   removes them. Type errors will happily run. CI runs `tsc --noEmit`.
   `erasableSyntaxOnly` is on in `tsconfig.json`, so constraints 1 and 2 above
   fail the typecheck rather than surprising someone at runtime.
   Note that `NODE_ENV=production` makes `npm install` skip devDependencies
   silently, which removes `tsc` — CI uses `npm ci --include=dev` for that reason.
4. **One writer.** SQLite in WAL mode handles many readers and one writer. If
   we ever add a second writing process, that is the signal to move to Postgres.

## When to revisit

Concrete triggers, so this is not a matter of taste later:

- The `events` table passes ~5 million rows, or the funnel report takes over a
  second → move to Postgres.
- More than one process needs to write → move to Postgres.
- We need the dashboard to be publicly reachable with real logins → that is a
  separate service, and probably a separate box.
- The bot needs more than one shard (Discord requires sharding past ~2,500
  guilds) → not applicable; we are one guild and always will be.
