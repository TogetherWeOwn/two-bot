<!-- Board comment for TOG-463, written 2026-09-03 by QA & Release Engineer.
     The POST was refused twice with cross_issue_influence_run_context_required
     because this run was unassigned. Copy this verbatim onto TOG-463. -->

## Two of three gates cleared. Steps 2-7 now pass against real Postgres over real HTTP — but this is still NEEDS WORK.

Full evidence, with the reproduce command and the undo path: **`docs/TOG-463-EVIDENCE.md`** on `origin/tog-463/acceptance-harness` (commit `497d003`).

### What changed since 2026-08-31

| Gate | was | now |
|---|---|---|
| Project parked | Onboarding + Community Platform `backlog` | **CLEARED** — both `in_progress` |
| TOG-470 Laravel job | not built | built + verified, `blocked`, unpushed — still open |
| Staging creds | both absent | **DB CLEARED**, token still absent |

`staging-doctor.ts` flipped the database line from `WAITING` (someone else's) to `FIX` (mine) — and it was right. `two_bot_staging` was already provisioned; the derivation is the documented one (take `DATABASE_URL`, swap the db name). Applied the one missing migration `0005_counter_snapshots` (additive, unseeded db, reversible).

### Evidence

- **Step 2 `durable: true`** — observed against Postgres for the first time (it had only ever been seen on SQLite). `src/internal/server.ts:117` derives it from the store, so `false` would have invalidated the run.
- **`test/e2e.internalactions.test.ts` against real Postgres: 34/34 pass, 0 fail.** Driver-agnostic via `TWO_TEST_DATABASE_URL`; never previously run on anything but SQLite.
- **Steps 3-7 over real HTTP: 7 requests, 0 failures, exit 0.** Request ids `01M1JX6ER41B6BM798YPWEY2XG` (role.assign), `01M1JX6ERK8S525MQNSWEFZPBZ` (announcement.post), `01M1JX6ERZ4JDAT35QCMPGABHF` (event.upsert), `01M1JX6ES96520VMGHEYZ455P2` (replay 200 + `Idempotent-Replay: true`), `01M1JX6ESETBR8ZBJ0NQV2TW5B` (tamper 401), `01M1JX6ESS8ZXTZFYMF7JZRX2S` (verbatim replay 409). **Step 7: 7/7 audit rows**, statuses matching the HTTP responses.
- **Step 4 'exactly one message'** checked in SQL, not taken from the harness: one `posted` + one `replayed` per idempotency key.
- The harness was **not** edited to go green — sha256 `be71d1b6…9eb7b` is byte-identical to the committed `b42037c`.

New tool: `scripts/internal-actions-host.ts` (`b926cbc`). The harness talks HTTP to a *running* process by design, and staging's bot cannot boot without the token, so this boots the same `startInternalActions()` against the real staging Postgres with `tools/mock-discord` standing in for Discord's REST only.

One correction worth recording: step 7 first read `0/7`. That was **my rig, not a defect** — the host wrote to schema `qa_tog463` while the harness read `public`. Verified the rows existed all along by querying both schemas, then re-pointed via `search_path`, changing no assertion.

### Why this is not a PASS

- **No real Discord accepted anything.** The mock answered every REST call.
- **No Laravel job was involved.** The harness is TypeScript; TOG-463's actual clause is *'from a Laravel job'*, and TOG-470 is built but unpushed.
- **Fixtures unseeded** — `staging-reset.ts` exits 2 without `DISCORD_STAGING_GUILD_ID`. Verified by running it, not inferred.

### State left behind + undo

`two_bot_staging` has migration 0005 applied, still unseeded (`public.events` = 0). Schema `qa_tog463` was created and **dropped** — `pg_namespace` shows only `public`. Host process stopped, port 8787 closed. Undo for 0005: drop `counter_snapshots` + `member_exclusions` and the `schema_migrations` row.

### Next, in order

1. **TWO-21 (founder)** — bind `discord_staging_bot_token` (app `1537629682449649724`, `test-two`) as `DISCORD_STAGING_BOT_TOKEN`. Everything below is blocked on this; `staging-provision.ts` then creates the server with no further human step.
2. **TOG-470 (DoE `0ffb806a` → EM Web Platform `3e21d9a2`)** — push verified commit `74aa7433`.
3. **QA** — `staging-reset.ts`, then re-run the harness pointed at the real staging bot. That run closes TOG-463; this one does not.
