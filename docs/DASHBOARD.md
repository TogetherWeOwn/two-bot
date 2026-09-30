# The growth dashboard

One page. Three questions:

1. **How many people joined this week?**
2. **Where did they come from?**
3. **How many are still here?**

Everything else on the page exists to stop you being misled about those three.

```
npm run dashboard              # writes data/dashboard.html - open it in a browser
npm run dashboard -- --serve   # serves it at http://127.0.0.1:8080, rebuilt per request
npm run dashboard -- --json    # the same numbers as JSON, for piping somewhere
npm run dashboard -- --weeks 26
```

It reads the bot's own Postgres database (`TWO_DATABASE_URL`), restricted to
`DISCORD_GUILD_ID`. Both values are required; a missing or whitespace-only guild
is refused before opening the database, including in `--serve` mode. Members,
joins, leaves, voice durations, channel events and gate history all come from
that one guild. Audit snapshots in `TWO_DATA_DIR` must be for the same guild.
There is no separate analytics store or nightly sync.

The HTML file is entirely self-contained — no fonts, no scripts, no CDN. You can
mail it, post it in Discord, or open it with no network at all and it looks the
same.

---

## How to read each number

### Joined this week

Joins recorded between Monday 00:00 UTC and now. Bots are excluded. Known bot
raids are excluded and shown separately as "set aside" — see below.

### Where they came from

The invite code a member used, when the bot saw them join.

**Right now this is empty, and that is correct.** Every join on record was
imported from the server's own log channels, which record *that* somebody
joined, never *which invite* they used. Discord does not expose it after the
fact. So the whole history reads **"Before tracking (imported history) — not
attributable"**, and it always will.

Attribution starts working with the **first join after the bot went live**. The
bot polls the invite list, watches which code's use count goes up, and credits
that code. Two people joining through different invites in the same second is
ambiguous, and a join through the vanity URL or Discovery shows no delta at all
— those are recorded as `vanity` or `unknown` rather than guessed at.

### Still here and active

Members who posted a message or joined a voice channel in the last 7 days and
have not left. This is the closest thing we have to "is the community alive".

Until the bot is deployed this tile reads **—**, not 0. A dated server snapshot
can count who is in the server; it cannot know who spoke last week. Zero would
claim a dead community, which is a different statement from "not measured yet".

### Members Discord shows / Real members

Two numbers, and the gap between them is the point.

**Members Discord shows** is the number in the member list. **Real members**
subtracts the accounts that are in that list but are not participants — raid
accounts, and members who never cleared the rules screen. Someone stuck at
screening cannot see or post in a single channel, so counting them as community
size inflates the only number worth growing.

These come from one of two sources, and the page always says which:

| Source | When | How it reads |
|---|---|---|
| **Funnel** | The bot is deployed and writing to `members` | Live and exact |
| **Snapshot** | Before deployment — the newest `data/server-audit-*.json` | Tagged `snapshot YYYY-MM-DD, not live` on every affected tile |

**The live funnel always wins.** The snapshot is used only when the members
table is completely empty, and the two are never blended — averaging a live
count with a dated one produces a number that is true of no moment at all.

As of the 2026-08-19 snapshot: 84 humans, 31 of them stuck at the rules screen,
so **53 real members**. That is the honest number, and it is roughly a third
smaller than the 84 the member list advertises. Before this fallback existed the
page showed `Real members 0`, which was not caution — it was wrong, and it was
the kind of wrong that looks like a dead server.

### D1 / D7 / D30 retention

Two columns, because we can measure two different things and only one of them is
complete:

| | What it means | How good is it |
|---|---|---|
| **Stayed** | They were still in the server on day N | **Exact.** A leave is logged for every member. |
| **Active** | They posted or entered voice on or **after** day N | Right going forward; under-counts history. |

"Active" is the number that actually matters — somebody who is technically still
a member but has said nothing for a year is not retained in any useful sense.
It under-reports old cohorts because message history before the bot went live
was only recoverable for members who show up in a log channel (206 of 1,851
members on record). It is exact from the day the bot connected.

**A dash means the cohort has not aged that far yet.** A cohort that joined
three days ago has no D30 number, and showing 0% would be a lie. Empty is not
zero anywhere on this page.

### Channels: alive / quiet / silent

| State | Rule |
|---|---|
| alive | a human posted in the last 30 days, or a funnel event landed there |
| quiet | last human post was 30–90 days ago |
| silent | nothing in 90 days or more |

Message counts come from the server snapshot written by `npm run audit:collect`
— the funnel log records that a member first spoke, not how busy a room is.
The page prints the snapshot's date, and says so loudly if it is more than a
week old. **Re-run `npm run audit:collect` before you trust the channel table.**

---

## Days that are set aside

A bot raid or a mass prune puts hundreds of joins or leaves on the board in an
afternoon. Averaged in, they make retention look catastrophic and none of it is
about the community.

So known one-off days are listed in `src/analytics/anomalies.ts`, excluded from
every headline number, and **printed on their own line at the bottom of the
page** with what they were. Nothing is deleted — the events stay in the database
exactly as recorded, and the exclusion is always visible.

Windows marked `unconfirmed` mean we can see the spike but no human has told us
what it was. The page says so every time.

This also drives the **"Of those, raid accounts"** tile: 30 accounts from three
mass-joins are still sitting in the member count Discord shows and have never
posted a word. Growing "members" and growing *those* are not the same job.

---

## Deploying it

`deploy/two-dashboard.service` runs the `--serve` mode on the bot host, bound to
localhost. Put it behind the host's existing reverse proxy **with
authentication** — the page shows member counts and channel names and is not for
the public.

