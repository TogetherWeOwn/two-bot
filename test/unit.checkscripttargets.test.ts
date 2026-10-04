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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  extractDocNpmRuns,
  extractDocTargets,
  extractTargets,
  findMissing,
  findMissingDocRefs,
} from '../scripts/check-script-targets.ts';

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

test('extractDocTargets finds scripts/<path> in prose and trims file:line + punctuation', () => {
  assert.deepEqual(extractDocTargets('run `node scripts/staging-doctor.ts` first'), [
    'scripts/staging-doctor.ts',
  ]);
  // Pinned references (scripts/x.ts:34-35) yield the path; sentence-final
  // periods are punctuation, not path.
  assert.deepEqual(extractDocTargets('pinned in the script (`scripts/staging-automations-proof.ts:34-35`);'), [
    'scripts/staging-automations-proof.ts',
  ]);
  assert.deepEqual(extractDocTargets('Re-run with scripts/backfill.ts. Then stop.'), [
    'scripts/backfill.ts',
  ]);
  // Dupes collapse; a bare historical filename never mentions scripts/.
  assert.deepEqual(extractDocTargets('`scripts/a.ts` and scripts/a.ts'), ['scripts/a.ts']);
  assert.deepEqual(extractDocTargets('the old `migrate-sqlite-to-postgres.ts` is gone'), []);
});

test('extractDocNpmRuns finds npm run <name> in prose', () => {
  assert.deepEqual(extractDocNpmRuns('run `npm run staging:doctor` then `npm run wave0`.'), [
    'staging:doctor',
    'wave0',
  ]);
  assert.deepEqual(extractDocNpmRuns('npm run levels:roles -- --guild <id>'), ['levels:roles']);
});

test('findMissingDocRefs names the doc for a missing file and a missing npm entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'docdrift-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'kept.ts'), '// fixture');
  const scripts = { kept: 'node scripts/kept.ts' };
  const docs = {
    'docs/RUNBOOK.md':
      'run `node scripts/kept.ts`, then `node scripts/never-existed.ts`, then `npm run kept` and `npm run typo:name`.',
  };
  assert.deepEqual(findMissingDocRefs(root, docs, scripts), [
    { doc: 'docs/RUNBOOK.md', ref: 'scripts/never-existed.ts', kind: 'file' },
    { doc: 'docs/RUNBOOK.md', ref: 'typo:name', kind: 'npm-script' },
  ]);
  assert.deepEqual(findMissingDocRefs(root, { 'docs/RUNBOOK.md': 'nothing referenced here' }, scripts), []);
});

test('the live docs reference no missing script file or npm entry', () => {
  // Failed while docs/RUNBOOK.md still pointed at the TOG-450-removed
  // scripts/migrate-sqlite-to-postgres.ts (TOG-10007); passes after the
  // reference was rewritten as history rather than a runnable path.
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as {
    scripts: Record<string, string>;
  };
  const docs: Record<string, string> = {};
  for (const doc of ['docs/RUNBOOK.md', 'docs/DEPLOY.md']) {
    docs[doc] = readFileSync(`${ROOT}/${doc}`, 'utf8');
  }
  assert.deepEqual(findMissingDocRefs(ROOT, docs, pkg.scripts), []);
});
