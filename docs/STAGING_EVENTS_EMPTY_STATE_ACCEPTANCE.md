# Staging acceptance: two-web `/events` empty-state (E1/E2/E3 + toggle)

Owner-run click-path for [TOG-5318](/TOG/issues/TOG-5318) (spec: [TOG-5250](/TOG/issues/TOG-5250)).
QA card: [TOG-5333](/TOG/issues/TOG-5333). Engineering fix and this script are
separate deliverables — this file is the script only.

- Time: ~20 minutes. Browser only. No terminal, no tokens, no database.
- Scope: staging only. Each step is independently PASS / FAIL / BLOCKED.

## Safety (read first)

1. **Staging only.** Use the staging `/events` URL from the [TOG-5318](/TOG/issues/TOG-5318)
   deployment evidence. Never `https://togetherweown.com/events` (production).
2. Clicks only. This script makes no posts, no RSVPs, no Discord writes.
3. Never simulate E3 by stopping staging services or touching the database.
   E3 uses the simulated-failure trigger documented on [TOG-5318](/TOG/issues/TOG-5318) — if
   no trigger exists yet, mark S4 BLOCKED and name the Web Engineer.

## Setup

| # | Do | Pass when |
|---|---|---|
| S0 | Open the staging `/events` URL. Confirm the address bar is the staging host, not `togetherweown.com`. | H1 `Events` with subheading `Game nights, tournaments and whatever else the community puts on.` A List/Calendar toggle is visible. |

State setup per step: use the seed/trigger the [TOG-5318](/TOG/issues/TOG-5318) deploy notes
provide (reads are stubbed until [TOG-5168](/TOG/issues/TOG-5168) lands real data). Fallbacks
are listed per step; anything unreachable is BLOCKED, never PASS-by-assumption.

## Steps

### S1 — Populated control (proves empty states mean something)

Reach: staging seed with at least one upcoming event (e.g. the Sunday Squad fixture).

- PASS when: at least one event card renders; **none** of the three empty
  blocks below is present (page-source search for `events-empty-never`,
  `events-empty-gap`, `events-empty-error` finds no match); toggle visible.

### S2 — E1: never had events (`events-empty-never`)

Reach: seed with zero upcoming AND zero past events (fallback: the natural
empty staging read).

- PASS when **all** hold:
  - H2 reads exactly `Nothing on the calendar yet.`
  - Body reads exactly `Game nights get posted here first. Join the Discord and you'll see them before they land on this page.`
  - Primary CTA `Join the Discord` links to `/discord`.
  - Page source contains `events-empty-never` and does **not** contain
    `events-empty-gap` or `events-empty-error`.
  - No `Past events` heading. No `Retry` button.

### S3 — E2: gap, history but no future (`events-empty-gap`)

Reach: seed with zero upcoming BUT at least one past event.

- PASS when **all** hold:
  - H2 reads exactly `No upcoming events — check back soon.`
  - A secondary line reads `Last time: {most-recent past event name + date}.`
  - A `Past events` heading lists past events, name + date only, newest first, at most 5.
  - A Discord join CTA is present but secondary (not the page's primary button).
  - Page source contains `events-empty-gap` and does **not** contain
    `events-empty-never` or `events-empty-error`. No `Retry` button.

### S4 — E3: load failure (`events-empty-error`), never E1

Reach: the simulated read-failure trigger from [TOG-5318](/TOG/issues/TOG-5318). No trigger, no
improvisation — mark BLOCKED.

- PASS when **all** hold:
  - H2 reads exactly `We couldn't load the calendar.`
  - Body reads exactly `The Discord always has the latest — come ask there.`
  - A `Retry` button is present: clicking it visibly re-fires the read
    (loading state, then E3 again while the failure stands, or content once cleared).
  - A `Join the Discord` link is present.
  - E1 copy (`Nothing on the calendar yet.`) is **absent** — a broken read must
    never pose as "nothing scheduled".
  - Page source contains `events-empty-error` and does **not** contain
    `events-empty-never`.

### S5 — Toggle persists across E1–E3 and across reload

Repeat in **each** of the states reached above (S2, S3, S4):

1. Click the toggle to `Calendar`. Reload the page.
2. Click the toggle back to `List`. Reload the page.

- PASS when **all** hold per state: toggle stays visible; the selected view
  survives each reload; after reload the page still shows the same empty state
  (only the List/Calendar chrome changes, never the state copy).

### S6 — CTA targets

- PASS when: every `Join the Discord` CTA in S2–S4 points at `/discord`;
  `Retry` in S4 responds to clicks (never a dead button).

## Record (reviewer-checkable)

| Step | Expected | Observed (fill in) | Verdict |
|---|---|---|---|
| S0 staging open | H1 + subheading + toggle, staging host | | PASS / FAIL |
| S1 populated | event card(s), no empty testid | | PASS / FAIL |
| S2 E1 copy + `events-empty-never` | exact copy, CTA → `/discord`, no gap/error | | PASS / FAIL |
| S3 E2 copy + `events-empty-gap` | exact copy, `Last time:`, `Past events` ≤ 5 newest-first, CTA secondary | | PASS / FAIL |
| S4 E3 copy + `events-empty-error` | exact copy, working `Retry`, E1 absent | | PASS / FAIL / BLOCKED |
| S5 toggle persist × 3 states + reload | visible, selection survives reload, state copy unchanged | | PASS / FAIL |
| S6 CTA targets | all CTAs → `/discord`, `Retry` live | | PASS / FAIL |

Verdict rule: every row PASS → staging PASS for the slice. Any FAIL → NEEDS WORK
citing the step. BLOCKED only with the trigger owner named (Web Engineer,
[TOG-5318](/TOG/issues/TOG-5318)).

Out of scope here: the 30-day Discord-join-taps metric/kill rule on
[TOG-5318](/TOG/issues/TOG-5318) — post-deploy measurement, not a staging click.
