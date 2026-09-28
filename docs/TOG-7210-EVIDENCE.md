# TOG-7210 — CONTRIBUTOR_ONBOARDING literal trial-run with evidence

**Verdict: PASS with fixes. Every step of `docs/CONTRIBUTOR_ONBOARDING.md` was
followed literally; 10 snags found, all 10 fixed in the doc. Zero unaddressed.**

Trial method: read each instruction as a fresh agent would, then verified the
claim against the repo (code, CI config, sibling docs) or by running the exact
command. Checked 2026-09-27 on branch
`TOG-7175-ship-backlog-community-platform-round-2-floor-refill-30-parallel-cards`.

## Follow-through log (step → result → disposition)

| # | Doc step (literal) | What the trial showed | Disposition |
|---|---|---|---|
| 1 | §1.1 "Grab the current invite" | Discord-side, not verifiable from repo; doc already hedges (announcements post or staff). | OK, left as-is |
| 2 | §1.2 "Accept the rules … bot records it (`gate_cleared`)" | Verified: `gate_cleared` defined `src/core/events.ts:19`, recorded `src/core/handlers.ts:143`, fed from gateway `src/discord/client.ts:338,383`. Backfill nuance (rows with `source='backfill:…'` carry join-time placeholder, `docs/EVENTS.md` §6) is out of newcomer scope. | OK, deliberately left; noted here |
| 3 | §1.3 "pick your games … grants you its role" | Verified (`src/onboarding/catalog.ts` roleId/roleName, `src/onboarding/flow.ts:105` roleIds) but doc never said *where* the picker is. | FIXED: named the game picker + catalog pointer |
| 4 | §1.4 "Say hi … someone will answer you" | Promise of a reply. Scorecard measures first human reply but guarantees nothing (`docs/ONBOARDING_ROTA.md`; rota needs an explicitly bound primary). Also "first message" is unscoped: metric needs first *eligible welcome/general* message + a later eligible reply from someone else, counted from rules acceptance when present (`docs/COMMUNITY_SCORECARD.md`). | FIXED: "someone usually answers — whether one does is itself a pilot number"; scoped to welcome/general + counted-from note |
| 5 | §1.5 "Come back once … ten minutes of voice counts the same as a message" | Two misleads: no "regular" metric exists; actual bar is weekly-active = one eligible message **or** ≥600 unioned voice seconds (`src/analytics/communityScorecard.ts:431`, scorecard doc). | FIXED: "showing up again is a habit" + "one message or ten minutes (600 unioned voice seconds)" |
| 6 | §1 privacy line "never … anything else" | False: invite code + inviter user ID stored (`docs/PRIVACY.md`); automod inspects in memory, stores nothing. | FIXED: invite attribution added, automod clarified |
| 7 | §2 "Mark attendance the way the event post says (host check-in)" | No such event-post convention exists in repo. Real mechanism: `/attendance event-occurrence:<id> member:<member>` slash command, needs `Manage Events`, idempotent (`src/analytics/communityAttendance.ts`); RSVP is explicitly not attendance (`docs/COMMUNITY_SCORECARD.md`, `docs/EVENT_RITUAL_PILOT_WEEK1_KIT.md:43`). | FIXED: exact command + permission + RSVP≠attendance |
| 8 | §2 "join-burst detector that alerts staff" | Verified real (`src/analytics/raidWatch.ts`, wired `src/index.ts:449`), but read as possibly-manual process. | FIXED: "alerts staff automatically (`src/analytics/raidWatch.ts`)" |
| 9 | §3 "Appeal … by DMing a moderator" vs "no mass-DMs" | Newcomer collision: DM-a-mod appeal next to "one unsolicited sales DM is a ban". Also bot never DMs (CEO sign-off required, `CONTRIBUTING.md`). | FIXED: human-appeal path + bot-never-DMs note |
| 10 | §3 "warnings, timeouts, kicks and bans … logged with a reason" | Verified (`docs/MODERATION.md`: ban/tempban/kick/timeout/warn; non-empty reason + idempotency key; audit rows). Wording undersold timeouts as persistent layer and missed temp/perm + idempotency. | FIXED wording |
| 11 | §4 docs-PR block: `gh auth setup-git` comment "the repos are private" | True but the failure it prevents (`could not read Username`, `README.md`) is never named; newcomer cannot tell success from skip. | FIXED: "without it git cannot reach the private repo" |
| 12 | §4 "needs a running Postgres 17+" | No pointer to how to get one; `CONTRIBUTING.md`/`README.md` give `createdb two_bot_test`. | FIXED: added `createdb` pointer |
| 13 | §4 `npm test` "must pass before you open the PR" | Verified fail-fast: `npm test` with no DB errors from `test/helpers/testDb.ts` with `TWO_TEST_DATABASE_URL is required` (ran it — exit non-zero, no silent green). Doc never said what failure looks like. | FIXED: named the fail-fast behavior (verified by running it) |
| 14 | §4 "Open the pull request against `main`" | The normal GitHub flow (fork + PR) is **refused on purpose**: `scripts/ci/refuse-fork-pr.sh` fails fork PRs on self-hosted runners (TOG-3103); fix is maintainer pushes branch here. A forking newcomer hits a red check with no doc warning. | FIXED: PR from inside the repo + maintainer-push note |
| 15 | §4 CI job description | Incomplete vs `.github/workflows/ci.yml` + `scripts/ci/run-check-job.sh` (script-target/credential guards, funnel-attribution eval; postgres job = `run-postgres-job.sh`: migrate, web:views, web:role, verify). | FIXED to match actual wrappers |
| 16 | §4 "A code owner reviews it" | Implies enforcement; `.github/CODEOWNERS` header says advisory on this plan (free, private repo — no branch protection; auto-request only). `CONTRIBUTING.md` agrees. | FIXED: auto-requested but not server-enforced |
| 17 | §4 "a pushed secret gets rotated, not just deleted" | True, understated: secret-scan walks full history, so removing in a later commit does not help (`.github/workflows/secret-scan.yml:78,104-106`). | FIXED: history-walk note |
| 18 | §4 "your name is on the pilot's contributor list" | **No such list exists in repo** (searched `*.md`/`*.ts`: only `community/contributor-spotlight-template.md` + examples — irregular, max 1/week, consent-first, public merged-PR history only). A newcomer would look for a list that isn't there. | FIXED: replaced with the actual spotlight practice + template link |

## Verified-but-OK (checked, no change)

- `gh auth setup-git` exists (`gh auth --help` lists it); `--include=dev` rationale matches `CONTRIBUTING.md` + `ci.yml:114-116`.
- Bot-noise 20% rule real (`docs/COMMUNITY_SCORECARD.md`: alert true at 20%); doc's "stay under 20%" matches.
- `DEPLOY.md` / `RUNBOOK.md` / `RAID-RESPONSE.md` / `MODERATION.md` links all resolve.
- Branch examples (`docs/…`, `fix/…`, `feat/…`) are examples, not exhaustive (`CONTRIBUTING.md` lists six types) — left as examples.
- Channel-name fallback paragraph already present; extended to name `#general`/`#events` explicitly.
- No `pr-lint` workflow exists; doc never claimed one — nothing to fix.

## Reproduce (reviewer, no Postgres, no token)

```bash
git diff main -- docs/CONTRIBUTOR_ONBOARDING.md   # the fix (this card)
node --test test/*.test.ts 2>&1 | head -5        # without TWO_TEST_DATABASE_URL: fails fast, "TWO_TEST_DATABASE_URL is required"
```

Docs-only change: no test/typecheck surface affected (`npm run typecheck` covers `src/`, not `docs/`).
