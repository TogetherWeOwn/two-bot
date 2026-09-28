# The presence probe — an instrument, not a number we publish

**TOG-469. Internal only. Nothing in here is rendered, ever.**

## Why this exists

TOG-75 asked whether to enable the Discord presence intent so the site could
show an honest "X online". It decided **option C**: no intent, `online_count`
stays null.

That decision rested on a single observation — **27** at the 19-Aug audit
(`docs/WEBSITE_CONTRACT.md:260`) against **23 bots**
(`audit/IDENTIFIERS.md:18`), i.e. single-digit humans online. One reading is
thin evidence for a standing decision, and a standing decision nobody revisits
is indistinguishable from a default.

So this replaces the one reading with a series. C now has an expiry condition.

## What it collects

Hourly, into `presence_probe` (migration 0004):

| Column | Source |
|---|---|
| `approximate_presence_count` | `GET /guilds/{id}?with_counts=true` |
| `bot_floor` | members with `user.bot` true — rescanned at most daily, `NULL` in between |

That is all of it. There is deliberately no stored human estimate; see the long
comment in the migration for why a column called `human_estimate` would end up
on a page.

## Why this is allowed when the presence intent was not

`approximate_presence_count` was rejected as a **published** figure and that
rejection stands — it counts our bots as people, and putting it on a trust page
is the same error as publishing 107 members when 84 are human.

But that defect only matters to a stranger reading the landing page.
**Internally we know the bot floor.** As an instrument the field is excellent,
on three properties that must all stay true:

1. **No gateway intent.** It is a field on a REST response.
   `src/discord/client.ts:22-28` keeps its five intents. *If a change here
   seems to need `GuildPresences`, the change is wrong — stop.*
2. **A guild-level aggregate.** There is no per-member row in it. That makes it
   strictly privacy-cheaper than the intent we declined, which would have
   streamed a status change per member.
3. **Never published.** Not in `web_v1`, not behind a flag, not "temporarily".
   If it reaches a page, the instrument has become the thing we rejected.

The one place member data is touched at all is the bot-floor count, which needs
a member listing because Discord has no endpoint that counts bots. It is
reduced to an integer inside `countBotFloor()`; no id is returned, stored or
logged. That is also why the floor is rescanned daily rather than hourly —
re-paging 100+ member objects every hour to re-derive a number that moves a few
times a year is a lot of data touched for nothing.

## Query cost and ceilings (TOG-7206)

Measured on seeded stub guilds in `test/unit.presenceprobecost.test.ts`:

| Guild size | Discord requests | Member objects touched | Floor |
|---|---|---|---|
| 107 members (today) | 2 (1 presence + 1 page) | 107 | 22 |
| 10,000 members | 12 (1 presence + 11 pages) | 10,000 | 2000 |
| 25,000 members | 12, then stops | 11,000 scanned, none counted | NULL (presence kept) |

Two ceilings bound the cost, and both refuse unbounded scans rather than
degrading quietly:

- **Bot-floor scan: `BOT_FLOOR_MAX_PAGES = 11`** (`src/jobs/presenceProbe.ts`).
  Eleven member-list requests cover guilds up to 10,000 members — ten full
  pages plus the short-or-empty page that proves the scan complete. Past that
  the scan stops, logs `presence_probe_bot_floor_truncated`, and the cycle
  records the presence reading with a NULL floor. A truncated roster is never
  reduced to a count: a partial scan reported as a number would silently shrink
  the floor as the guild grows. `countBotFloor()` takes the ceiling as a
  REQUIRED argument and throws on a missing or non-positive value, so no
  caller can page the roster by forgetting to bound it; `runProbeCycle()`
  takes it required too, and only the `startPresenceProbe()` scheduler fills
  in the module default.
