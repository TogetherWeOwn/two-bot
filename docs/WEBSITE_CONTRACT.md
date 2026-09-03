# The website data contract

**Version: `v1.0` — live.** (Doc revision `v1.0.2`, 2026-08-30 — prose only,
the runtime contract is unchanged at `1.0`.) The `web_v1` schema and its nine
views exist in Postgres, and the `two_web_ro` role can read them and nothing
else. Both re-verified against a clean database on 2026-08-30: 35/35 role
checks, 23/23 contract tests. Build against this.

The website reads the bot's Postgres database directly. No sync job, no API in
between, no second copy of the numbers that can drift from the first.

The thing that makes that safe is this contract: **the website reads views in
the `web_v1` schema and nothing else.** It never reads `events`, `members`, or
any other table the bot owns. That means the bot can rename a column, add an
index, or restructure a table tomorrow without breaking a single page, as long
as the views still return what is written here.

If a field you need is not in here, it does not exist yet. Ask for it and it
gets added in a version bump — do not reach past the views into the tables,
because the moment that happens this whole arrangement stops working. (You
cannot, in fact: the grants forbid it. Ask anyway rather than working around
it.)

> **What is real today, and what is null.** The views exist and the shapes are
> final. Three of them have real data now — `members`, `member_milestones` and
> the two `funnel_*` views read tables the bot has been filling since day one.
> The collector behind `live_counts` and `rank_counts` has **shipped** (TOG-73),
> but it reads Discord, and the bot has no Discord token in this environment —
> so on a database today those two views still return **nulls**, and
> `next_event` returns **zero rows** until TOG-74. That is not a failure state
> and it needs no special handling: it is exactly the degraded path in §3, which
> you have to build anyway. Building against it now means the empty states get
> exercised from the first day rather than the last. §6.2 has the detail.

---

## 1. Versioning

The schema name carries the major version: `web_v1`.

| Change | What happens |
|---|---|
| New view, or a new column on an existing view | Minor bump (`v1.0` → `v1.1`). No warning needed. Additive only. |
| Column renamed, removed, or its type/meaning changed | **Major bump.** A new `web_v2` schema is created alongside `web_v1`. Both run for at least 30 days. |
| A bug fixed in a view's logic (the number was wrong) | Patch bump, announced on the issue. The shape does not change. |

`web_v1.contract_meta` returns the live version at runtime, so the website can
assert the version it was built against and fail loudly rather than quietly
rendering something else.

**The major-bump rule is enforced by Postgres, not by discipline.** The views
are applied with `CREATE OR REPLACE`, which can append a column but cannot
rename, reorder, remove or retype one. So a change that would silently break
your pages fails at deploy time on our side, and that failure *is* the signal
that it needs a `web_v2`. Nobody has to remember the rule.

Every change gets a line in the changelog at the bottom of this file.

---

## 2. The views

Every timestamp is **ISO-8601 UTC text** (`2026-08-19T20:19:24.719Z`), matching
how the bot stores them. Cast on the way out if you want a real timestamp:
`counts_updated_at::timestamptz`.

Every count column is **nullable, and null means "we do not know"**. See §3.

### `web_v1.contract_meta` — always exactly one row

| Column | Type | Notes |
|---|---|---|
| `contract_version` | text | e.g. `1.0`. Compare against what you built for. |
| `guild_id` | text | The TWO server's Discord snowflake. Derived from the data until the bot records it explicitly; null on an empty database. |

### `web_v1.live_counts` — always exactly one row

The landing page counter. One row, always present, even when every value in it
is null and even when nothing has ever been collected. An empty table still
answers.

| Column | Type | Notes |
|---|---|---|
| `human_member_count` | int, **nullable** | Members in the server, **bots and dynamically-derived raid accounts excluded from the same Discord snapshot**. 54 at the last grounded audit (107 total − 23 bots − 30 raid accounts). |
| `online_count` | int, **nullable** | Humans currently online, bots excluded. **Null in v1** — see §6.1. |
| `counts_updated_at` | text, nullable | When `human_member_count` was last read from Discord. Null if never. |
| `online_updated_at` | text, nullable | When `online_count` was last read. Separate from the above because the two go stale at very different rates. |

**The timestamps are returned even when the value beside them has aged out**, so
you can render "as of 09:14" on the degraded path instead of going silent with
no explanation.

### `web_v1.rank_counts` — one row per rank

