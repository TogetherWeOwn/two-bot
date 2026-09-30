import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE, checkBudgets, parseArgs, reportBudgets, type BenchMetrics } from '../scripts/event-store-bench.ts';

const fixture = (): BenchMetrics => ({
  members: BASELINE.members,
  events: BASELINE.events,
  writeMs: BASELINE.writeMsPerEvent * BASELINE.events,
  reads: Object.entries(BASELINE.reads).map(([label, ms]) => ({ label, ms })),
});

test('baseline and inclusive thresholds pass with a visible report', () => {
  const metrics = fixture();
  const lines: string[] = [];
  assert.equal(reportBudgets(metrics, (s) => lines.push(s)), 0);
  assert.equal(lines.filter((s) => /^\s+PASS /.test(s)).length, 9);
  assert.match(lines.join('\n'), /baseline=0\.247 limit=0\.741/);
  assert.match(lines.at(-1)!, /threshold result: PASS/);
  metrics.writeMs = BASELINE.writeMsPerEvent * 3 * BASELINE.events;
  metrics.reads.forEach((r) => { r.ms = 10; });
  assert.ok(checkBudgets(metrics).every((c) => c.pass));
});

test('write regression fails; each read regression fails independently', () => {
  const slowWrite = fixture();
  slowWrite.writeMs *= 3.01;
  const lines: string[] = [];
  assert.equal(reportBudgets(slowWrite, (s) => lines.push(s)), 1);
  assert.match(lines.join('\n'), /FAIL write ms\/event/);
  assert.match(lines.at(-1)!, /FAIL \(1 budget violations\)/);
  for (const label of Object.keys(BASELINE.reads)) {
    const metrics = fixture();
    metrics.reads.find((r) => r.label === label)!.ms = 10.001;
    assert.deepEqual(checkBudgets(metrics).filter((c) => !c.pass).map((c) => c.label), [label]);
  }
});

test('changed workload, missing reads and invalid timings fail closed', () => {
  for (const value of [NaN, Infinity, -1]) {
    const metrics = fixture();
    metrics.writeMs = value;
    assert.ok(checkBudgets(metrics).some((c) => !c.pass));
    const badRead = fixture();
    badRead.reads[0].ms = value;
    assert.ok(checkBudgets(badRead).some((c) => !c.pass));
  }
  const metrics = fixture();
  metrics.reads.pop();
  metrics.members--;
  metrics.events--;
  assert.equal(checkBudgets(metrics).filter((c) => !c.pass).length, 3);
});

test('check mode pins the workload and rejects malformed CLI arguments', () => {
  assert.deepEqual(parseArgs([]), { members: 2000, check: false });
  assert.deepEqual(parseArgs(['--check']), { members: 2000, check: true });
  assert.deepEqual(parseArgs(['2000', '--check']), { members: 2000, check: true });
  assert.deepEqual(parseArgs(['--check', '2000']), { members: 2000, check: true });
  assert.deepEqual(parseArgs(['30000']), { members: 30000, check: false });
  for (const args of [['0'], ['-1'], ['NaN'], ['Infinity'], ['2.1'], ['500001'], ['--typo'], ['1', '--check'], ['--check', '--check'], ['1', '2']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('a budget breach produces a real nonzero process exit without a database', () => {
  const script = new URL('../scripts/event-store-bench.ts', import.meta.url).href;
  for (const [factor, expectedStatus] of [[1, 0], [4, 1]]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { BASELINE, reportBudgets } from ${JSON.stringify(script)};
      process.exitCode = reportBudgets({
        members: BASELINE.members, events: BASELINE.events,
        writeMs: BASELINE.writeMsPerEvent * BASELINE.events * ${factor},
        reads: Object.entries(BASELINE.reads).map(([label, ms]) => ({ label, ms })),
      });
    `], { encoding: 'utf8' });
    assert.equal(child.status, expectedStatus, child.stderr);
    assert.match(child.stdout, expectedStatus ? /threshold result: FAIL/ : /threshold result: PASS/);
  }
});

test('CI measures three fixed workloads and cannot hide any failed sample', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'bench-wrapper-'));
  try {
    // Stub the benchmark process, not the budget checker: exercise shell exit
    // propagation and argument pinning without opening any database.
    writeFileSync(join(dir, 'node'), `#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 2 && "$1" == scripts/event-store-bench.ts && "$2" == --check ]] || exit 99
count=0
if [[ -f "$COUNT_FILE" ]]; then read -r count < "$COUNT_FILE"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$COUNT_FILE"
IFS=, read -r -a codes <<< "$SAMPLE_CODES"
exit "\${codes[$((count - 1))]}"
`, { mode: 0o755 });
    for (const [codes, expectedStatus, expectedSamples] of [
      ['0,0,0', 0, 3], ['1,0,0', 1, 3], ['0,1,0', 1, 3], ['0,0,1', 1, 3], ['1,1,1', 1, 3],
      ['2,0,1', 2, 1], ['1,2,0', 2, 2], ['0,0,2', 2, 3],
    ] as const) {
      const countFile = join(dir, 'count');
      rmSync(countFile, { force: true });
      const child = spawnSync('bash', [new URL('../scripts/ci/run-event-store-bench.sh', import.meta.url).pathname], {
        encoding: 'utf8',
        env: { PATH: `${dir}:${process.env.PATH}`, COUNT_FILE: countFile, SAMPLE_CODES: codes },
      });
      assert.equal(child.status, expectedStatus, child.stderr);
      assert.equal(Number(readFileSync(countFile, 'utf8').trim()), expectedSamples);
      assert.equal((child.stdout.match(/benchmark sample \d\/3/g) ?? []).length, expectedSamples);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI distinguishes a setup error from a measured budget breach without connecting', () => {
  const child = spawnSync(process.execPath, [new URL('../scripts/event-store-bench.ts', import.meta.url).pathname, '--check'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, TWO_TEST_DATABASE_URL: 'not-a-postgres-url' },
  });
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /Only Postgres is supported/);
  assert.doesNotMatch(child.stdout, /threshold result/);
});

test('CLI refuses an ambient production URL when no test URL was explicitly supplied', () => {
  const child = spawnSync(process.execPath, [new URL('../scripts/event-store-bench.ts', import.meta.url).pathname, '--check'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, TWO_DATABASE_URL: 'postgres://do-not-connect.invalid/production' },
  });
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /TWO_TEST_DATABASE_URL is not set/);
});
