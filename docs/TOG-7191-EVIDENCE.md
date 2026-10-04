# TOG-7191 — community scorecard snapshot job dry-run with evidence

**Verdict: PASS (offline harness). Snapshot and scorecard both equal the
hand-computed fixture exactly; two Discord reads, zero network calls.**

"Dry-run" here is literal: both jobs run end to end against a seeded database
and a stubbed Discord read path, and the test asserts the exact numbers. A
global fetch trap fails the run on any real network call.

## Seed (9-member roster + 5-message week, all hand-computed)

| id | shape | expected |
|---|---|---|
| `alice` | prospect only | highest `prospect` |
| `bob` | prospect+member (nested) | highest `member` |
| `carol` | all five (nested) | highest `legend` |
| `dave` | no roles | `rankKey: null`, still a counted human |
| `erin` | prospect+member+soldier (nested) | highest `soldier` |
| `bot-1` | bot with all roles | excluded from humans and ranks |
| `raid-0/1/2` | never-active, joined inside the three real raid windows | excluded, in `member_exclusions` |
| 5 week messages | one `eligible_human` actor each, human channel | `rawFactCount` 5, 5 active humans, HOLD |

Expected snapshot: 5 humans, 4 ranked (prospect/member/soldier/legend 1-1-1-0-1
highest, holders 4-3-2-1-1), 3 raid exclusions.
Expected scorecard: coverage complete, evidence sufficient, botNoise 0/5,
no joins, intervention HOLD, revision 1.

## Reproduce (reviewer dry-run, no Postgres, no token)

```bash
node --test test/unit.communityscorecard-dryrun.test.ts
```

Expected tail (exit 0): the `SNAPSHOT_DRYRUN_EVIDENCE` line
(`humanMemberCount` 5, `rankedMemberCount` 4, `raidAccountsExcluded` 3,
`discordReads` 2, `fetchCalls` 0) and the `SCORECARD_DRYRUN_EVIDENCE` line
(`rawFactCount` 5, `weeklyActiveHumans` 5, HOLD, `fetchCalls` 0).

## What was run

| # | Check | Result |
|---|---|---|
| 1 | `node --test test/unit.communityscorecard-dryrun.test.ts` — static send-surface pin + snapshot dry-run + scorecard dry-run | PASS — 3/3 |
| 2 | `npm run typecheck` | PASS |
| 3 | Postgres-backed siblings (`unit.communitysnapshots`, `unit.communityscorecard`, `unit.communityscorecardjob`) — need `TWO_TEST_DATABASE_URL`; unavailable in this sandbox | NOT RUN here — left green for CI |

## Gotchas for the reviewer

- The exclusion order is raid-window order (2025-07-06, 2025-09-12,
  2025-12-15), not roster order: `['raid-0', 'raid-2', 'raid-1']`. The test
  failed on this once during development, which is the pin working.
- `scripts/community-scorecard.ts` holds no Discord client; the static pin
  checks client surface, not the `DISCORD_GUILD_ID` env name.
- The evidence lines print on green runs only; a red run fails above them, so
  the log can never certify a run that did not pass.

## Files

- `test/fixtures/community-scorecard-dryrun.ts` — the hand-computed numbers.
- `test/unit.communityscorecard-dryrun.test.ts` — the proof (static pin + two dry-runs + evidence logs).
- `src/jobs/communitySnapshots.ts`, `src/jobs/communityScorecard.ts`, `scripts/community-scorecard.ts` — in scope, unchanged.

Refs: TOG-7191
