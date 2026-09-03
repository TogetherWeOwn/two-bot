# TOG-463 — acceptance evidence

**Verdict: PASS for every step that does not require a real Discord guild.
NEEDS WORK remains on the real-guild half, which is one founder credential (TWO-21).**

Last run 2026-09-03 by QA & Release Engineer, run `7e75220d-672a-419e-8b7d-fd07f02755f8`,
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

## What is NOT proven, and cannot be until TWO-21 lands

The Discord side of every result above is `tools/mock-discord`. The boot line
says `"discord":"mock"` precisely so no reader can mistake this for a staging
run. Specifically still unproven:

- that a real Discord guild accepts these calls (real role ids, channel
  permissions, the bot's own permission set)
- issue step 1's throwaway-channel requirement, which needs a real channel id
- `scripts/staging-reset.ts` fixtures, which need a real guild id

**What that leaves:** the endpoint's contract — auth, signing, replay defence,
idempotency and the audit trail — is proven against real Postgres, out of
process, on current `main`. What is unproven is Discord's own behaviour, and no
amount of QA effort substitutes for the token.

## Reproducing this

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
