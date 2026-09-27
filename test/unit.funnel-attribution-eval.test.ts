/**
 * The golden ambiguous-vs-unknown eval, checked itself (TOG-5849, the
 * prompt-quality slice of TOG-5681).
 *
 * A guard nobody has watched fail is not a guard. The failure this one exists
 * to catch - a report or prompt that merges "several codes moved" with
 * "nothing moved" into one unattributed bucket - only matters on a day when
 * the campaign is asking which listing produces joins, and by then it is too
 * late to find out the eval was string-matching without checking the bucket.
 * So the merges are staged here from synthetic cases rather than waited for.
 *
 * Fully offline: the eval drives inviteGrowth/attributeJoins and the
 * no-database InviteTracker.attribute path, so this runs under plain
 * `npm test` with no Postgres, no token, and no secrets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  categoryOf,
  evaluateCase,
  loadFixture,
  scoreRun,
  type GoldenCase,
} from '../scripts/funnel-attribution-eval.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A window case shaped like the fixture's, overridden per test. */
function windowCase(over: Partial<GoldenCase> & { id: string }): GoldenCase {
  return {
    title: 'synthetic',
    why: 'synthetic',
    kind: 'window',
    scenario: {
      prevUses: { aaa: 5, bbb: 1 },
      currentUses: [
        { code: 'aaa', uses: 7 },
        { code: 'bbb', uses: 2 },
      ],
      joinCount: 2,
      guildHasVanity: false,
    },
    expect: { sources: ['ambiguous:aaa+bbb', 'ambiguous:aaa+bbb'], exact: [false, false] },
    expectCategory: 'ambiguous',
    ...over,
  };
}

test('the golden fixture loads and every bucket is populated', () => {
  const cases = loadFixture();
  // Floors, not equalities: adding cases must never red the build, deleting
  // the bucket coverage must. The ambiguous-vs-unknown split is the whole
  // point, so those two buckets carry the higher floor.
  assert.ok(cases.length >= 12, `only ${cases.length} golden cases`);
  const inBucket = (cat: string) => cases.filter((c) => c.expectCategory === cat).length;
  assert.ok(inBucket('ambiguous') >= 3, 'the ambiguous bucket needs its split coverage');
  assert.ok(inBucket('unknown') >= 3, 'the unknown bucket needs its split coverage');
  for (const cat of ['vanity', 'invite-exact', 'invite-placed']) {
    assert.ok(inBucket(cat) >= 1, `bucket ${cat} is empty: the eval would pass by asserting nothing about it`);
  }
  assert.deepEqual(
    new Set(cases.map((c) => c.id)).size,
    cases.length,
    'duplicate golden case ids',
  );
  for (const c of cases) {
    assert.ok(c.why.length > 0, `case ${c.id} has no recorded reason`);
  }
});