The Prospect → Legend ladder with a headcount each. Rank names are Discord
roles; the mapping from role ID to rank lives in the bot, so the website never
hardcodes a snowflake.

| Column | Type | Notes |
|---|---|---|
| `rank_key` | text | Stable machine key: `prospect`, `member`, `soldier`, `veteran`, `legend`. Safe to use in CSS classes and URLs. |
| `rank_label` | text | Display name as it appears in Discord. Can change; `rank_key` will not. |
| `rank_order` | int | 1 = Prospect … 5 = Legend. Sort by this, never alphabetically. |
| `member_count` | int, **nullable** | Humans whose **highest** rank is this one. Mutually exclusive: these sum to the ranked population. This is the number to put on the ladder. |
| `holders_count` | int, **nullable** | Humans holding the role at all, including people who have since ranked past it. Cumulative, so these sum to more than the membership. |
| `snapshot_at` | text, nullable | When the rank snapshot was taken. |

Rows are always returned for all five ranks, in `rank_order`, **including on a
completely empty database**. A rank never disappears from the result set just
because nobody holds it — that would make the ladder look shorter than it is.

**Two columns because the ranks stack.** In the TWO server a Legend still holds
Soldier, Member and Prospect. From the 2026-08-19 audit, humans only:

| Rank | `holders_count` | `member_count` (highest rank) |
|---|---|---|
| Prospect | 51 | 10 |
| Member | 41 | 24 |
| Soldier | 17 | 10 |
| Veteran | 7 | 1 |
| Legend | 6 | 6 |

The 2026-08-19 audit's `holders_count` sums to 122 against 84 Discord human
accounts — publish that as a ladder and the columns visibly do not add up. The
collector removes the same raid exclusion set from both columns and the live
counter; the published exclusive sum must therefore never exceed the published
human member count. Read the current figures from the view, not this audit.

The `member_count` column above is derived from the cumulative audit figures by
subtraction, which is right only if the ranks are strictly nested. That is what
the numbers look like, but the rank collector will compute it from actual role
membership and confirm it. **Treat these five numbers as accurate to ±1 until
the collector has actually run against a live guild** — and read them from the
view, never from this table.

### `web_v1.members` — one row per member

For member profiles. **Deliberately thin**, see §4 for what is not here. Bots
are excluded entirely, and so are the raid accounts in `member_exclusions` —
the same exclusion set the live counter and the rank ladder apply, so a profile
page and the landing-page number can never disagree about who is a member.

| Column | Type | Notes |
|---|---|---|
| `member_id` | text | Discord snowflake. The only identifier we hold. |
| `joined_at` | text, nullable | First join. Null for members who predate our data. |
| `tenure_days` | int, nullable | Whole days since `joined_at`. Precomputed so the website is not doing date maths, and so "tenure" means the same thing on every page. |
| `rank_key` | text, nullable | Highest rank held, or null if they hold no rank role. Null for everyone until the TOG-73 collector gets a Discord token and runs (§6.2), so treat null as the normal case for now. |
| `is_current_member` | boolean | False for people who have left. They stay in the view — dropping them would quietly flatter our retention numbers. |

**No usernames or avatars.** We do not store them (`docs/PRIVACY.md`), so a
profile page must resolve the display name from Discord at render time. If the
website needs names in the database, that is a privacy decision for the CEO,
not something I can add unilaterally. Raised in §6.3.

### `web_v1.member_milestones` — event history for profiles

| Column | Type | Notes |
|---|---|---|
| `member_id` | text | |
| `milestone` | text | Whitelisted: `joined`, `left`, `rank_changed`. |
| `occurred_at` | text | |
| `detail` | text, nullable | For `rank_changed`, the new `rank_key`. Null otherwise. |

The whitelist is the point. Adding a milestone type is a contract version bump
and an edit to the view, not a silent widening — otherwise "first message at
14:02" ends up on a public page because someone started emitting an event.
`first_message` and `voice_session_start` are recorded by the bot today and do
**not** appear here; there is a test that says so.

`rank_changed` is already in the whitelist even though nothing emits it yet, so
TOG-73 can start emitting without the contract changing.

### `web_v1.next_event` — zero or one row

| Column | Type | Notes |
|---|---|---|
| `event_id` | text | Discord scheduled event ID. |
| `name` | text | |
| `starts_at` | text | |
| `channel_id` | text, nullable | |
| `description` | text, nullable | |

