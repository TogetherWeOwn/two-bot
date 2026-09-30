# Membership chronology: tested author-fix checkpoint

Author task: [TOG-10212](/TOG/issues/TOG-10212). Existing independent review: [TOG-10284](/TOG/issues/TOG-10284). Existing PR: https://github.com/TogetherWeOwn/two-bot/pull/387.

## Publication state

At reconciliation, PR #387 was open and unmerged at `c81e6c87562529aab9a776c24fc65cd13c3eea28`. Its latest review was CHANGES, not approval. The preserved `/tmp/pr387-fix` tree contained two unpublished regression tests; neither fix had been pushed. This checkpoint preserves the tested candidate, not a merged deliverable or a new review verdict.

`TOG-10212-review-fixes.patch` applies to exact head `c81e6c87` and contains all six candidate files, including the new REST observation tests. SHA-256: `972a541145c262efb4db105b0bfe4d4a8277d92ad918f27bd0e925f0227d2f61`. The local execution branch was not switched or rewritten.

## Candidate fixes

- `src/store/eventStore.ts:130`: after five failed optimistic metadata compare-and-swaps, take a portable no-op event-row UPDATE lock, then re-read and advance the maximum. The final guarded update must succeed or throw; exhausted retries cannot acknowledge lost evidence. Original occurrence, attribution, metadata, and event identity are retained. No PostgreSQL-only casts or locking syntax is added to the offline SQLite path.
- `src/discord/rest.ts:54`: observed GETs stamp request dispatch after pacing. Successful retries carry their own request bound. Header arrival and JSON-body completion are not presence instants. Existing ordinary GET data/null behavior is retained.
- `scripts/capture.ts:189`: presence evidence uses the later of the page's request-start bound and the returned actual `joined_at`. This conservative bound retains departures while a response streams; the reported actual join still proves a genuinely newer spell if the member rejoined during the request. History remains occurrence-ordered.
- Tests reproduce five real PostgreSQL CAS collisions, a gateway departure while one loopback response streams, and retained during-capture rejoin/between-page departure behavior. Additional hermetic REST tests distinguish request, header, and body time; cover retry evidence; and preserve failed-page/null and ordinary GET contracts.

## Verification on the candidate tree

All database tests used only `postgres://agent_test@agent-testdb:5432/two_bot_test_tog10212`, with private per-file schemas. HTTP used loopback and synthetic fixtures only; no live Discord, staging, production, credential substitution, or host action.

- `TWO_TEST_DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_bot_test_tog10212 node --test test/unit.membership-chronology.test.ts test/unit.membership-replay.test.ts test/unit.membership-clock.test.ts test/unit.membership-rest-observation.test.ts test/e2e.capture.test.ts test/e2e.funnel-flow.test.ts test/e2e.funnel-accuracy.test.ts`: **29 pass, 0 fail, 0 skip**.
- `node --test test/unit.capture.test.ts test/unit.onboarding-exploratory.test.ts test/unit.membership-rest-observation.test.ts` with the same card-scoped test URL: **31 pass, 0 fail, 0 skip**. Onboarding exploratory tests remain hermetic, including their SQLite probes.
- `npm --prefix /tmp/pr387-fix run typecheck`: final **exit 0**. Initial new-test TypeScript failures (`Response.json` readonly/property shape) were corrected before the final pass.
- `git -C /tmp/pr387-fix diff --check`: **exit 0**.
- Negative controls: an exact `c81e6c87` archive with only the two new regression tests failed **2/2**, for the expected defects: departure cleared to NULL during streaming; newest `.000050Z` observation lost and `.000005Z` retained after five collisions. The candidate passes both.
- Current main `96777468472f23a02a1e97a43ffab3912fe5df2a`: CI run `36763523187` **success**. Deploy run `36765295550` fails at the existing missing-target provisioning gate; [TOG-8272](/TOG/issues/TOG-8272) already owns that provisioning. No deploy rerun or credential action taken.
- Full suite and new-head GitHub CI were **not run**; no new PR head exists yet.

## Published continuation — 2026-09-30

The next reconciliation established that current `main` has neither the shared branch's pending-join retention machinery nor its observed-roster helper. Those sibling features are unmerged, so importing them into this maintenance PR would unnecessarily expand its scope. Shared pending-only retries will still need to preserve original evidence if those separate features are later integrated; that is not required to publish this six-file correction.

Published the tested candidate to the SAME PR #387 by fast-forwarding its existing remote branch from `c81e6c87562529aab9a776c24fc65cd13c3eea28` to `ddb8218f48978b4ac3bcc82c0110aaab813b00a1`. The remote commit changes exactly the six candidate source/test files, whose SHA-256 hashes were verified against the preserved candidate. GitHub's PR head briefly lagged the successful ref-update receipt; read-only reconciliation confirmed both remote ref and PR head. The publication was not repeated. The shared execution branch was neither switched nor repointed, and sibling source files were not touched.

Fresh combined proof: the nine focused suites listed above ran together with **57 passed, 0 failed, 0 skipped**, on the same isolated card-scoped database. Typecheck and diff-check both exited 0. This is one non-overlapping test count, unlike summing the earlier overlapping invocations.

At publication, exact-head PR lint was green, CI `36776484882` and secret scan `36776484861` were running. No new approval or merge is claimed. Full local suite was not run.

## Immediate author continuation

Check required CI against unchanged head `ddb8218f48978b4ac3bcc82c0110aaab813b00a1` through the persisted issue-monitor path. If red, inspect and fix the concrete failure on this SAME PR. If all required checks are green, reopen the SAME [TOG-10284](/TOG/issues/TOG-10284) with this head and the new regression evidence, then block the author task on that real review edge. Only the independently approving reviewer may squash-merge. The author task is not done before verified merge.
