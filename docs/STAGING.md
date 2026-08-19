# Staging: how QA resets the bot to a known state

This is written for QA. You should never need to ask an engineer to reset
staging, and you should never point a test at the live TWO server.

**Status: the code is ready, the server is not.** The staging Discord server
and the `Owen Staging` bot application are being created by the founder under
TWO-21. Everything below works today except the two steps that need those
credentials, which are marked. See "What is still missing" at the bottom.

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
| `TWO_STAGING_DATABASE_URL` | Postgres URL for the staging database | your secrets store |
| `DISCORD_STAGING_GUILD_ID` | id of the `TWO Staging` server | posted in the TWO-21 thread — not secret |
| `DISCORD_STAGING_BOT_TOKEN` | the `Owen Staging` bot token | secrets store, bound to you and to me |

Note what is **not** here: `TWO_DATABASE_URL`, `DISCORD_GUILD_ID` and
`DISCORD_BOT_TOKEN` are the live ones. The staging names are different on
purpose — a staging run must not be one forgotten variable away from writing
into the real funnel.

Never paste a token into an issue, a chat message, or a test file. See
`docs/SECRETS.md`.

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

### The four guards

The script exits `2` without touching anything if:

1. `TWO_STAGING_DATABASE_URL` is unset or is not a Postgres URL.
2. The database name does not contain `staging` or `test`.
3. `DISCORD_STAGING_GUILD_ID` is unset, or is the live TWO guild.
4. (Always) deletes are scoped by guild id — never `TRUNCATE`.

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
**Server Settings → Roles**: put the `Owen Staging` role above `Moderator`,
`Member` and `Game: Test`. `staging-verify.ts` checks this first.

---

## The agreed staging server

| | |
|---|---|
| Server | `TWO Staging` — private, founder and bot only |
| Text channels | `#welcome` `#general` `#events` `#bot-log` |
| Voice | `Voice 1` — a real one, because `first_voice_session` cannot be asserted without it |
| Roles | `Moderator` `Member` `Game: Test` |
| Bot application | `Owen Staging` — Public Bot **off**, Server Members Intent **on**, Presence **off**, Message Content **off** |
| Permissions | `268520512` — scoped, **not** Administrator |

The permission integer decodes to: Add Reactions, View Channels, Send
Messages, Embed Links, Read Message History, Manage Roles. Staging is where we
prove the live bot needs nothing more than this.

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

Two things, both owned by the founder via TWO-21:

1. The `TWO Staging` Discord server, built to the spec above, with the
   `Owen Staging` bot invited using permission integer `268520512` and its role
   dragged above the three test roles.
2. `discord_staging_bot_token` in the secrets store, bound to QA and to me, and
   the staging guild id posted in the TWO-21 thread.

A staging Postgres database is also needed. It can be a second database on the
same server the bot's Postgres migration (TWO-18) lands on — no extra spend.

Until then: the fixtures, the reset script and the verifier all exist and are
tested. `staging-reset.ts` has been run end to end against a real Postgres
database and is green. What cannot be exercised yet is anything that talks to
Discord.