**Zero rows means there is no next event.** That is the correct, expected answer
today — the server has none scheduled, and nothing is polling for them until
TOG-74. The view will never invent a placeholder to avoid an empty result, so
the designed empty state is reachable in production and not just in a mockup.

An event that has already started stays as `next_event` until Discord moves it
off `active`, so "happening now" does not blink off the page mid-session.

### `web_v1.upcoming_events` — zero or more rows

Same columns as `next_event`, ordered by `starts_at`, limited to the next 90
days. `next_event` is literally the first row of this. Cancelled and completed
events appear in neither.

### `web_v1.funnel_daily` and `web_v1.funnel_by_source` — **staff pages only**

The join numbers behind the dashboard. Aggregate, guild-level, no member IDs,
bots excluded. A day with no activity produces no row.

`funnel_daily`: `day`, `joins`, `leaves`, `first_messages`, `first_voice_sessions`, `net_change`.
`funnel_by_source`: `day`, `source`, `joins`.

`source` values (`invite:aB3xY9`, `ambiguous:a+b`, `vanity`, `unknown`,
`web:one_click`) are documented in `docs/EVENTS.md`. Show `unknown` as itself;
never fold it into a real invite code. `web:one_click` is the website's own
one-click join (`guild.add_member`) — the web→Discord conversion number.

⚠️ **Audience: authenticated staff pages.** These are exposed so the website can
render the growth dashboard, not so the public site can render momentum.
`two-design/docs/CONTENT.md` rules out growth framing on public pages, and right
now these numbers are 0 joins in 30 days. Putting them on the landing page would
be accurate and self-defeating at the same time.

---

## 3. The zero rule

**Hard guarantee: a count column is null when we do not know it. It is never 0
as a stand-in.**

Enforced in three places, not one:

- **The collector** writes a snapshot only after a successful Discord read. A
  failed read changes nothing; the previous value and its timestamp stay exactly
  as they were. Nothing writes a 0.
- **The schema** refuses a count without the time it was read
  (`guild_counters_members_dated`). An undated count could never be aged out, so
  it would be published as fresh forever.
- **The view** nulls a value whose timestamp is past its ceiling (§5). This is
  the one that matters most: it means a collector that *stopped* ages its own
  numbers out. If the ceiling lived in the writer, a bot that died at 09:00
  would still be publishing 09:00's count on Tuesday.

So `0` in `human_member_count` would mean the server genuinely emptied out, and
`null` means our plumbing hiccuped. The website can tell those apart, which is
the whole point: a page rendering "0 online" says *dead*; a page rendering
nothing says *a service is having a moment*.

`member_count` in `rank_counts` is the one place a real 0 is expected — nobody
holds Legend yet.

---

## 4. What this contract deliberately does not expose

Not because it is secret. Because a field that exists eventually ends up on a
page, and these are numbers that would hurt us on the way past.

- **Message counts, post counts, activity rates.** Anywhere, at any grain.
- **`last_active_at` per member.** It is in our tables. It is not in the views.
- **Per-channel activity.**
- **Anything that reads as momentum for a public page** — "joined this week",
  trend arrows, sparkline series.
- **Usernames, nicknames, avatars, emails, IPs.** We do not have them.
- **Message content.** We do not request the intent, so it does not exist.
- **`approximate_presence_count`, at any grain.** We now collect it hourly into
  `presence_probe` (TOG-469, migration 0004) as an internal instrument, to test
  on a series rather than one reading whether the online number would ever be
  worth publishing. It is **not** a candidate for this contract and adding a
  view over it is not a small change: it counts our 23 bots as people, which is
  the same error as publishing 107 members when 84 are human. A test asserts no
  file in `sql/` names that table. See `docs/PRESENCE_PROBE.md`.

The full never-show list is the Web Lead's, in `two-design/docs/CONTENT.md`.
This section mirrors it at the data layer so the rule is enforced by what the
website *can* read, not only by what it chooses to render. The cheapest place to
enforce a rule is the place where breaking it is impossible.

A test asserts the exact column list of `web_v1.members`, so adding one of these
by accident is a red build rather than a discovery.

---

## 5. Caching and freshness

**The landing page never waits on Discord.** It reads a table the bot has
already filled in. Discord being slow or down cannot make a page slow.

