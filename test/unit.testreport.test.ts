/**
 * TOG-6487: `scripts/test-report.ts` acceptance test on fixtures.
 *
 * The gap: as of the 2026-09-27 scan no test file referenced the script's
 * reporter itself. `test/unit.requiresuites.test.ts` pins everything
 * downstream (`check`, `tally`, `parseResults`, `annotations`) against
 * hand-built rows, but nothing pinned the rows: a change to the skip mapping
 * (bare `true` vs reason string vs empty-string reason), the suite/test split
 * via `details.type`, or the pass/fail mapping would stay green while every
 * consumer silently read the wrong verdicts.
 *
 * So this feeds a canned multi-suite event stream through the real reporter
 * generator and diffs the NDJSON clean, then tallies it to pin the
 * skipped/failed counts operators rely on. A third test runs the real
 * reporter under `node --test` against two tiny fixture suites, proving the
 * mapping holds outside a hand-built stream.
 *
 * Hermetic: synthetic events plus fixture files under tmpdir. No token, no
 * DB, no live Discord. The reviewer acceptance is literal: corrupt any
 * expected row below and the run names the failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import reporter, { type ReportedTest } from '../scripts/test-report.ts';
import { parseResults, tally } from '../scripts/require-suites.ts';

const ROOT = resolve(import.meta.dirname, '..');

interface CannedEvent {
  type: string;
  data: {
    file?: string;
    name: string;
    nesting: number;
    skip?: boolean | string;
    todo?: boolean | string;
    details?: { type?: string };
  };
}

/** One NDJSON row per test point, parsed back for the diff. */
async function collect(events: CannedEvent[]): Promise<ReportedTest[]> {
  async function* stream(): AsyncGenerator<CannedEvent> {
    yield* events;
  }
  const out: ReportedTest[] = [];
  for await (const line of reporter(stream())) {
    assert.match(line, /\n$/, 'every row is one newline-terminated JSON object');
    out.push(JSON.parse(line) as ReportedTest);
  }
  return out;
}

/**
 * A canned run across two suites exercising every mapping branch: a passing
 * suite with a pass, a bare skip, a reasoned skip and an empty-reason skip; a
 * suite that skipped itself with no tests underneath (the `tests 0, skipped 0`
 * case the printed summary cannot see); a failing test under a failing suite;
 * a todo; a point with no file key; and a non-result event that must be
 * dropped.
 */
function cannedEvents(): CannedEvent[] {
  const alpha = '/r/test/alpha.test.ts';
  const beta = '/r/test/beta.test.ts';
  return [
    { type: 'test:pass', data: { file: alpha, name: 'alpha suite', nesting: 0, details: { type: 'suite' } } },
    { type: 'test:pass', data: { file: alpha, name: 'passes', nesting: 1 } },
    { type: 'test:pass', data: { file: alpha, name: 'skipped bare', nesting: 1, skip: true } },
    { type: 'test:pass', data: { file: alpha, name: 'skipped with reason', nesting: 1, skip: 'needs DB' } },
    // `skip` is `true` when bare and the reason string when given, so the
    // falsy check has to survive an empty-string reason: still skipped.
    { type: 'test:pass', data: { file: alpha, name: 'skipped with empty reason', nesting: 1, skip: '' } },
    { type: 'test:pass', data: { file: alpha, name: 'vanished suite', nesting: 0, details: { type: 'suite' }, skip: true } },
    { type: 'test:fail', data: { file: beta, name: 'broke', nesting: 1 } },
    { type: 'test:fail', data: { file: beta, name: 'beta suite', nesting: 0, details: { type: 'suite' } } },
    { type: 'test:pass', data: { file: beta, name: 'todo item', nesting: 1, todo: true } },
    { type: 'test:pass', data: { name: 'no file key', nesting: 1 } },
    { type: 'test:diagnostic', data: { file: alpha, name: 'noise', nesting: 0 } },
  ];
}

function cannedRows(): ReportedTest[] {
  const alpha = '/r/test/alpha.test.ts';
  const beta = '/r/test/beta.test.ts';
  const row = (file: string, name: string, over: Partial<ReportedTest> = {}): ReportedTest => ({
    file,
    name,
    nesting: 1,
    type: 'test',
    status: 'pass',
    skip: false,
    todo: false,
    ...over,
  });
  return [
    row(alpha, 'alpha suite', { nesting: 0, type: 'suite' }),
    row(alpha, 'passes'),
    row(alpha, 'skipped bare', { skip: true }),
    row(alpha, 'skipped with reason', { skip: true }),
    row(alpha, 'skipped with empty reason', { skip: true }),
    row(alpha, 'vanished suite', { nesting: 0, type: 'suite', skip: true }),
    row(beta, 'broke', { status: 'fail' }),
    row(beta, 'beta suite', { nesting: 0, type: 'suite', status: 'fail' }),
    row(beta, 'todo item', { todo: true }),
    row('', 'no file key'),
  ];
}

test('the reporter maps a canned multi-suite stream to exact NDJSON rows', async () => {
  assert.deepEqual(await collect(cannedEvents()), cannedRows());
});

test('the canned report tallies to per-file skipped/failed counts', async () => {
  const byFile = tally(await collect(cannedEvents()), '/r');
  assert.deepEqual(byFile.get('test/alpha.test.ts'), {
    tests: 4,
    suites: 2,
    skipped: 4,
    failed: 0,
  });
  assert.deepEqual(byFile.get('test/beta.test.ts'), {
    // The TODO still appears in the raw report, but cannot prove execution.
    tests: 1,
    suites: 1,
    skipped: 0,
    failed: 2,
  });
});

test('the real reporter under node --test writes the same rows for fixture suites', () => {
  const work = mkdtempSync(join(tmpdir(), 'testreport-'));
  try {
    writeFileSync(
      join(work, 'alpha.test.ts'),
      `import { describe, test } from 'node:test';\n` +
        `describe('alpha suite', () => {\n` +
        `  test('passes', () => {});\n` +
        `  test('skipped point', { skip: 'canned reason' }, () => {});\n` +
        `});\n`,
    );
    writeFileSync(
      join(work, 'beta.test.ts'),
      `import { test } from 'node:test';\n` +
        `test('fails on purpose', () => { throw new Error('canned failure'); });\n`,
    );
    const out = join(work, 'results.ndjson');
    // Node suppresses nested test discovery when NODE_TEST_CONTEXT leaks into
    // the child, exiting zero without running a fixture. Strip it so the
    // fixture suites really execute (tog4104-offline precedent).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const res = spawnSync(
      process.execPath,
      [
        '--test',
        `--test-reporter=${join(ROOT, 'scripts/test-report.ts')}`,
        `--test-reporter-destination=${out}`,
        join(work, 'alpha.test.ts'),
        join(work, 'beta.test.ts'),
      ],
      { cwd: work, env: childEnv, encoding: 'utf8' },
    );
    // Beta fails on purpose, so the run itself is red; the report must still
    // exist and describe every point.
    assert.equal(res.status, 1, res.stdout + res.stderr);
    const rows = parseResults(readFileSync(out, 'utf8'));
    const byFile = tally(rows, work);
    assert.deepEqual(byFile.get('alpha.test.ts'), {
      tests: 2,
      suites: 1,
      skipped: 1,
      failed: 0,
    });
    assert.deepEqual(byFile.get('beta.test.ts'), {
      tests: 1,
      suites: 0,
      skipped: 0,
      failed: 1,
    });
    const names = rows.map((r) => r.name).sort();
    assert.ok(names.includes('alpha suite'), names.join(', '));
    assert.ok(names.includes('fails on purpose'), names.join(', '));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
