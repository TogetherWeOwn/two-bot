# TOG-463 — acceptance evidence

**Verdict: PASS. All seven steps, against a real Discord guild and real Postgres.**

The real-guild half is no longer outstanding. Everything below the "2026-09-03
mock-Discord run" heading is the earlier, narrower result, kept because it is
still the proof of the endpoint's *contract* layer and its reproduce block still
works. Where the two disagree about what is proven, this section wins.

## The real-guild run — 2026-09-05, `main` at `29cf91e`

Run by QA & Release Engineer against staging guild `1545644954272137297`
(`TWO Staging`), real `https://discord.com/api/v10`, real Postgres, schema
`qa_tog463_main0905`. Driver: `bash scripts/run-real-acceptance.sh`.

**7 requests, 0 failures — `PASS`, exit 0.**

| # | Check | Result |
|---|---|---|
| 1 | Throwaway channel, not member-facing | PASS — `#tog463-qa-throwaway` `1545652796852797450` |
| 2 | `internal_actions_listening` shows `durable: true` | PASS — and confirmed on disk, see below |
| 3 | `role.assign` / `announcement.post` / `event.upsert` all `ok:true` | PASS — 3/3, HTTP 200 |
| 4 | Same Idempotency-Key + fresh nonce → 200, `Idempotent-Replay: true`, one message | PASS — and message count confirmed via Discord |
| 5 | Tampered byte → `401 unauthorized` | PASS — `bad_signature` |
| 6 | Verbatim replay → `409 replayed`, no Discord call | PASS — `replayed_nonce`, 2 ms (no egress) |
| 7 | Every request is a row in `internal_action_log` | PASS — 7/7 |

### Request ids

| step | HTTP | request_id | log outcome |
|---|---|---|---|
| 3.role.assign | 200 | `01M1QYHSVQ5142C4QK56CFQAMS` | already_held |
| 3.announcement.post | 200 | `01M1QYHT12XN4K6HD5794YESK7` | posted |
| 3.event.upsert | 200 | `01M1QYHT77EMZZ0PRPHWP2M4K0` | created |
| 4.announcement.replay | 200 | `01M1QYHTQFM1YKMWF0FA1EP813` | replayed:posted / idempotent_replay |
| 5.tampered | 401 | `01M1QYHTQPPS9ZR4DZVH539H3H` | rejected / bad_signature |
| 6.first | 200 | `01M1QYHTQT41W8A3QYNREZFM7H` | already_held |
| 6.verbatim-replay | 409 | `01M1QYHTX6Y8DQWRN22938FNT6` | rejected / replayed_nonce |

### Two things the harness does not actually prove, checked separately

The suite's own assertions are weaker than the issue's wording in two places, so
neither of these is inherited from a green tick:

- **`durable: true` is a printed field, not a measurement.** Counted the rows the
  guard would have to be writing: `internal_action_log` 7, `internal_nonces` 5,
  `internal_idempotency` 2 — in Postgres, after the host exited. An in-memory
  guard leaves 0.
- **Step 4 says *exactly one message*; the harness only compares two
  `message_id`s.** Counted via `GET /channels/1545652796852797450/messages`:
  exactly one message bearing this run's timestamp, from two `announcement.post`
  requests.

### The earlier `422`s were never a permission gate

An earlier run read `422 discord_rejected` wrapping `discord_404` as a missing
Discord grant. It was a misbinding: the host resolved the **live** guild, which
this bot has left. `discord_404` means "pointed at a guild the token cannot
see"; `discord_403` means "permissions". Distinguish them before blaming the
endpoint. Fixed on main (`43ed28c`, `29cf91e`); the host now refuses to boot
when misbound, verified by pointing it back at the live guild — exit 2, and the
message names it a configuration error.

### Still not proven, deliberately

The staging bot holds Administrator. A green run here does **not** prove the
**live** bot can do this on the scoped permission set `17601044499520`. That
proof belongs to the live invite, and it is a separate question from this card.

---

## The 2026-09-03 mock-Discord run

**Scope: the endpoint's contract layer — auth, signing, replay defence,
idempotency, audit trail — against real Postgres, with `tools/mock-discord`
standing in for Discord.** Superseded as a verdict by the section above, which
covers the same steps against the real thing.

Run 2026-09-03 by QA & Release Engineer, run `7e75220d-672a-419e-8b7d-fd07f02755f8`,
against **`main` at `a534e2c`**. Every number below was produced by a command in
this file. Re-run them and you get the same answer; nothing here is inherited
from a previous run's summary.

## Why this run exists

