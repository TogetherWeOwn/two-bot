# Source identity: settings-wiring surface baseline c2a00876

## Why a surface baseline, not a runtime pin

Staging redeploys on nearly every merge, so a fixed runtime SHA goes stale
within hours — twice in 24 h before this packet (`7995b3f`, then `5f57256d`,
then `47c48197`, each refused at run time). This packet pins the
settings-wiring surface instead of the whole runtime: at run time the wrapper
takes the operator-measured running commit and verifies its surface files are
byte-identical to the reviewed baseline below. It refuses otherwise. A newer
staging SHA with an untouched surface runs; the pin no longer expires on
every redeploy.

## Baseline choice

- Surface baseline `c2a00876d9772c0e341e7aed643518cf02d100a3`: the staging
  runtime the operator measured on 2026-09-28T15:15Z (TOG-8977 hand-back).
  Prior pins `47c48197d46647e34132544523e863e3c92d82ff` (PR #244),
  `5f57256d41130b056389f3098f3b0c84a9d9e261` (PR #209) and
  `7995b3fb13feda26ae35356bc5227c67870370c9` are all ancestors of it, and it
  is an ancestor of `origin/main`.
- Why this commit: it still contains the startup wiring fix `15b8f6c2` (PR
  #172, TOG-4230, merged 2026-09-24):
  `git merge-base --is-ancestor 15b8f6c c2a00876` → true. That fix passes the
  already-loaded `settings` store into `startInternalActions` beside the
  durable store, so with the existing settings flags enabled both settings
  verbs are served instead of refused with `action_not_allowed`.
- The wiring surface is byte-stable across the whole stale-pin window: the
  `startup` excerpt text is identical at `47c48197` and `c2a00876` (same
  sha256 `006bfbfd…`); the settings gate excerpts (`needsStores`,
  `isImplemented`, `assertAllowed`, `serverGate`, `actionError`) are
  text-identical with only +1 line shifts in `src/internal/actions.ts`. The
  wiring files changed in 6 of 213 commits `5f57256d..origin/main`, and zero
  times `c2a00876..origin/main` (27 commits).
- The delta from the prior pin `47c48197` to this baseline adds the gated
  `event.read` mapped-event verifier (TOG-5510, commit `601f5337`, PR #266:
  +90 `discordActions.ts`, +48 `actions.ts`, +6 `config.ts`,
  `TWO_INTERNAL_ALLOW_EVENT_READ` default-off) plus `env_only` catalog
  bookkeeping. It does not touch the settings path: `settings.get`/`set`
  dispatch, `NEEDS_SETTINGS_STORE`, the settings handlers and the settings
  flag block are unchanged. PR #266 merged with no recorded reviews, so this
  packet attests the settings path is byte-identical to the reviewed pin —
  not that `event.read` is approved. The flag stays default-off in the proof
  environment.
- The rejected runtime `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90` (TOG-4104
  HOLD) shares no ancestry with this baseline in either direction. The prior
  packet's HOLD conclusion for that runtime stands; this packet does not
  re-authorize it. `run-proof.sh` refuses a malformed runtime declaration and
  any touched surface before any Docker copy or exec.

Reproduce the topology (no moving refs, no abbreviated SHAs):

```bash
BASE=c2a00876d9772c0e341e7aed643518cf02d100a3
FIX=15b8f6c278c58c5653fe0ef85f1695a57a4361e8
OLD=f5fd3e1d6d08847589d3bf48ebc0b0e198196e90
PREV=47c48197d46647e34132544523e863e3c92d82ff
for o in "$BASE" "$FIX" "$OLD" "$PREV"; do git cat-file -t "$o"; done
git merge-base --is-ancestor "$FIX" "$BASE" && echo fix-in-baseline
git merge-base --is-ancestor "$PREV" "$BASE" && echo prev-in-baseline
git merge-base --is-ancestor "$BASE" origin/main && echo baseline-on-main
git merge-base --is-ancestor "$OLD" "$BASE" || echo old-not-in-baseline
git merge-base --is-ancestor "$BASE" "$OLD" || echo baseline-not-in-old
```

## Review and CI provenance of the baseline (recorded, not re-asserted)

- The baseline is the operator-measured staging runtime, not a reviewed PR
  head. This packet does **not** claim independent review of the baseline
  commit as a whole — only that its settings-wiring surface is byte-identical
  to the reviewed excerpts (verified below).
- Image provenance is **not** established by source identity: the operator
  must supply the resulting immutable image ID as `PROOF_IMAGE_ID`. The
  wrapper compares it against the live container's inspected image ID; tags
  and revision labels alone are not attestation.
- This packet (surface check + re-baseline) still needs fresh exact-head Code
  Reviewer approval, green required CI on its own head, and a non-author
  merge before any authorized host use. See [RUNBOOK.md](RUNBOOK.md).

## Wired startup at the baseline

At `c2a00876`, `src/index.ts:946-975` passes `settings` (the initialized
`SettingsStore`, constructed and loaded earlier in startup) into
`startInternalActions`. `src/internal/server.ts:303-305` evaluates
`opts.settings ?? null`, and `src/internal/actions.ts:216-243`
(`assertAllowed`) only refuses settings verbs with `action_not_allowed` /
`action_needs_settings` when that port is missing. With the store present and
the verbs enabled, both `settings.get` and `settings.set` are allowed.
`src/internal/config.ts:100-107` gates both verbs on the environment-only
`TWO_INTERNAL_ALLOW_SETTINGS=1` flag, default off.

Eight byte-exact excerpts (file blob IDs and line ranges) are committed in
`test/fixtures/tog4104-runtime-source.json` so shallow/offline CI can execute
the pinned surface without a full checkout:

| Block | Path | Blob | Lines |
|---|---|---|---|
| `startup` | `src/index.ts` | `f89e5100dffd12630eac24d9a18f3d3988dbad14` | 946-975 |
| `serverGate` | `src/internal/server.ts` | `5fe42441a964a5c4c2bbd4758d305ee2cdc2fa92` | 303-305 |
| `implemented` | `src/internal/actions.ts` | `5e98ab1e92aff4f14cd7c5dfa8e74886a351bb93` | 29-41 |
| `needsStores` | `src/internal/actions.ts` | `5e98ab1e92aff4f14cd7c5dfa8e74886a351bb93` | 51-69 |
| `isImplemented` | `src/internal/actions.ts` | `5e98ab1e92aff4f14cd7c5dfa8e74886a351bb93` | 208-210 |
| `assertAllowed` | `src/internal/actions.ts` | `5e98ab1e92aff4f14cd7c5dfa8e74886a351bb93` | 216-243 |
| `actionError` | `src/internal/errors.ts` | `5731256e009c25c745f38641703c128e73cdf2fe` | 69-82 |
| `settingsFlag` | `src/internal/config.ts` | `ff92c2470dad5f3a70ce7ac7f169851e2811649b` | 100-107 |

`test/tog4104-runtime-wiring.test.ts` executes the actual surface excerpts:
the pinned startup call, the server null-default/gate, the action
authorization code and the settings flag (off by default, both verbs enabled
when set). Constructors are stubbed; both verbs are enabled and a settings
sentinel is in scope. The pinned call wires the sentinel through and both
verbs are allowed. A control with the `settings,` line removed re-opens the
TOG-4104 denial, and null settings, disabled actions and a missing durable
store still refuse. This is a targeted startup-options integration witness,
**not** full app/HTTP/DB bootstrap evidence.

Recheck excerpt provenance against the baseline object, never a moving checkout:

```bash
node ops/tog-4104/verify-runtime-source.mjs
node ops/tog-4104/verify-runtime-source.mjs <candidate-sha>
node --test test/tog4104-runtime-wiring.test.ts
```

A candidate runtime whose surface is byte-identical passes the verifier; any
touched surface fails with the drifted block named.

## Identity limitations

- Static Git comparison, not a live execution result. Source facts about cache,
  authentication and wiring are not evidence of what the operator's container
  runs; only the operator's deploy receipt plus the wrapper's inspected
  container/image IDs and the surface byte-comparison attest that.
- `Dockerfile` uses a digest-pinned `node:24-bookworm-slim`, but matching
  surface files do not attest base image digest, installed modules, build
  context, local edits or mounted overlays. That is what `PROOF_IMAGE_ID` is
  for.
- The surface check covers the six wiring files' full bytes, not just the
  excerpts — stronger than the excerpt witness, but still not full-runtime
  equivalence. A change outside the surface files (new verbs, new Discord
  calls, new jobs) passes the check by design; the check answers only "is
  the reviewed settings path what is running".
- The live write contract has no CAS. Mandatory external writer exclusion and
  interrupted-run recovery limitations are explicit in [RUNBOOK.md](RUNBOOK.md).
- No full-runtime equivalence, website non-admin denial or live acceptance is
  claimed. The TOG-4104 HOLD packet's adverse findings for `f5fd3e1` are
  unchanged and out of scope here.
