# Staging signed settings proof — HOLD packet

**HOLD: the measured runtime cannot serve settings.get/settings.set.** At
`f5fd3e1d6d08847589d3bf48ebc0b0e198196e90`, startup omits the settings service
from `startInternalActions`. Both actions therefore return `action_not_allowed`,
even with both flags enabled. See [SOURCE_IDENTITY.md](SOURCE_IDENTITY.md) for
exact source citations, the integration witness and the minimal required change.
The previous packet's positive runtime-readiness conclusion was wrong.

This PR is preparation/offline verification only. Its review or merge **does not
remove this HOLD**. `run-proof.sh` validates its source/preconditions then exits 2
with HOLD before **any** Docker operation, for both `run` and `recover`. There is
no override flag. Do not invoke the engine directly to bypass this gate.

[TOG-3706](/TOG/issues/TOG-3706) remains the sole host execution card. No duplicate
Operator card, deployment, restart, flag write, database provisioning, credential
or permission change is authorized. The existing flags remain at 1. No host run
or setting change was performed by this packet's author.

## Measured identity — not an executable target

| Pin | Recorded identity |
|---|---|
| App | `uy4d9ndeygjcem6lgayhxgub` |
| Exact container | `bot-uy4d9ndeygjcem6lgayhxgub` |
| Guild | `1545644954272137297` (TWO Staging) |
| Rejected runtime | `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90` |
| Proof source | Independently reviewed full head, separate from runtime |
| Candidate keys | `TWO_RAID_JOIN_THRESHOLD`, `TWO_RAID_WINDOW_SECONDS` |
| Offline fixture | Numeric strings `7`, `42`, respectively |

An image tag is operator-measured metadata, not attestation of installed bytes.
Do not replace the runtime pin with current main, an ancestor or a sibling, and
do not deploy merely to make this probe pass.

## Prerequisites for a separately authorized runnable packet

1. Review the bounded startup wiring change: pass the initialized settings store
   to the internal-action server and integration-test the actual startup options,
   null/unavailable-store denial, signed actions, audit and cache readback.
2. Separately authorize the exact source/build and reconcile image digest,
   installed source/dependencies and staging app/container/guild provenance on
   the existing host chain. This packet supplies **no replacement runtime SHA**.
3. Revise and independently review the runtime pin and operator wrapper together.
   A future wrapper must inspect the exact running staging container/image,
   record image ID, and copy/exec through the immutable container ID; no mutable
   name race, secret transfer or flags in rollback. Do not remove the HOLD alone.
4. Establish exclusive staging writers and no joins, including recovery; wait at
   least 20 seconds after quiescence for the default 15-second cache poll before
   capture. No dashboard saves, other clients, direct DB writers, second bot
   process or in-flight save may remain. The API has no CAS/distributed lock.
5. Fresh exact-head Code Reviewer approval, green required CI, distinct non-author
   merge and Director reconciliation are required before authorized host use.

The future exclusivity assertion is not a lock. Read guards do not cover the
check/set race, cached invisible changes or ABA. If writer exclusion cannot be
established, HOLD. Supporting concurrent writers needs a separately reviewed
conditional-write contract, not an optimistic claim from these fixtures.

## Retained executable engine — offline verification, not a host command

`settings-signed-proof.mjs` retains the signed proof/recovery implementation so
its safety behavior can be exercised offline. Fixture servers deliberately
provide a settings service; they are **not** replicas of measured startup. The
source integration test separately witnesses that measured startup is unwired.
A denied initial get exits 2 with `failure: runtime.settings-unavailable`, without
mutation. No live roundtrip or live rollback is claimed.

If a separately reviewed runtime eventually enables the service, the retained
contract is:

- Preflight refuses wrong/missing app, runtime, guild, proof source, keys, flags,
  writer assertion, malformed pre-state, URL credentials, redirects or a
  non-literal-loopback endpoint. Keys remain in the container environment.
- Capture both actual stored values and JSON types; get never reads environment
  fallback. Stored values must be digit strings or integers in 1..3600. Exact
  strings (including leading zeroes) survive restoration. Only prior absence
  permits null/unset. No audit SQL or latest-old_value heuristic is safe.
- Fixtures `7`/`42` are valid bounded raid settings, not fabricated channel IDs.
  They are **two sequential writes**, not an atomic pair; no joins may occur.
- Signed controls assert settings get/set, environment-only/unclassified/action
  allowlist 403 and malformed-signature/tampered-body/unknown-key-ID 401. Exact
  readback allows 20 seconds for the cache; presence alone cannot pass.
- Before each attempted write, fsync an authenticated encrypted journal (0700
  directory, 0600 file, AES-256-GCM key context-derived from the existing signing
  key). Signing material is never persisted. Finally cleanup uses signed set for
  normal audit/version/timestamp/delete invalidation and verifies exact pre-state.
- Applied write + response loss uses the same body/operation ID and fresh nonce.
  Any uncertainty keeps PROOF FAIL even if cleanup succeeds. Matching readback
  alone cannot prove that a delayed original write will not still land.
- Pending intents older than 45 seconds, or a backward clock, refuse automatic
  replay before the runtime's unfenced 60-second claim takeover. This is not an
  exactly-once guarantee. Old pending intents require receiver-side completion
  reconciliation; no fresh ID, journal edit or blind restore is permitted.
- The `recover` engine mode loads the original encrypted pre-state and operation
  IDs. It refuses a live/reused PID, source/endpoint mismatch, tampered journal or
  observed writer drift. Successful recovery emits RECOVERED, never PROOF PASS.
  A confirmed written checkpoint can be restored later; an old ambiguous pending
  checkpoint cannot automatically be recovered. The host wrapper remains HOLD.

If an earlier manually invoked engine left a journal, preserve it and the
exclusive window; do not run this held wrapper as a purported recovery, delete
state, recreate the container, rotate/reorder keys or blind-unset. Record a
redacted failure on the existing host card for a bounded reconciliation decision.
Never print/copy values, signatures, response bodies or journal plaintext. Never
run with `set -x` or upload the private journal directory.

## Receipt interpretation and remaining gaps

The wrapper's exit 2 / HOLD is the only supported operator outcome for this
packet, **not** successful cleanup or staging acceptance. Engine fixtures check:

- `0 PROOF PASS`: offline signed controls and exact cleanup passed.
- `0 RECOVERED`: offline rollback verified, not proof acceptance.
- `1 PROOF FAIL`: assertion/interruption/uncertainty/cleanup failure.
- `2 REFUSED`: this invocation has not attempted mutation; any older outstanding
  recovery state still needs resolution.

Engine receipts carry runtime/proof source, prior row presence, cleanup outcome,
uncertainty and safe failure code, never values/signatures/key IDs. Full runtime
or deployed-byte equivalence is not established. HMAC 401 is **not** website
non-admin authorization denial; that needs separate staging website route/contract
evidence. [TOG-3469](/TOG/issues/TOG-3469) acceptance and
[TOG-4092](/TOG/issues/TOG-4092) capacity gate remain unchanged.

## Offline verification

```bash
node --check ops/tog-4104/settings-signed-proof.mjs
bash -n ops/tog-4104/run-proof.sh
node --test test/tog4104-offline.test.ts test/tog4104-discovery.test.ts test/tog4104-runtime-wiring.test.ts
```

The CI entrypoint requires every expected named executable case, not a positive
Node test count (empty files count as passing tests). Its negative mutations run
the unchanged entrypoint against empty files and unrelated named cases; both
must fail. No fixture success removes the runtime HOLD.
