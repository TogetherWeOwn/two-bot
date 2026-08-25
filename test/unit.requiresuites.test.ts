/**
 * The check that proves the Postgres-only suites ran, checked itself.
 *
 * A guard nobody has watched fail is not a guard. The failure this one exists to
 * catch - a suite that skips instead of running - only happens on a broken day,
 * and by then it is too late to find out the check was wrong. So the failures
 * are staged here from synthetic reporter output rather than waiting for one.
 *
 * The first test is the important one: it is a real capture of what Node emits
 * when a `describe` skips itself, which is the case the printed summary cannot
 * see (`tests 0`, `skipped 0`, exit 0).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, tally, parseResults, POSTGRES_SUITES } from '../scripts/require-suites.ts';
import type { ReportedTest } from '../scripts/test-report.ts';

const ROOT = '/repo';

function point(file: string, over: Partial<ReportedTest> = {}): ReportedTest {
  return {
    file: `${ROOT}/${file}`,
    name: 'a test',
    nesting: 1,
    type: 'test',
    status: 'pass',
    skip: false,
    todo: false,
    ...over,
  };
}

/** A run in which every suite in the manifest ran in full. */
function goodRun(): ReportedTest[] {
  const rows: ReportedTest[] = [];
  for (const suite of POSTGRES_SUITES) {
    rows.push(point(suite.file, { type: 'suite', nesting: 0, name: suite.file }));
    for (let i = 0; i < suite.minTests; i++) rows.push(point(suite.file, { name: `test ${i}` }));
  }
  return rows;
}

test('a run where every Postgres suite ran is accepted', () => {
  assert.deepEqual(check(goodRun(), { root: ROOT }), []);
});

test('a suite that skipped itself is caught, though the summary counts it as nothing', () => {
  // This is exactly what node:test emits for
  //   describe('backup round trip', { skip: !usingPostgres && '...' }, ...)
  // with the database absent: one passing suite point carrying a skip, and not
  // one test point underneath it. `# tests 0 # skipped 0`, exit 0.
  const rows = goodRun().filter((r) => !r.file.endsWith('e2e.backup.test.ts'));
  rows.push(
    point('test/e2e.backup.test.ts', {
      type: 'suite',
      nesting: 0,
      name: 'backup round trip',
      skip: true,
    }),
  );

  const problems = check(rows, { root: ROOT });
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /e2e\.backup\.test\.ts: 1 test point\(s\) SKIPPED/);
  // And the count floor catches it a second way, independently.
  assert.match(problems[1], /0 passing tests, expected at least/);
});

test('a suite that vanished entirely is caught, not silently passed over', () => {
  const rows = goodRun().filter((r) => !r.file.endsWith('e2e.concurrency.test.ts'));
  const problems = check(rows, { root: ROOT });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /e2e\.concurrency\.test\.ts: reported no tests at all/);
});

test('losing tests out of a suite is caught even though the rest still pass', () => {
  const target = POSTGRES_SUITES[0];
  const rows = goodRun().filter(
    (r) => !(r.file.endsWith(target.file.replace('test/', '')) && r.type === 'test'),
  );
  rows.push(point(target.file));

  const problems = check(rows, { root: ROOT });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /1 passing tests, expected at least 22/);
});

test('a NEW suite that skips is caught, which the manifest alone cannot do', () => {
  const rows = goodRun();
  rows.push(
    point('test/e2e.somethingnew.test.ts', {
      type: 'suite',
      nesting: 0,
      name: 'a later Postgres-only suite',
      skip: true,
    }),
  );

  const problems = check(rows, { root: ROOT });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /e2e\.somethingnew\.test\.ts.*Nothing may skip in this job/s);
});

test('an allowlisted skip is tolerated, so the rule can be relaxed deliberately', () => {
  const rows = goodRun();
  rows.push(point('test/e2e.somethingnew.test.ts', { type: 'suite', nesting: 0, skip: true }));

  assert.deepEqual(check(rows, { root: ROOT, maySkip: ['test/e2e.somethingnew.test.ts'] }), []);
});

test('a failing test point is reported', () => {
  const rows = goodRun();
  rows.push(point('test/unit.store.test.ts', { status: 'fail', name: 'broke' }));
  const problems = check(rows, { root: ROOT });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /unit\.store\.test\.ts: 1 failing test point/);
});

test('an empty run is a failure, not a pass', () => {
  const problems = check([], { root: ROOT });
  assert.ok(problems.some((p) => /no test points at all/.test(p)), problems.join('\n'));
});

test('the tally separates suites from tests and counts skips at any nesting', () => {
  const rows = [
    point('test/a.test.ts', { type: 'suite', nesting: 0 }),
    point('test/a.test.ts', { nesting: 1 }),
    point('test/a.test.ts', { nesting: 2, skip: true }),
  ];
  assert.deepEqual(tally(rows, ROOT).get('test/a.test.ts'), {
    tests: 2,
    suites: 1,
    skipped: 1,
    failed: 0,
  });
});

test('reporter output round trips through the parser', () => {
  const rows = goodRun().slice(0, 3);
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  assert.deepEqual(parseResults(text), rows);
  assert.deepEqual(parseResults(''), []);
});
