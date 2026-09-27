# TOG-7198 QA evidence — moderation kill-switch flip cycle

Deliverable: behavior-test PR #230 (`test/moderation-killswitch-flip` → `main`), head `74b35ca6`.
Review: [TOG-7502](/TOG/issues/TOG-7502) (Code Reviewer; approving reviewer merges per review economy).

Acceptance: all verbs refuse while disabled, all recover after.

## Design note

The kill switch is boot-applied: `TWO_MODERATION` is `env_only`
(`src/core/settingsCatalog.ts:138`) and `loadModerationConfig()` runs once at
boot (`src/index.ts:301`). There is no runtime toggle, so "flip the switch
mid-flow" is an environment edit plus a restart — which is exactly what the
test performs in-process through the live signed HTTP endpoint.

## Results (2026-09-27, Postgres 17.11)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| flip suite `test/e2e.moderation-killswitch-flip.test.ts` | 3/3 pass |
| all nine verbs execute mid-flow (8 Discord calls + warn row) | pass |
| all nine refuse at the allowlist gate after disable restart (`action_not_allowed`, non-retryable, zero Discord calls, no second warn row) | pass |
| all nine recover on re-enable | pass |
| verb-count pin (fails closed on a tenth verb) | pass |
| neighbors `e2e.moderation-shutdown` + `e2e.moderation-actions` | 15/15 pass |
| mutation 1: drop `TWO_MODERATION` co-gate in `src/internal/config.ts` | refuse test red (as designed) |
| mutation 2: corrupt `kick` outcome in `src/moderation/service.ts` | both execute phases red (as designed) |

No bugs filed: every verb refused and recovered; the two anomalies found
during development (`warn` being a store write, not a Discord call) were
fixture errors, corrected by proving `warn` via its stored row.

## Verdict

`QA 74b35ca6: NEEDS WORK` is not warranted on the evidence — the suite passes —
but the card stays open: per the trust standard a code card is `done` only when
its PR is merged, and the author never merges their own PR. Handoff to the
Code Reviewer via [TOG-7502](/TOG/issues/TOG-7502); this card is blocked on that verdict.