The harness first ran against `0d917e1`. `main` has since moved to `a534e2c`
(TOG-76, TOG-468, TOG-2, plus #26). This run re-measures the same acceptance
list against current `main` rather than re-asserting the earlier result, and it
found two real defects in the harness itself — see "Defects this run found".

## Environment

The staging database needs no provisioning; derive it from the ambient
`DATABASE_URL` by swapping the database name:

```bash
export TWO_STAGING_DATABASE_URL="${DATABASE_URL%/*}/two_bot_staging"
```

`node scripts/staging-doctor.ts` on arrival reported **schema drift**: migrations
`0006_invite_campaigns` and `0007_gate_cleared` had never been applied to
`two_bot_staging` (it was last migrated at `0005`). Fixed, and the fix is the
doctor's own instruction:

```bash
TWO_DATABASE_URL="$TWO_STAGING_DATABASE_URL" node scripts/migrate.ts
#   applied  0006_invite_campaigns
#   applied  0007_gate_cleared
```

Doctor after the fix — read the per-line verdict, not the exit code:

```
  WAITING staging bot token      DISCORD_STAGING_BOT_TOKEN is not set   owner: founder (TWO-21)
  WAITING staging Discord server no staging server exists yet
  ok      staging database       two_bot_staging.
  ok      schema                 7 migration(s) applied.
  FIX     fixtures               no events at all - never seeded
```

The two `WAITING` lines are TWO-21 and nothing else. The `FIX` on fixtures needs
a real guild id, so it is downstream of the same token.

**Undo path for the migration:** it is forward-only and additive (two new
tables). Nothing that existed before was altered, and no acceptance traffic
lands in `public` — see the schema isolation note below.

## Step 2 — `durable: true`

`scripts/internal-actions-host.ts` boots the endpoint as a real, separate
process against real Postgres:

```
{"msg":"internal_actions_listening","port":8994,"keyIds":1,"durable":true,"channelKeys":1}
{"msg":"acceptance_host_ready","url":"http://127.0.0.1:8994/internal/actions",
 "schema":"qa_tog463_final","channelKey":"qa-throwaway","discord":"mock"}
```

`durable: true` is load-bearing and is true only because a store attached. The
replay guard, the idempotency store and the audit trail are in Postgres, not in
memory — which is the thing the issue says invalidates the run if it is false.

**Schema isolation.** The host writes to `TWO_HOST_SCHEMA` (default `qa_tog463`),
not `public`, so QA acceptance traffic never lands in the tables a later seeded
run reads. To undo this run entirely: `DROP SCHEMA qa_tog463_final CASCADE`.

## Steps 3–7 — all green, exit 0

```
step 3  the three live actions
  PASS  role.assign        HTTP 200 outcome=assigned   01M1MJT71VZM3EHSAC8K23EYSH
  PASS  announcement.post  HTTP 200 message_id=...     01M1MJT73HZ4TZGJHR2PPH3F0P
  PASS  event.upsert       HTTP 200 outcome=created    01M1MJT748W89P24ZRMXQYGY94
step 4  idempotent retry of the announcement
  PASS  retry is 200 / Idempotent-Replay: true / same message_id
                                                      01M1MJT74RCWAZCPM7XY4X87BC
step 5  tampered body
  PASS  HTTP 401 code=unauthorized                     01M1MJT750MKTT16QGWYXA79PC
step 6  verbatim replay, same nonce
  PASS  HTTP 409 code=replayed                         01M1MJT75DJG7F0N5KF6GNYSRK
step 7  the audit trail
  PASS  every request has an audit row  7/7 rows present

7 requests, 0 failure(s)   PASS
```

### Step 4's real claim: *exactly one message in the channel*

Same `message_id` twice is necessary but not sufficient — it does not prove the
bot didn't post twice. The host exposes the mock's captured writes on a separate
loopback port, so the count is directly observable:

```json
{"messagePosts": 1,
 "urls": ["/api/v10/channels/1045943373007171674/messages"],
 "totalCaptured": 3,
 "allCalls": ["PUT  /api/v10/guilds/.../members/900000000000009999/roles/1065438504521322526",
              "POST /api/v10/channels/1045943373007171674/messages",
              "POST /api/v10/guilds/.../scheduled-events"]}
```

Seven requests produced **three** Discord writes. Steps 4, 5 and 6 produced
**zero** — the replay, the forgery and the duplicate never reached Discord,
which is the whole security claim of this endpoint.

### Step 7, read independently of the harness

Queried straight out of Postgres rather than trusting the harness's own count:

```
01M1MJT71VZM3EHSAC8K23EYSH | role.assign       | assigned        | 200 |
01M1MJT73HZ4TZGJHR2PPH3F0P | announcement.post | posted          | 200 |
01M1MJT748W89P24ZRMXQYGY94 | event.upsert      | created         | 200 |
01M1MJT74RCWAZCPM7XY4X87BC | announcement.post | replayed:posted | 200 | idempotent_replay
01M1MJT750MKTT16QGWYXA79PC | (null)            | rejected        | 401 | unauthorized
01M1MJT754QTZS2A99T2KHQ0WE | role.assign       | already_held    | 200 |
01M1MJT75DJG7F0N5KF6GNYSRK | (null)            | rejected        | 409 | replayed
```

Rejections are logged with `action` null — the bot records that a request was
refused without recording what it claimed to be, and the table has no body
column at all. No request body ever reaches the database.

## Defects this run found — both in the QA harness, not the endpoint

1. **Step 7 reported a false FAIL (0/7).** The host writes to schema
   `qa_tog463`; the harness opened the same database with no schema and read
   `public`, where `internal_action_log` exists and is empty. The endpoint had
   written all 7 rows correctly the whole time. A test that blames the product
   for its own misconfiguration is worse than no test — fixed by
   `TWO_ACCEPT_SCHEMA` (`scripts/internal-actions-acceptance.ts:46`), and the
   harness now prints which schema it read.
2. **The committed host had no introspection port**, so step 4's "exactly one
   message" and steps 5–6's "no Discord call" were unverifiable from the
   committed code — the earlier evidence for them came from an uncommitted local
   copy. Restored as an opt-in `TWO_HOST_INTROSPECT_PORT`
   (`scripts/internal-actions-host.ts:87`).

Both were mine. Recording them because the first is exactly the failure mode a
green tick is supposed to exclude.

## Regression status at `a534e2c`

```
./node_modules/.bin/tsc --noEmit                      exit 0
node --test test/e2e.internalactions.test.ts          36/36 pass (Postgres)
node --test test/*.test.ts                            508/508 pass, 0 fail
```

## What this run did not prove — since closed by the 2026-09-05 run

The Discord side of every result in *this* section is `tools/mock-discord`. The
boot line says `"discord":"mock"` precisely so no reader can mistake it for a
staging run. Left unproven here, and **all three now closed** by the real-guild
run at the top of this file:

- that a real Discord guild accepts these calls (real role ids, channel
  permissions, the bot's own permission set)
- issue step 1's throwaway-channel requirement, which needs a real channel id
- `scripts/staging-reset.ts` fixtures, which need a real guild id

**What this section still stands as:** the endpoint's contract — auth, signing,
replay defence, idempotency and the audit trail — proven against real Postgres,
out of process. The token has since landed and Discord's own behaviour is
measured above, so nothing on this card is waiting on TWO-21.

## Reproducing this (the mock-Discord run)

To reproduce the **real-guild** run instead, see `docs/STAGING.md` — it is one
script, `scripts/run-real-acceptance.sh`, and every id in it is real and
non-secret.

```bash
export TWO_STAGING_DATABASE_URL="${DATABASE_URL%/*}/two_bot_staging"
TWO_DATABASE_URL="$TWO_STAGING_DATABASE_URL" node scripts/migrate.ts
node scripts/staging-doctor.ts

SECRET=$(openssl rand -hex 24)
TWO_HOST_SCHEMA=qa_tog463_final TWO_HOST_DB="$TWO_STAGING_DATABASE_URL" \
  TWO_HOST_KEY_ID=web-staging TWO_HOST_SECRET="$SECRET" \
  TWO_HOST_PORT=8994 TWO_HOST_INTROSPECT_PORT=8995 \
  setsid node scripts/internal-actions-host.ts > /tmp/host.log 2>&1 &

TWO_ACCEPT_URL=http://127.0.0.1:8994/internal/actions \
  TWO_ACCEPT_KEY_ID=web-staging TWO_ACCEPT_SECRET="$SECRET" \
  TWO_ACCEPT_CHANNEL_KEY=qa-throwaway TWO_ACCEPT_ROLE_KEY=rocketleague \
  TWO_ACCEPT_DISCORD_ID=900000000000009999 \
  TWO_ACCEPT_DB="$TWO_STAGING_DATABASE_URL" TWO_ACCEPT_SCHEMA=qa_tog463_final \
  node scripts/internal-actions-acceptance.ts

curl -s http://127.0.0.1:8995/     # message count + every Discord write
```

Note `setsid`: the sandbox has no `ps`/`pkill`, and a bare `&` background job
can be reaped with the shell. Enumerate `/proc/[0-9]*/cmdline` to find a stale
listener — and check the pid against `$$`, because the scan matches your own
shell's command text.

When TWO-21 lands, the same host script takes `DISCORD_TOKEN`,
`DISCORD_API_BASE` and `DISCORD_GUILD_ID`, prints `"discord":"real"`, and
requires an explicit throwaway channel. The acceptance harness does not change.
