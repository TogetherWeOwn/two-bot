# Staging: how QA resets the bot to a known state

This is written for QA. You should never need to ask an engineer to reset
staging, and you should never point a test at the live TWO server.

**Status: the code is ready, the server is not.** The only thing outstanding
is the `test-two` bot token (TWO-21). The server itself no longer needs a
human — the bot creates it, see "Building the staging server" below.
Everything else works today; the steps that need the token are marked.

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
| `DISCORD_STAGING_GUILD_ID` | id of the `TWO Staging` server | printed by `staging-provision.ts` and posted on TWO-25 — not secret |
| `DISCORD_STAGING_BOT_TOKEN` | the `test-two` bot token | secrets store, bound to you and to me |

Note what is **not** here: `TWO_DATABASE_URL`, `DISCORD_GUILD_ID` and
`DISCORD_BOT_TOKEN` are the live ones. The staging names are different on
purpose — a staging run must not be one forgotten variable away from writing
into the real funnel.

### Which bot is which

Two applications, and they are easy to confuse because one of them has two
names. Application ids are public — they are in every invite URL — so they are
written down in `src/staging/spec.ts` and checked at startup:

| Application | id | Use |
|---|---|---|
| `Owen` | `1539711683898118154` | **live.** Never in a staging variable. |
| `test-two` (created 14 Aug, five days before `Owen`) | `1537629682449649724` | staging |

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
| Bot application | `test-two` (`1537629682449649724`) — Server Members Intent **on** (already), Presence **off**, Message Content **off**. Public Bot should be **off**; as of 2026-08-20 it is still **on**, which is hygiene rather than a blocker — the provisioning script now detects the consequences itself |
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

One thing from the founder, via TWO-21:

1. `discord_staging_bot_token` — the `test-two` bot token in the secrets
   store, bound to QA and to me. The application already exists
   (`1537629682449649724`); the token needs to reach our environments.

   **Checked again 2026-08-20: still absent here.** What was present instead
   was the *live* bot's token under the generic name `DISCORD_BOT_TOKEN` —
   which is correct for the production bot and useless for staging. "In the
   store" and "bound to the agent that needs it" are different things, and
   from outside they look identical. Report absence; do not improvise around
   it.

That is now the whole dependency. The server no longer needs a human, and
nobody needs to send us a guild id — `staging-provision.ts` creates the server
and prints the id itself, the first time it runs.

A staging Postgres database is also needed. It can be a second database on the
same server the bot's Postgres migration (TWO-18) lands on — no extra spend.

Until then: the fixtures, the reset script, the verifier and the provisioning
script all exist. `staging-reset.ts` has been run end to end against a real
Postgres database and is green, and every provisioning *decision* — create vs
adopt, the ten-guild guard, role hierarchy under both ownership models — is
covered by `test/unit.provision.test.ts`, which needs no token. What cannot be
exercised yet is anything that actually talks to Discord.
