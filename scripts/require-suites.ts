/**
 * Run the test suite and fail unless the Postgres-only suites actually ran.
 *
 *   TWO_TEST_DATABASE_URL=postgres://... node scripts/require-suites.ts
 *   node scripts/require-suites.ts --results FILE   # check a run, do not re-run it
 *
 * ## Why this exists
 *
 * The `postgres` CI job (TOG-465) gives the suite a real database. It does not
 * prove the Postgres-only suites *used* it. The argument that they did was:
 * the env var is set, the deploy sequence in the same job needs the same
 * database and passes, therefore the `skip:` guards in e2e.webcontract,
 * e2e.backup and e2e.concurrency must have been false. Sound reasoning - and
 * reasoning is not a check. Rename the env var, or grow a second skip
 * condition, and the job stays green while the suites go back to skipping.
 * That is the exact failure TOG-465 existed to kill (TOG-475).
 *
 * ## Why it does not read the summary
 *
 * The obvious implementation - run `npm test` and assert `skipped 0` - is
 * itself green by absence. A `describe` that skips itself reports:
 *
 *   ok 1 - backup round trip # SKIP needs TWO_TEST_DATABASE_URL
 *   # tests 0
 *   # skipped 0
 *
 * Measured on Node 24.19: three whole suites absent, `skipped 0`, exit 0. The
 * printed counters cannot see this. So the check reads the structured reporter
 * stream instead (scripts/test-report.ts), where the skip is still attached to
 * the test point, and asserts per file: reported at all, nothing skipped, and
 * at least as many passing tests as the last time anyone looked.
 *
 * ## Why it runs inside the job
 *
 * The broker profile withholds `actions:read` (TOG-247), so no agent can read a
 * job log from outside to check this after the fact. The assertion has to fail
 * the job itself, which is the right design regardless.
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportedTest } from './test-report.ts';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/**
 * The suites that are meaningless without a real Postgres, and the number of
 * passing tests each had when it was last measured.
 *
 * `minTests` is a floor, not an equality: adding tests must never red the
 * build, deleting them must. If a refactor legitimately removes tests, lower
 * the number in the same commit - that is the conversation this file is for.
 *
 * Measured 2026-08-25 against Postgres 18.4, at e9d28a0.
 */
export const POSTGRES_SUITES: ReadonlyArray<{ file: string; minTests: number; why: string }> = [
  {
    file: 'test/e2e.webcontract.test.ts',
    minTests: 22,
    why: 'the whole web_v1 contract the website reads, including the role grants',
  },
  {
    file: 'test/e2e.backup.test.ts',
    minTests: 7,
    why: 'the dump/restore round trip - the only thing standing behind a restore',
  },
  {
    file: 'test/e2e.concurrency.test.ts',
    minTests: 4,
    why: 'two writer processes against one database; SQLite cannot express it',
  },
];

/**
 * Suites allowed to skip in this job. Empty, and it should stay empty: this job
 * exists so that nothing silently opts out of it. A new conditional suite lands
 * here with a reason, or it is not conditional.
 */
export const MAY_SKIP: ReadonlyArray<string> = [];

export interface FileTally {
  tests: number;
  suites: number;
  skipped: number;
  failed: number;
}

/** Reduce reporter rows to a per-file tally, keyed by repo-relative path. */
export function tally(rows: ReportedTest[], root: string = ROOT): Map<string, FileTally> {
  const out = new Map<string, FileTally>();
  for (const row of rows) {
    // The reporter records absolute paths; the manifest is repo-relative so it
    // reads like the file listing and survives being run from anywhere.
    const key = row.file.startsWith(`${root}/`) ? row.file.slice(root.length + 1) : row.file;
    let t = out.get(key);
    if (!t) {
      t = { tests: 0, suites: 0, skipped: 0, failed: 0 };
      out.set(key, t);
    }
    if (row.type === 'suite') t.suites += 1;
    else t.tests += 1;
    // A skipped suite hides every test under it, so a skip anywhere in the file
    // means the file did not run in full - counted whatever its nesting.
    if (row.skip) t.skipped += 1;
    if (row.status === 'fail') t.failed += 1;
  }
  return out;
}

/**
 * The whole check, as a pure function of the reporter output, so that it can be
 * tested against synthetic runs instead of only against a green day. Returns
 * the problems it found; empty means the run is acceptable.
 */
