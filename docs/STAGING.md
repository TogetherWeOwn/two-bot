# Staging: how QA resets the bot to a known state

This is written for QA. You should never need to ask an engineer to reset
staging, and you should never point a test at the live TWO server.

**Status (2026-09-05): READY. Both halves are live — nothing is blocked.**

`scripts/staging-doctor.ts` exits **0** and all five readiness checks are
green:

| Check | State |
|---|---|
| staging bot token | **ok** — `Owen QA Test` (`1469137636663758888`) |
| staging Discord server | **ok** — `TWO Staging` (`1545644954272137297`) |
| staging database | **ok** — `two_bot_staging` |
| schema | **ok** — 9 migrations applied |
| fixtures | **ok** — the known state |

Set both of these and you can run the suite:

```bash
export DISCORD_STAGING_GUILD_ID=1545644954272137297   # not a secret
export TWO_STAGING_DATABASE_URL=...                   # the two_bot_staging database
```

The server was provisioned on 2026-09-05: `#welcome`, `#general`, `#events`,
`#bot-log`, voice `Voice 1`, and roles `Moderator`, `Member`, `Game: Test`,
with the bot's role raised above all three. `staging-provision.ts --apply` is
idempotent — re-running it reports `0 error(s)` and changes nothing.

The full reset loop was proven end to end against this guild: deleting three
members and every `first_message` event made `staging-reset.ts --check` exit
**1**, and `staging-reset.ts` then restored the known state and exited **0**.

**Two things worth knowing before you read further.**

*The bot did not create this server, and could not.* `POST /guilds` refuses bot
tokens outright — `{"message":"Bots cannot use this endpoint","code":20001}`,
confirmed on a bare payload and on API v9. A human created the server and
invited the bot. If staging is ever rebuilt from scratch, that step is a
human's, and it is not a credential or a permission problem.

*The bot is not the server owner here.* Not being
the owner means role hierarchy is enforced — if role assignment ever
starts failing, check the bot's role is still above `Moderator`, `Member` and
`Game: Test`.

*Grant update (2026-09-26): the bot no longer
holds Administrator* — effective mask `2240785742687959`, Administrator (bit 3)
absent, Manage Channels (bit 4) present. So a staging green run proves the
*with-bit-4* path only; it cannot prove the no-bit-4 case, which is decided by
the static requirement (`POST /guilds/{id}/channels` needs guild-level bit 4 —
see docs/INTERNAL_ACTIONS.md §8). The old "Administrator confound" warning above is
stale; the confound is now explicit bit 4, not Admin.

---

## Running the TOG-463 acceptance suite

Copy-paste. Every id below is real and was used for a green run on
2026-09-05; none of them is a secret.

```bash
export W=/path/to/your/two-bot/worktree
export QA_DB="$TWO_STAGING_DATABASE_URL"
export OUT=/tmp/tog463-out

export CHANNEL_ID=1545652796852797450    # #tog463-qa-throwaway
export ROLE_ID=1545652793937760276       # @tog463-qa-throwaway
export TARGET=275483498603741184         # the one human member of TWO Staging

bash scripts/run-real-acceptance.sh
```

Result: **7 requests, 0 failure(s) — `PASS`, exit 0.** `role.assign` returns
`assigned`, `event.upsert` returns `created`, both against real Discord.

`#tog463-qa-throwaway` and `@tog463-qa-throwaway` exist for exactly this and
nothing else. The channel is not member-facing, so `announcement.post` putting
a real message in it is harmless — which matters, because the script cannot
delete what it posts. The role sits **below** the bot's role, which is what
makes `role.assign` work rather than 403.

### If you see `role.assign` and `event.upsert` fail together

Do not read that as a permission gate. It was one for a while and it is not
one now. The overwhelmingly likely cause is the host being bound to a guild
the staging bot is not in — the live guild, which it has left. That produced
exactly `discord_404` on `role.assign` and `discord_403` on `event.upsert`,
which is indistinguishable from a missing grant unless you look at the boot
line.