It is read-only. It opens the database, runs SELECTs, and closes. It cannot
write, and it stores nothing.

## Privacy

The page shows counts, invite codes, and channel names. It does not show a
member list, usernames, or message content — see `docs/PRIVACY.md`. If you need
per-member detail, that is `npm run roster`, which is a terminal command and not
a web page for a reason.

## If a number looks wrong

`npm run dashboard -- --json` prints everything the page is built from, including
the caveats it renders. `npm run funnel` prints the same numbers from the same
tables in the terminal — if those two disagree, one of them has a bug and the
event log is the tiebreaker.

---

## The `--json` contract

`npm run dashboard -- --json` prints the `DashboardData` object defined in
`src/analytics/dashboard.ts` — the exact object `renderHtml` builds the page
from, so the page and the JSON cannot disagree. `--serve` mode serves the same
object at `/dashboard.json`. The output is JSON-safe: it survives
`JSON.parse(JSON.stringify(data))` unchanged.

**Stability promise:** downstream consumers parse this output, so keys are
never renamed or removed without updating this section AND
`test/unit.dashboard-json.test.ts` in the same commit. That test pins the full
key set and every field's type on seeded data and fails on any rename, removal
or undocumented addition. `null` means "not measurable", never zero — see the
per-field notes.

Top-level fields:

| Field | Type | Meaning |
|---|---|---|
| `generatedAt` | string (ISO instant) | When the numbers were built; `thisWeek` covers `[thisWeek.start, generatedAt)` |
| `guildId` | string \| null | Configured `DISCORD_GUILD_ID`, even when that guild has no events (legacy nullable shape retained) |
| `thisWeek` / `lastWeek` | `{ start, joins, leaves, net }` | `start` is the Monday (`YYYY-MM-DD`) of the week; `net` = joins − leaves, counted numbers only |
| `active7d` / `active30d` | number | Members still here with `last_active_at` in the window; leavers never count |
| `humansInServer` | number | Non-bot members who have not left (Discord's member-list number) |
| `raidAccountsStillCounted` | number | Of those, accounts that arrived in a known raid window |
| `realHumans` | number | `humansInServer` − `raidAccountsStillCounted`; the headline community size |
| `memberCountSource` | `'funnel'` \| `'snapshot'` \| `'none'` | `funnel`: live members table; `snapshot`: dated audit census, used only when the table is empty; `none`: neither has anything |
| `memberCountAsOf` | string \| null | Census instant, set only when `memberCountSource` is `'snapshot'` |
| `joinedNeverSpoke` | number | Still here, joined, no first message or voice session on record |
| `avgVoiceSessionSeconds` | number \| null | Mean over known-start sessions only; null when none measured — not a zero average |
| `measuredVoiceSessions` | number | Known-start sessions with a usable duration that entered the mean |
| `excludedUnknownStarts` | number | `startKnown: false` ends left out before averaging; counted, never averaged |
| `weeks` | `WeekRow[]` | Per-week history, oldest first |
| `cohorts` | `CohortRow[]` | One row per week in `weeks` |
| `retentionOverall` | `{ d1, d7, d30 }` | All-time roll-up of the cohort table; each a `RetentionCell` or null |
| `gateOverall` | `GateConversion` \| null | All-time rules-gate conversion; null when never observed — not 0% |
| `sourcesAllTime` | `SourceCount[]` | Joins by human-readable source, biggest first |
| `channels` | `ChannelRow[]` | Channel activity, busiest first |
| `channelSnapshotAt` | string \| null | When the channel snapshot was taken; null when there is none |
| `caveats` | string[] | Honest caveats, rendered on the page |
| `anomalies` | `Anomaly[]` | `unconfirmed` and `confirmed` windows only |

Nested shapes:

- `WeekRow`: `weekStart` (string, Monday `YYYY-MM-DD`), `joins`, `setAside`
  (joins inside anomaly windows — reported, never averaged in), `leaves`, `net`,
  `bySource` (`SourceCount[]` for that week).
- `SourceCount`: `source` (raw string as recorded), `label` (what a human
  reads), `unattributed` (boolean — true means "we do not know", not a real
  channel), `joins`.
- `CohortRow`: `weekStart`, `size` (non-bot, non-anomaly joins that week), `d1`
  / `d7` / `d30` (`RetentionCell`, or null when the cohort has not aged that
  far), `gate` (`GateConversion`, or null when never observed).
- `RetentionCell`: `eligible` (members whose Nth day has happened),
  `stayed` (still in the server on day N — exact), `active` (recorded active on
  or after day N — under-reports pre-bot history).
- `GateConversion`: `observed` (the denominator: cleared + stuck +
  leftAtTheGate), `cleared`, `stuck` (never cleared, still here — the action
  list), `leftAtTheGate` (never cleared, gone, joined while watched),
  `unknowable` (left out of the percentage: joined and left before we watched).
- `ChannelRow`: `channelId`, `name`, `category` (string \| null),
  `humanMsgs30d` / `humanMsgs90d` / `uniqueHumans30d` (number \| null — null
  with no snapshot), `lastMessageAt` (string \| null), `daysSilent` (number \|
  null), `events30d` (funnel events attributed to the channel — always known),
  `state` (`'alive'` \| `'quiet'` \| `'silent'`).
- `Anomaly`: `id`, `kind` (`'raid'` \| `'cleanup'` \| `'prune'`), `start` /
  `end` (`YYYY-MM-DD`, inclusive), `eventTypes`, `status` (`'confirmed'` \|
  `'unconfirmed'`), `label`, `note`.