export function check(
  rows: ReportedTest[],
  opts: { root?: string; required?: typeof POSTGRES_SUITES; maySkip?: ReadonlyArray<string> } = {},
): string[] {
  const root = opts.root ?? ROOT;
  const required = opts.required ?? POSTGRES_SUITES;
  const maySkip = opts.maySkip ?? MAY_SKIP;
  const byFile = tally(rows, root);
  const problems: string[] = [];

  for (const suite of required) {
    const t = byFile.get(suite.file);
    if (!t) {
      problems.push(
        `${suite.file}: reported no tests at all. It was renamed, deleted, or the run did not include it. ` +
          `This job exists to run it (${suite.why}).`,
      );
      continue;
    }
    if (t.skipped > 0) {
      problems.push(
        `${suite.file}: ${t.skipped} test point(s) SKIPPED. The database is not reaching the suite - ` +
          `check TWO_TEST_DATABASE_URL and the guard in the file (${suite.why}).`,
      );
    }
    if (t.tests < suite.minTests) {
      problems.push(
        `${suite.file}: ${t.tests} passing tests, expected at least ${suite.minTests}. ` +
          `Tests were removed, or part of the suite stopped running (${suite.why}).`,
      );
    }
  }

  // The manifest is fail-closed for the three suites we know about. This catches
  // the fourth: a Postgres-only suite added later that quietly skips here.
  for (const [file, t] of [...byFile].sort()) {
    if (t.skipped > 0 && !maySkip.includes(file) && !required.some((s) => s.file === file)) {
      problems.push(
        `${file}: ${t.skipped} test point(s) SKIPPED. Nothing may skip in this job - ` +
          `add it to POSTGRES_SUITES if it needs the database, or to MAY_SKIP with a reason.`,
      );
    }
    if (t.failed > 0) problems.push(`${file}: ${t.failed} failing test point(s).`);
  }

  if (byFile.size === 0) problems.push('the reporter recorded no test points at all: the run did not happen.');

  return problems;
}

export function parseResults(text: string): ReportedTest[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ReportedTest);
}

/** Every file `npm test` would run, expanded here so the two cannot drift. */
function testFiles(): string[] {
  return readdirSync(join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `test/${name}`);
}

async function run(destination: string): Promise<number> {
  const args = [
    '--test',
    // Two reporters: one for a human reading the job log, one for this script.
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${join(ROOT, 'scripts/test-report.ts')}`,
    `--test-reporter-destination=${destination}`,
    ...testFiles(),
  ];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  return await new Promise<number>((done) => {
    child.on('exit', (code, signal) => done(signal ? 1 : (code ?? 1)));
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const at = process.argv.indexOf('--results');
  const existing = at >= 0 ? process.argv[at + 1] : undefined;

  let exitCode = 0;
  let resultsPath: string;
  let temporary = false;

  if (existing) {
    resultsPath = existing;
  } else {
    if (!process.env.TWO_TEST_DATABASE_URL?.trim()) {
      // Failing here rather than after a 25-second run: without the URL every
      // suite in the manifest skips, and the report below would be a long way
      // of saying the same thing.
      console.error('require-suites: TWO_TEST_DATABASE_URL is not set. This runner is for the Postgres job.');
      process.exit(1);
    }
    resultsPath = join(tmpdir(), `two-bot-results-${process.pid}.ndjson`);
    temporary = true;
    exitCode = await run(resultsPath);
  }

  const rows = parseResults(readFileSync(resultsPath, 'utf8'));
  if (temporary) rmSync(resultsPath, { force: true });

  const problems = check(rows);

  console.log('');
  for (const suite of POSTGRES_SUITES) {
    const t = tally(rows).get(suite.file);
    console.log(
      `require-suites: ${suite.file} -> ${t ? `${t.tests} passing, ${t.skipped} skipped` : 'NOT REPORTED'}`,
    );
  }

  if (problems.length > 0) {
    console.error('\nrequire-suites: the Postgres-only suites did not run.\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nA green run here would mean the database was present and unused. See scripts/require-suites.ts.');
    process.exit(1);
  }

  console.log('require-suites: every Postgres-only suite ran, nothing skipped.');
  process.exit(exitCode);
}