| Setting | Value | Why |
|---|---|---|
| Counter refresh interval | **60 seconds** | The Lead asked for 60s and nothing here needs to be fresher. A member count that is a minute old has never been wrong in a way anybody noticed. |
| Rank snapshot interval | **10 minutes** | Ranks change a few times a month. Polling faster is pure API burn. |
| Scheduled events poll | **10 minutes** | |
| `online_count` goes null after | **15 minutes** without a successful read | Presence is volatile. A 15-minute-old "26 online" is a guess wearing a number's clothes. |
| `human_member_count` goes null after | **24 hours** without a successful read | Membership barely moves. Yesterday's count is still true enough to publish; last week's is not. |
| Rank counts go null after | **24 hours** | Same reasoning. |

The three refresh intervals are the collectors' business (TOG-73, TOG-74). The
three **ceilings are live now**, inside the views, with a test each.

Suggested rendering, matching the Live counter states in
`two-design/docs/COMPONENTS.md` — the website's call, not mine:

- `counts_updated_at` under 10 minutes old → render the number plainly.
- 10 minutes to the null ceiling → render the number plus "as of HH:MM".
- Value is null → render the degraded state. Omit the number entirely.

The bot's own alerting treats a counter that has not refreshed in 15 minutes as
a fault on our side. The website should not have to notice, and should never
show a visitor an error about our infrastructure.

---

## 6. Open items — read before building against this

### 6.1 `online_count` is null — decided, not pending

**This is settled. Do not build a page that waits for it.** TOG-75 chose
**option C — ship without an online count** on 2026-08-25, and the issue is
`done`. Plan for `online_count` to be null indefinitely.

The bot does not request the `GUILD_PRESENCES` gateway intent
(`src/discord/client.ts` keeps the intent list minimal on purpose). Without it
we cannot see who is online, so we cannot count humans online.

The options as they were weighed:

| Option | Result |
|---|---|
| **A. Enable the presence intent** | A real humans-only online count. It is a privileged intent — a toggle in the Discord developer portal — and it means the bot receives presence updates for every member. We would store only the aggregate count, never per-member presence. |
| **B. Use Discord's `approximate_presence_count`** | One REST call, no intent needed — but it counts the 23 bots along with the humans. At the audit it read **27**, and we have no way to say how many of those were humans. It would publish an inflated number on a page whose job is to be trustworthy. **Rejected.** |
| **C. Ship without it — CHOSEN** | `online_count` stays null, the counter shows members only, and the degraded path gets exercised from day one. |

The decision was the President & COO's, not the CEO's — an earlier revision of
this document named the CEO as the owner, and that error is the single reason
the question sat unanswered for six days. A doc that names the wrong owner is
worse than one that names none.

C carries an expiry condition rather than being a permanent no: TOG-469 landed
an **internal-only** presence instrument (`presence_probe`, migration `0004`)
so that reopening A is done on a measured series rather than on argument. That
table is explicitly **not** in this contract and never will be without a
version bump — see §4.

If A is ever adopted, it is **additive**: a null column starts returning a
number. No version bump, no website change.

### 6.2 The counter collector has shipped, but nothing is filling the tables yet

The views are live and correctly shaped. **On a database today `live_counts`
still returns nulls, `rank_counts` five null rows, and `next_event` nothing** —
measured, not assumed (2026-08-30, migrations + `web:views` applied to a clean
Postgres). Build for that.

- **TOG-73 — shipped** (`src/jobs/communitySnapshots.ts`, migration `0005`).
  60-second member cache, 10-minute rank snapshot, feeding `live_counts`,
  `rank_counts` and `members.rank_key`. It reads the Discord REST API, and
  **this company holds no Discord token for the TWO server**, so in this
  environment the job's reads fail and — by design, §3 — it writes nothing.
  The moment a token exists the numbers appear with no website change.
- **TOG-74 — not started.** Scheduled-events poller → `next_event`,
  `upcoming_events`.

Flagged so nobody plans a launch date assuming the data is already sitting
there. The distinction that matters to you: TOG-73 is no longer *code to be
written*, it is *code waiting on a credential*, and the degraded path in §3 is
what renders in the meantime either way.

### 6.3 Profiles have no display names

Covered in §2 under `web_v1.members`. Either the website resolves names from
Discord at render time, or the CEO signs off on us storing them. I have not
assumed either. It is a data-model question for TOG-49.

---

## 7. The website's database role

One role, `two_web_ro`, that can read the views and genuinely nothing else.