- **Trend read: 14-day query window** (`scripts/presence-trend.ts`). `--days`
  used to pull the whole series and slice in memory; now the window goes into
  the query (`readSeries(db, guildId, { since })`), bounded below by the
  14-day trigger window so the verdict always sees what it needs. Against a
  seeded two-year series (1460 rows) the windowed query reads 28 rows.

Raise `BOT_FLOOR_MAX_PAGES` only after re-measuring: the cost test prints the
current numbers, and the PR that changes the constant carries them.

## How containment is enforced

Not by this document. By four things that fail loudly:

- **The grant.** `presence_probe` is in the bot schema, and
  `src/store/webRole.ts` REVOKEs the website's role from every table there,
  granting SELECT only inside `web_v1`. The website cannot read this even if
  someone writes a view over it by mistake.
- **A test that no file in `sql/` names the table** — so no contract view can
  select from it.
- **A test pinning `WEB_CONTRACT_VIEWS`** — a new view is a red build, not a
  quiet addition.
- **A test that `client.ts` never names a presence intent**, and still requests
  exactly five.

All in `test/unit.presenceprobe.test.ts`, which runs in an isolated Postgres
schema created from the immutable shipping migrations.

## Reading it

```
npm run presence:trend                # the series and the verdict
npm run presence:trend -- --days 14   # shorter table
npm run presence:trend -- --json      # machine readable
npm run presence:trend -- --web-live  # assert web_v1 is actually serving
```

Needs `TWO_DATABASE_URL` and `DISCORD_GUILD_ID`. Exit code 2 means the trigger
fired, so a cron can act without parsing text.

The report prints one derived "humans (rough)" figure next to its caveat. It is
a subtraction of two approximations — Discord's own estimate, minus a count of
bot *accounts* rather than bots currently *online* — and it has no defined error
bar. It exists to give a sense of scale in a terminal. Never publish it.

## The trigger that would reopen option A

Reopen when **both** hold:

- `web_v1` is live, **and**
- `approximate_presence_count` sustains peaks **≥ 45** against the ~23 bot
  floor — roughly 20+ humans online at once.

TOG-469 states that in prose. Prose with a number in it gets re-improvised every
time somebody reads it, so it is decided once in `src/analytics/presence.ts` and
`evaluateTrigger()` is the only thing allowed to answer:

| Constant | Value | Why |
|---|---|---|
| `REOPEN_PEAK_THRESHOLD` | 45 | TOG-469. Compare to a **raw** reading, bots included — never to a human estimate. |
| `REOPEN_REQUIRED_DAYS` | 3 | One busy night is a LAN party, not a community that grew. |
| `REOPEN_WINDOW_DAYS` | 14 | Trailing. Three big days last month do not qualify today. |
| `MIN_DAYS_FOR_A_VERDICT` | 7 | Below this we report `insufficient_data`, not `closed`. |

Daily **peak**, not daily mean: the question is whether the server is ever busy
enough to be worth a headline, and a 24-hour average is dominated by the small
hours in every timezone at once.

Four verdicts:

- `insufficient_data` — too thin a series to say anything. Not the same
  sentence as "we looked and the answer is no".
- `closed` — we looked, and presence is not close. **C stands, on evidence.**
- `armed` — the numbers qualify but `web_v1` was not asserted live. No action.
- `fires` — both halves hold.

`web_v1` being live is not observable from this repo (contract views existing is
not a serving site), so it is a human assertion via `--web-live`. Without the
flag the verdict tops out at `armed`. A number alone must never reopen A.

**When it fires**, the acceptance criteria for option A are already written: the
CISO's controls 1–5 in their assessment on TOG-75 — presence cache 0; handler
reads id + `status !== 'offline'` only; bot filter with a test; presence never
reaches `log.*`; `docs/PRIVACY.md` updated in the same change. **Do not
re-derive them.**

## Done when

The series is being collected, a human can read the trend, and nothing about it
is reachable from the website. **If the number never approaches 45, this
instrument has done its job by keeping A closed on evidence.**
