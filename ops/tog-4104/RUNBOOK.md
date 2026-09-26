# Staging signed settings proof — runnable packet (TOG-4705)

This packet re-pins the TOG-4104 proof to the wired runtime
`7995b3fb13feda26ae35356bc5227c67870370c9` and lifts the HOLD **only for that
pin**. At that commit startup passes the initialized settings store to
`startInternalActions`, so both settings verbs are served with the existing
flags enabled. See [SOURCE_IDENTITY.md](SOURCE_IDENTITY.md) for pin choice,
topology, excerpt provenance and review/CI records.

`run-proof.sh` validates source, runtime, image identity and the exclusive
window, then resolves the running staging container once by exact name and
copies/executes only through the immutable container ID. Any other runtime
refuses before any Docker operation; the offline test proves it with the
rejected `f5fd3e1` runtime as the negative case. There is no override flag.
Do not invoke the engine directly to bypass this gate.

[TOG-3706](/TOG/issues/TOG-3706) remains the sole host execution card. No
duplicate Operator card, restart, flag write, database provisioning,
credential or permission change is authorized. Staging only: do not touch
production, flags, credentials or the DB. The existing flags remain at 1.

## Pinned identity

| Pin | Recorded identity |
|---|---|
| App | `uy4d9ndeygjcem6lgayhxgub` |
| Exact container | `bot-uy4d9ndeygjcem6lgayhxgub` |
| Guild | `1545644954272137297` (TWO Staging) |
| Pinned runtime | `7995b3fb13feda26ae35356bc5227c67870370c9` (PR #175 merge, contains `15b8f6c`) |
| Proof source | This packet's merged head, passed as `$2` and byte-checked against `ops/tog-4104` |
| Candidate keys | `TWO_RAID_JOIN_THRESHOLD`, `TWO_RAID_WINDOW_SECONDS` |
| Offline fixtures | Numeric strings `7`, `42`, respectively |

The rejected runtime `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90` stays refused.
An image tag is operator-measured metadata, not attestation of installed
bytes. Do not replace the runtime pin with current main, an ancestor or a
sibling.

## Operator steps (TOG-3706 only, after this packet merges)

1. Deploy exactly `7995b3fb13feda26ae35356bc5227c67870370c9` to
   `uy4d9ndeygjcem6lgayhxgub`. Record the Coolify deployment id and the
   resulting immutable image ID (`sha256:…`).
2. Quiesce all writers: no dashboard saves, other clients, direct DB writers,
   second bot process, in-flight save, or joins. The API has no
   CAS/distributed lock. Wait at least 20 seconds after quiescence for the
   default 15-second cache poll before capture.
3. Run the proof from a checkout at this packet's merged head (`$SOURCE`):
   ```bash
   PROOF_EXCLUSIVE_WINDOW=staging-writers-quiesced \
   PROOF_RUNTIME_REVISION=7995b3fb13feda26ae35356bc5227c67870370c9 \
   PROOF_IMAGE_ID='<sha256 from step 1>' \
   ops/tog-4104/run-proof.sh run "$SOURCE"
   ```
   The wrapper prints one `PROOF TARGET app=… container=<64-hex> image=…
   ref=… runtime=… source=… mode=…` line recording the immutable container
   and image IDs. Signing keys stay inside the container: the script never
   reads or passes `TWO_INTERNAL_KEYS`. The only injected value is
   `PROOF_SOURCE_SHA`, the validated packet commit, which is not a secret.
4. Capture the deployment id from step 1, the wrapper's `PROOF TARGET` line,
   and the bot logs covering the run: `setting_changed`
   (`src/index.ts:233`, emitted per changed hot-wired key with `from`/`to`)
   and `settings_reloaded` (`src/core/settings.ts:217`, emitted on poll with
   version/key counts). Post the receipt plus these three records as the
   proof comment on TOG-3101.
5. On `PROOF FAIL` (exit 1) with an uncertain checkpoint, preserve the
   journal and the exclusive window and re-run with `recover` instead of
   `run`. Successful recovery emits RECOVERED, never PROOF PASS.

If writer exclusion cannot be established, do not run: the exclusivity
assertion is not a lock. Read guards do not cover the check/set race, cached
invisible changes or ABA. Supporting concurrent writers needs a separately
reviewed conditional-write contract, not an optimistic claim from these
fixtures.

## Retained executable engine — safety contract

`settings-signed-proof.mjs` refuses before mutation on: wrong/missing app,
runtime, guild, proof source, keys, flags, writer assertion, malformed
pre-state, URL credentials, redirects or a non-literal-loopback endpoint.
Keys remain in the container environment.

- Capture both actual stored values and JSON types; get never reads
  environment fallback. Stored values must be digit strings or integers in
  1..3600. Exact strings (including leading zeroes) survive restoration. Only
  prior absence permits null/unset. No audit SQL or latest-old_value
  heuristic is safe.
- Fixtures `7`/`42` are valid bounded raid settings, not fabricated channel
  IDs. They are **two sequential writes**, not an atomic pair; no joins may
  occur.
- Signed controls assert settings get/set, environment-only/unclassified/action
  allowlist 403 and malformed-signature/tampered-body/unknown-key-ID 401.
  Exact readback allows 20 seconds for the cache; presence alone cannot pass.
- Before each attempted write, fsync an authenticated encrypted journal (0700
  directory, 0600 file, AES-256-GCM key context-derived from the existing
  signing key). Signing material is never persisted. Finally cleanup uses
  signed set for normal audit/version/timestamp/delete invalidation and
  verifies exact pre-state.
- Applied write + response loss uses the same body/operation ID and fresh
  nonce. Any uncertainty keeps PROOF FAIL even if cleanup succeeds. Matching
  readback alone cannot prove that a delayed original write will not still
  land.
- Pending intents older than 45 seconds, or a backward clock, refuse automatic
  replay before the runtime's unfenced 60-second claim takeover. This is not
  an exactly-once guarantee. Old pending intents require receiver-side
  completion reconciliation; no fresh ID, journal edit or blind restore is
  permitted.
- The `recover` engine mode loads the original encrypted pre-state and
  operation IDs. It refuses a live/reused PID, source/endpoint mismatch,
  tampered journal or observed writer drift. Successful recovery emits
  RECOVERED, never PROOF PASS.

If an earlier manually invoked engine left a journal, preserve it and the
exclusive window; do not run this wrapper as a purported recovery, delete
state, recreate the container, rotate/reorder keys or blind-unset. Record a
redacted failure on the existing host card for a bounded reconciliation
decision. Never print/copy values, signatures, response bodies or journal
plaintext. Never run with `set -x` or upload the private journal directory.

## Receipt interpretation

- `0 PROOF PASS`: signed controls and exact cleanup passed on the pinned
  runtime; staging acceptance still needs the TOG-3101 proof comment with
  deployment id, `PROOF TARGET` line and the `setting_changed` /
  `settings_reloaded` log capture.
- `0 RECOVERED`: offline rollback verified, not proof acceptance.
- `1 PROOF FAIL`: assertion/interruption/uncertainty/cleanup failure.
- `2 REFUSED`: this invocation has not attempted mutation; any older
  outstanding recovery state still needs resolution.

Engine receipts carry runtime/proof source, prior row presence, cleanup
outcome, uncertainty and safe failure code, never values/signatures/key IDs.
Full runtime or deployed-byte equivalence is not established. HMAC 401 is
**not** website non-admin authorization denial; that needs separate staging
website route/contract evidence. [TOG-3469](/TOG/issues/TOG-3469) acceptance
and [TOG-4092](/TOG/issues/TOG-4092) capacity gate remain unchanged.

## Offline verification

```bash
node --check ops/tog-4104/settings-signed-proof.mjs
bash -n ops/tog-4104/run-proof.sh
node ops/tog-4104/verify-runtime-source.mjs
node --test test/tog4104-offline.test.ts test/tog4104-discovery.test.ts test/tog4104-runtime-wiring.test.ts
```

The CI entrypoint requires every expected named executable case, not a
positive Node test count (empty files count as passing tests). Its negative
mutations run the unchanged entrypoint against empty files and unrelated
named cases; both must fail.
