/** Explicit owned-cluster profile, separate from the service-DB test glob.
 * node scripts/require-restart-storage.ts --provision
 * TWO_TEST_POSTGRES_BIN=/trusted/bin node scripts/require-restart-storage.ts
 * node scripts/require-restart-storage.ts --results report.ndjson
 */
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotations, check, MAY_SKIP, parseResults, tally } from './require-suites.ts';
import type { ReportedTest } from './test-report.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const STORAGE_FILES = [
  'test/stagingRestartStorage.integration.ts',
  'test/stagingRestartStorage.entrypoint.ts',
] as const;
// Imported test events name their declaration file, not the entrypoint wrapper.
export const STORAGE_SUITES = [
  { file: STORAGE_FILES[0], minTests: 5, why: 'owned cluster migrations, isolation, lease identity and cleanup' },
  { file: 'test/e2e.stagingrestart.test.ts', minTests: 2, why: 'real entrypoint restarts and real scheduler on owned storage' },
] as const;

/** No ambient environment spread: not even PATH, NODE_OPTIONS, PG*, or npm config.
 * https://nodejs.org/docs/latest-v24.x/api/child_process.html#child_processspawncommand-args-options
 */
export function childEnvironment(work: string, bin?: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: 'C', LC_ALL: 'C',
    HOME: join(work, 'home'), TMPDIR: join(work, 'tmp'),
    ...(bin === undefined ? {} : { TWO_TEST_POSTGRES_BIN: bin }),
  };
}

export function checkStorage(rows: ReportedTest[], root = ROOT): string[] {
  // TODO points also do not prove execution. Reject malformed rows before tally
  // rather than letting an unknown status/type manufacture a passing floor.
  if (rows.some((row) => !row || typeof row.file !== 'string' || !row.file || typeof row.name !== 'string' ||
      !['test', 'suite'].includes(row.type) || !['pass', 'fail'].includes(row.status) ||
      typeof row.skip !== 'boolean' || typeof row.todo !== 'boolean' || row.todo)) {
    return ['owned-storage report contains a malformed or TODO test point'];
  }
  return check(rows, { root, required: STORAGE_SUITES, maySkip: MAY_SKIP });
}

export async function command(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', () => done(1));
    // close follows stdio completion, unlike exit. Signals and spawn errors fail.
    child.once('close', (code, signal) => done(signal ? 1 : (code ?? 1)));
  });
}

async function provision(work: string): Promise<string> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('CI provisioning requires Linux x64; other platforms must supply trusted binaries.');
  }
  const install = join(work, 'postgres');
  await mkdir(install, { mode: 0o700 });
  for (const file of ['package.json', 'package-lock.json']) {
    await copyFile(join(ROOT, 'scripts/ci/postgres-bin', file), join(install, file));
  }
  // A lockfile-only native dependency, installed in job-owned scratch; root
  // dependencies and ordinary cross-platform npm ci are unchanged.
  // https://docs.npmjs.com/cli/v11/commands/npm-ci
  // npm enables its own Node compile cache. Keep installer scratch separate so
  // the test cleanup assertion measures test-owned state, not npm cache files.
  const installerTmp = join(work, 'installer-tmp');
  await mkdir(installerTmp, { mode: 0o700 });
  const rc = await command('npm', ['ci', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'],
    install, { ...childEnvironment(work), TMPDIR: installerTmp });
  if (rc !== 0) throw new Error('Pinned PostgreSQL provisioning failed.');
  const bin = join(install, 'node_modules/@embedded-postgres/linux-x64/native/bin');
  for (const tool of ['initdb', 'postgres']) {
    if (await command(join(bin, tool), ['--version'], ROOT, childEnvironment(work)) !== 0) {
      throw new Error('Provisioned PostgreSQL binary could not execute.');
    }
  }
  return bin;
}

function report(rows: ReportedTest[], exitCode: number): number {
  const problems = checkStorage(rows);
  if (exitCode !== 0) problems.push('owned-storage test child failed or was signalled');
  if (process.env.GITHUB_ACTIONS) {
    for (const line of annotations(rows, problems)) console.log(line);
  }
  const counts = tally(rows);
  for (const suite of STORAGE_SUITES) {
    const t = counts.get(suite.file);
    console.log(`require-restart-storage: ${suite.file} -> ${t ? `${t.tests} tests, ${t.skipped} skipped, ${t.failed} failed` : 'NOT REPORTED'}`);
  }
  for (const problem of problems) console.error(`require-restart-storage: ${problem}`);
  return problems.length ? 1 : 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--results') {
    return report(parseResults(await readFile(args[1], 'utf8')), 0);
  }
  if (args.length && !(args.length === 1 && args[0] === '--provision')) {
    throw new Error('Use --provision, --results FILE, or no arguments with TWO_TEST_POSTGRES_BIN.');
  }
  // A short, fixed OS temp prefix avoids inherited TMPDIR and Unix socket path
  // limits. Every HOME/TMPDIR/cache/binary/report belongs to this invocation.
  const work = await mkdtemp('/tmp/rsci-');
  await mkdir(join(work, 'home'), { mode: 0o700 });
  await mkdir(join(work, 'tmp'), { mode: 0o700 });
  try {
    const bin = args[0] === '--provision' ? await provision(work) : process.env.TWO_TEST_POSTGRES_BIN;
    if (!bin || !isAbsolute(bin) || await realpath(bin) !== bin) {
      throw new Error('TWO_TEST_POSTGRES_BIN must identify trusted absolute local binaries.');
    }
    for (const tool of ['initdb', 'postgres']) await access(join(bin, tool), constants.X_OK);
    for (const file of STORAGE_FILES) await access(join(ROOT, file), constants.R_OK);
    const destination = join(work, 'report.ndjson');
    // Both storage files bootstrap their own owned postgres cluster
    // (freePort -> release -> postgres bind). Node runs test files in
    // parallel by default, so the two clusters race for the same ephemeral
    // port on the shared self-hosted host: one binds, the other fails at
    // createRestartStorage setup while its sibling passes (TOG-6361: runs
    // 36303845863 runner1 entrypoint setup refusal, 36306568799 runner12
    // integration first-test setup refusal). Serialize the two files; the
    // freePort/bind gap against other hosts' jobs remains, but the
    // in-job collision that fails every PR run is gone.
    const rc = await command(process.execPath, [
      '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${join(ROOT, 'scripts/test-report.ts')}`,
      `--test-reporter-destination=${destination}`, ...STORAGE_FILES,
    ], ROOT, childEnvironment(work, bin));
    return report(parseResults(await readFile(destination, 'utf8')), rc);
  } finally {
    // Successful tests close their retained child handles and remove their
    // directories. Never erase a leftover cluster (or signal an unowned PID)
    // to make failed cleanup appear green.
    if ((await readdir(join(work, 'tmp'))).length) {
      throw new Error('Owned-storage scratch was not empty after the run; retained for investigation.');
    }
    await rm(work, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch {
    // Exceptions from tooling/report parsing can include paths or environment
    // values. Do not print them; failure is never a successful empty report.
    console.error('require-restart-storage: provisioning, test inputs, report or cleanup failed; details withheld.');
    if (process.env.GITHUB_ACTIONS) console.log('::error title=Owned-storage requirement::Provisioning, test inputs, report or cleanup failed.');
    process.exitCode = 1;
  }
}
