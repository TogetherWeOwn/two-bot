/**
 * Run the Postgres-backed test suite and fail unless its critical suites report
 * their expected test floors with no skips.
 *
 *   TWO_TEST_DATABASE_URL=postgres://... node scripts/require-suites.ts
 *   node scripts/require-suites.ts --results FILE   # check a run, do not re-run it
 *
 * The structured reporter catches whole suites that vanish or skip in a way the
 * node:test summary cannot represent reliably. The test helper itself requires
 * TWO_TEST_DATABASE_URL, so a missing database now fails before the suite can
 * fall back to another engine.
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
  {
    file: 'test/e2e.containment.test.ts',
    minTests: 2,
    why: 'parallel Discord audit entries must serialize before destructive containment',
  },
  {
    // TOG-3471 (ported from the TOG-3052 slice). The residual check below
    // catches an unregistered suite that SKIPS or FAILS, but not one that
    // reports nothing at all - and this suite is the only place the "no
    // persisted row, no delete" invariant is exercised against a real
    // Postgres, so it vanishing silently is the failure that matters.
    // Measured 2026-09-20 against Postgres 18.1.
    file: 'test/unit.tempvoice.test.ts',
    minTests: 54,
    why: 'the "no persisted row, no delete" invariant, and the atomic per-user cap claim behind it',
  },
  {
    // TOG-3100. The residual check below catches an unregistered suite that
    // SKIPS or FAILS, but not one that reports nothing at all - and this suite
    // is the only place the env-only refusal is exercised against a real
    // Postgres, so it vanishing silently is the failure that matters.
    // Measured 2026-09-17 against Postgres 18.1, at f538689 + this commit.
    file: 'test/e2e.settingshotreload.test.ts',
    minTests: 8,
    why: 'a HOT key reloading without a restart, and the schema-level refusal of every env-only key',
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
        `${suite.file}: ${t.skipped} test point(s) SKIPPED. Nothing in the required ` +
          `Postgres-backed suite may opt out (${suite.why}).`,
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
  // the fourth: a required Postgres-backed suite added later that quietly skips here.
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

/**
 * GitHub Actions `::error` lines naming every failing test point.
 *
 * The broker profile withholds `actions:read` (TOG-247), so no agent can
 * download this job's log to find out what failed. Annotations are the only
 * channel that survives, and without this a red run reports exactly
 * "Process completed with exit code 1" - which names neither the suite nor the
 * test, and costs a whole CI round trip to narrow down.
 *
 * Suites are skipped: node:test marks a `describe` failed when a child test
 * fails, so emitting both would double-report the same failure.
 */
export function annotations(
  rows: ReportedTest[],
  problems: ReadonlyArray<string> = [],
  root: string = ROOT,
): string[] {
  // Annotation commands are newline-delimited, so any literal one truncates.
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const out: string[] = [];

  for (const row of rows) {
    if (row.status !== 'fail' || row.type === 'suite') continue;
    const file = row.file.startsWith(`${root}/`) ? row.file.slice(root.length + 1) : row.file;
    out.push(`::error file=${esc(file)},title=Failing test::${esc(`${file} > ${row.name}`)}`);
  }
  for (const p of problems) out.push(`::error title=Postgres suite requirement::${esc(p)}`);

  return out;
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
      // Fail before spawning dozens of files that all require the same URL.
      console.error('require-suites: TWO_TEST_DATABASE_URL is not set. This suite requires Postgres.');
      process.exit(1);
    }
    resultsPath = join(tmpdir(), `two-bot-results-${process.pid}.ndjson`);
    temporary = true;
    exitCode = await run(resultsPath);
  }

  const rows = parseResults(readFileSync(resultsPath, 'utf8'));
  if (temporary) rmSync(resultsPath, { force: true });

  const problems = check(rows);

  // Emitted before the human-readable report, and whenever the run is red at
  // all - a failing test exits non-zero through `exitCode` without necessarily
  // producing a `problems` entry.
  if (process.env.GITHUB_ACTIONS && (problems.length > 0 || exitCode !== 0)) {
    for (const line of annotations(rows, problems)) console.log(line);
  }

  console.log('');
  for (const suite of POSTGRES_SUITES) {
    const t = tally(rows).get(suite.file);
    console.log(
      `require-suites: ${suite.file} -> ${t ? `${t.tests} passing, ${t.skipped} skipped` : 'NOT REPORTED'}`,
    );
  }

  if (problems.length > 0) {
    console.error('\nrequire-suites: the required Postgres-backed suites did not run.\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nA green run here would mean the database was present and unused. See scripts/require-suites.ts.');
    process.exit(1);
  }

  console.log('require-suites: every required Postgres-backed suite ran, nothing skipped.');
  process.exit(exitCode);
}
