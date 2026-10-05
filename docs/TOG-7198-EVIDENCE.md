# TOG-7198 QA evidence — moderation kill-switch flip cycle

Deliverable: behavior-test PR #230 (`test/moderation-killswitch-flip` → `main`), head `74b35ca6`.
Review: [TOG-7502](/TOG/issues/TOG-7502) (Code Reviewer; approving reviewer merges per review economy).

Acceptance: all verbs refuse at the endpoint allowlist gate while disabled;
all execute on a fresh enabled start. Scope is endpoint/config coverage only —
see limits below.

## Design note

The kill switch is boot-applied: `TWO_MODERATION` is `env_only`
(`src/core/settingsCatalog.ts:143`) and `loadModerationConfig()` runs once at
boot (`src/index.ts:301`). There is no runtime toggle, so "flip the switch
mid-flow" is an environment edit plus a restart — which the test approximates
in-process: each phase boots the live signed HTTP endpoint via
`startInternalActions` directly (`test/e2e.moderation-killswitch-flip.test.ts:105-119`).

Limit: this is endpoint/config allowlist coverage, not a full operator
restart. The fixture never executes the mandatory boot shutdown preflight
(`await enforceModerationShutdownPreflight(...)` at `src/index.ts:331`). The
enabled phase runs a 60-second tempban, which stages a pending unban row, so a
real disabled boot over that state with no override would refuse before
serving HTTP (`src/moderation/shutdownPreflight.ts:197-213,272-279`); only
`TWO_MODERATION_DISABLE_OVERRIDE=1` proceeds and logs the stranded set
instead. Outstanding releases must be resolved (or the separately governed
override used) before a real disabled boot.

## Results (2026-09-27, Postgres 17.11)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| flip suite `test/e2e.moderation-killswitch-flip.test.ts` | 3/3 pass |
| all nine verbs execute mid-flow (8 Discord calls + warn row) | pass |
| all nine refuse at the allowlist gate after disable restart (`action_not_allowed`, non-retryable, zero Discord calls, no second warn row) | pass |
| all nine execute on a fresh enabled start after re-enable (`test/e2e.moderation-killswitch-flip.test.ts:215-229`) | pass |
| preserved-state on/off/on recovery (pending unbans, idempotency state retained across the flip) | not covered — see gap below |
| verb-count pin (fails closed on a tenth verb) | pass |
| neighbors `e2e.moderation-shutdown` + `e2e.moderation-actions` | 15/15 pass |
| mutation 1: drop `TWO_MODERATION` co-gate in `src/internal/config.ts` | refuse test red (as designed) |
| mutation 2: corrupt `kick` outcome in `src/moderation/service.ts` | both execute phases red (as designed) |

Coverage gap (stated, not a bug filed): `beforeEach` resets the database
(`test/e2e.moderation-killswitch-flip.test.ts:56`), so the on/off test ending
at line 213 and the separate re-enable test at lines 215-229 each start from a
fresh database. This is a fresh enabled-start smoke check — an uninterrupted
on/off/on cycle retaining pending unbans and idempotency state is not covered.

No bugs filed on the covered scope: every verb executed, refused at the gate,
and executed again on a fresh enabled start; the two anomalies found during
development (`warn` being a store write, not a Discord call) were fixture
errors, corrected by proving `warn` via its stored row.

## Verdict

`QA 74b35ca6: NEEDS WORK` is not warranted on the evidence — the suite passes —
but the card stays open: per the trust standard a code card is `done` only when
its PR is merged, and the author never merges their own PR. Handoff to the
Code Reviewer via [TOG-7502](/TOG/issues/TOG-7502); this card is blocked on that verdict.
