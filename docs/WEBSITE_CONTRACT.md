# The website data contract

**Version: `v0.1` — draft, open for the Web Lead's sign-off. Not frozen yet.**
It freezes at `v1.0` when the views are created in Postgres, which cannot
happen until TWO-18 (SQLite → Postgres) is finished.

The website reads the bot's Postgres database directly. No sync job, no API in
between, no second copy of the numbers that can drift from the first.

The thing that makes that safe is this contract: **the website reads views in
the `web_v1` schema and nothing else.** It never reads `events`, `members`, or
any other table the bot owns. That means the bot can rename a column, add an
index, or restructure a table tomorrow without breaking a single page, as long
as the views still return what is written here.

If a field you need is not in here, it does not exist yet. Ask for it and it
gets added in a version bump — do not reach past the views into the tables,
because the moment that happens this whole arrangement stops working.

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
| `guild_id` | text | The TWO server's Discord snowflake. |

### `web_v1.live_counts` — always exactly one row

The landing page counter. One row, always present, even when every value in it
is null.

| Column | Type | Notes |
|---|---|---|
| `human_member_count` | int, **nullable** | Members in the server, **bots excluded**. 84 at the last audit, not 107. |
| `online_count` | int, **nullable** | Humans currently online, bots excluded. **Null in v1** — see §6.1. |
| `counts_updated_at` | text, nullable | When `human_member_count` was last read from Discord. Null if never. |
| `online_updated_at` | text, nullable | When `online_count` was last read. Separate from the above because the two go stale at very different rates. |

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

Rows are always returned for all five ranks, in `rank_order`. A rank never
disappears from the result set just because nobody holds it — that would make
the ladder look shorter than it is.

**Two columns because the ranks stack.** In the TWO server a Legend still holds
Soldier, Member and Prospect. From the 2026-08-19 audit, humans only:

| Rank | `holders_count` | `member_count` (highest rank) |
|---|---|---|
| Prospect | 51 | 10 |
| Member | 41 | 24 |
| Soldier | 17 | 10 |
| Veteran | 7 | 1 |
| Legend | 6 | 6 |

`holders_count` sums to 122 against 84 human members — publish that as a ladder
and the columns visibly do not add up. `member_count` sums to 51, which is the
number of humans who have any rank at all. The other 33 are the 31 stuck at the
rules screen (none of whom hold a rank role) plus 2 with no roles.

The `member_count` column above is derived from the cumulative audit figures by
subtraction, which is right only if the ranks are strictly nested. That is what
the numbers look like, but the rank collector will compute it from actual role
membership and confirm it. Treat these five numbers as accurate to ±1 until it
runs.

### `web_v1.members` — one row per member

For member profiles. **Deliberately thin**, see §4 for what is not here.

| Column | Type | Notes |
|---|---|---|
| `member_id` | text | Discord snowflake. The only identifier we hold. |
| `joined_at` | text, nullable | First join. Null for members who predate our data. |
| `tenure_days` | int, nullable | Whole days since `joined_at`. Precomputed so the website is not doing date maths. |
| `rank_key` | text, nullable | Highest rank held, or null if they hold no rank role (33 of 84 humans today). |
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

The whitelist is the point. Adding a milestone type is a contract version bump,
not a silent widening — otherwise "first message at 14:02" ends up on a public
page by accident.

### `web_v1.next_event` — zero or one row

| Column | Type | Notes |
|---|---|---|
| `event_id` | text | Discord scheduled event ID. |
| `name` | text | |
| `starts_at` | text | |
| `channel_id` | text, nullable | |
| `description` | text, nullable | |

**Zero rows means there is no next event.** That is the correct, expected
answer today — the server has none scheduled. The view will never invent a
placeholder to avoid an empty result, so the designed empty state is reachable
in production and not just in a mockup.

### `web_v1.upcoming_events` — zero or more rows

Same columns as `next_event`, ordered by `starts_at`, limited to the next 90
days. `next_event` is literally the first row of this.

### `web_v1.funnel_daily` and `web_v1.funnel_by_source` — **staff pages only**

The join numbers behind the dashboard. Aggregate, guild-level, no member IDs.

`funnel_daily`: `day`, `joins`, `leaves`, `first_messages`, `first_voice_sessions`, `net_change`.
`funnel_by_source`: `day`, `source`, `joins`.

`source` values (`invite:aB3xY9`, `ambiguous:a+b`, `vanity`, `unknown`) are
documented in `docs/EVENTS.md`. Show `unknown` as itself; never fold it into a
real invite code.

⚠️ **Audience: authenticated staff pages.** These are exposed so the website
can render the growth dashboard, not so the public site can render momentum.
`two-design/docs/CONTENT.md` rules out growth framing on public pages, and
right now these numbers are 0 joins in 30 days. Putting them on the landing
page would be accurate and self-defeating at the same time.