test('every golden case passes against the real attribution code', () => {
  const summary = scoreRun(loadFixture());
  assert.equal(summary.failed, 0, summary.results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`).join('\n'));
  assert.equal(summary.passed, summary.results.length);
});

test('merging ambiguous into unknown fails the eval even when the strings match', () => {
  // Nothing moved, so the code honestly answers unknown - but the case claims
  // the ambiguous bucket. String equality alone would pass this; the category
  // check is what makes it an ambiguous-vs-unknown eval.
  const merged = windowCase({
    id: 'synthetic-merged',
    scenario: {
      prevUses: { a: 2 },
      currentUses: [{ code: 'a', uses: 2 }],
      joinCount: 1,
      guildHasVanity: false,
    },
    expect: { sources: ['unknown'], exact: [false] },
    expectCategory: 'ambiguous',
  });
  const r = evaluateCase(merged);
  assert.equal(r.ok, false, 'a merge of the two buckets must fail');
  assert.match(r.detail, /outside bucket ambiguous/);
});

test('a placed per-code split mislabeled ambiguous fails', () => {
  // A +2 / B +1 with 3 arrivals is fully determined in aggregate. Labeling it
  // ambiguous throws away the campaign's per-code join counts - the exact
  // regression TOG-5681 exists to prevent.
  const mislabeled = windowCase({
    id: 'synthetic-split-as-ambiguous',
    scenario: {
      prevUses: { aaa: 5, bbb: 1 },
      currentUses: [
        { code: 'aaa', uses: 7 },
        { code: 'bbb', uses: 2 },
      ],
      joinCount: 3,
      guildHasVanity: false,
    },
    expect: {
      sources: ['invite:aaa', 'invite:aaa', 'invite:bbb'],
      exact: [false, false, false],
    },
    expectCategory: 'ambiguous',
  });
  const r = evaluateCase(mislabeled);
  assert.equal(r.ok, false);
  assert.match(r.detail, /outside bucket ambiguous/);
});

test('an unknown mislabeled ambiguous fails on the legacy single-join path too', () => {
  const r = evaluateCase({
    id: 'synthetic-legacy-merged',
    title: 'synthetic',
    why: 'synthetic',
    kind: 'legacy-attribute',
    scenario: { grew: [], guildHasVanity: false },
    expect: { source: 'unknown' },
    expectCategory: 'ambiguous',
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /outside bucket ambiguous/);
});

test('a wrong exact flag fails even when the sources are right', () => {
  // One code moved and the count closes: the only exact case. Claiming
  // exact=false here would silently demote the one proven attribution.
  const r = evaluateCase(
    windowCase({
      id: 'synthetic-exact-demotion',
      scenario: {
        prevUses: { aB3xY9: 4 },
        currentUses: [{ code: 'aB3xY9', uses: 5 }],
        joinCount: 1,
        guildHasVanity: false,
      },
      expect: { sources: ['invite:aB3xY9'], exact: [false] },
      expectCategory: 'invite-exact',
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.detail, /exact/);
});

test('the per-bucket tally scores the fixture split, not just a pass count', () => {
  const summary = scoreRun([
    windowCase({ id: 'a' }),
    windowCase({
      id: 'u',
      scenario: {
        prevUses: { a: 2 },
        currentUses: [{ code: 'a', uses: 2 }],
        joinCount: 1,
        guildHasVanity: false,
      },
      expect: { sources: ['unknown'], exact: [false] },
      expectCategory: 'unknown',
    }),
  ]);
  assert.deepEqual(summary.byCategory.ambiguous, { passed: 1, total: 1 });
  assert.deepEqual(summary.byCategory.unknown, { passed: 1, total: 1 });
  assert.deepEqual(summary.byCategory.vanity, { passed: 0, total: 0 });
});

/**
 * Doc↔fixture↔script taxonomy pin (TOG-6503, gap landed after round-1 via
 * TOG-5849 PR #206).
 *
 * The `expectCategory` row in docs/FUNNEL_ATTRIBUTION_EVAL.md is the
 * authoritative bucket list. This test pins all three surfaces to it: the
 * eval script's CATEGORIES, the fixture's expectCategory values, and the
 * script's verdict mapping. Rename one label in the doc row and this fails.
 * It deliberately does NOT re-check attribution logic (TOG-5681 owns that) —
 * expected sources are categorized directly, without driving the real code.
 */
test('doc taxonomy pins fixture buckets and script verdict labels (TOG-6503)', () => {
  const doc = readFileSync(join(ROOT, 'docs/FUNNEL_ATTRIBUTION_EVAL.md'), 'utf8');

  // 1. The doc's authoritative taxonomy row lists exactly the script buckets.
  const row = doc.split('\n').find((l) => l.includes('`expectCategory`'));
  assert.ok(row, 'doc no longer defines the `expectCategory` taxonomy row');
  const bucketsInDoc = [...row.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1] as string)
    .filter((t) => t !== 'expectCategory');
  assert.deepEqual(
    [...bucketsInDoc].sort(),
    [...CATEGORIES].sort(),
    `doc taxonomy drift: doc lists [${bucketsInDoc.join(', ')}], script has [${[...CATEGORIES].join(', ')}]`,
  );

  // 2. The fixture uses exactly the doc taxonomy — no silent bucket add/drop.
  const cases = loadFixture();
  const bucketsInFixture = [...new Set(cases.map((c) => c.expectCategory))].sort();
  assert.deepEqual(
    bucketsInFixture,
    [...bucketsInDoc].sort(),
    `fixture buckets [${bucketsInFixture.join(', ')}] disagree with doc taxonomy [${bucketsInDoc.join(', ')}]`,
  );

  // 3. The script's verdict mapping matches the doc's stated meanings.
  assert.equal(categoryOf('ambiguous:a+b', false), 'ambiguous');
  assert.equal(categoryOf('unknown', false), 'unknown');
  assert.equal(categoryOf('vanity', false), 'vanity');
  assert.equal(categoryOf('invite:abc', true), 'invite-exact');
  assert.equal(categoryOf('invite:abc', false), 'invite-placed');

  // 4. Every fixture expectation sits in its claimed bucket (taxonomy only —
  // no attribution code runs here; evaluateCase covers the live path above).
  for (const c of cases) {
    const exp = c.expect;
    if ('sources' in exp) {
      exp.sources.forEach((s, i) => {
        assert.equal(
          categoryOf(s, exp.exact[i] as boolean),
          c.expectCategory,
          `case ${c.id}: expected source ${s} (exact=${exp.exact[i]}) is outside bucket ${c.expectCategory}`,
        );
      });
    } else {
      // Legacy single-join path records no exactness: placement by construction.
      assert.equal(
        categoryOf(exp.source, false),
        c.expectCategory,
        `case ${c.id}: expected source ${exp.source} is outside bucket ${c.expectCategory}`,
      );
    }
  }
});

test('fixture validation rejects version drift, duplicates, and an empty set', () => {
  const work = mkdtempSync(join(tmpdir(), 'golden-fixture-'));
  try {
    const good = loadFixture();
    const write = (name: string, doc: unknown) => {
      const p = join(work, name);
      writeFileSync(p, JSON.stringify(doc));
      return p;
    };
    assert.throws(() => loadFixture(write('bad-version.json', { version: 999, cases: good })), /version/);
    assert.throws(
      () => loadFixture(write('dupes.json', { version: 1, cases: [good[0], good[0]] })),
      /duplicate golden case id/,
    );
    assert.throws(() => loadFixture(write('empty.json', { version: 1, cases: [] })), /no cases/);
    assert.throws(() => loadFixture(join(work, 'missing.json')), /cannot read golden fixture/);
    assert.throws(
      () => loadFixture(write('bad-kind.json', { version: 1, cases: [{ ...good[0], kind: 'oracle' }] })),
      /unknown kind/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
