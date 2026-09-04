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

Removing them is a separate tool, `scripts/raid-remove.ts`. See **Removing the
accounts** below: dry run by default, kick rather than ban, safe to re-run.

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
   real 18+ gamers who do not want to hand Discord a phone number. TWO retained
   roughly **5 real joins in the measured year** — the earlier 24/year figure
   counted 19 surviving raid accounts as people — so taxing every genuine
   arrival is a real cost, not a free win.
4. **Remove accounts still behind the rules gate after 14 days.** Adopted on
   TOG-412 and implemented by `scripts/rules-gate-timeout.ts` (TOG-479). It is a
   deterministic Discord flag plus Discord's own join timestamp, not the burst
   detector's heuristic. It ships report-only for its first 30 days; execution
   still requires `--execute --expect <n>` and can only kick, never ban.

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

The chosen route is `🔧〢updates-and-changes`, channel
`1138590808715571300`: it is staff-only and already Discord's
`safety_alerts_channel_id`. `.env.example` carries that value for deploys to
copy. Left empty, the detector still runs but the alert goes to the process log
only, which nobody reads at 21:16 on a Monday.

The detector goes live with the bot itself (TWO-11). Until the bot is deployed,
nothing is watching in real time.

## Removing the accounts

`scripts/raid-remove.ts` (TOG-451). The list and the removal are deliberately
two tools: producing the list is evidence-gathering and safe to do at any time,
removing is a moderation action a human has authorised.

```
node scripts/raid-list.ts --ids > data/targets.txt
node scripts/raid-remove.ts --ids-from data/targets.txt                     # dry run
node scripts/raid-remove.ts --ids-from data/targets.txt --execute --expect 30
```

**It kicks. It never bans.** A kicked account can come back through the rules
gate; a banned one cannot, and unbanning thirty accounts by hand is not a
realistic undo. There is no ban code path to switch on — `src/discord/kick.ts`
has one method, and a test fails if a second one appears.

**Dry run is the default and it cannot reach Discord.** Without `--execute` the
script never constructs a client at all, so the dry run is read-only by
construction rather than by intention. It prints the same per-account lines the
real run would.

**The target list is an input, never a constant.** `--ids-from` takes a file or
`-` for stdin, in the format `raid-list.ts --ids` already prints (`#` comments
and blank lines are fine). No count and no id is hardcoded anywhere in the tool.

**`--execute` requires `--expect <n>`** and refuses if the file disagrees. The
authorised count was still open when this was written — the authorisation says
nineteen in one sentence and implies thirty in another (TOG-411) — so the
operator states the number they believe they are authorised for and the tool
checks it. A list that grew between being produced and being run stops here.

**Every account gets a durable line** in `data/raid-removal-audit.jsonl`
(`--audit` to move it) — id, action, outcome, HTTP status, timestamp — appended
and fsync'd before the next account is touched. That path is gitignored: it
names individual members and must not reach GitHub (docs/PRIVACY.md).

**Re-running the same command is safe.** Anything already kicked or already gone
is skipped without a request; anything that failed is retried. Killed between a
successful kick and its audit line, the retry gets a 404 and records
`already_gone` — kick is idempotent at Discord, which is the other reason it is
a kick. Three consecutive failures end the run rather than repeating a missing
permission thirty times.

Exit codes: `0` clean · `1` aborted, or some accounts failed · `2` refused to
start (bad list, count mismatch, no token).

The dry run also cross-checks against `data/server-audit-2026-08-19.json`. That
file holds **no member roster** — its own `note` says so, and pointing
`--ids-from` at it gets a specific error rather than an empty run. What it does
hold is the envelope: 84 human members, 31 stuck at the rules gate. Every
confirmed raid account was pending at that gate, so a target list longer than 31
is flagged as containing something that evidence does not explain.

Execution itself is TOG-411, and it is blocked: the Discord credentials for this
server are not held by this company (TOG-432). `--execute` without a token says
so and exits rather than sending anyone looking for one.

## Rules-gate timeout

`scripts/rules-gate-timeout.ts` is the self-maintaining half of the TOG-412 gate
decision. It reads the complete live roster and selects only human members for
which Discord reports both:

- `pending: true`; and
- `joined_at` at least `RULES_GATE_TIMEOUT_DAYS` ago. The named constant is 14
  days, chosen because it spans two weekends while preserving the measured raid
  precision: all 30 confirmed raid accounts were still pending after 8–13
  months; exactly one real person was pending in the 2026-08-19 audit.

```
node scripts/rules-gate-timeout.ts                         # report only
node scripts/rules-gate-timeout.ts --execute --expect 30  # only after report-only sign-off
```

Report-only is the default for the first 30 days. The deploy installs
`two-bot-rules-gate-timeout.timer`, which runs the report daily at 04:43 UTC. It
reads Discord, names every target in the journal, and appends one `would_kick`
audit line per account to `data/rules-gate-timeout-audit.jsonl`; it constructs
no kicker and sends no DELETE. The file is gitignored because it contains
member IDs. Enabling removal later is a deliberate unit change: add
`--execute --expect <the reviewed count>` to the service's `ExecStart`, then
`systemctl daemon-reload`; there is no environment switch that can turn it on
accidentally.

Execution is deliberately double-gated. `--execute` alone refuses to start, and
`--expect <n>` must match the fresh live report. The action reuses
`src/discord/kick.ts`, so it is a kick only: a removed person can rejoin through
the same invite and sees the rules gate first. There is no ban path.

The report cannot be run against the live guild from this company today because
the Discord credential is absent. That does not block building or testing the
rule against fixtures; it does block starting the 30-day live observation
period. TOG-13 owns that separate deploy credential dependency.

## If an alert fires

1. **Look before acting.** A genuine surge — a stream drop, a post that landed —
   is the thing we have been trying to cause. `node scripts/roster.ts 1` says
   which invite sent them.
2. If it is a raid: Server Settings → Safety Setup, **pause invites**. That stops
   the arrival rate at the source and is reversible in one click.
3. Remove the accounts, once a human has authorised it. Label the window in
   `src/analytics/anomalies.ts` first, then `node scripts/raid-list.ts --ids`
   into `node scripts/raid-remove.ts` — dry run, read it, then `--execute`.
4. Add the window to `ANOMALIES` with `kind: 'raid'`, so the funnel stops
   counting it as community behaviour and the account list can find it later.
