# Owned-storage CI profile

This is local synthetic CI evidence only. It neither authorizes actual staging
nor wires gateway admission, restart policy, or an alternate application assembly.
The runtime and both existing owned-storage test bodies are unchanged.

## Required path

`.github/workflows/ci.yml` runs `scripts/ci/run-check-job.sh` in the required
`check` job, after dependency installation. The fail-fast sequence is:

1. `npm run typecheck`
2. `npm run test:postgres` (the existing service-DB glob and six suite floors)
3. `npm run test:restart-storage -- --provision` (independent owned clusters)
4. `npm run verify:grant:selftest`

The downstream `postgres` contract/grant job and its wrapper are unchanged.
`test/unit.restartstorageci.test.ts` executes the required wrapper with a tracing
npm shim and injects a failure at every command; it also checks workflow reach
and package-script binding. It does not substitute the real seven-test profile.

## Provisioning provenance

- CI-only package: `@embedded-postgres/linux-x64@18.4.0-beta.17`.
- Measured executables: `initdb (PostgreSQL) 18.4` and
  `postgres (PostgreSQL) 18.4`.
- Source archive:
  <https://registry.npmjs.org/@embedded-postgres/linux-x64/-/linux-x64-18.4.0-beta.17.tgz>
- Integrity (also in `scripts/ci/postgres-bin/package-lock.json`):
  `sha512-jVw/MdDtIX/vICH/DKIe6/mHpiCggdx6QVyza4vt/NbcZFsL0KhwglF6F1Koqx3gRBZ9XtN+vi63EsqSyqOSxA==`
- Upstream package/build documentation:
  <https://github.com/leinelissen/embedded-postgres#readme> describes supported
  platforms and its upstream PostgreSQL binary distribution.
- Installer contract: <https://docs.npmjs.com/cli/v11/commands/npm-ci> documents
  frozen installs from the lockfile. The pinned native package's postinstall
  hydrates its bundled library symlinks; no global installation or sudo is used.

The root `pg` dependency is a client, not `initdb`/`postgres`. Node's standard
library and the separate Docker service cannot supply these executables. A
single leaf native dependency is therefore isolated in a nested CI package;
there is no additional root/runtime dependency or root lockfile change. Ordinary
cross-platform `npm ci` never installs it. `--provision` intentionally supports
the existing Linux x64 runner only and refuses other platforms. A developer can
instead supply trusted local binaries with `TWO_TEST_POSTGRES_BIN=/absolute/bin
npm run test:restart-storage`.

Each provisioned invocation copies the two pinned manifests into a fresh private
`/tmp/rsci-*` directory and runs `npm ci` there against the npm registry. There is
no reusable mutable binary/cache path and no dependence on an agent's npm cache.
Provisioning output includes the binary versions before tests start.

## Isolation, reporting and failure semantics

`childEnvironment()` builds an explicit literal environment, not a subtraction
from `process.env`. Its entire allowlist is PATH (the current Node directory plus
`/usr/bin:/bin`), C locale, private HOME and TMPDIR, and the selected absolute
TWO_TEST_POSTGRES_BIN. PGPORT/PGPASSWORD/PGOPTIONS, inherited database URLs,
NODE_ENV/NODE_OPTIONS, proxy variables and credentials cannot reach the owned
test child. Provisioning has a separate private TMPDIR because npm writes a
Node compile cache; installer cache is not mistaken for leaked cluster storage.
No `.env` loading or inherited Node arguments are used.

The explicit test inputs are the original integration and entrypoint wrappers.
The reused NDJSON reporter attributes imported tests to their declaration file:

| Report file | Required minimum |
| --- | ---: |
| `test/stagingRestartStorage.integration.ts` | 5 |
| `test/e2e.stagingrestart.test.ts` | 2 |

The regular service-DB suite already includes `e2e.stagingrestart.test.ts`; this
profile runs those same entrypoint tests with an owned cluster instead. It is
not a claim that the ordinary glob lacked entrypoint coverage.

The profile reuses `check`, `tally`, `parseResults`, `annotations` and the empty
`MAY_SKIP` policy. Missing input files/binaries, missing/empty/malformed reports,
below-floor/suite-only reports, skipped/failed/TODO points and child signals or
spawn failures cannot return green. Failure annotations remain visible in CI.
`--results FILE` checks saved reports without launching tests.

The existing storage tests verify retained-child shutdown, connection refusal,
lease closure and empty fixture directories. The wrapper additionally requires
its test TMPDIR to be empty before deleting its private installation, cache,
home and report. If test scratch remains, it fails and retains the directory
for investigation rather than deleting a possibly running cluster or signaling
an arbitrary PID. There is no host cleanup instruction.

Node API references:
- <https://nodejs.org/docs/latest-v24.x/api/child_process.html#child_processspawncommand-args-options>
- <https://nodejs.org/docs/latest-v24.x/api/test.html#custom-reporters>

## Local verification

With NODE_ENV unset and root dev dependencies installed:

```sh
npm run typecheck
node --test test/unit.requiresuites.test.ts test/unit.restartstorageci.test.ts
npm run test:restart-storage -- --provision
# With a separate disposable loopback service DB (never a shared/staging URL):
./scripts/ci/run-check-job.sh
./scripts/ci/run-postgres-job.test.sh
```

Report service-DB and owned-cluster counts separately. The entrypoint profile
includes three modes and a real 60-second scheduler tick; do not shorten those
assertions to make CI green. The issue evidence records commands, counts,
negative controls and cleanup, including unsuccessful development attempts.

## Integration boundary

This candidate is based on the parent's reviewed
`4a8d8d846cb2fd37f661e5cdaacccf4bce91cf07`; it does not alter that branch.
Fresh main `d2555efbafeb2913f03d20689921037527350654` contains fork-gate workflow
protections absent from that baseline. Parent integration must preserve those
protections when reconciling the workflow; applying the whole old workflow over
main would be incorrect. The child delta only replaces the check job's four
commands with the explicit wrapper and does not modify job dependencies.
No parent rebase, merge, deployment or actual staging is authorized here.
