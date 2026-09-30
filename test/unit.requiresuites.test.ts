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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { check, tally, parseResults, annotations, POSTGRES_SUITES } from '../scripts/require-suites.ts';
import reporter, { type ReportedTest } from '../scripts/test-report.ts';

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

const ONE_TEST = [{ file: 'test/required.test.ts', minTests: 1, why: 'synthetic execution floor' }];

test('one valid pass meets a one-test required floor', () => {
  assert.deepEqual(check([point(ONE_TEST[0].file)], { root: ROOT, required: ONE_TEST }), []);
});

test('bare, reason-bearing and empty-reason TODO tests and suites cannot prove execution', async () => {
  for (const type of ['test', 'suite']) {
    for (const todo of [true, 'not implemented', '']) {
      async function* events() {
        yield {
          type: 'test:pass',
          data: { file: `${ROOT}/${ONE_TEST[0].file}`, name: 'placeholder', nesting: 0, details: { type }, todo },
        };
      }
      const lines: string[] = [];
      for await (const line of reporter(events())) lines.push(line);
      const rows = parseResults(lines.join(''));
      assert.equal(rows[0].status, 'pass');
      assert.equal(rows[0].todo, true);
      // A TODO suite must fail even if a valid child meets the floor.
      if (type === 'suite') rows.push(point(ONE_TEST[0].file));
      const problems = check(rows, { root: ROOT, required: ONE_TEST });
      assert.ok(problems.some((p) => /required\.test\.ts.*TODO.*placeholder/.test(p)), problems.join('\n'));
      assert.equal(tally(rows.slice(0, 1), ROOT).size, 0, 'TODOs are not executed test points');
    }
  }
});

test('unregistered TODO points are rejected even in a file allowed to skip', () => {
  const rows = [point(ONE_TEST[0].file), point('test/optional.test.ts', { todo: true })];
  assert.ok(check(rows, { root: ROOT, required: ONE_TEST, maySkip: ['test/optional.test.ts'] })
    .some((p) => /optional\.test\.ts.*TODO/.test(p)));
});

function malformedPoints(): unknown[] {
  const good = point(ONE_TEST[0].file);
  const out: unknown[] = [null, false, 3, 'test', [], {}];
  const badFields = {
    file: [undefined, null, 42, '', '   '],
    name: [undefined, null, 42],
    nesting: [undefined, null, '0', -1, 0.5],
    type: [undefined, null, 42, '', 'not-a-node-type'],
    status: [undefined, null, 42, '', 'not-a-node-status'],
    skip: [undefined, null, 0, '', 'false'],
    todo: [undefined, null, 0, '', 'reason'],
  };
  for (const [field, values] of Object.entries(badFields)) {
    for (const value of values) out.push({ ...good, [field]: value });
  }
  return out;
}

test('malformed report points fail before tallying and cannot manufacture a required floor', () => {
  for (const bad of malformedPoints()) {
    // Exercise JSON input as well as check(): TypeScript types cannot validate --results.
    const rows = parseResults(JSON.stringify(bad));
    const problems = check(rows, { root: ROOT, required: ONE_TEST });
    assert.ok(problems.some((p) => /malformed.*test point #1/i.test(p)), JSON.stringify(bad));
    assert.equal(tally(rows, ROOT).size, 0, 'malformed rows must not be counted');
    assert.doesNotThrow(() => annotations(rows, problems, ROOT));
    assert.ok(check([point(ONE_TEST[0].file), ...rows], { root: ROOT, required: ONE_TEST }).length,
      'meeting the floor must not hide a malformed extra row');
  }
});

test('--results emits report problems and exits nonzero for TODO and malformed rows without a database', () => {
  const work = mkdtempSync(join(tmpdir(), 'required-suite-report-'));
  try {
    const path = join(work, 'results.ndjson');
    const env = { PATH: process.env.PATH, GITHUB_ACTIONS: 'true' };
    const run = (rows: unknown[]) => {
      writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      return spawnSync(process.execPath, ['scripts/require-suites.ts', '--results', path], {
        cwd: resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 10_000,
      });
    };
    const greenRows = goodRun().map((row) => ({ ...row, file: row.file.slice(ROOT.length + 1) }));
    const green = run(greenRows);
    assert.equal(green.status, 0, green.stdout + green.stderr);
    for (const bad of [null, { ...point(ONE_TEST[0].file), file: null },
      { ...point(ONE_TEST[0].file), status: 'not-a-node-status' },
      point(ONE_TEST[0].file, { todo: true }), point(ONE_TEST[0].file, { type: 'suite', todo: true })]) {
      const red = run([...greenRows, bad]);
      assert.equal(red.status, 1, red.stdout + red.stderr);
      assert.match(red.stdout, /::error title=Postgres suite requirement::/);
      assert.match(red.stderr, /malformed|TODO/);
      assert.doesNotMatch(red.stderr, /TypeError/);
    }
  } finally {
    rmSync(work, { recursive: true });
  }
});

test('a suite that skipped itself is caught, though the summary counts it as nothing', () => {
  // This is what node:test emits for a conditionally skipped describe: one
  // passing suite point carrying a skip, and not one test point underneath it.
  // `# tests 0 # skipped 0`, exit 0.
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

test('a failing test is named in an annotation, because the job log is unreadable', () => {
  // `actions:read` is withheld, so this line is the only place a red run says
  // which test broke. A bare exit code is what this exists to replace.
  const rows = [
    point('test/e2e.backup.test.ts', { type: 'suite', nesting: 0, name: 'backup round trip', status: 'fail' }),
    point('test/e2e.backup.test.ts', { name: 'restores an empty database', status: 'fail' }),
    point('test/e2e.backup.test.ts', { name: 'passes' }),
  ];

  assert.deepEqual(annotations(rows, [], ROOT), [
    '::error file=test/e2e.backup.test.ts,title=Failing test::' +
      'test/e2e.backup.test.ts > restores an empty database',
  ]);
});

test('annotations escape the characters that would truncate the command', () => {
  const rows = [point('test/a.test.ts', { name: 'a\nb%c', status: 'fail' })];
  const [line] = annotations(rows, ['one%problem'], ROOT);

  assert.ok(line !== undefined && !line.includes('\n'), 'a literal newline would truncate the annotation');
  assert.ok(line.endsWith('test/a.test.ts > a%0Ab%25c'));
  assert.deepEqual(annotations([], ['one%problem'], ROOT), [
    '::error title=Postgres suite requirement::one%25problem',
  ]);
});

test('a green run produces no annotations at all', () => {
  assert.deepEqual(annotations(goodRun(), [], ROOT), []);
});