```
npm run migrate          # tables (migration 0003)
npm run web:views        # the schema and the nine views (sql/web_v1.sql)
TWO_WEB_RO_PASSWORD=... npm run web:role
npm run verify:web-role  # prove it
```

`web:role` is idempotent — run it again after adding a view, run it again to
rotate the password. It never prints the password. The password reaches the Web
Lead through the secrets process in `docs/SECRETS.md`. Never in an issue
comment, never in the repo.

What the role gets:

- `CONNECT` on the database, `USAGE` on `web_v1`, `SELECT` on its views.
- `default_transaction_read_only = on`, so even a bug in the website cannot
  issue a write. Not a grant — a property of every session the role opens.
- `NOCREATEDB NOCREATEROLE NOSUPERUSER NOINHERIT`, plus an explicit `REVOKE ALL`
  on the bot's schema, its tables, its sequences and its functions. Explicitly,
  not by omission: a REVOKE that was never needed costs nothing and outlives
  someone later granting something by hand.

The views are owned by the bot's role and run with `security_invoker` off
(Postgres's default), so `two_web_ro` reads through them without any grant on
the underlying tables. That is what makes "views and nothing else" true rather
than aspirational.

### How we know

`npm run verify:web-role` connects **as** `two_web_ro` and runs 35 checks. It
does not read a permissions table and infer an answer — several ways of asking
Postgres "can this role read that" give an answer that is true in the catalogue
and wrong at the point of use. It tries the queries and reads the refusal.

Run against a clean database on 2026-08-25, all 35 passed:

```
ok    read web_v1.contract_meta … web_v1.funnel_by_source   (9 views, readable)
ok    live_counts returns exactly one row  -  1 row(s)
ok    rank_counts returns all five ranks in ladder order
                                           -  prospect -> member -> soldier -> veteran -> legend
ok    contract_meta reports v1.0           -  v1.0
ok    cannot read public.events            -  refused (42501)
ok    cannot read public.members           -  refused (42501)
      … and invite_snapshots, schema_migrations, the four internal_* tables,
        web_contract_meta, guild_counters, rank_ladder, rank_snapshots,
        member_ranks, scheduled_events — all refused (42501)
ok    cannot write to a contract view      -  refused (42501)
ok    cannot write to the bot's tables     -  refused (25006)
ok    cannot create a table                -  refused (25006)
ok    cannot create a table in the web schema  -  refused (25006)
ok    session is read-only by default      -  default_transaction_read_only = on
ok    can select from the contract views and nothing else
                                           -  exactly 9 relations, all in web_v1

verify-web-role: 35 passed, 0 failed (role two_web_ro, schema web_v1).
```

That last check is the one that earns the phrase "and nothing else". Everything
above it is a list someone wrote down, so it can only catch what that person
thought of. It asks Postgres to enumerate **every relation in the database** and
report which ones this role can select from — so a table added next year, or a
grant to `PUBLIC` that nobody associated with this role, shows up without anyone
having predicted it.

The write probe deliberately targets `upcoming_events`, which is a plain SELECT
over one table and therefore auto-updatable. Probing a view with a join would be
refused for being unwritable whatever the grants said, and a check that passes
because of the shape of a view tells you nothing about who is allowed to write.

It has been checked against a deliberate over-grant: `GRANT SELECT ON
public.events TO two_web_ro` makes it fail two checks and exit non-zero. A
verification nobody has seen fail is not a verification.

**It runs in CI, on every pull request.** The `postgres` job in
`.github/workflows/ci.yml` starts a `postgres:17` service, sets
`TWO_TEST_DATABASE_URL`, and runs the whole suite against it — so this
contract's 23 cases, the backup round trip and the concurrent-writer test now
pass by passing rather than by skipping. The same job then runs the deploy
sequence in §7 end to end, `migrate` → `web:views` → `web:role` →
`verify:web-role`, so a migration that quietly hands `two_web_ro` more access
than it needs fails the PR that introduced it. A documented step nothing
executes is how a runbook rots; this one is executed. Landed by TOG-465.

---

## 8. Status

| Piece | State |
|---|---|
| This document | Published, **`v1.0`** (doc revision `v1.0.2`) |
| `web_v1` schema and its 9 views | **Live.** `sql/web_v1.sql`, applied by `npm run web:views` and at bot startup |
| Tables behind them | **Live.** `migrations/0003_web_contract_tables.sql`, `0005_counter_snapshots.sql` |
| `two_web_ro` role and grants | **Live.** `npm run web:role`, proven by `npm run verify:web-role` — **35/35 re-run against a clean Postgres on 2026-08-30** |
| Tests | `test/e2e.webcontract.test.ts` — 23 cases, Postgres only. **23/23 re-run 2026-08-30**, and run by CI in the `postgres` job (TOG-465) |
| Counter cache + rank snapshot collector | **Code shipped (TOG-73)**, 60s member cache / 10m rank snapshot — but **not yet producing data**: it needs a Discord token the company does not hold. See §6.2. |
| Scheduled events poller | TOG-74, not started |
| Presence intent decision | TOG-75, `done` — see §6.1 |

**What a website build sees today, measured rather than promised.** On
2026-08-30 the full §7 sequence was run against a clean Postgres and every view
queried as `two_web_ro`:

| View | Today |
|---|---|
| `contract_meta` | one row, `1.0` |
| `live_counts` | one row, all four columns null |
| `rank_counts` | five rows, ladder order, counts null |
| `members` / `member_milestones` / `funnel_*` | readable, empty on a fresh database |
| `next_event` / `upcoming_events` | zero rows |

Every one of those is the designed empty state in §3, not a fault.

**Where the SQL lives, and why it is split.** Tables are in `migrations/`, which
is immutable by rule. Views are in `sql/web_v1.sql`, applied with `CREATE OR
REPLACE`, because a contract view gets edited over its life — a `v1.1` adds a
column to an existing view, and that is an edit to that file, not a new
migration. See the note at the top of `sql/web_v1.sql`.

---

## Changelog

| Version | Date | Change |
|---|---|---|
| `v1.0.3` | 2026-09-03 | **Additive value only; no view, column or type changed, runtime contract remains `1.0`.** TOG-464: `funnel_by_source.source` gains one new value, `web:one_click`, stamped on joins the bot itself performed via `guild.add_member` (docs/INTERNAL_ACTIONS.md §7). Rows with this value appear only once that action is switched on; nothing built against `v1.0` needs to move. |
| `v1.0.2` | 2026-08-30 | **Documentation only; no view, column, type or `contract_meta` value changed, so nothing built against `v1.0` needs to move.** Removes status drift that had the document contradicting itself: §6.2 still said the counter collector did not exist while §8 said it had shipped. Both now say the same thing — TOG-73's code is merged (`c12654a`) but produces no data, because it reads Discord and the company holds no token for the TWO server, so `live_counts` and `rank_counts` still read null today. §6.1 records the TOG-75 outcome (**option C, decided, `done`**) instead of presenting a live A/B/C choice, and drops the incorrect claim that it was the CEO's call — this is the fix TOG-468 asks for. §2 `members` now states the raid exclusion the view has actually applied since TOG-73, and the stale "33 of 84 humans" / "until TOG-73 runs" notes are gone. §8 replaces promised numbers with measured ones: the full §7 deploy sequence, `verify:web-role` (35/35) and `test/e2e.webcontract.test.ts` (23/23) were re-run against a clean Postgres on 2026-08-30, and every view was queried as `two_web_ro` to record what a website build actually sees today. |
| `v1.0.1` | 2026-08-25 | **Documentation correction only; runtime contract remains `1.0`.** `human_member_count` excludes the dynamically-derived raid set as well as bots, yielding 54 on the grounded 2026-08-19 snapshot rather than the raw 84 Discord human accounts. TOG-73 applies the same exclusion to rank counts and public member rows and writes nothing when any raid window is ungrounded. No view shape or `contract_meta` value changed. |
| `v1.0` | 2026-08-25 | **Live.** Schema, nine views, the tables behind them and the `two_web_ro` role created and verified against Postgres — 32/32 role checks, 22 tests, whole suite green on both drivers. No shape the Lead asked for moved between `v0.1` and here. New in this version: the freshness ceilings live in the views rather than being a promise about the collector; the zero rule is a schema constraint as well as collector behaviour; `rank_changed` is pre-whitelisted in `member_milestones` so TOG-73 needs no contract change; an in-progress event stays as `next_event`. TWO-\* references renumbered to their TOG equivalents (TOG-73, TOG-74, TOG-75). |
| `v0.1` | 2026-08-19 | First draft. Written against the Web Lead's field list on TOG-43 and `two-design/docs/CONTENT.md` / `COMPONENTS.md`. Not frozen. |
