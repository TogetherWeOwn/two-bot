# Onboarding and routing (TWO-7)

How a new member gets from "just joined" to "in a channel about a game they
actually play", and what currently stops that from finishing.

## The journey

1. **They join.** The server has a rules gate, so they arrive `pending` and
   cannot click, type, or react. We do nothing yet. This matters: 11 of the last
   12 joins were still pending at the moment `GuildMemberAdd` fired, so
   welcoming on join would have welcomed people who could not respond.
2. **They accept the rules.** Discord sends a member update with `pending`
   flipping true -> false. *That* is our trigger.
3. **We post a welcome** in the landing channel, mentioning them, with a game
   picker attached (a select menu, not reactions - it survives restarts and does
   not need a message to be re-reacted).
4. **They pick their games.** We grant the matching roles, remove any they
   unticked, and reply — privately, visible only to them — with direct links to
   the channels those roles just opened.
5. **They click a link and they are in the room.**

No DMs at any point. Nothing is mass-messaged. The only public post is the one
welcome in the landing channel; everything else is an ephemeral reply that only
that member sees. This is a hard constraint from the issue, and
`test/e2e.onboarding.test.ts` asserts the bot never even opens a DM channel.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DISCORD_LANDING_CHANNEL_IDS` | Comma-separated. Where the welcome is posted. **If empty, onboarding does not run.** |
| `TWO_ONBOARDING_DRY_RUN` | `1` = show the picker and record the funnel, but grant no roles. |

Onboarding is off by default on purpose. On a live 100-member server, a bot that
guesses which channel to post into is worse than a bot that does nothing.

## The catalog

`src/onboarding/catalog.ts` is the single mapping from "a game someone picks" to
"the role we grant" to "the room we send them to". It is read from the live
server, not invented, and `scripts/verify-catalog.ts` checks it against the live
server without changing anything.

Some picks have no dedicated room (Rocket League, Fall Guys, Retro, Tabletop,
Pokémon, CounterStrike, War Thunder). Those route to `#game-hub` **by design**
and are not counted as a failure. Adding a room later is a catalog edit.

## What is blocking the last step

Three categories deny `VIEW_CHANNEL` to `@everyone` and grant it back to
**nobody**:

| Category | Role that should see it | Members already holding that role |
| --- | --- | --- |
| 🎯 Shooters | Shooter Games | 27 |
| 🎮 Survival | Survival Games | 11 |
| 👻 Horror | Horror Games | 6 |

(Counts read live on 2026-08-19, from 107 members.)

So the rooms are invisible to every non-admin, including the 27 people who
already asked for shooters. Assigning the role today routes a member nowhere.
44 members are already holding a key to a door that does not open.

Until that is fixed, onboarding **degrades on purpose**: it links `#game-hub`,
which members can actually open, rather than a link that 404s on their first
minute in the server. Every time that happens it is recorded as
`degraded` on the `channel_routed` event, so the shortfall shows up as a number
in the weekly report instead of being invisible.

`scripts/apply-game-channel-access.ts` is the fix. It needs CEO sign-off before
`--apply`, because it changes server permissions.

## The trap: categories do not grant anything

Discord resolves a member's permissions from **the channel's own overwrites**. A
category is a template you can sync down to its children; it grants nothing at
runtime. Adding the overwrite to the three categories and stopping there would
look correct in the Discord UI and change nothing for any member.

That is why `apply-game-channel-access.ts` writes to the category **and** every
channel inside it, and why `verify-catalog.ts` deliberately does not walk up to
the parent when deciding whether a channel is visible.

There is an end-to-end test for exactly this - "granting view on the categories
alone is NOT enough" - which runs the whole journey against a server configured
the wrong way and asserts the member still ends up at the hub. If someone
simplifies the script back to categories-only, that test fails.

## What the fix does and does not do

Does:

- adds one overwrite per channel granting `VIEW_CHANNEL` to the one matching
  game role, on the three categories and the three channels inside them.

Does not:

- touch the `@everyone` deny. The rooms stay hidden from people who did not ask
  for them.
- grant anything except `VIEW_CHANNEL`. Posting, attaching and so on keep coming
  from the member's normal permissions.
- touch any role, any other channel, or any member.

`--revert` removes only the overwrites the script added.

## Verifying

```
npm run verify:catalog                      # live, read-only
node scripts/apply-game-channel-access.ts   # dry run, prints the diff
npm test                                    # includes the full journey e2e
```

The e2e suite runs the same member journey against three server configurations -
dark, categories-only, and fully lit - so we know the fix is both necessary and
sufficient before touching the real server.

## The number this moves

`channel_routed` per new member, and seconds from `member_join` to
`channel_routed` (`EventStore.secondsBetween`). The target from TWO-7 is under
60 seconds. Watch `degraded` alongside it: a non-zero total means members are
landing in the hub instead of the room they asked for.
