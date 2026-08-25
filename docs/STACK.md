# Stack choice for the TWO bot

Short version: **Node 24 + TypeScript + discord.js + Postgres, on one small
Linux box under systemd.** Everything below is the reasoning, and what would
make us change our minds.

> **Changed 2026-08-24 (TOG-37): SQLite → Postgres.** This document used to say
> SQLite and listed *"more than one process needs to write"* as the trigger to
> move. The website is that second process, so the trigger fired and we moved.
> The original reasoning is kept at the bottom under
> [Why we started on SQLite](#why-we-started-on-sqlite): it was correct at the
> time, and a trigger that actually fires is worth more than a prediction that
> was right.

## The decisions

| Piece | Choice | Why |
|---|---|---|
| Language | TypeScript on Node 24 | Discord's best-supported library is JavaScript. Types catch schema mistakes at edit time, which matters when the whole point is trustworthy numbers. |
| Build step | None | Node 24 runs `.ts` files directly by stripping types. No bundler, no `dist/`, no build to get wrong. What you read in `src/` is what runs in production. |
| Discord library | discord.js v14 | The default choice for Discord bots in JS. Well maintained, complete gateway coverage, huge amount of public help when we get stuck. |
| Datastore | Postgres via `pg` | Two processes write the funnel log now — the bot and the website. Postgres gives us concurrent writers, real transactions and `ON CONFLICT` arbitration. SQLite gave the second writer a lock error. |
| Schema changes | Numbered `.sql` files in `migrations/`, applied by `src/store/migrate.ts` | Two teams share one database. Ad-hoc bootstrap scripts do not survive that. See `migrations/README.md` for the number ranges. |
| Hosting | systemd on one Linux VM | `Restart=always` gets us crash recovery and reboot survival in four lines. No container runtime to maintain. |
| Backups | Nightly gzipped NDJSON dump, 14 kept, copied off-box, restored monthly by a drill | See `docs/RUNBOOK.md`. |

Runtime dependencies: **two** (discord.js, pg). `ws` and `typescript` are
dev-only. Fewer moving parts means fewer things that can be broken at 2am by
someone who is not an engineer.

## Connection handling

One pool per process, created once in `src/store/postgresDriver.ts` and closed
on SIGTERM. Things worth knowing before you change it:

- **Pool size is `TWO_DB_POOL_MAX`, default 5.** The bot writes a handful of
  rows per member event; it is not throughput-bound. A large pool on a small
  Postgres just moves the queue from the app into the database, where it is
  harder to see. Raise it only after observing actual connection waits.
- **`statement_timeout` is set (15s default).** A runaway query should die
  rather than pin a connection until the next restart.
- **The pool has an `error` listener.** An idle pooled connection dropped by
  the server — a restart, a failover, an idle timeout on a proxy — emits
  `error` on the pool. With no listener that is an unhandled exception and it
  takes the bot down. The pool discards the bad client by itself; we just have
  to not die.
- **The connection is probed at boot.** Failing at startup is much easier to
  diagnose than failing on the first member join at 3am.
- **`TWO_DATABASE_URL`, deliberately not `DATABASE_URL`.** Plenty of hosts
  inject a `DATABASE_URL` of their own, and silently writing the funnel log
  into somebody else's database is not a failure mode worth having.
- **Transactions run on one connection.** `db.transaction(fn)` hands `fn` a
  handle bound to a single pooled client. Statements prepared off the outer
  `Db` go to a *different* connection and will not see uncommitted rows. Always
  use the argument, never the closure.

Who is connected:

```sql
SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2;
```

Every connection this repo opens names itself — `two-bot`, `two-bot-backup`,
`two-bot-migrate`, `two-bot-restore`. Anything else is the website or a human.

## Backup and restore

Full operational detail is in `docs/RUNBOOK.md`; the design decisions are here.

- **The dump is gzipped NDJSON, not `pg_dump`.** `pg_dump` is the better tool
  and we should switch the moment `postgresql-client` is on the host. It is not
  today, and a backup procedure that only runs on a machine we do not have is
  not a backup procedure. `src/store/dump.ts` is plain Node with no system
  dependency.
- **The dump is one `REPEATABLE READ` transaction.** Every table is read as of
  the same instant, so the bot does not have to be stopped to take a backup.
  Without it, a join landing between the `events` read and the `members` read
  produces a backup whose projection disagrees with its own event log.
- **The manifest carries a row count per table**, taken inside that same
  snapshot. That is what makes a restore *verifiable* rather than hopeful:
  "did every row the dump claimed to hold arrive" has an answer.
- **There is an end-of-file marker.** A dump that stops mid-file is the
  disk-full case, and it is refused rather than restored as a prefix.
- **Restore targets `TWO_RESTORE_URL`, not `TWO_DATABASE_URL`, and needs
  `--force`.** Restoring truncates the target. The one mistake that must not be
  possible by accident is aiming it at production because the variable happened
  to be in the shell already.
- **A monthly drill restores the newest backup into a scratch database.** An
  untested backup is a hypothesis. The way it fails is silent — green every
  night for six months, unreadable on the day it matters.

## Why not the obvious alternatives

- **Python + discord.py** — fine library, but we would be running a second
  language ecosystem for the dashboard anyway. One language for bot, jobs, and
  dashboard is worth more than any per-library preference.
- **Staying on SQLite with WAL** — WAL gives many readers and *one* writer. The
  second writer gets `SQLITE_BUSY`. Retries would paper over it until two
  writes genuinely collided, and the thing that gets dropped is a join, which
  is the number the company steers on.
- **Serverless / Cloudflare Workers** — a Discord gateway bot needs a
  long-lived websocket. Serverless is the wrong shape for this.
- **Docker** — adds a runtime to patch and debug for no benefit at one service
  on one box. Worth revisiting when there is a bot *and* a dashboard *and* a
  worker.
- **A managed Postgres** — worth it the day someone is woken up by this box.
  The plan is the same VM, with a nightly dump copied off-box and a monthly
  restore drill; `deploy/` carries the units and `docs/RUNBOOK.md` the
  procedure. Note what is and is not true today: no box is running this build
  yet, so nothing is being backed up on a schedule, and the restore has been
  drilled against a synthetic database rather than production data. Treat "we
  can restore in minutes" as a claim that becomes true when the bot is live on
  Postgres in staging and the first real drill passes — tracked on TOG-45, and
  recorded in the restore-drill section of the runbook. Revisit managed
  Postgres the first time that drill is the thing standing between us and data
  loss.

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
4. **Every store call is `await`ed.** No Postgres client for Node is
   synchronous, so `EventStore.record()` cannot be sync. This is the one
   visible consequence of the move at call sites; names, arguments and return
   values are unchanged.
5. **SQL is written once, in SQLite's `?` style.** The Postgres driver rewrites
   `?` to `$1..$n`. Until the SQLite path is deleted, every statement has to be
   valid in both dialects — in practice that means sticking to
   `ON CONFLICT ... DO NOTHING` and `RETURNING`, which both engines share.
6. **Migrations are immutable once applied.** The runner records a checksum and
   refuses to start if a file it has already applied has changed underneath it.
   Add a new migration instead.

## When to revisit

Concrete triggers, so this is not a matter of taste later:

- Anyone is woken up by this Postgres → move to a managed one.
- The `events` table passes ~50 million rows, or the funnel report takes over a
  second on Postgres → partition `events` by month, or move the projections
  into materialised views.
- Connection waits show up in `pg_stat_activity` → raise `TWO_DB_POOL_MAX`
  before doing anything cleverer.
- A third writer appears that is not the bot or the website → stop letting
  services share tables and give it the read-only contract instead
  (`docs/WEBSITE_CONTRACT.md`).
- The bot needs more than one shard (Discord requires sharding past ~2,500
  guilds) → not applicable; we are one guild and always will be.

## Why we started on SQLite

Kept because the reasoning was sound and the trigger it named is the one that
actually fired.

The original entry read:

> **Datastore — SQLite via Node's built-in `node:sqlite`.** Zero servers to
> run, zero extra dependencies, and the entire dataset is one file we can copy.
> At our size (a few thousand members, maybe a few hundred thousand events a
> year) this is not a compromise — it is faster than a network database would
> be.

and the constraint it imposed:

> **One writer.** SQLite in WAL mode handles many readers and one writer. If we
> ever add a second writing process, that is the signal to move to Postgres.

That was right on both counts, and it cost about a day to unwind because the
constraint was written down in advance and all writes already went through
`EventStore`. The lesson worth carrying: name the trigger when you make the
cheap choice, so that later the decision is a lookup rather than an argument.

The SQLite driver still exists behind config (`TWO_DB_PATH`, used only when
`TWO_DATABASE_URL` is empty) so a rollback does not need a deploy. It is
deleted once Postgres has held up in staging for a week — tracked on TOG-45.
Do not build anything new on it.
