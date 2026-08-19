# Bot raids: what happened, what stops it, what the bot does

Three bot raids reached this server in fourteen months. Nobody noticed the last
two for five months. 30 of those accounts are still members today, which is why
36% of the "member count" was fiction.

This is the working document for TWO-56.

## The three raids

| Raid | Accounts | Window | Cleaned up | Still in the server |
|---|---|---|---|---|
| 2025-07-06 | 1,015 | 56 minutes | 976, a month later | 11 |
| 2025-09-12 | 15 | 6 seconds | 11 | 4 |
| 2025-12-15 | 15 | 11 seconds | none | 15 |

None of the 1,045 has ever posted a message or entered a voice channel.

Get the current list any time — read-only, kicks nobody:

```
node scripts/raid-list.ts             # the list, with the safety checks shown
node scripts/raid-list.ts --ids       # ids only, for pasting into a mod tool
node scripts/raid-list.ts --verify    # confirm each one against the live server
```

## The gates the server already has, and why they did not help

This is the part that was wrong in the first draft of TWO-56, so it is written
down. TWO is **not** an open server:

- **Verification level 2 (Medium)** — a joiner needs a verified email and an
  account older than five minutes.
- **Membership screening (the rules gate)** is on. A new arrival lands with
  `pending: true` and cannot type, react or click anything until they accept.

Both were on during all three raids. They did not help, and the reason is
structural: **those gates govern talking, not joining.** A farm account has a
verified email and is months old, so it walks straight through level 2, and it
never intended to talk, so the rules gate costs it nothing. It joins, it sits in
the member count, and every per-member number we publish gets divided by it.

Confirmed live on 2026-08-19: all 30 accounts are still in the server and all 30
are still `pending`. Discord's own audit counted 31 members pending the rules
gate — 30 of them are these. Exactly one is a real person who never finished.

So the honest framing for the CEO is not "put a gate in place." It is: **the
gates we have stop raiders from speaking. Nothing stops them being counted.**

## What actually stops the pattern

In rough order of cost to real members:

1. **Discord's own Raid Protection** (Server Settings → Safety Setup → Raid
   Protection). Detects join-raid patterns and forces suspicious joiners through
   an extra verification. Costs a normal joiner nothing. This is the obvious
   first move, and it is a CEO/server-owner change, not an engineering one.
2. **Alerts, so nobody finds out five months late.** This is our part. See
   below.
3. **Verification level 4 (phone).** Would stop a farm dead, and would also cost
   real 18+ gamers who do not want to hand Discord a phone number. On a server
   taking ~2 real joins a month, that is a real cost to weigh, not a free win.
4. **Auto-removing accounts that never clear the rules gate after N days.** A
   clean, self-maintaining fix — and a standing moderation action taken by a
   bot, which needs explicit sign-off before it is built, not after.

Note what is *not* on the list: AutoMod. TWO's three AutoMod rules cover flagged
words, spam content and mention spam. `mention_raid_protection_enabled` is on,
but that is protection against ping storms, not against joins.

## What the bot does

`src/analytics/raidWatch.ts` watches joins on a sliding window. **Five joins in
sixty seconds raises an alert.** That is it — an alert.

Where the threshold comes from: replay it over every join in the server's
recorded history and it fires 5 times, all of them on the three known raid days,
and never on any other day in nine years.

```
$ node scripts/raid-list.ts --scan
  Detector replay over 1799 recorded joins: 5 alerts
    2025-07-06    3 alerts, peak 34 joins in a window  -- known raid
    2025-09-12    1 alerts, peak 5 joins in a window  -- known raid
    2025-12-15    1 alerts, peak 5 joins in a window  -- known raid
```

A raid trips it in seconds — on the fifth account, not after all 1,015. A long
raid re-alerts every 15 minutes rather than once per account.

### What it deliberately does not do

It does not kick, ban, prune, lock the server, change a setting, or message a
member. Not because it is hard — because a bot that removes members on a
heuristic will eventually remove a real one at 3am with nobody watching. The
alert names the accounts and a human decides.

The alert also sends no pings of any kind: IDs go out in backticks with mentions
suppressed, so a formatting slip can never turn a staff heads-up into 50 pings.

### Turning it on

Set `DISCORD_STAFF_ALERT_CHANNEL_ID` to a **staff-only** channel — the alert
lists member IDs and must not be readable by members. The bot needs View Channel
and Send Messages there, and nothing else.

Left empty, the detector still runs and the alert goes to the process log only.
That is the current state, and it is weak: nobody reads a journal at 21:16 on a
Monday. The channel is a CEO choice, so it stays unset until they name one.

The detector goes live with the bot itself (TWO-11). Until the bot is deployed,
nothing is watching in real time.

## If an alert fires

1. **Look before acting.** A genuine surge — a stream drop, a post that landed —
   is the thing we have been trying to cause. `node scripts/roster.ts 1` says
   which invite sent them.
2. If it is a raid: Server Settings → Safety Setup, **pause invites**. That stops
   the arrival rate at the source and is reversible in one click.
3. Remove the accounts. `node scripts/raid-list.ts --ids` after the window is
   labelled in `src/analytics/anomalies.ts`.
4. Add the window to `ANOMALIES` with `kind: 'raid'`, so the funnel stops
   counting it as community behaviour and the account list can find it later.
