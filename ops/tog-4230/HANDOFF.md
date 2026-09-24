# S2 startup wiring — source handoff v1 (HOLD)

This is the source-only deliverable for [TOG-4230](/TOG/issues/TOG-4230),
[PR #172](https://github.com/TogetherWeOwn/two-bot/pull/172).
It is **not an executable deployment packet or a replacement runtime pin**.
Director reconciliation belongs to [TOG-4233](/TOG/issues/TOG-4233);
[TOG-3706](/TOG/issues/TOG-3706) remains the sole host execution card.

## Immutable source identities

| Object | Full identity | Meaning |
|---|---|---|
| Historical measured runtime | `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90` | Startup omits settings; still rejected, not replaced here |
| Reviewed HOLD packet merge | `b09ab5a0f8cd94b2b74e7165cb2c7281ed25cb17` | `ops/tog-4104/SOURCE_IDENTITY.md` and `RUNBOOK.md` remain authoritative for the HOLD |
| Startup repair commit | `3db3697d911bd19066610b56b477bc8b7c78fa34` | Injects the initialized settings instance; adds regression tests |
| Required-suite pin commit | `2fb90f30a33a0ba63ff5d02e91207ab1cc886a7e` | Pins eight startup tests in the Postgres manifest |
| Repair entrypoint blob | `5432c822cc633268e0056ff200b39543c341eec3` | `src/index.ts` at the suite-pin commit |
| Dependency lock blob | `c45268dfafde4af1821547620d14887b7013c6ef` | `package-lock.json` at the suite-pin commit |

The final reviewed PR head includes this document and must be recorded in the
issue receipt after pushing; a document cannot embed its own commit hash. The
non-author merger must record the exact approved head, green required check URLs,
merge commit and merged packet URL. A squash merge is a different commit: record
both identities and compare the resulting relevant source, not ancestry alone.
As of preparation, **approval and merge are pending**. The earlier review at the
suite-pin commit withheld approval because `postgres` failed during container
initialization; local passing tests do not replace that required check.

In a clean source checkout, the reviewer can reproduce immutable source facts:

```bash
git show f5fd3e1d6d08847589d3bf48ebc0b0e198196e90:src/index.ts
git show 3db3697d911bd19066610b56b477bc8b7c78fa34 -- src/index.ts
git rev-parse 2fb90f30a33a0ba63ff5d02e91207ab1cc886a7e:src/index.ts
git rev-parse 2fb90f30a33a0ba63ff5d02e91207ab1cc886a7e:package-lock.json
```

## Behavior and evidence boundary

The production repair only supplies the existing loaded/polled `SettingsStore`
to `startInternalActions`. `loadInternalActionsConfig` remains environment-only;
authentication, signing keys, action allowlists and flags are not moved into the
settings database. No consumer implementation is redone.

The eight-case startup suite evaluates the actual working-tree startup call with
stubbed surrounding dependencies, then separately exercises the real HTTP server,
settings store and isolated Postgres. It is **not a complete Discord/application
boot**, deployed-byte attestation or a staging execution result. Its coverage
includes injection/control mutation, signed settings get/set, persisted audit,
cache refresh/consumer readback, unset behavior and refusal paths. The independent
review records 8/8 passing, a removed-injection control at 6 pass/2 fail, adjacent
unit suites 42/42 and hot-reload 11/11. Those are historical local review results,
not fresh CI results on the final head.

The historical measured-source witness remains deliberately red for runtime
readiness: its tests pass by proving the old startup rejects settings verbs.
HMAC 401 proves envelope refusal, **not website non-admin denial**.
[TOG-3469](/TOG/issues/TOG-3469), [TOG-4092](/TOG/issues/TOG-4092) and all other
live acceptance gates remain unchanged.

## Reproducing the isolated test and build contract

Use Node 24 with development dependencies (`npm ci --include=dev`) in a clean
source checkout. Supply `TWO_TEST_DATABASE_URL` only from an isolated disposable
test database, never staging or production. The helpers create private schemas
and truncate fixture tables. With that isolated database prepared:

```bash
node --test test/e2e.settingsstartup.test.ts
node --test test/unit.internalconfig.envonly.test.ts test/unit.internalsettings.test.ts test/unit.requiresuites.test.ts test/e2e.settingshotreload.test.ts
npm run test:postgres
```

`npm run test:postgres` invokes `scripts/require-suites.ts`, which runs the full
test glob, requires eight startup cases and permits no skipped tests. It is not
an eight-test-only command. CI uses Postgres 17; the independent review's local
Postgres 18.1 result does not replace CI. The review also reported an untouched
base typecheck error at `src/staging/restartGatewayStrategy.ts:103`; only the
actual required-check result can satisfy CI, not a local waiver of that error.

Build contract at the suite-pin source: `Dockerfile:19` uses floating
`node:24-bookworm-slim`; `:38-46` installs locked production dependencies with
`npm ci --omit=dev --ignore-scripts` and copies `src`, `scripts`, `migrations`,
`sql` and `tsconfig.json`. `:48,66` runs as `node` with
`CMD ["node","src/index.ts"]`. There is no emitted `dist` build: Node executes
TypeScript directly. `.dockerignore:24-31` excludes tests, ops and Markdown, so
this packet/proof source is not delivered inside the runtime image. The health
check targets `/healthz`, not `/readyz` or settings readiness. Resolving the
floating base and verifying runtime inputs is part of the future build receipt.

## Build and provenance gates — future authorized work only

No image was built, installed, inspected or substituted by this source handoff.
Before any future installation, the Director must reconcile and independently
review an exact source/build/runtime/wrapper packet, not just remove the HOLD.
The receipt must contain:

1. Exact approved PR head, successful required checks on that head, distinct
   non-author merger, merge commit, source tree and versioned packet URL.
2. Exact build source and clean build-context manifest; Dockerfile and lockfile
   hashes; resolved base-image digest; dependency installation inputs; build log
   and immutable output image digest/ID. Tags and revision labels alone are not
   source or installed-byte attestation.
3. Actual staging app/container/guild identity, immutable running container ID,
   image digest/ID, installed source/dependency manifest and any bind mounts or
   overlays. Compare actual installed bytes to the reviewed build manifest;
   source ancestry or matching labels cannot stand in for this comparison.
4. Separate proof-source and runtime pins plus an independently reviewed wrapper
   that selects and executes through the immutable container ID, without a mutable
   name race. The existing held wrapper remains unchanged and must not be bypassed.
5. A retained known prior image/runtime identity and state-preservation plan.
   Any difference from the expected source, build or container means HOLD.

No blanks in that receipt may be inferred from `main`, an ancestor, a sibling
revision, successful local tests or the existence of this document. Record
unknowns explicitly and stop. A future runtime/wrapper pin requires independent
review; this packet intentionally supplies neither.

## Installation and verification preconditions (not execution authority)

After the above reconciliation and separate authorization on the existing host
chain, installation must use the reviewed immutable artifact and preserve the
existing database, configuration, secrets and recovery journal. No new flags,
permissions, credentials, migrations or host commands are authorized here.
Capture the prior immutable runtime identity before any authorized replacement;
verify the installed-byte and container evidence before permitting the reviewed
proof. A source merge alone is not installation or live acceptance.

The future signed proof must preserve the original safety contract from the held
runbook: exclusive writers (including dashboards, DB writers, other processes
and in-flight saves), no joins, and at least 20 seconds of quiescence before
capture for the default 15-second poll. The API has no CAS/distributed lock. If
exclusive access cannot be established, HOLD rather than assume read guards are
sufficient. Settings get reports actual stored JSON, not environment fallback.

## State-preserving rollback and interrupted proof

- Reverting application code is distinct from restoring settings. A prior image
  can restore prior code only after separate authorization; it does not undo DB
  writes or prove settings service availability. Keep the prior immutable image
  and deployment configuration; do not delete or recreate database state.
- Capture both prior row presence and exact JSON value/type, preserving integers,
  strings and leading zeroes. **Only prior absence permits null/unset.** Never use
  environment fallback, latest audit old_value, fabricated defaults or blanket
  unset as restoration state.
- Before any proof write, retain the authenticated encrypted, fsynced journal
  under the reviewed contract (0700 directory, 0600 file, AES-256-GCM; existing
  signing-key-derived context, no persisted signing material). Never publish
  values, signatures, response bodies or journal plaintext.
- Restore through signed settings actions with ordinary audit/version invalidation
  and exact post-poll readback under continued writer exclusion. Two selected
  values are sequential writes, not an atomic pair. Cleanup success after any
  uncertain write does not convert failure into proof acceptance.
- Preserve original operation IDs and journal during response loss/interruption.
  Pending intent older than 45 seconds, backward clock, drift or unresolved
  completion means HOLD for receiver-side reconciliation: no fresh IDs, journal
  editing, blind restore, key rotation/reordering or destructive container
  replacement. Successful recovery means RECOVERED, never PROOF PASS.
- The current wrapper refuses both run and recover before Docker. Do not invoke
  the engine directly to bypass it. Resolve any outstanding journal on the
  existing host card before code rollback that would make recovery unavailable.

## Completion receipt and remaining owners

The source issue may close only after exact-head approval, all required checks
green, distinct non-author merge, and registration of the merge and this packet.
The Director then reconciles the future runnable packet; the authorized operator
acts only through the existing host card. Website authorization and live staging
acceptance remain independent gates. No deployment, live probe, restart, setting,
flag, credential or permission change was performed for this handoff.
