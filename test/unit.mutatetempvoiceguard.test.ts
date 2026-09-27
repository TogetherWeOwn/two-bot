/**
 * The staging guard on scripts/mutate-tempvoice.ts, proved by running it (TOG-6501).
 *
 * WHY THIS EXISTS. The harness rewrites a working-tree file and runs the unit
 * suite once per mutation, so an accidental run is a tree edit plus minutes of
 * suite time. The guard demands BOTH an explicit `--staging` flag AND a scratch
 * `TWO_TEST_DATABASE_URL` before touching anything; `--help` is the only
 * flag-free run. These tests execute the real script: the refusal cases assert
 * a non-zero exit and a byte-identical fixture, and the `--staging` case runs
 * one real mutation (M1) against a fixture target plus a fixture suite that
 * fails only when the guard is relaxed — exit 0 with 1/1 killed proves the
 * mutation was actually performed, and the fixture is restored afterwards.
 *
 * Hermetic and fast: fixtures live under tmpdir, the scratch database URL is a
 * non-routable postgres:// value nothing connects to (the harness never opens
 * it; only the child suite would, and the fixture suite asserts on bytes, not
 * rows), and no Discord, guild, or network is involved. The M1 anchor is read
 * out of the real script, so a renamed guard cannot keep this green while the
 * harness mutates nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'mutate-tempvoice.ts');
const scriptSource = readFileSync(SCRIPT, 'utf8');

/**
 * The M1 mutation's anchor and replacement, lifted verbatim out of the script:
 * a copy here would keep passing after someone edited the harness.
 */
function m1Pair(): { from: string; to: string } {
  const block = scriptSource.slice(scriptSource.indexOf("name: 'M1 protected-id guard removed'"));
  assert.ok(block.length > 0, 'M1 mutation is missing from the harness');
  const from = /from: `([^`]*)`/.exec(block)?.[1];
  const to = /to: `([^`]*)`/.exec(block)?.[1];
  if (!from || !to) throw new Error('could not read the M1 anchor out of the harness');
  return { from, to };
}

/** A fixture target carrying the M1 anchor exactly once, and a fixture suite that fails only when it is gone. */
function fixture(): { dir: string; target: string; suite: string; original: string } {
  const { from } = m1Pair();
  const dir = mkdtempSync(join(tmpdir(), 'two-mutate-guard-'));
  const target = join(dir, 'target-fixture.ts');
  const suite = join(dir, 'guard-suite.test.ts');
  const original =
    '// mutate-tempvoice guard fixture (TOG-6501): bytes only, never executed.\n' +
    'export function guarded(this: any, channelId: string): string {\n' +
    `${from}\n` +
    "    return 'protected';\n" +
    '  }\n' +
    "  return 'ok';\n" +
    '}\n';
  assert.equal(original.split(from).length - 1, 1, 'the fixture must carry the M1 anchor exactly once');
  writeFileSync(target, original);
  writeFileSync(
    suite,
    'import { test } from \'node:test\';\n' +
      'import assert from \'node:assert/strict\';\n' +
      'import { readFileSync } from \'node:fs\';\n' +
      'test(\'fixture guard intact\', () => {\n' +
      '  const target = process.env.TWO_MUTATE_GUARD_TARGET ?? \'\';\n' +
      '  assert.ok(target, \'TWO_MUTATE_GUARD_TARGET is not set\');\n' +
      '  const bytes = readFileSync(target, \'utf8\');\n' +
      `  assert.ok(bytes.includes(${JSON.stringify(from)}), 'mutated fixture: the guard anchor is gone');\n` +
      '});\n',
  );
  return { dir, target, suite, original };
}

/** Enough environment for node to boot, nothing else — in particular no database URL survives unless added. */
function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', ...extra };
  for (const k of ['HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'SYSTEMDRIVE', 'LANG', 'TZ']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

/** A scratch postgres:// value nothing connects to: the harness never opens it, it only gates the flag. */
const SCRATCH_DB = 'postgres://127.0.0.1:1/two_scratch_must_not_connect';

function runHarness(args: string[], env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

for (const [name, args, env] of [
  ['refuses with neither flag nor database', [] as string[], scrubbedEnv()],
  ['refuses with --staging but no database', ['--staging'], scrubbedEnv()],
  ['refuses with a database but no flag', [], scrubbedEnv({ TWO_TEST_DATABASE_URL: SCRATCH_DB })],
  [
    'refuses a non-postgres database URL even with --staging',
    ['--staging'],
    scrubbedEnv({ TWO_TEST_DATABASE_URL: 'sqlite:///tmp/not-postgres.db' }),
  ],
] as Array<[string, string[], NodeJS.ProcessEnv]>) {
  test(`${name} (non-zero exit, zero writes)`, () => {
    const f = fixture();
    try {
      const run = runHarness(['--target', f.target, '--suite', f.suite, ...args], env);
      assert.notEqual(run.status, 0, `harness exited 0: ${run.output.slice(0, 1000)}`);
      assert.match(run.output, /refusing/, 'the refusal must say so');
      assert.match(run.output, /Nothing was mutated/, 'the refusal must promise no mutation');
      assert.equal(readFileSync(f.target, 'utf8'), f.original, 'a refused run wrote to the fixture');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

test('--help still exits 0 with a scrubbed env and mutates nothing', () => {
  const f = fixture();
  try {
    const run = runHarness(['--help'], scrubbedEnv());
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /^usage:/im, 'no usage line');
    assert.match(run.output, /mutate-tempvoice/, 'usage names no script file');
    assert.equal(readFileSync(f.target, 'utf8'), f.original, '--help wrote to the fixture');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('with --staging and a scratch DB it performs the mutation and restores', { timeout: 120_000 }, () => {
  const f = fixture();
  try {
    const run = runHarness(
      ['--staging', '--target', f.target, '--suite', f.suite, '--only', 'M1 protected-id'],
      scrubbedEnv({ TWO_TEST_DATABASE_URL: SCRATCH_DB, TWO_MUTATE_GUARD_TARGET: f.target }),
    );
    assert.equal(run.status, 0, `harness failed: ${run.output.slice(0, 2000)}`);
    assert.match(run.output, /KILLED.*M1 protected-id/, 'no KILLED line for M1: the mutation was not performed');
    assert.match(run.output, /1\/1 mutations killed/, 'expected exactly one killed mutation');
    assert.doesNotMatch(run.output, /SURVIVED/, 'the fixture suite survived its own mutation');
    assert.equal(readFileSync(f.target, 'utf8'), f.original, 'the harness did not restore the fixture');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
