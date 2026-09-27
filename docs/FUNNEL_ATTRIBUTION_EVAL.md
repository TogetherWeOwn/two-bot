# Funnel attribution golden eval

The ambiguous-vs-unknown split is a prompt-quality contract, not just code.
`ambiguous` ("several codes moved and the arithmetic does not close") and
`unknown` ("nothing moved, the invite delta is lost") are different facts
about what happened — simultaneous launches versus an offline bot — and they
ask for opposite fixes. A report line, prompt, or summary that merges them
into one "unattributed" bucket hides which problem to fix. This eval keeps
the buckets apart.

Parent work: [TOG-5681](/TOG/issues/TOG-5681) (the funnel-report split).
This card: [TOG-5849](/TOG/issues/TOG-5849) (the golden case set + eval).

## Running it

```bash
npm run eval:funnel-attribution          # human-readable, per-case lines + fixture split
node scripts/funnel-attribution-eval.ts --json   # same result as JSON (sources, exact flags, per-bucket tally)
npm run test:postgres                   # required CI path, which runs the eval first via scripts/ci/run-check-job.sh
node --test test/unit.funnel-attribution-eval.test.ts   # the eval checking itself, offline
```

Fully offline: no network, no database, no Discord token, no secrets. The
eval drives the real code in `src/core/inviteTracker.ts` (`inviteGrowth` +
`attributeJoins` for window cases, `InviteTracker.attribute` for the legacy
single-join path), so a change to the attribution rules that breaks a bucket
reds here. Exit 0 means all 16 golden cases passed; exit 1 means a case
failed or the fixture is malformed.

## What it scores

Not just a pass count — the **fixture split**, printed on the last lines:

```
funnel-attribution-eval: 16/16 golden cases passed
  fixture split  ambiguous: 3/3  unknown: 3/3  vanity: 2/2  invite-exact: 2/2  invite-placed: 6/6
```

Every answer in a case must sit in the case's bucket. A per-code split
labeled ambiguous (or vice versa) fails even if the strings match an
expectation — that category check is what makes this an
ambiguous-vs-unknown eval rather than a generic assertion file.

## Adding a case

Cases live in `test/fixtures/funnel-attribution-golden.json` (versioned;
the eval refuses a version it does not understand). One case:

| Field | Meaning |
|---|---|
| `id` | Unique, kebab-case. The eval refuses duplicates. |
| `title` / `why` | One line each. `why` must say which real-world shape the case pins and what regression it guards — a case without a reason is rejected by the unit test. |
| `kind` | `window` (invite-counter diff → `attributeJoins`) or `legacy-attribute` (one instant's growers → `InviteTracker.attribute`). |
| `scenario` | Window: `prevUses` map, `currentUses` list of `{code, uses}`, `joinCount`, `guildHasVanity`. Legacy: `grew` list, `guildHasVanity`. |
| `expect` | Window: exact `sources` array plus the `exact` flag per answer. Legacy: the single `source` string. |
| `expectCategory` | The bucket every answer must sit in: `ambiguous`, `unknown`, `vanity`, `invite-exact` (only when one code moved and the count closes), or `invite-placed`. |

Rules for a good case:

1. **Drive the real code.** Expectations are computed from `inviteGrowth`
   output, not hand-built growth maps — the magnitudes must survive the
   whole path to the event.
2. **Name the boundary.** The most valuable cases sit exactly on one:
   closing vs. not closing with the same counters (compare
   `ambiguous-two-codes-no-close` with `split-exact-counts-not-ambiguous`),
   or a reset code that would flip `invite-exact` to `unknown` unclamped
   (`counter-reset-clamp-feeds-exact`).
3. **Keep the category floors in mind.** `test/unit.funnel-attribution-eval.test.ts`
   requires ≥3 ambiguous and ≥3 unknown cases and ≥1 of each other bucket.
   Deleting a bucket's coverage reds the build; adding cases never does.
4. **Do not hand-pin models, routes, or credentials.** There is nothing to
   pin: the eval is deterministic and offline by construction.

## When it goes red

- A `FAIL` line names the case, the bucket, and the mismatch (`sources …,
  expected …` / `N answer(s) outside bucket …`). Fix the code or, if the
  attribution rules deliberately changed, update the fixture's `expect` in
  the same commit and say why in the case's `why`.
- `golden fixture has no cases` / `duplicate golden case id` / version
  mismatch: the fixture edit broke the eval's own guardrails, not the
  attribution code. Fix the fixture.
