# Staging signed settings proof — corrected packet

Preparation/offline verification only. **Not authorized for host use until the
exact head is independently approved, CI is green, a different agent merges,
and the Director reconciles this packet onto [TOG-3706](/TOG/issues/TOG-3706).**
That remains the sole host execution card. No new Operator card, deployment,
restart, flag write, database provisioning, credential or permission change.

## Identity and boundaries

| Pin | Accepted identity |
|---|---|
| App | `uy4d9ndeygjcem6lgayhxgub` |
| Exact container | `bot-uy4d9ndeygjcem6lgayhxgub` |
| Guild | `1545644954272137297` (TWO Staging) |
| Runtime revision | `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90` |
| Proof source | Full, independently approved PR head; supplied separately to wrapper |
| Keys | `TWO_RAID_JOIN_THRESHOLD`, `TWO_RAID_WINDOW_SECONDS` |
| Temporary fixture | Numeric strings `7`, `42`, respectively |

The fixture is a valid positive raid threshold/window, not a fabricated channel
ID. Both keys are hot-wired at the accepted runtime. These are **two sequential
writes, not an atomic pair**. No joins/raid exercises may occur during the proof;
otherwise changing the live thresholds could alter moderation behavior. A stored
pre-value must be an integer number or digit string in 1..3600; another existing
shape produces REFUSED without mutation. Recovery preserves JSON type and exact
string (including leading zeroes), not merely its numeric interpretation.

The source comparison and build limitations are in [SOURCE_IDENTITY.md](SOURCE_IDENTITY.md).
The image tag is operator-measured revision metadata, **not an attestation of
compiled bytes**. The wrapper records the immutable image ID as additional
receipt evidence. Changed container/image/tag or uncertain source provenance is
HOLD; do not substitute current main or redeploy to make the check pass.

## Mandatory exclusive writer window

The live handler has **no compare-and-set or distributed writer lock** and its
reads are cached. The local journal lock serializes this probe only. Read guards
are drift detectors, not atomic concurrency control.

Before starting, the operator must establish and record a window with **no other
settings writers**: no dashboard saves, other internal clients, direct database
writers or second bot process sharing these settings; no in-flight save remains.
Keep this exclusion (and the no-joins condition) until cleanup or recovery is
verified. The wrapper waits 20 seconds after the operator's assertion, allowing
the 15-second cache poll to settle before capture. It does not stop services or
change permissions to establish exclusion for you.

**If that exclusion cannot be established, HOLD: do not set the assertion.** A
read-before-write cannot protect against a concurrent write between the check
and set, an ABA change, or an unobserved cached change. Supporting an online
concurrent-writer proof would require a separately reviewed, deployed conditional
settings-write/version contract; this packet does not authorize that runtime
change. Do not claim the fixture tests prove atomic concurrency safety.

## Run (operator only)

Use a private checkout containing the approved head object. `PROOF_HEAD` must be
copied from the fresh exact-SHA review record, not a moving branch or current
main. The following block is Bash and syntax-checked; the placeholder must be
replaced with the reviewed full 40-character SHA. Fetching/checking out this
packet is source preparation, **not a bot deployment**.

```bash
set -euo pipefail
PROOF_HEAD='<independently-reviewed-full-head-sha>'
[[ "$PROOF_HEAD" =~ ^[a-f0-9]{40}$ ]] || exit 2
git fetch origin "$PROOF_HEAD"
git switch --detach "$PROOF_HEAD"
# Set this ONLY after establishing the exclusive window described above.
export PROOF_EXCLUSIVE_WINDOW=staging-writers-quiesced
bash ops/tog-4104/run-proof.sh run "$PROOF_HEAD"
```

`run-proof.sh` verifies the full commit and packet bytes, exact container name,
running state, image tag revision and image ID; then copies only the proof code
and invokes it by immutable container ID, not a replaceable name. The proof refuses missing/wrong guild,
app/runtime/source, missing keys or flags, URL credentials, redirects, non-literal
loopback and malformed/unsupported pre-state. The signing key stays in the
existing container environment. Nothing prints it, any signature, request body,
response body, journal plaintext or setting value. Never run under `set -x` or
upload the private journal directory.

Signed controls assert environment-only/unclassified-setting/action allowlist
403, malformed-signature/tampered-body/unknown-key-ID 401. The actual get/set
roundtrip asserts exact stored fixture values, allowing up to 20 seconds for the
15-second settings cache poll. Presence alone is never a passing assertion.

Both pre-states are captured before writing. Each attempted mutation has a saved
idempotency key and durable encrypted intent. `finally` restores every attempted
key, using the captured value for a stored row and null **only for proven prior
absence**. Every restored state is read back and compared exactly. Restoration
uses the signed `settings.set` path, so its normal transaction, audit,
`nextval('guild_settings_version_seq')`/timestamp for saves, and delete/count
invalidation for absence remain intact. **Do not use the previous packet's audit
SQL or select the latest old_value: that can restore the fixture rather than the
pre-run state.** No database edits are needed by this packet.

## Executable rollback / interrupted-run recovery

