# Event-store benchmark calibration

`node scripts/event-store-bench.ts --check` uses a fixed workload of 2,000
members / 8,667 events and a checked-in calibration matched to observed runtime
settings. The CI wrapper measures three independent schema lifecycles. **Every
sample must pass**; a later success never hides a breach. Setup/runtime errors
stop the wrapper immediately with exit 2. Budget violations exit 1.

Run only against agent-testdb or a disposable CI service container. Supply
`TWO_TEST_DATABASE_URL` explicitly; the ambient `TWO_DATABASE_URL` is never used.
The benchmark creates/migrates/drops its own schema and closes its connection.
Runtime diagnostics are read-only and allowlisted; connection URLs are not logged.

## Why there are two calibrations

The original local calibration used durability disabled. The CI workflow uses
stock Postgres with durability enabled. These are different measurement
environments, not interchangeable write baselines. Applying the fast-container
0.741 ms/event ceiling to stock durable CI rejected an unchanged implementation.

Verified CI calibration evidence:

- [Run 36656843442 / check job 109702952854](https://github.com/TogetherWeOwn/two-bot/actions/runs/36656843442/job/109702952854), 2026-09-30.
- PR head: `b64abf1ceec8ba39b8b518cff35d40b65f3c9c3a`.
- Actually measured checkout: GitHub CI merge `08cbb8befa66a60708025662e541243ff9e6247a`,
  merging that head into main `2d05db020b35c2889c1aa300e2ae0f775dd2c0bb`.
  The checkout log confirms both parents and the full merge SHA.
- `git diff 2d05db02 08cbb8be -- src migrations package.json package-lock.json`
  is empty: the measured EventStore implementation, schema and dependencies were
  identical to the main reference, not a newly regressed implementation.
- [Main reference CI run 36656673228](https://github.com/TogetherWeOwn/two-bot/actions/runs/36656673228)
  completed successfully on `2d05db020b35c2889c1aa300e2ae0f775dd2c0bb`.
- The PR head itself has no src/migration/dependency changes from its original
  branch point `b0a26a5e3882dd0784d208079f309893e2ede7e8`. The calibration proof
  above uses the actual tested merge tree and its green main parent instead.
- All three fixed workloads and all six read budgets passed. Only the invalid
  cross-environment write comparison failed; the required wrapper passed.
- These data establish a calibration mismatch. They do not isolate exactly how
  much time each durability setting, shared buffer size or runner contributes.
  No production/staging verification or DB setting mutation was performed.

| Calibration | Node / Postgres | fsync / full_page_writes / synchronous_commit | shared_buffers | Write samples (ms/event) | Median | 3x ceiling |
| --- | --- | --- | --- | --- | --- | --- |
| agent-testdb | 24.21 / 17.11 | off / off / off | 512MB | 0.247, 0.262, 0.246 | 0.247 | **0.741** (unchanged) |
| ci-postgres | 24.21 / 17.11 | on / on / on | 128MB | 1.674, 1.666, 1.654 | 1.666 | **4.998** |

Both observed environments were Linux x64, `wal_sync_method=fdatasync`,
`max_wal_size=1GB`, `checkpoint_timeout=5min`. Selection requires these settings,
Node major 24, Postgres major 17 and the corresponding durability/buffer tuple.
A missing, mixed or uncalibrated tuple fails closed before seeding. In GitHub CI
(`CI=true`), the fast profile is expressly refused. No profile is selected from
the observed timing, so a slow run cannot promote itself to a looser budget.

Read baselines are the median across three complete runs; each run measures the
median of seven warm query samples:

| Read | agent-testdb baseline (ms) | ci-postgres samples (ms) | ci-postgres baseline (ms) | Ceiling in both profiles (ms) |
| --- | --- | --- | --- | --- |
| funnel count (type+time) | 0.061 | 0.363, 0.313, 0.343 | 0.343 | 10 |
| joiners DISTINCT (windowed) | 0.079 | 0.413, 0.367, 0.381 | 0.381 | 10 |
| stage DISTINCT (unwindowed) | 0.158 | 0.585, 0.544, 0.567 | 0.567 | 10 |
| member rung lookup | 0.049 | 0.328, 0.306, 0.330 | 0.328 | 10 |
| hasEvent probe | 0.069 | 0.307, 0.296, 0.300 | 0.300 | 10 |
| write series (recorded_at scan) | 0.892 | 2.020, 1.913, 1.978 | 1.978 | 10 |

The policy remains **3x recorded writes** and **max(3x recorded read, 10ms)**,
with exact workload counts and finite/nonnegative timings. The original local
limit, all read limits, failure retention and CI durability are preserved. The
durable profile adds a measured, comparable reference rather than changing the
old profile's limit. It still rejects >3x durable write regressions.

## Verification and refresh policy

```sh
node --test test/unit.eventstorebench.test.ts
TWO_TEST_DATABASE_URL=postgres://agent_test@agent-testdb:5432/agent_test \
  bash scripts/ci/run-event-store-bench.sh
```

Hermetic tests verify profile selection/refusal, missing/version/mixed runtime
settings, CI refusal of the fast tuple, both inclusive boundaries and >3x
regressions, actual process exit codes for both profiles, malformed metrics,
fixed workload, and first/middle/last failed sample retention.

Record three comparable fixed-workload measurements of a known-good reference
implementation before refreshing a profile. Include runtime settings, exact
source/base SHA and CI logs in the review evidence. Never disable durability,
recalibrate from a known-regressed implementation, choose a profile from measured
latency, silently fall back on an unknown runtime, or raise the multiplier to
make a regression green. Independent exact-head review and green required check
plus dependent postgres gates are still required before merge.