`internal-actions-host-real.ts` now refuses to serve in that state and says so
(`FATAL the staging bot is not a member of guild ...`), so a run that boots at
all is bound correctly. Check the `acceptance_host_ready` line reports
`guildId: 1545644954272137297`.

`ROLE_ID` is required for the same class of reason: the default role map is the
**live** guild's `ALL_PICKS`, whose snowflakes do not resolve here, and an
unresolvable role id also answers `discord_404`.

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
| `DISCORD_STAGING_GUILD_ID` | id of the `TWO Staging` server | copied from Discord by the human who created the server (right-click → Copy Server ID) and posted on TWO-25 — not secret |
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

**Fixed 2026-09-05, after it fired for real.** This section used to warn that the
reset *deletes* scoped to `DISCORD_STAGING_GUILD_ID` (guard 5) while the funnel
counts it verified against afterwards were **not** scoped. That is exactly what
happened on the first real-guild run: the database still held a synthetic set
under `999999999999999001` from before the server existed, the reset seeded
correctly under `1545644954272137297`, and the verification step then reported
every funnel row as exactly doubled and exited 1 on a database that was fine.
Read cold, that looks like fixture corruption.

`EventStore.countByType` now takes an optional guild id
(`src/store/eventStore.ts:338`), and `staging-reset.ts` and `staging-doctor.ts`
both pass it. `test/unit.staging.test.ts` seeds two guilds into one database and
pins both halves: scoped counts see one guild, unscoped counts still sum every
guild — the live bot has exactly one guild and relies on the unscoped meaning.

Stranded rows are still worth cleaning up. They no longer corrupt the count, but
they are rows nobody meant to keep, and `SELECT DISTINCT guild_id FROM events`
is the fastest way to notice a guild id you no longer recognise. The recovery is
a scoped delete of the old id, not a `TRUNCATE` — the same three tables the
reset itself clears (`src/staging/fixtures.ts:299`):

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

**This is already done — `TWO Staging` (`1545644954272137297`) exists and is
provisioned.** Keep reading only if you are rebuilding staging from scratch, or
you want to know why the server was made by hand.

**One human step, then one command.** The human step cannot be automated — see
the box below before you go looking for a way around it.

> ### A bot cannot create the server. This was measured, not assumed.
>
> Discord's docs say a bot in fewer than ten guilds may call `POST /guilds`,
> and everything in this repo was built on that. On **2026-09-05** it was run
> for real, with the staging bot in **zero** guilds and every guard passing:
>
> ```
> POST https://discord.com/api/v10/guilds   {"name":"TWO Staging", ...}
> -> HTTP 400  {"message":"Bots cannot use this endpoint","code":20001}
> ```
>
> Retried with a bare `{"name":"TWO Staging"}` body, and again on API **v9** —
> the same `20001` all three times. So it is the endpoint refusing bot tokens,
> not our payload, not our API version, and **not a permission, intent or
> portal setting anyone can grant**. Do not re-raise this as a credential or a
> permission request; there is nothing to grant.

**Step 1 — a human makes the server (about a minute).**

1. Discord → **Add a Server** → **Create My Own** → name it exactly `TWO Staging`.
2. Open the invite link that `node scripts/staging-provision.ts` prints, and
   pick that server.
3. Right-click the server → **Copy Server ID** (needs Developer Mode on).

⚠️ **Who can do step 2.** Application `1469137636663758888` (`Owen QA Test`)
has **Public Bot OFF**. The invite link therefore works *only for the person
who owns that application in the developer portal* — anyone else opening it
gets an error, not a server picker. Either the portal owner does steps 1–2, or
they switch Public Bot on first.

**Step 2 — the script fills it in.** Needs `DISCORD_STAGING_BOT_TOKEN`.

```bash
export DISCORD_STAGING_GUILD_ID=<the id from step 1.3>   # not a secret
node scripts/staging-provision.ts            # prints the plan, changes nothing
node scripts/staging-provision.ts --apply    # creates channels and roles
```