---

## 3. The zero rule

**Hard guarantee: a count column is null when we do not know it. It is never 0
as a stand-in.**

This is enforced in the bot, not just in the view:

- The counter job writes a snapshot **only after a successful Discord read**.
- A failed read changes nothing. The previous value and its timestamp stay
  exactly as they were. Nothing writes a 0.
- If no snapshot has ever succeeded, the column is null and the timestamp is
  null.

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

The full never-show list is the Web Lead's, in `two-design/docs/CONTENT.md`.
This section mirrors it at the data layer so the rule is enforced by what the
website *can* read, not only by what it chooses to render. Cheapest place to
enforce a rule is the place where breaking it is impossible.

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

### 6.1 `online_count` is null in v1, and I need a decision to change that

The bot does not request the `GUILD_PRESENCES` gateway intent
(`src/discord/client.ts` keeps the intent list minimal on purpose). Without it
we cannot see who is online, so we cannot count humans online.

The options, honestly stated:

| Option | Result |
|---|---|
| **A. Enable the presence intent** | A real humans-only online count. It is a privileged intent — a toggle in the Discord developer portal — and it means the bot receives presence updates for every member. We would store only the aggregate count, never per-member presence. This is a permissions change, so it is the CEO's call, not mine. |
| **B. Use Discord's `approximate_presence_count`** | One REST call, no intent needed — but it counts the 23 bots along with the humans. At the audit it read **27**, and we have no way to say how many of those were humans. It would publish an inflated number on a page whose job is to be trustworthy. **Recommend against.** |
| **C. Ship without it** | `online_count` stays null, the counter shows members only, and the degraded path gets exercised from day one. |

**v1 ships as C** so nothing is blocked on a decision. Moving to A is a
one-line intent change plus a counter job update once approved. Tracked as
TWO-52, with the CEO as the unblock owner.

### 6.2 Rank counts and events need collectors that do not exist yet

`rank_counts` and `next_event` are specified above but there is nothing filling
them today — the bot has never stored role membership or scheduled events.
Both are small jobs: TWO-50 (counters and ranks) and TWO-51 (events). I am
flagging it so nobody plans a launch date assuming the data is already sitting
there.

### 6.3 Profiles have no display names

Covered in §2 under `web_v1.members`. Either the website resolves names from
Discord at render time, or the CEO signs off on us storing them. I have not
assumed either.

---

## 7. The website's database role

One role, `two_web_ro`, that can read the views and genuinely nothing else.

```sql
CREATE ROLE two_web_ro LOGIN PASSWORD :'web_password';

-- Read-only at the transaction level, so even a bug cannot write.
ALTER ROLE two_web_ro SET default_transaction_read_only = on;
ALTER ROLE two_web_ro CONNECTION LIMIT 20;

-- No access to the bot's own tables. Explicitly, not by omission.
REVOKE ALL ON SCHEMA public FROM two_web_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM two_web_ro;

-- Exactly the views, exactly SELECT.
GRANT USAGE ON SCHEMA web_v1 TO two_web_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA web_v1 TO two_web_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA web_v1 GRANT SELECT ON TABLES TO two_web_ro;
```

The views are owned by the bot's role and created with
`security_invoker = off`, so `two_web_ro` reads through them without needing
any grant on the underlying tables. That is what makes "views and nothing else"
true rather than aspirational.

The password goes to the Web Lead through the secrets process in
`docs/SECRETS.md`. Never in an issue comment, never in a repo.

**Verification, once the role exists** — these must all fail:

```sql
SET ROLE two_web_ro;
SELECT * FROM events LIMIT 1;                      -- permission denied
SELECT * FROM members LIMIT 1;                     -- permission denied
INSERT INTO web_v1.live_counts VALUES (...);       -- read-only transaction
CREATE TABLE probe (id int);                       -- permission denied
```

and this must succeed:

```sql
SELECT * FROM web_v1.live_counts;
```

That check ships as a script (`scripts/verify-web-role.ts`) and runs in CI, so
a future migration cannot quietly hand the website more access than it needs.

---

## 8. Status

| Piece | State |
|---|---|
| This document | Published, `v0.1`, awaiting Web Lead sign-off |
| Views created in Postgres | **Blocked on TWO-18** (SQLite → Postgres migration) |
| `two_web_ro` role and grants | Blocked on the same |
| Counter cache + rank snapshot collector | TWO-50, blocked on the same |
| Scheduled events poller | TWO-51, blocked on the same |
| Presence intent decision | TWO-52, with the CEO |

---

## Changelog

| Version | Date | Change |
|---|---|---|
| `v0.1` | 2026-08-19 | First draft. Written against the Web Lead's field list on TWO-23 and `two-design/docs/CONTENT.md` / `COMPONENTS.md`. Not frozen. |
