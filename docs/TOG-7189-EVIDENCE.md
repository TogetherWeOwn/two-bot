# TOG-7189 — reengagement dry-run on a seeded DB, with evidence log

**Verdict: PASS (offline harness). `buildList` returns exactly the expected
quiet list, writes zero rows, and makes zero network calls.**

"Dry-run" here is literal: `buildList` with no `markListed` afterwards, which
is exactly what `npm run reengage` does without `--mark`. The job reads the
funnel tables and returns IDs; it writes nothing and calls nobody.

## Seed (8 members, all outside or inside known windows on purpose)

| id | shape | expected |
|---|---|---|
| `m-active` | active 2d ago | off the list, `stillActive` |
| `m-quiet` | quiet 30d, text history | `slipping`, `daysQuiet: 30` |
| `m-dormant` | quiet 90d, voice-only history | `dormant`, `daysQuiet: 90`, `engagedVia: voice` |
| `m-never` | joined 30d ago, never posted/voiced | `never_engaged`, `daysQuiet: null` |
| `m-fresh` | joined 1d ago | off the list, `inGracePeriod` |
| `m-bot` | quiet 200d, `is_bot` | off the list |
| `m-left` | quiet 200d, `left_at` set | off the list |
| `m-raid` | joined `2025-07-06T20:40` (raid window) | off the list, `raidAccounts: 1` |

## Reproduce (reviewer dry-run, no Postgres, no token)

```bash
node --test test/unit.reengagement-dryrun.test.ts
```

Expected tail (exit 0): the `REENGAGEMENT_DRYRUN_EVIDENCE` line names the
exact quiet list (`m-never:never_engaged`, `m-quiet:slipping`,
`m-dormant:dormant`), `memberRowsAfter` equals `memberRowsBefore` (8),
`eventsAfter` is 0, and `fetchCalls` is 0.

## What was run

| # | Check | Result |
|---|---|---|
| 1 | `node --test test/unit.reengagement-dryrun.test.ts` — static send-surface pin + seeded dry-run | PASS — 2/2 |
| 2 | `node --test test/unit.inactivity-nomessage.test.ts` — sibling no-send suite, no regressions | PASS — 5/5 |
| 3 | `npm run typecheck` | PASS |
| 4 | Pin regexes mutation-checked synthetically (a `rest.post` call / a `post` verb on `DiscordRest` both fail the pin) | PASS |
| 5 | `test/unit.reengagement.test.ts` — needs `TWO_TEST_DATABASE_URL` (isolated Postgres); unavailable in this sandbox | NOT RUN here — left green for CI |

## Notes for the reviewer

- `scripts/reengagement.ts` still resolves display names via `rest.get` at
  print time; the pin asserts that is the *only* `rest.*` call shape and that
  `DiscordRest` exposes no mutating verb, so a future send path fails the
  test before any fixture runs.
- The evidence line prints on green runs only; a red run fails above it, so
  the log can never certify a run that did not pass.

## Files

- `test/unit.reengagement-dryrun.test.ts` — the proof (static pin + seeded dry-run + evidence log).

Refs: TOG-7189