It adopts that server and creates the four text channels, `Voice 1` and the
three roles from `src/staging/spec.ts`. Re-runnable: a fully built server plans
nothing.

Things worth knowing:

- **Dry run is the default.** It writes into somebody's real Discord server, so
  it prints the plan first.
- **The bot does NOT own this server, so role hierarchy is live.** This is the
  practical consequence of the box above. A bot that creates a guild owns it and
  bypasses hierarchy; an *invited* bot does not. Its role must sit above
  `Moderator`, `Member` and `Game: Test` or role assignment fails with a silent
  403. The script pushes those roles down automatically when there is room, and
  tells you to drag the bot up when there is not. `staging-verify.ts` checks it.
- **It counts the bot's guilds first and says what it finds.**
  `GET /users/@me/guilds` runs before anything else. Any guild the bot is in
  that is not ours prints a `WARNING` naming it — the staging bot should only
  ever be in `TWO Staging`, so anything else means somebody invited it.
- **It never creates a second `TWO Staging`.** If it finds two, it stops and
  makes you pick.
- **It never deletes or renames anything.** Channels outside the spec are
  reported and left alone.
- **A freshly made server has no humans in it but its creator.**

```bash
node scripts/staging-provision.ts --apply --invite                 # 7-day, 5-use link
node scripts/staging-provision.ts --apply --grant-admin <user-id>  # after they join
```

Share the invite link directly, not in a public channel.

**`--invite` works on the current server — measured 2026-09-05**, `DID create a
7-day, 5-use invite to #welcome`, `0 error(s)`. An earlier version of this page
predicted `HTTP 403` here, reasoning that the invite set `17601044499520` does
not carry Create Instant Invite (bit 0) and an invited bot cannot exceed its
invite. Both of those statements are true and the conclusion was still wrong:
the bot was added with **Administrator**, which implies bit 0. If staging is
ever rebuilt with the scoped invite instead, expect the 403 after all.

`--grant-admin` is untested. Neither flag is needed for QA — the person who made
the server is already in it and can invite anyone else from the Discord client
in two clicks.

### The bot does NOT own the server — so both checks apply

An earlier version of this page said the opposite, because the bot was going to
create the server and a guild's owner bypasses permission and hierarchy checks
entirely. It cannot create it any more (`code 20001`, see above), so every real
staging server is human-made with the bot invited into it like any other bot.
That reverses both consequences:

1. **The role-position failure described below CAN happen, and is the one to
   expect.** The bot's role must sit above `Moderator`, `Member` and
   `Game: Test`. `staging-verify.ts` checks this first.
2. **The invite permission set would be provable on staging again** — an
   invited bot holds exactly what its invite carried, so a green staging run
   would be real evidence about what the live bot needs. ⚠️ **Not on the
   current server:** the bot was added with **Administrator**, which implies
   everything, so `staging-verify.ts` WARNs instead of proving the scoped set.
   That proof belongs on the live invite until staging is rebuilt with
   `stagingInviteUrl()`.
3. **The invite must carry Manage Events and Create Events**, which the
   onboarding set `268520512` does not. `event.upsert` posts to
   `/guilds/{id}/scheduled-events`; TOG-463 measured the `403` on a real guild.
   `STAGING_INVITE_PERMISSIONS` (`17601044499520`) is what `stagingInviteUrl()`
   emits, and `test/unit.staging.test.ts` fails if an action's bit goes missing.

The owner-bypass branch still exists in `evaluateHierarchy` and is still
correct for any guild the bot does happen to own; it is simply not the path any
real staging server takes now.

---

## Checking the staging server itself

**Needs `DISCORD_STAGING_BOT_TOKEN` and `DISCORD_STAGING_GUILD_ID`.** Runnable
today; it exits **0** against the current server, with one WARN about the bot
holding Administrator.

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
**Server Settings → Roles**: put the `Owen QA Test` role above `Moderator`,
`Member` and `Game: Test`. `staging-verify.ts` checks this first. (This is now
the expected failure rather than a rare one — the bot is an invited member of a
human-made server, not its owner.)