The container-local `/tmp/tog-4104-private` directory is owner-only (0700). Its
journal is 0600, AES-256-GCM authenticated/encrypted using a context-separated key
derived in memory from the existing signing key. Only these two non-secret numeric
settings and request identities are journaled; the signing key is never stored.
Atomic rename and fsync precede writes. Do not delete the directory or recreate
the container while recovery is pending. Do not rotate/reorder the signing key.

For socket loss/timeout or invalid write response, the probe makes one bounded
same-body/same-idempotency-key reconciliation attempt. A fresh nonce is signed;
there is no fresh operation ID. Cleanup cannot begin for an uncertain write until
a completed result is obtained; matching readback alone is not proof that a late
write cannot still land. Cleanup may make another bounded reconciliation attempt.
Any response uncertainty keeps the original run **PROOF FAIL**, even when cleanup
succeeds. There is no background retry loop. Explicit pre-action `429 rate_limited`
gets one 1.1-second backoff with a fresh nonce; polling is every two seconds to
respect the live 20-token burst / one-token-per-second refill.

**Lease boundary:** the live idempotency store allows unfenced takeover of an
in-flight claim at 60 seconds. A completed result is retained, but an unfinished
claim is not an exactly-once guarantee. The journal timestamps each write intent;
the executable refuses automatic reconciliation once its age reaches 45 seconds
(or the clock moves backward), leaving a 15-second margin. `failure:
write.reconciliation-expired` means HOLD for reconciliation of receiver-side
completion and the saved pre-state, not a fresh ID, journal edit, or blind retry.
This packet deliberately does not supply automatic recovery of an old ambiguous
in-flight request. A confirmed `written` checkpoint can still be restored later;
an old `writePending` or `restorePending` checkpoint cannot be replayed safely by
this tool. Machine/DB stalls and loss of the exclusive window also require HOLD.

If output says `recovery-required`, keep the exclusive window and use the exact
same reviewed source and unchanged container/key. This is rollback, not a new
proof. It loads the authenticated pre-run journal rather than capturing the
fixture as a new baseline:

```bash
set -euo pipefail
PROOF_HEAD='<same-independently-reviewed-full-head-sha>'
[[ "$PROOF_HEAD" =~ ^[a-f0-9]{40}$ ]] || exit 2
export PROOF_EXCLUSIVE_WINDOW=staging-writers-quiesced
bash ops/tog-4104/run-proof.sh recover "$PROOF_HEAD"
```

Recovery refuses a still-running probe (PID lock), wrong source/endpoint or
unreadable/tampered journal. After a killed process, it removes the stale lock
only when that PID demonstrably no longer exists. A reused/live PID produces
HOLD, not an automatic kill. It settles recorded pending writes using their
original idempotency IDs, then restores exact pre-state and verifies both keys.
It emits `RECOVERED`, **never PROOF PASS**. A new normal run cannot overwrite an
outstanding journal. Do not launch recovery while an original run is still live.

If readback detects another writer's value, the probe stops without overwriting
that value. If idempotency outcome stays uncertain, the journal is missing, the
container was replaced, the key changed, or recovery still fails: **HOLD, no
manual blind overwrite/unset and no new proof**. Record the redacted failure on
the existing host card for a bounded reconciliation decision. Retain the
journal; do not export/decrypt it into a ticket. Keep flags at 1; they predate this
packet and are never changed by its run or rollback.

## Exit codes and redacted evidence

- `0 PROOF PASS`: signed positive/negative controls and exact cleanup passed.
- `0 RECOVERED`: rollback verified only; not live staging acceptance.
- `1 PROOF FAIL`: assertion, interruption, response uncertainty or cleanup failed.
- `2 REFUSED`: this invocation has not attempted a mutation; an older pending
  recovery may still exist. A refusal is not permission to discard that journal.

Post the wrapper's image ID/proof-source lines and the probe's single JSON receipt
on [TOG-3706](/TOG/issues/TOG-3706), plus the exclusive-window start/end timestamps.
The receipt carries runtime, proof source, each key's prior presence,
`cleanup: exact-prestate-verified | recovery-required | not-started`, uncertainty
and verdict; no settings values, signatures or key IDs. The merged packet/test
links are evidence of preparation only. Parent acceptance and the product-capacity
gate remain blocked pending authorized live execution and remaining evidence.

## Remaining acceptance gaps

- HMAC failure is **not** website non-admin authorization denial. Obtain the
  staging website non-admin route/contract test evidence separately.
- A store roundtrip does not prove Discord behavior, website UX or full-runtime
  equivalence. Cache-aware equality is tested; not deployment reproducibility.
- Exclusive writer control is an operator precondition, not supplied by this API.
- No host/live run was performed by the packet author. Offline tests use HTTP
  fixtures with actual stored values and execute this exact probe and recovery.

## Offline verification

```bash
node --check ops/tog-4104/settings-signed-proof.mjs
bash -n ops/tog-4104/run-proof.sh
node --test test/tog4104-settingspoof-offline.test.mjs
node --test test/tog4104-wrapper-offline.test.mjs
node --test test/tog4104-offline.test.ts
```
