# Fork-policy rollout

These files are the trusted policy, not the workflow activation. Land this
script-only prerequisite through independent review first. PR #123 can then
check out a base that already contains the policy, remove every bootstrap
checkout, and enable the gate. Until that second PR lands, these files do not
protect a workflow that never calls them.

A candidate-selected immutable SHA is not an approved trust source. The checker
therefore rejects **all** bootstrap checkouts, including the previously used
`ac9153f05cb888ff2cb23588e275ad53efc48433` and the older
`1b0d5dc620e7cd479587b26028ef35367b2efe05`. There is no mutable-ref fallback,
allowlist supplied by the candidate, or absent-policy success path.

## Verify the prerequisite

```sh
npm ci --ignore-scripts --prefix scripts/ci
./scripts/ci/refuse-fork-pr.test.sh scripts/ci/fixtures/fork-policy
```

This runs the refusal cases, YAML-policy regression tests, and coverage against
a checked-in workflow fixture (data only, not a workflow GitHub executes).
The default self-test target is the repository's actual workflows; before
activation, checking those must fail because they do not yet have a gate.
The prerequisite changes neither `.github/workflows` nor application code;
its policy tests must be run explicitly during independent review, in addition
to the normal CI suite.

## Activate only after the prerequisite merges

For each PR-triggered workflow, the gate must contain exactly these six steps,
in this order (see `fixtures/fork-policy/.github/workflows/ci.yml`):

1. Check out `github.event.pull_request.base.sha || github.sha`, with credentials disabled.
2. Run the trusted refusal with the actual head repository expression.
3. Set up Node 24.
4. Install the trusted parser lockfile with lifecycle scripts disabled.
5. Check out candidate workflow data into the separate `candidate` directory.
6. Run the trusted self-test and candidate-coverage checker on that directory.

Every dependent job needs the gate and must preserve success-based scheduling.
The checker validates the **complete** tail: missing/no-op coverage, extra
steps, `always()`/`failure()` overrides, environment/shell/working-directory
changes, and overwriting the trusted checkout all fail. Each PR-triggered
workflow must validate candidate wiring itself; protection does not rely on a
particular sibling workflow also being triggered.

After main includes the prerequisite, integrate that main commit into PR #123,
apply the prepared no-bootstrap wiring, and run:

```sh
./scripts/ci/refuse-fork-pr.test.sh "$PWD"
node --test test/unit.interaction-reply.test.ts
git diff --check
```

Obtain fresh normal CI and an independent exact-head review before the
non-author merge. The onboarding reply repair in PR #123 must be preserved.
Do not push the no-bootstrap activation before its base contains the policy:
missing base policy is intentionally an error, not permission to skip the gate.