---

## The agreed staging server

| | |
|---|---|
| Server | `TWO Staging` (`1545644954272137297`) — private, created by a human and owned by them (`275483498603741184`). The bot is an ordinary invited member; it cannot create a server (`code 20001`) |
| Text channels | `#welcome` `#general` `#events` `#bot-log` |
| Voice | `Voice 1` — a real one, because `first_voice_session` cannot be asserted without it |
| Roles | `Moderator` `Member` `Game: Test` |
| Bot application | `Owen QA Test` (`1469137636663758888`) — Server Members Intent **on**, Presence **off**, Message Content **off**. Public Bot should be **off** — verify this on the new application; the provisioning script detects the consequences either way. **Must not be a member of the live TWO guild** (`326474832151838730`); it left on 2026-09-05 and `GET /users/@me/guilds` now returns `TWO Staging` only |
| Permissions | Actually held: **Administrator** (`8`) — granted by whoever invited the bot, and it implies everything below. `17601044499520` is the invite set (`STAGING_INVITE_PERMISSIONS`) `stagingInviteUrl()` emits; `268520512` remains the narrower onboarding set the **live** bot is invited with |

The invite integer decodes to: Add Reactions, View Channels, Send Messages,
Embed Links, Read Message History, Manage Roles, **Manage Events**, **Create
Events**. The first six are `STAGING_PERMISSIONS`, the onboarding set. The two
events bits are there because `event.upsert` calls
`POST /guilds/{id}/scheduled-events`, which Manage Server does not imply —
TOG-463 measured that as a real `403` against a real guild on 2026-09-05, and
an invited bot can never exceed what its invite carried. Inviting with the
narrow set therefore guarantees a second trip to a human.

Staging is where we prove the live bot needs no more than this. That proof is
real again now that the bot is an invited member rather than the guild owner —
an owner bypasses the mask entirely and would make every run pass.

⚠️ **Changing the invite integer invalidates links already sent.** A server
made from an older link has to be re-authorized with a new one; the bot cannot
top itself up.

---

## Guild configuration backup and restore drill

Guild configuration is separate from the Postgres backup. The nightly snapshot
captures guild settings, roles, channels, permission overwrites and emoji, then
writes a drift report against `src/redesign/clean-slate.ts` and sends both files
to the same off-box backup store as database dumps. A missing upload command is
a hard failure; a local-only snapshot must not turn the timer green.

```bash
npm run backup:guild-config
```

The systemd path is `two-bot-guild-config-backup.timer`. The bootstrap provisions
`/etc/two-bot/credentials/discord_staging_token` for the Owen QA Test token and
enables the timer only when that file is non-empty and
`/etc/two-bot/two-bot.env` sets
`DISCORD_STAGING_GUILD_ID=1545644954272137297`. It also requires either
`TWO_GUILD_CONFIG_UPLOAD_CMD` or the existing `TWO_BACKUP_UPLOAD_CMD` in
`/etc/two-bot/backup.env`; otherwise the snapshot fails rather than remaining
local-only.

Restore is staging-only, dry-run by default, and requires two explicit write
flags. It never accepts the live guild id or a snapshot made by a different
application.

```bash
npm run restore:guild-config -- --snapshot /path/to/two-staging-guild-config-....json
npm run restore:guild-config -- \
  --snapshot /path/to/two-staging-guild-config-....json \
  --confirm-staging-guild --apply \
  --evidence /path/to/restore-drill-evidence.json
```

The evidence file records before/source/after counts and SHA-256 hashes plus the
number of role, channel, overwrite, setting and emoji operations. A successful
run finishes with `remaining=0`; re-running the same restore must report zero
Discord writes. The command is intentionally non-destructive: it creates or
patches snapshot objects, but does not delete extra current objects.

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
