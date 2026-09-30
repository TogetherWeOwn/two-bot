import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations } from '../src/store/migrate.ts';

/**
 * Migration number-range ratchet (TOG-9996).
 *
 * migrations/README.md splits the shared directory between two teams:
 * bot owns 0001–0999, the website owns 1000–1999. Nothing enforces that, so
 * a mistyped number silently lands in the other team's range and the next
 * merge collides. This test is the ratchet.
 *
 * Reviewer check: drop a comment-only `migrations/2000_probe.sql` fixture
 * and run this file — the on-disk test fails naming the range rule below.
 * Delete the fixture afterwards; it must never be committed.
 */
export const RANGE_RULE =
  'migration range rule: bot migrations stay in 0001–0999, website migrations in 1000–1999 (see migrations/README.md)';

const ID_PATTERN = /^(\d{4})_[a-z0-9_]+$/;

export function rangeViolation(id: string): string | null {
  const match = ID_PATTERN.exec(id);
  if (!match) return `${id} violates the ${RANGE_RULE} (expected NNNN_short_snake_case.sql)`;
  const n = Number(match[1]);
  if ((n >= 1 && n <= 999) || (n >= 1000 && n <= 1999)) return null;
  return `${id} violates the ${RANGE_RULE}`;
}

test('every on-disk migration falls in its team range', () => {
  const violations = loadMigrations()
    .map((migration) => rangeViolation(migration.id))
    .filter((violation): violation is string => violation !== null);
  assert.equal(violations.length, 0, `out-of-range migrations:\n${violations.join('\n')}`);
});

test('range edges pass and out-of-range ids name the rule', () => {
  for (const ok of ['0001_first', '0999_bot_edge', '1000_web_edge', '1999_web_edge']) {
    assert.equal(rangeViolation(ok), null, `${ok} should be in range`);
  }
  for (const bad of ['0000_zero', '2000_beyond', '2500_probe', 'no_number_prefix']) {
    const violation = rangeViolation(bad);
    assert.ok(violation, `${bad} should be rejected`);
    assert.match(violation, /migration range rule/);
    assert.match(violation, /0001–0999/);
    assert.match(violation, /1000–1999/);
  }
});
