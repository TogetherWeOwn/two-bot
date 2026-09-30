import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { childEnvironment, checkStorage, command, STORAGE_SUITES } from '../scripts/require-restart-storage.ts';
import type { ReportedTest } from '../scripts/test-report.ts';

const ROOT = resolve(import.meta.dirname, '..');
function rows(): ReportedTest[] {
  return STORAGE_SUITES.flatMap((suite) => Array.from({ length: suite.minTests }, (_, i) => ({
    file: suite.file, name: `test ${i}`, nesting: 0, type: 'test', status: 'pass', skip: false, todo: false,
  })));
}

test('owned-storage profile requires 5 integration and 2 declaration-attributed entrypoint tests', () => {
  assert.deepEqual(checkStorage(rows()), []);
  assert.ok(checkStorage([]).length);
  for (const suite of STORAGE_SUITES) {
    assert.ok(checkStorage(rows().filter((row) => row.file !== suite.file)).length);
    const below = rows();
    below.splice(below.findIndex((row) => row.file === suite.file), 1);
    assert.ok(checkStorage(below).length);
  }
  const wrongAttribution = rows().map((row) => row.file.includes('e2e.')
    ? { ...row, file: 'test/stagingRestartStorage.entrypoint.ts' } : row);
  assert.ok(checkStorage(wrongAttribution).length);
});

test('skips, failures, TODOs and unregistered skipped/failed points cannot pass', () => {
  for (const delta of [{ skip: true }, { status: 'fail' as const }, { todo: true }]) {
    const bad = rows(); bad[0] = { ...bad[0], ...delta };
    assert.ok(checkStorage(bad).length);
    assert.ok(checkStorage([...rows(), { ...bad[0], file: 'test/unknown.ts' }]).length);
  }
  const suiteOnly = rows().map((row) => ({ ...row, type: 'suite' }));
  assert.ok(checkStorage(suiteOnly).length);
});

