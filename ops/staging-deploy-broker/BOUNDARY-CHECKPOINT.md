# Staging broker boundary checkpoint — 2026-09-30

Scope: the adverse exact-head review of `407017d0481dc806c164121503a770c0d8391f2a`
on [PR #291](https://github.com/TogetherWeOwn/two-bot/pull/291),
[TOG-9053](/TOG/issues/TOG-9053). This is author evidence, not approval,
an installation instruction, or a successful staging deployment receipt.

## Decisions

1. **Decoded semantic equality is not a security proof.** JSON parsing discards
   overwritten duplicate keys. Every embedded object/array is now emitted from
   its depth-bounded shaped value, never from its original bytes. Canonicalizing
   benign JSON whitespace is intentional; `msg`, `guilds` and timestamps survive.
   The original unbounded decoded object is never stringified for comparison.
2. **JSON quote state is candidate-local.** Quotes in prose do not suppress a
   following candidate. Arrays, objects, nested records and JSON-in-string values
   share the recursive redaction policy.
3. **PEM context belongs to the bounded batch.** Inspect every BEGIN/END
   transition before per-entry shaping or truncation. An unmatched END means the
   batch started inside a key: redact the preceding tail. An unmatched BEGIN
   redacts the remainder. Completing and reopening blocks within an entry must
   update context for subsequent entries.
4. **Inspect without unbounded serialization.** Walk panel objects iteratively,
   including field names, with node/text budgets. Decode JSON escape sequences
   conservatively in an inspection-only view so Unicode-escaped markers cannot
   strand body entries. If offsets differ or an object overlaps a PEM span,
   collapse the entry instead of splicing unsafe offsets. Exceeding inspection
   budgets redacts the entire batch. Deep objects still reach the shaping depth
   guard and return HTTP 200 with redaction, not a stack-overflow HTTP 500.
5. **Do not exempt a fixture path or disable private-key scanning.** Historical
   false positives are four exact commit/file/rule/line fingerprints in
   `.gitleaksignore`. Current tests construct marker labels; their runtime
   fixtures are unchanged. A new same-path synthetic base64-shaped private-key
   fixture remains detectable with the ignore file installed.

## Verification

- Published pre-fix broker, exercised with the new tests: all seven residual
  leak scenarios and the deep-wrapper regression reproduce. No live panel,
  service, database, credential or deployment is used.
- Corrected broker: `node --test ops/staging-deploy-broker/server.test.mjs` —
  **49/49**. Eleven added tests include seven real-handler leak cases exercised
  as raw and object-wrapped entries, a 12,000-level object and embedded JSON span,
  budget exhaustion, multiple marker spans, and actual smoke-parser assertions.
- `node scripts/deploy-target-selftest.mjs` — **32/32**; fail-closed missing-target
  gates and hosted HTTPS transport remain unchanged.
- `npm run typecheck` and `git diff --check` pass.
- CI-pinned gitleaks **8.30.1**: branch-history scan (`origin/main..HEAD`) and
  current-directory scan pass. Before the exceptions, the history scan returned
  exactly the four reviewed synthetic private-key fingerprints. Calibration
  with the exceptions enabled still reports a new private-key-shaped fixture.

## Remaining gates and limits

This patch closes enumerated reproductions; it is not a proof that arbitrary
unstructured plaintext can never contain an unknown secret. Raw gaps still use
known host-credential and generic-pattern scrubbing. Structured sensitive fields
and PEM regions use the stronger shaping policy above. A future typed,
smoke-record-only interface would reduce raw-log privilege, but changing that
interface is not silently included in this correction.

Independent exact-head approval plus green required CI remains mandatory. Only
then may the existing [TOG-8272](/TOG/issues/TOG-8272) operator handoff install
an approved, pinned artifact with rollback and provision its scoped staging
credential. Hosted-runner reachability and a successful GitHub staging Deployment
plus smoke are still unverified. No panel bearer goes to Actions; the staging app
pin is unchanged. [TOG-6903](/TOG/issues/TOG-6903) production HOLD remains.
