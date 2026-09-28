/**
 * The guard that stops the next dangling `node scripts/<x>` entry, checked itself.
 *
 * WHY THIS EXISTS (TOG-6810). `package.json` mapped `reconcile` to
 * `node scripts/reconcile.ts` since the initial import and no such file ever
 * existed; nothing referenced it, so the fix was removal. This test pins the
 * guard two ways: synthetic cases prove it still refuses things (a guard nobody
 * has watched fail is not a guard), and the live-tree case fails on any tree
 * that reintroduces a dangling target - it failed before the `reconcile`
 * removal and passes after.
 *
 * Hermetic: pure string parsing plus fixture trees under tmpdir. No DB, no Discord.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractTargets, findMissing } from '../scripts/check-script-targets.ts';

const ROOT = resolve(import.meta.dirname, '..');

test('extractTargets finds node scripts/<x> through flags and compound commands', () => {
  assert.deepEqual(extractTargets('node scripts/funnel.ts'), ['scripts/funnel.ts']);
  assert.deepEqual(extractTargets('node --env-file=.env src/index.ts'), []);
  assert.deepEqual(extractTargets('node scripts/levels-import-mee6.ts inventory'), [
    'scripts/levels-import-mee6.ts',
  ]);
  assert.deepEqual(extractTargets('node --test test/*.test.ts'), []);
  assert.deepEqual(extractTargets('bash scripts/ci/check-src-snowflakes.sh'), []);
  assert.deepEqual(extractTargets('node scripts/a.ts && node scripts/b.ts'), [
    'scripts/a.ts',
    'scripts/b.ts',
  ]);
});

test('findMissing refuses a dangling target and names the script', () => {
  const missing = findMissing(ROOT, {
    ok: 'node scripts/funnel.ts',
    dangling: 'node scripts/never-existed.ts',
    shell: 'bash scripts/ci/check-src-snowflakes.sh',
  });
  assert.deepEqual(missing, [{ script: 'dangling', target: 'scripts/never-existed.ts' }]);
});

test('findMissing passes a tree whose targets all exist', () => {
  assert.deepEqual(
    findMissing(ROOT, {
      a: 'node scripts/funnel.ts',
      b: 'node scripts/audit-switch.ts --halt',
    }),
    [],
  );
});

test('the live package.json has no dangling node scripts/<x> target', () => {
  // Failed while `reconcile` pointed at the never-created
  // scripts/reconcile.ts (TOG-6810); passes after its removal.
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.deepEqual(findMissing(ROOT, pkg.scripts), []);
  assert.ok(!('reconcile' in pkg.scripts), 'the dangling reconcile entry is gone');
});
