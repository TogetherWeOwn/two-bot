# Staging: how QA resets the bot to a known state

This is written for QA. You should never need to ask an engineer to reset
staging, and you should never point a test at the live TWO server.

**Status (2026-09-05): the database half is live, the Discord half is not.**

The token landed and the database is real, so four of the five readiness
checks are green:

| Check | State |
|---|---|
| staging bot token | **ok** — `Owen QA Test` (`1469137636663758888`) |
| staging database | **ok** — `two_bot_staging` |
| schema | **ok** — 9 migrations applied |
| fixtures | **ok** — the known state |
| staging Discord server | **blocked** — see below |

**The one blocker: the staging bot is a member of the live TWO server.**
`Owen QA Test` is in `TogetherWeOwn` (`326474832151838730`) and nothing else.
`staging-provision.ts` therefore aborts before any network write — a bot
sitting in production receives production gateway events and can act there
with whatever permissions its invite carried, which is the exact outcome this
whole document exists to prevent. It is not a bug and it must not be edited
around.

**To unblock it, a human with Manage Server on the live TWO guild must remove
`Owen QA Test` from it.** Nothing else is outstanding; re-run
`staging-provision.ts --apply` afterwards and the bot builds its own server.

Everything that does not need Discord works today, including the full reset
loop QA runs between test runs. `scripts/staging-doctor.ts` will tell you
where things stand without you having to read the rest of this page.

---

## The two rules

1. **Staging has its own everything.** Its own Discord server, its own bot
   application, its own token, its own Postgres database. Nothing is shared
   with production, including env var names.
2. **Never run any of this with the live values loaded.** The reset script
   refuses four different ways (below), but the first line of defence is you.

---

## What you need in your environment