test('owned child environment is a closed literal allowlist with private HOME/TMPDIR', () => {
  assert.deepEqual(childEnvironment('/tmp/owned', '/trusted/bin'), {
    PATH: `${resolve(process.execPath, '..')}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C',
    HOME: '/tmp/owned/home', TMPDIR: '/tmp/owned/tmp', TWO_TEST_POSTGRES_BIN: '/trusted/bin',
  });
  assert.deepEqual(Object.keys(childEnvironment('/tmp/owned')).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
});

test('spawn failure, nonzero exit and child signal propagate as failure', async () => {
  const env = childEnvironment('/tmp/unused');
  assert.equal(await command('/does-not-exist', [], ROOT, env), 1);
  assert.equal(await command(process.execPath, ['-e', 'process.exit(23)'], ROOT, env), 23);
  assert.equal(await command(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], ROOT, env), 1);
});

test('required workflow wrapper reaches owned storage in order and fails fast at every command', () => {
  const work = mkdtempSync(join(tmpdir(), 'check-job-'));
  try {
    for (const binary of ['npm', 'node']) {
      const fake = join(work, binary);
      writeFileSync(fake, '#!/usr/bin/env bash\ncommand="${0##*/} $*"\nprintf "%s\\n" "$command" >> "$TRACE"\nif [[ "${FAIL_ON:-}" == "$command" ]]; then exit 23; fi\n');
      chmodSync(fake, 0o755);
    }
    const sequence = ['npm run check:script-targets', 'npm run check:credentials', 'npm run check:credentials:selftest', 'npm run check:env-drift', 'npm run check:env-drift:selftest', 'npm run deploy:selftest', 'npm ci --ignore-scripts --prefix scripts/ci', 'node --test scripts/ci/normalize-release.test.mjs', 'npm run typecheck', 'npm run eval:funnel-attribution', 'npm run test:postgres', 'npm run test:restart-storage -- --provision', 'npm run verify:grant:selftest'];
    for (const failOn of ['', ...sequence]) {
      const trace = join(work, 'trace'); writeFileSync(trace, '');
      const result = spawnSync('bash', ['scripts/ci/run-check-job.sh'], {
        cwd: ROOT, encoding: 'utf8', env: { PATH: `${work}:/usr/bin:/bin`, TRACE: trace, FAIL_ON: failOn },
      });
      assert.equal(result.status, failOn ? 23 : 0, result.stdout + result.stderr);
      const expected = failOn ? sequence.slice(0, sequence.indexOf(failOn) + 1) : sequence;
      assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), expected);
      if (failOn) assert.ok(result.stdout.includes(`::error title=Required check command failed::${failOn} exited 23`));
    }
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const checkJob = workflow.split('\n  check:\n')[1].split('\n  postgres:\n')[0];
    assert.match(checkJob, /      - name: Run required checks including owned storage\n        run: \.\/scripts\/ci\/run-check-job\.sh/);
    assert.doesNotMatch(checkJob, /\b(?:if|continue-on-error):/);
    assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts['test:restart-storage'], 'node scripts/require-restart-storage.ts');
  } finally { rmSync(work, { recursive: true }); }
});

test('CLI rejects absent, empty, malformed, skipped, failed and below-floor reports', () => {
  const work = mkdtempSync(join(tmpdir(), 'storage-report-'));
  try {
    const path = join(work, 'report.ndjson');
    const bad = rows(); bad[0].skip = true;
    const failed = rows(); failed[0].status = 'fail';
    for (const contents of [undefined, '', '{bad', JSON.stringify(null), bad.map((row) => JSON.stringify(row)).join('\n'), failed.map((row) => JSON.stringify(row)).join('\n'), rows().slice(1).map((row) => JSON.stringify(row)).join('\n')]) {
      if (contents !== undefined) writeFileSync(path, contents);
      const result = spawnSync(process.execPath, ['scripts/require-restart-storage.ts', '--results', path], {
        cwd: ROOT, env: { ...childEnvironment(work), GITHUB_ACTIONS: 'true' }, encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /::error /);
    }
    writeFileSync(path, rows().map((row) => JSON.stringify(row)).join('\n'));
    assert.equal(spawnSync(process.execPath, ['scripts/require-restart-storage.ts', '--results', path], {
      cwd: ROOT, env: childEnvironment(work), encoding: 'utf8',
    }).status, 0);
  } finally { rmSync(work, { recursive: true }); }
});

/** Run the real CLI/reporter against a tiny copied repo, not a mock of spawn.
 * No postgres is launched in these mutation controls; real clusters are tested
 * by the separate seven-test profile in the required job.
 */
test('CLI runs explicit files with a clean environment and refuses missing files/binaries and child failures', () => {
  const work = mkdtempSync(join(tmpdir(), 'storage-cli-'));
  try {
    mkdirSync(join(work, 'scripts')); mkdirSync(join(work, 'test')); mkdirSync(join(work, 'bin'));
    writeFileSync(join(work, 'package.json'), '{"type":"module"}');
    for (const script of ['require-restart-storage.ts', 'require-suites.ts', 'test-report.ts']) {
      copyFileSync(join(ROOT, 'scripts', script), join(work, 'scripts', script));
    }
    for (const bin of ['initdb', 'postgres']) {
      writeFileSync(join(work, 'bin', bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const integration = join(work, 'test/stagingRestartStorage.integration.ts');
    const entry = join(work, 'test/stagingRestartStorage.entrypoint.ts');
    const makeTests = (n: number) => `import { test } from 'node:test';\n${Array.from({ length: n }, (_, i) => `test('point ${i}', () => {});`).join('\n')}\n`;
    const clean = `import assert from 'node:assert/strict';
      assert.equal(process.env.NODE_ENV, undefined);
      for (const key of Object.keys(process.env)) {
        assert.ok(!key.startsWith('PG') && !['TWO_DATABASE_URL','TWO_TEST_DATABASE_URL','NODE_OPTIONS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','DISCORD_BOT_TOKEN','GH_TOKEN','NPM_TOKEN'].includes(key));
      }
      assert.match(process.env.HOME, /^\\/tmp\\/rsci-/);
      assert.match(process.env.TMPDIR, /^\\/tmp\\/rsci-/);
    `;
    writeFileSync(integration, clean + makeTests(5));
    writeFileSync(entry, "await import('./e2e.stagingrestart.test.ts');\n");
    writeFileSync(join(work, 'test/e2e.stagingrestart.test.ts'), makeTests(2));
    const poison = {
      ...childEnvironment(work, join(work, 'bin')), PGPORT: '1', PGPASSWORD: 'inert', PGOPTIONS: 'inert',
      TWO_DATABASE_URL: 'inert', TWO_TEST_DATABASE_URL: 'inert', NODE_ENV: 'production', NODE_OPTIONS: '--trace-warnings',
      HTTP_PROXY: 'inert', HTTPS_PROXY: 'inert', ALL_PROXY: 'inert', DISCORD_BOT_TOKEN: 'inert', GH_TOKEN: 'inert', NPM_TOKEN: 'inert',
    };
    const run = (env: NodeJS.ProcessEnv = poison) => spawnSync(process.execPath, ['scripts/require-restart-storage.ts'], {
      cwd: work, env, encoding: 'utf8',
    });
    const good = run(); assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /e2e.stagingrestart.test.ts -> 2 tests, 0 skipped, 0 failed/);
    assert.equal(run({ ...poison, TWO_TEST_POSTGRES_BIN: '/missing/binaries' }).status, 1);
    assert.equal(run({ ...poison, TWO_TEST_POSTGRES_BIN: '' }).status, 1);
    rmSync(entry); assert.equal(run().status, 1);
    writeFileSync(entry, "await import('./e2e.stagingrestart.test.ts');\n");
    for (const mutation of ['', "import { test } from 'node:test'; test.skip('skip', () => {});", "import { test } from 'node:test'; test('fail', () => { throw new Error('fixture'); });", "process.kill(process.pid, 'SIGTERM');"]) {
      writeFileSync(integration, mutation);
      assert.equal(run().status, 1);
    }
  } finally { rmSync(work, { recursive: true }); }
});
