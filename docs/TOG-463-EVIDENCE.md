# TOG-463 acceptance evidence — 2026-09-03

QA & Release Engineer. Run `aa796838-c671-4213-b005-e5f8ecf65a6f`.

**Disposition: still NEEDS WORK for the clause TOG-463 actually asks for**, but
six of the seven steps are now proven against a real durable store over real
HTTP, which was not true before this run. The one thing missing is Discord
itself, and it is founder-owned (TWO-21).

Read the "What this does NOT prove" section before quoting the PASS anywhere.

---

## What changed since the last run

Two of the three gates that were open on 2026-08-31 have cleared:

| Gate | 2026-08-31 | 2026-09-03 |
|---|---|---|
| 1. Project parked | Onboarding + Community Platform both `backlog` | **CLEARED** — both `in_progress` |
| 2. Laravel job (TOG-470) | not built | built, verified, `blocked`, unpushed — still open |
| 3. Staging creds | both absent | **DB CLEARED**, token still absent |

The staging database gate cleared because `staging-doctor.ts` changed its
verdict from `WAITING` (someone else's) to `FIX` (mine). It was right: the
`two_bot_staging` database was already provisioned on the estate Postgres, and
the derivation is the one in `docs/STAGING.md` — take `DATABASE_URL`, swap the
database name. It connected first try.

## What I ran, and what it proved

### Migration 0005 applied to staging

`staging-doctor` reported 1 of 5 migrations missing. `0005_counter_snapshots`
is additive (`CREATE TABLE IF NOT EXISTS`) against an unseeded database, so
applying it was reversible and mine to decide.

```
$ TWO_DATABASE_URL="$TWO_STAGING_DATABASE_URL" node scripts/migrate.ts
{"msg":"migration_applied","id":"0005_counter_snapshots"}
migrate: applied 1.
```

Staging now reports `ok schema — 5 migration(s) applied.`

### The existing e2e suite, against real Postgres for the first time

`test/helpers/testDb.ts` is driver-agnostic via `TWO_TEST_DATABASE_URL`. Until
now it had only ever been run on SQLite.

```
$ TWO_TEST_DATABASE_URL=<staging> node --test test/e2e.internalactions.test.ts
ℹ tests 34
ℹ pass 34
ℹ fail 0
```

Note the boot line in that output: `"durable":true`. **This is TOG-463 step 2**,
and it is the first time it has been observed against Postgres rather than
SQLite. `durable` is `Boolean(opts.store)` (`src/internal/server.ts:117`), so a
`false` here would mean the replay guard was in-process — the issue says such a
run is invalid.

### Steps 3–7 over real HTTP

The harness at `b42037c` deliberately does not import the bot's server — it
speaks HTTP to a *running* process, so it measures a deployment and not a copy
of the source. Something therefore has to be running, and staging's bot cannot
boot without the `test-two` token. New this run:
`scripts/internal-actions-host.ts` (commit `b926cbc`) boots the **same**
`startInternalActions()` the bot boots, against the **real** staging Postgres,
with `tools/mock-discord` standing in for Discord's REST API only.

```
$ node scripts/internal-actions-host.ts
{"msg":"internal_actions_listening","port":8787,"durable":true,"channelKeys":1}
{"msg":"acceptance_host_ready","url":"http://127.0.0.1:8787/internal/actions","schema":"qa_tog463"}

$ node scripts/internal-actions-acceptance.ts
step 3  the three live actions
  PASS  role.assign        HTTP 200 outcome=assigned  request_id=01M1JX6ER41B6BM798YPWEY2XG
  PASS  announcement.post  HTTP 200 message_id=...    request_id=01M1JX6ERK8S525MQNSWEFZPBZ
  PASS  event.upsert       HTTP 200 outcome=created   request_id=01M1JX6ERZ4JDAT35QCMPGABHF
step 4  idempotent retry of the announcement
  PASS  retry is 200                    request_id=01M1JX6ES96520VMGHEYZ455P2
  PASS  Idempotent-Replay: true         header=true
  PASS  same message_id as the original
step 5  tampered body
  PASS  tampered body is 401 unauthorized  request_id=01M1JX6ESETBR8ZBJ0NQV2TW5B
step 6  verbatim replay, same nonce
  PASS  verbatim replay is 409 replayed   request_id=01M1JX6ESS8ZXTZFYMF7JZRX2S
step 7  the audit trail
  PASS  every request has an audit row  7/7 rows present

7 requests, 0 failure(s)
PASS   (exit 0)
```

**Step 4's "exactly one message"**, checked in SQL rather than taken from the
harness's word — one `posted`, one `replayed`, per idempotency key:

```
 idempotency_key               | n | posted | replayed
 tog463-ann-a6761f5e78104cdb   | 2 |   1    |    1
 tog463-ann-bce2c38fa1cadecd   | 2 |   1    |    1
```

The harness was **not** modified to make this pass. It is byte-identical to the
committed version:

```
$ git show origin/tog-463/acceptance-harness:scripts/internal-actions-acceptance.ts | sha256sum
be71d1b67e70c4cf3ef8890eb8de75b3325cfb308919d9fd6127ea46a9f9eb7b
$ sha256sum scripts/internal-actions-acceptance.ts
be71d1b67e70c4cf3ef8890eb8de75b3325cfb308919d9fd6127ea46a9f9eb7b
```

### One honest correction

Step 7 first reported `0/7 rows present`. That was **my rig, not a product
defect**: the host writes to schema `qa_tog463` and the harness's connection was
reading `public`. Confirmed by querying both schemas directly — the 7 rows were
in `qa_tog463` all along, with statuses matching the HTTP responses. Re-pointed
via `?options=-csearch_path%3Dqa_tog463` in the URL, which changed no assertion
in the harness. Recording it because a green tick that followed a red one
deserves to say why.

## What this does NOT prove

- **No real Discord accepted anything.** `tools/mock-discord` answered every
  REST call. Step 3's three actions and step 4's "exactly one message in the
  channel" are proven against the mock's captured requests and the audit trail,
  not against Discord.
- **No Laravel job was involved.** The harness is TypeScript. TOG-463's actual
  sentence is *"the Lead can call all three actions **from a Laravel job**
  against staging"*, and the caller half (TOG-470) is built but unpushed and
  `blocked`.
- **Fixtures are unseeded.** `staging-reset.ts` exits 2 — it needs
  `DISCORD_STAGING_GUILD_ID`, which needs the token. Verified by attempting it,
  not inferred.

So: the endpoint's auth, replay, idempotency and audit layers are now evidenced
against a real durable store. The end-to-end clause of TOG-44 is not.

## State I left behind, and how to undo it

- `two_bot_staging` has migration `0005_counter_snapshots` applied. Still
  unseeded (`public.events` = 0 rows). Undo: drop the `counter_snapshots` and
  `member_exclusions` tables and delete the `schema_migrations` row.
- Schema `qa_tog463` was created for the acceptance traffic and **dropped**
  afterwards. `select nspname from pg_namespace` returns only `public`.
- `scripts/internal-actions-host.ts` committed as `b926cbc` and pushed to
  `origin/tog-463/acceptance-harness`. It is a dev/test tool; nothing in `src/`
  imports it.
- The host process is stopped; port 8787 is closed.

## What the next person does

1. **TWO-21 (founder)** — bind `discord_staging_bot_token` (application
   `1537629682449649724`, `test-two`) as `DISCORD_STAGING_BOT_TOKEN`. Nothing
   below can start until this exists. `staging-provision.ts` then creates the
   server without further human involvement.
2. **TOG-470 (DoE `0ffb806a` → EM Web Platform `3e21d9a2`)** — push the verified
   commit `74aa7433` so a Laravel job exists to call from.
3. **QA** — `node scripts/staging-reset.ts`, then run the harness with
   `TWO_ACCEPT_URL` pointed at the real staging bot instead of the host script.
   That run, not this one, is what closes TOG-463.

Reproduce this run:

```bash
export TWO_STAGING_DATABASE_URL="<DATABASE_URL with db swapped to two_bot_staging>"
npx tsx scripts/staging-doctor.ts
TWO_TEST_DATABASE_URL="$TWO_STAGING_DATABASE_URL" node --test test/e2e.internalactions.test.ts
TWO_HOST_DB="$TWO_STAGING_DATABASE_URL" TWO_HOST_KEY_ID=web-staging \
  TWO_HOST_SECRET=$(openssl rand -hex 24) TWO_HOST_PORT=8787 \
  node scripts/internal-actions-host.ts &
TWO_ACCEPT_URL=http://127.0.0.1:8787/internal/actions TWO_ACCEPT_KEY_ID=web-staging \
  TWO_ACCEPT_SECRET=<same secret> TWO_ACCEPT_CHANNEL_KEY=qa-throwaway \
  TWO_ACCEPT_ROLE_KEY=rocketleague TWO_ACCEPT_DISCORD_ID=900000000000009999 \
  TWO_ACCEPT_DB="$TWO_STAGING_DATABASE_URL?options=-csearch_path%3Dqa_tog463" \
  node scripts/internal-actions-acceptance.ts
```
