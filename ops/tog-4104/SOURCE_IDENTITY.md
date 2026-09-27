# Source identity: pinned wired runtime 7995b3f

## Pin choice

- Pinned runtime `7995b3fb13feda26ae35356bc5227c67870370c9`: merge commit of
  PR #175 (TOG-3186), merged 2026-09-26T02:14:02Z. It is an ancestor of
  `origin/main` (`git merge-base --is-ancestor 7995b3f origin/main` → true).
- Why this commit: it is the reviewed main-line merge that contains the
  startup wiring fix `15b8f6c2` (PR #172, TOG-4230, merged 2026-09-24):
  `git merge-base --is-ancestor 15b8f6c 7995b3f` → true. That fix passes the
  already-loaded `settings` store into `startInternalActions` beside the
  durable store, so with the existing settings flags enabled both settings
  verbs are served instead of refused with `action_not_allowed`.
- The rejected runtime `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90` (TOG-4104
  HOLD) shares no ancestry with this pin in either direction. The prior
  packet's HOLD conclusion for that runtime stands; this packet does not
  re-authorize it. `run-proof.sh` refuses any `PROOF_RUNTIME_REVISION` other
  than the pin below before any Docker operation.

Reproduce the topology (no moving refs, no abbreviated SHAs):

```bash
PIN=7995b3fb13feda26ae35356bc5227c67870370c9
FIX=15b8f6c278c58c5653fe0ef85f1695a57a4361e8
OLD=f5fd3e1d6d08847589d3bf48ebc0b0e198196e90
for o in "$PIN" "$FIX" "$OLD"; do git cat-file -t "$o"; done
git merge-base --is-ancestor "$FIX" "$PIN" && echo fix-in-pin
git merge-base --is-ancestor "$PIN" origin/main && echo pin-on-main
git merge-base --is-ancestor "$OLD" "$PIN" || echo old-not-in-pin
git merge-base --is-ancestor "$PIN" "$OLD" || echo pin-not-in-old
```

## Review and CI provenance of the pin (recorded, not re-asserted)

- PR #175's only recorded review is a COMMENTED self-review by the author
  (GitHub blocks self-APPROVE); author and merger are the same identity, and
  PR #172 records no reviews. This packet does **not** claim independent
  review of the pin.
- Check-runs on the pin commit report success for `check`, `postgres`,
  `gitleaks` and `fork-gate` (queried 2026-09-26 via the check-runs API).
- Image provenance is **not** established by source identity: the operator
  must deploy exactly this commit and supply the resulting immutable image ID
  as `PROOF_IMAGE_ID`. The wrapper compares it against the live container's
  inspected image ID; tags and revision labels alone are not attestation.
- This packet (new wrapper + re-pin) still needs fresh exact-head Code
  Reviewer approval, green required CI on its own head, and a non-author
  merge before any authorized host use. See [RUNBOOK.md](RUNBOOK.md).

## Wired startup at the pin

At `7995b3f`, `src/index.ts:881-910` passes `settings` (the initialized
`SettingsStore`, constructed and loaded earlier in startup) into
`startInternalActions`. `src/internal/server.ts:303-305` evaluates
`opts.settings ?? null`, and `src/internal/actions.ts:215-242`
(`assertAllowed`) only refuses settings verbs with `action_not_allowed` /
`action_needs_settings` when that port is missing. With the store present and
the verbs enabled, both `settings.get` and `settings.set` are allowed.

Seven byte-exact excerpts (file blob IDs and line ranges) are committed in
`test/fixtures/tog4104-runtime-source.json` so shallow/offline CI can execute
the pinned startup without a full checkout:

| Block | Path | Blob | Lines |
|---|---|---|---|
| `startup` | `src/index.ts` | `204b81b79b6988a9b9a4fa99d216ecb4a3c51b6a` | 881-910 |
| `serverGate` | `src/internal/server.ts` | `5fe42441a964a5c4c2bbd4758d305ee2cdc2fa92` | 303-305 |
| `implemented` | `src/internal/actions.ts` | `3421bcb86d670dcd32a916653cea92f9e9a6aa3c` | 29-40 |
| `needsStores` | `src/internal/actions.ts` | `3421bcb86d670dcd32a916653cea92f9e9a6aa3c` | 50-68 |
| `isImplemented` | `src/internal/actions.ts` | `3421bcb86d670dcd32a916653cea92f9e9a6aa3c` | 207-209 |
| `assertAllowed` | `src/internal/actions.ts` | `3421bcb86d670dcd32a916653cea92f9e9a6aa3c` | 215-242 |
| `actionError` | `src/internal/errors.ts` | `5731256e009c25c745f38641703c128e73cdf2fe` | 69-82 |

`test/tog4104-runtime-wiring.test.ts` executes the actual pinned startup call,
the server null-default/gate and the action authorization code above.
Constructors are stubbed; both verbs are enabled and a settings sentinel is in
scope. The pinned call wires the sentinel through and both verbs are allowed.
A control with the `settings,` line removed re-opens the TOG-4104 denial, and
null settings, disabled actions and a missing durable store still refuse. This
is a targeted startup-options integration witness, **not** full app/HTTP/DB
bootstrap evidence.

Recheck excerpt provenance against the pinned object, never a moving checkout:

```bash
node ops/tog-4104/verify-runtime-source.mjs
node --test test/tog4104-runtime-wiring.test.ts
```

## Identity limitations

- Static Git comparison, not a live execution result. Source facts about cache,
  authentication and wiring are not evidence of what the operator's container
  runs; only the operator's deploy receipt plus the wrapper's inspected
  container/image IDs attest that.
- `Dockerfile` uses floating `node:24-bookworm-slim`. Matching source does not
  attest base image digest, installed modules, build context, local edits or
  mounted overlays. That is what `PROOF_IMAGE_ID` is for.
- The live write contract has no CAS. Mandatory external writer exclusion and
  interrupted-run recovery limitations are explicit in [RUNBOOK.md](RUNBOOK.md).
- No full-runtime equivalence, website non-admin denial or live acceptance is
  claimed. The TOG-4104 HOLD packet's adverse findings for `f5fd3e1` are
  unchanged and out of scope here.