| Variable | What it is | Where it comes from |
|---|---|---|
| `TWO_STAGING_DATABASE_URL` | Postgres URL for the staging database | the `two_bot_staging` database, already provisioned and migrated — see [The staging database](#the-staging-database) |
| `DISCORD_STAGING_GUILD_ID` | id of the `TWO Staging` server | printed by `staging-provision.ts` and posted on TWO-25 — not secret |
| `DISCORD_STAGING_BOT_TOKEN` | the `Owen QA Test` bot token | secrets store as `discord_staging_bot_token`, bound to you and to me |

Note what is **not** here: `TWO_DATABASE_URL`, `DISCORD_GUILD_ID` and
`DISCORD_BOT_TOKEN` are the live ones. The staging names are different on
purpose — a staging run must not be one forgotten variable away from writing
into the real funnel.

### Which bot is which

Three applications now, and they are easy to confuse. Application ids are
public — they are in every invite URL — so they are written down in
`src/staging/spec.ts` and checked at startup:

| Application | id | Use |
|---|---|---|
| `Owen` | `1539711683898118154` | **live.** Never in a staging variable. |
| `Owen QA Test` | `1469137636663758888` | **staging** — bound 2026-09-05 |
| `test-two` (created 14 Aug) | `1537629682449649724` | **superseded.** Was staging until 2026-09-05 |

`test-two` is still a real bot with a working token, so a stale shell would
keep running happily against the wrong guild. `checkStagingToken` therefore
**refuses** it by id rather than treating it as an unknown third app. If you
hit that refusal, re-read the secret — do not edit the spec.

`staging-provision.ts` and `staging-verify.ts` both decode the application id
out of the token you gave them (it is the first dot-separated segment, base64)
and **refuse to run if it is the live bot** — before any network call. This is
not theoretical: on 2026-08-19 the secrets store bound this agent the live
bot's token while the staging one was absent. If you see that refusal, the
variable was filled from the wrong application; raise it on TWO-21 rather than
editing anything locally. A token *reset* is fine and changes nothing here —
resets change the secret, never the application id.

Never paste a token into an issue, a chat message, or a test file. See
`docs/SECRETS.md`.

---

## Start here, every time

```bash
node scripts/staging-doctor.ts
```

One command, one answer. It reads your environment, and — only if the database
is safe to open — looks inside it to see whether the schema is applied and the
fixtures are the known state. It writes nothing, never contacts Discord, and
never prints a token.

The exit code is the useful part:

| Code | Means | What you do |
|---|---|---|
| `0` | ready | reset, then run your suite |
| `1` | something is set wrong | the `FIX` lines are yours; each one carries the command |
| `3` | waiting on somebody | nothing. The line names the owner and the issue |

**A `3` is not your setup being broken.** It is the difference between "I typed
something wrong" and "the founder has not bound the token yet", and until this
script existed the only way to tell them apart was to run four scripts and read
four different refusals one at a time. As of **2026-08-25** a clean checkout with
no staging variables bound prints **two** `WAITING` lines — the token, and the
server, which waits on the token — plus one `FIX` for the database. The database
moved out of `WAITING` because it now exists (TOG-45); setting the variable is
your job, not a queue behind anyone.

## The staging database

`two_bot_staging`, on the same Postgres server as the rest of the estate — a
second database, not a second server, so it costs nothing. Provisioned and
migrated on 2026-08-25 under TOG-45.

```bash
export TWO_STAGING_DATABASE_URL="postgres://<user>:<pw>@<host>:5432/two_bot_staging"
```

Take the user, password and host from the `DATABASE_URL` already in your
environment and swap the database name — that is the whole derivation. The name
matters: `staging` in it is what satisfies guard 2, and the reset script wipes
what it is given.

All four migrations (`0001_initial` … `0004_presence_probe`) are applied. It is
deliberately **left unseeded** — fixtures are written scoped to a guild id, and
seeding it under a placeholder before the real `TWO Staging` guild exists would
leave rows that no later reset deletes. See [One database, one
guild](#one-database-one-guild) for why that matters more than it looks.

## Applying the schema to the staging database

**Read the variable names twice.** `scripts/migrate.ts` is a general tool and
only knows `TWO_DATABASE_URL` — the **live** name. To migrate staging you map
the staging URL onto it, on one line, deliberately:

```bash
TWO_DATABASE_URL="$TWO_STAGING_DATABASE_URL" node scripts/migrate.ts
```

This is the one place in the whole staging flow where a typo points a schema
change at production. The doctor prints this exact command when it finds
pending migrations, so copy it from there rather than from memory.

---

## Resetting between runs

```bash
node scripts/staging-reset.ts
```

That is the whole thing. It wipes every row for the staging guild, writes the
fixtures back, re-seeds a second time to prove the seed is idempotent, then
prints the funnel and exits non-zero if any count is off. Take a non-zero exit
seriously — it means the state you are about to test against is not the state
this document describes.

```bash
node scripts/staging-reset.ts --check    # print the counts, change nothing
```

Expected output on a good reset:

```
staging database : two_staging
guild            : <staging guild id>
reset            : 34 events written, 10 member rows

funnel state
  ok   invite_click           5
  ok   member_join            10
  ok   onboarding_prompted    4
  ok   game_roles_selected    2
  ok   channel_routed         2
  ok   first_message          7
  ok   first_voice_session    1
  ok   member_inactive        1
  ok   member_leave           2

joined-never-posted: 2 (900000000000000005, 900000000000000001)

Known state. Safe to run the integration suite.
```

### The five guards

The script exits `2` without touching anything if:

1. `TWO_STAGING_DATABASE_URL` is unset or is not a Postgres URL.
2. The database name does not contain `staging` or `test`.
3. It points at the same host and database as `TWO_DATABASE_URL` — **even under
   a different username and password**. Two connection strings with different
   credentials and the same target are the same database, and a reset against
   the live one would delete every growth number we have with no undo.
4. `DISCORD_STAGING_GUILD_ID` is unset, or is the live TWO guild.
5. (Always) deletes are scoped by guild id — never `TRUNCATE`.

Guards 1–4 are the same code the doctor runs (`src/staging/readiness.ts`), so
the refusal you get here and the diagnosis you get there cannot drift apart.
The refusal names the owner and the next step, same as the doctor does.

### One database, one guild

**Do not point two guild ids at the same staging database.** The asymmetry that
makes this bite: the reset *deletes* scoped to `DISCORD_STAGING_GUILD_ID` (guard
5), but the funnel counts it verifies against afterwards are **not** scoped —
`EventStore.countByType` is `SELECT COUNT(*) FROM events WHERE event_type = ?`
across the whole database (`src/store/eventStore.ts:239`).

So fixtures seeded under guild A survive a reset run under guild B, and then
inflate every count B checks. The failure is loud rather than silent — the reset
exits non-zero with counts reading `member_join 20/10` — but the cause reads
like a broken fixture set, and the rows the scoped delete will not touch are the
last place anyone looks.

This is why `two_bot_staging` was left unseeded rather than seeded under a
placeholder id. If you do strand rows this way, the recovery is a scoped delete
of the old id, not a `TRUNCATE` — the same three tables the reset itself clears
(`src/staging/fixtures.ts:299`):

```sql
DELETE FROM events           WHERE guild_id = '<the-stale-id>';
DELETE FROM members          WHERE guild_id = '<the-stale-id>';
DELETE FROM invite_snapshots WHERE guild_id = '<the-stale-id>';
```

### What the reset does *not* clear

Ten tables in the schema carry a `guild_id`; the reset clears three. The other
seven — `guild_counters`, `member_ranks`, `rank_snapshots`, `scheduled_events`,
`presence_probe`, `internal_discord_events`, `web_contract_meta` — belong to
subsystems the fixtures do not seed, so on a freshly migrated database they are
empty and "known state" is true.

They stop being empty as soon as an integration suite exercises those
subsystems. If your suite touches ranks, scheduled events or presence, the reset
will not undo it and you must clear those tables yourself, scoped by guild id
the same way. Nothing enforces this yet — it is tracked on TOG-45 rather than
left as folklore.

---

## What the fixtures are

Ten synthetic members, defined in `src/staging/fixtures.ts`. Each one exists to
be a funnel shape you can assert against. Every id begins `90000000000000` —
below anything Discord has ever issued, so a fixture can never collide with a
real member, and `grep` finds all of them.

| Fixture | id ends | The shape it gives you |
|---|---|---|
| lurker | `01` | joined 7 days ago, never said a word |
| chatter | `02` | joined, prompted, posted two hours later |
| voicer | `03` | the complete path, ending in a real voice session |
| fast | `04` | join → first message in **40 seconds** |
| stalled | `05` | prompted, then nothing — onboarding drop-off |
| inactive | `06` | quiet 40 days, **already flagged** — must not be flagged twice |
| leaver | `07` | joined, posted, left |
| rejoiner | `08` | joined, left, came back — `left_at` must end up NULL |
| bot | `09` | a bot: present in `members`, must never appear in a funnel number |
| quiet | `10` | quiet 30 days, never flagged — the one a sweep should catch |

Derived state you can rely on:

- `joinedNeverPosted()` returns exactly **2**: lurker and stalled.
- `flagInactive(db, store, 14)` newly flags exactly **1**: quiet. Not the
  already-flagged one, not the leaver, not the bot.
- `secondsBetween(fast, member_join, first_message)` is exactly **40**.
- Invite baselines for `qa-alpha` and `qa-beta` are seeded, so the first
  `InviteTracker.diffAndStore()` after a reset has something to diff against.

### Timestamps are relative, and why you should care

Every fixture time is an offset in **days from now**, not a fixed date. If they
were pinned to a calendar date, the "inactive" fixtures would drift into being
inactive for the wrong reason and your suite would start passing by accident.

The consequence for you: absolute timestamps differ between resets, the funnel
*shape* never does. Assert on shape and on the derived numbers above, not on
literal ISO strings.

### If you add a fixture

Update `EXPECTED_FUNNEL` in the same commit. `test/unit.staging.test.ts`
asserts the two agree, so a half-update fails loudly instead of drifting.

---

## Building the staging server

**Needs `DISCORD_STAGING_BOT_TOKEN`. Run once, by an engineer.**

```bash
node scripts/staging-provision.ts            # prints the plan, changes nothing
node scripts/staging-provision.ts --apply    # creates it
```

Discord lets a bot create a server (`POST /guilds`) as long as it is in fewer
than ten, and a fresh staging bot is in zero. So the bot makes its own server,
becomes its owner, and fills in the four text channels, `Voice 1` and the three
roles from `src/staging/spec.ts`. No invite link, no permission integer, no
authorize step.

**It prints the guild id.** Nobody has that id until this runs. Put it in
`DISCORD_STAGING_GUILD_ID` and post it on TWO-25.

Things worth knowing before you run it:

- **Dry run is the default.** A guild the bot created cannot have its ownership
  transferred to a person, so a mistake can only be deleted, never handed over.
- **It never creates a second `TWO Staging`.** If one exists it reconciles it.
  If it somehow finds two, it stops and makes you pick. This matters more than
  it sounds: a bot can only create guilds while in fewer than ten, so a loop
  that made ten of them would permanently lose the ability to make another. The
  script refuses to create past eight.
- **It counts the bot's guilds before it creates anything, and says what it
  finds.** `GET /users/@me/guilds` runs first. Zero guilds is the normal first
  run and prints nothing. Any guild the bot is in that is not ours prints a
  `WARNING` naming it — the staging bot should only ever be in `TWO Staging`,
  so anything else means somebody else invited it, which is possible while
  `test-two` is still a Public Bot. At ten it stops with an explicit message
  naming the count, the limit and the Public Bot setting, instead of letting
  Discord refuse `POST /guilds` halfway through a QA run.
- **If the founder made the server by hand**, invite the bot to it, set
  `DISCORD_STAGING_GUILD_ID`, and run the same script — it then only fills in
  what is missing and never creates anything.
- **It never deletes or renames anything.** Channels outside the spec are
  reported and left alone.
- **A bot-created server has no humans in it.** Not even the founder.

```bash
node scripts/staging-provision.ts --apply --invite                 # 7-day, 5-use link
node scripts/staging-provision.ts --apply --grant-admin <user-id>  # after they join
```

Share the invite link directly, not in a public channel.

### One consequence of the bot owning the server

Discord skips permission and hierarchy checks entirely for a guild owner. Two
things follow:

1. The role-position failure described below **cannot happen** on a bot-owned
   staging server. `staging-verify.ts` knows this and does not report it.
2. The scoped permission set `268520512` therefore cannot be proved on staging
   any more — an owner holds everything by definition. That proof moves to the
   live invite. `staging-verify.ts` says so rather than passing quietly, so
   nobody later mistakes a green staging run for evidence the live bot needs
   nothing more.

If the founder created the server by hand and invited the bot normally, both
checks apply as they always did.

---

## Checking the staging server itself

**Needs `DISCORD_STAGING_BOT_TOKEN` — not runnable until the founder creates
the server.**

```bash
node scripts/staging-verify.ts
```

Run this the first time the server exists, and any time role assignment starts
behaving oddly. It checks the server against the agreed spec
(`src/staging/spec.ts`): the four text channels, `Voice 1`, the three roles,
the scoped permission set, and Server Members Intent.

**Read this before debugging anything else.** The most common staging failure
is that the bot's own role sits *below* a role it is asked to grant. Discord
returns 403, nothing logs an error, and the member simply never gets the role —
so the funnel records someone who "chose not to pick a game". A wrong number,
not a crash, which is why it can survive for days. The fix is one drag in
**Server Settings → Roles**: put the `test-two` role above `Moderator`,
`Member` and `Game: Test`. `staging-verify.ts` checks this first.

---

## The agreed staging server

| | |
|---|---|
| Server | `TWO Staging` — private, created and owned by the staging bot |
| Text channels | `#welcome` `#general` `#events` `#bot-log` |
| Voice | `Voice 1` — a real one, because `first_voice_session` cannot be asserted without it |
| Roles | `Moderator` `Member` `Game: Test` |
| Bot application | `Owen QA Test` (`1469137636663758888`) — Server Members Intent **on**, Presence **off**, Message Content **off**. Public Bot should be **off** — verify this on the new application; the provisioning script detects the consequences either way. **Must not be a member of the live TWO guild** (`326474832151838730`); as of 2026-09-05 it is, and that is the open blocker |
| Permissions | owner — implicit. `268520512` remains the scoped set the **live** bot is invited with |

The permission integer decodes to: Add Reactions, View Channels, Send
Messages, Embed Links, Read Message History, Manage Roles. We used to say
staging is where we prove the live bot needs nothing more than that. Since the
bot now owns the staging guild, it holds everything there regardless, so that
proof has to happen against the live invite instead. Do not read a green
staging run as evidence about live permissions.

---

## Running the bot against staging

**Needs the staging token.**

```bash
DISCORD_BOT_TOKEN="$DISCORD_STAGING_BOT_TOKEN" \
DISCORD_GUILD_ID="$DISCORD_STAGING_GUILD_ID" \
TWO_DATABASE_URL="$TWO_STAGING_DATABASE_URL" \
  node src/index.ts
```

The bot itself has no idea it is in staging — it reads the same variable names
it always does. The staging-specific names exist so that *you* have to map them
across deliberately, one command, where you can see it.

---

## What is still missing

`node scripts/staging-doctor.ts` answers this from your own environment, which
is more reliable than a page someone has to remember to edit. What follows is
the state on **2026-08-25**.

**Resolved 2026-09-05.** `discord_staging_bot_token` is bound to QA and to me
as `DISCORD_STAGING_BOT_TOKEN`, and it is live — `GET /users/@me` returns
`Owen QA Test` (`1469137636663758888`). The database is done too (see below).

What remains is **not** a credential: the staging bot is a member of the live
TWO guild, so `staging-provision.ts` refuses to build the staging server. That
needs a human with Manage Server on `326474832151838730` to kick
`Owen QA Test`. See the status block at the top of this file.

Kept because the lesson outlived the blocker: through 2026-08-20 the token
looked absent, and what was present instead was the *live* bot's token under
the generic name `DISCORD_BOT_TOKEN` — correct for production, useless and
dangerous for staging. The value was never missing; it had been bound to the
**Web Lead**, who does not need it. "In the store" and "bound to the agent
that needs it" are different things, and from outside they look identical.
Report absence; do not improvise around it.

~~The second, also the founder, via TWO-11: a Postgres host.~~ **Done
2026-08-25 (TOG-45).** The host was already reachable and already had an empty
`two_bot_staging` database on it; nobody had ever applied a schema to it, so
from the outside it looked identical to "no host yet". All four migrations are
now applied and the full QA loop has been exercised against it end to end — see
the note below. This no longer waits on the founder, on TWO-11, or on the
Infrastructure Engineer hire.

Nobody needs to send us a guild id — `staging-provision.ts` creates the server
and prints the id itself, the first time it runs.

Until then: the fixtures, the reset script, the doctor, the verifier and the
provisioning script all exist. Every *decision* any of them makes is covered by
tests that need no token, no network and no Postgres —
`test/unit.staging.test.ts`, `test/unit.provision.test.ts` and
`test/unit.readiness.test.ts`.

### What has actually been run against Postgres, and what has not

The database half is no longer theoretical. On 2026-08-25 the whole QA loop was
exercised against a real PostgreSQL 17 server, in a throwaway database seeded
and dropped in the same run:

| Step | Result |
|---|---|
| `migrate.ts` on an empty database | 4 migrations applied, exit 0 |
| `staging-reset.ts` | 34 events, 10 member rows; all 11 funnel counts correct |
| Reseed on top of a fresh seed | inserted 0 — the idempotency claim, proven not asserted |
| Second full reset | identical output — repeatable between suite runs |
| Delete 7 `first_message` rows, then `staging-doctor.ts` | `FIX fixtures — 1 funnel count off: first_message 0/7` |
| `staging-reset.ts` again | recovered to the known state, exit 0 |

That is the drift-detect-and-recover cycle QA depends on, on the real engine,
including the diagnosis being *specific* about which count moved.

**Still unproven, and honestly so:** everything that talks to Discord. The
provisioning script, the verifier, the role hierarchy check and the gateway
listener have never run against a real guild, because no staging token has ever
reached this environment. Their decisions are unit-tested; their network calls
are not. Do not read the table above as covering them.
