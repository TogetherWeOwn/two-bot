/**
 * TOG-10647: argument refusals through the real restore entrypoint. Module
 * doubles trace inspect/openDb/migrate/restore, including positive controls
 * so a typo cannot silently select the destructive path. No real database,
 * driver, backup reader, or inherited target environment is used here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/pg-restore.ts', import.meta.url));
const hooks = fileURLToPath(new URL('./fixtures/restore-args-hooks.mjs', import.meta.url));

function setup() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'restore-args-'));
  const file = join(root, 'backup.ndjson.gz');
  const trace = join(root, 'trace.txt');
  // Only existsSync sees this file: backup validation is doubled separately.
  writeFileSync(file, 'argument grammar fixture');
  const run = (args: string[], withTarget = true) => {
    writeFileSync(trace, '');
    const result = spawnSync(process.execPath, ['--import', hooks, cli, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        RESTORE_TEST_TRACE: trace,
        ...(withTarget ? { TWO_RESTORE_URL: 'postgres://fake-test-target/restore_target' } : {}),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'CLI must exit normally, not via a signal');
    assert.notEqual(result.status, null);
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      operations: readFileSync(trace, 'utf8').split('\n').filter(Boolean),
    };
  };
  return { root, file, run };
}

const refusals: Array<{ name: string; args: (file: string) => string[]; error: RegExp }> = [
  { name: 'misspelled dry-run with force', args: (f) => [f, '--dry-rnu', '--force'], error: /unknown option/ },
  { name: 'unknown flag before file', args: (f) => ['--wat', f, '--dry-run'], error: /unknown option/ },
  { name: 'short unknown flag', args: (f) => [f, '-f', '--force'], error: /unknown option/ },
  { name: 'value attached to a boolean flag', args: (f) => [f, '--force=true'], error: /unknown option/ },
  { name: 'second backup operand', args: (f) => [f, `${f}.second`, '--force'], error: /exactly one backup/ },
  { name: 'repeated backup operand', args: (f) => [f, '--dry-run', f], error: /exactly one backup/ },
  { name: 'both modes', args: (f) => [f, '--force', '--dry-run'], error: /cannot combine/ },
  { name: 'both modes reversed', args: (f) => ['--dry-run', f, '--force'], error: /cannot combine/ },
  { name: 'duplicate force', args: (f) => [f, '--force', '--force'], error: /duplicate option/ },
  { name: 'duplicate dry-run', args: (f) => [f, '--dry-run', '--dry-run'], error: /duplicate option/ },
  { name: 'no backup operand', args: () => ['--force'], error: /exactly one backup/ },
  { name: 'no arguments', args: () => [], error: /exactly one backup/ },
  { name: 'help combined with restore', args: (f) => ['--help', f, '--force'], error: /--help must be used alone/ },
  { name: 'help with an unknown flag', args: () => ['--help', '--wat'], error: /unknown option/ },
];

for (const { name, args, error } of refusals) {
  test(`refuses ${name} before any file or target operation`, (t) => {
    const f = setup();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const result = f.run(args(f.file));
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, error);
    assert.match(result.output, /usage: node scripts\/pg-restore\.ts/);
    assert.doesNotMatch(result.output, /(?:RESTORE|DRY RUN) VERIFIED/);
    assert.deepEqual(result.operations, [], 'refused grammar must not inspect/open/migrate/restore');
  });
}

test('missing mode preserves the explicit force refusal without target operations', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = f.run([f.file]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /wipes the target\. Pass --force/);
  assert.deepEqual(result.operations, []);
});

test('--help alone succeeds without a backup or target operations', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = f.run(['--help']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Usage:.*\(--force \| --dry-run\)/);
  assert.deepEqual(result.operations, []);
});

for (const mode of ['--force', '--dry-run']) {
  for (const flagFirst of [false, true]) {
    test(`one backup + ${mode} succeeds (${flagFirst ? 'flag' : 'file'} first)`, (t) => {
      const f = setup();
      t.after(() => rmSync(f.root, { recursive: true, force: true }));
      const result = f.run(flagFirst ? [mode, f.file] : [f.file, mode]);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, mode === '--force' ? /RESTORE VERIFIED/ : /DRY RUN VERIFIED/);
      assert.deepEqual(result.operations, mode === '--force'
        ? ['inspect', 'open', 'migrate', 'restore', 'close']
        : ['inspect', 'open', 'query', 'close']);
    });
  }
}

test('--dry-run without a target inspects only the backup', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = f.run([f.file, '--dry-run'], false);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /DRY RUN VERIFIED/);
  assert.deepEqual(result.operations, ['inspect']);
});
