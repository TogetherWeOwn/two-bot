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
    // TOG-6492. The two website-role CLIs executed end to end through the
    // real scripts: the provision grant list equals the contract, verify
    // passes on its own exit code, and a real over-grant fails it. Counted
    // from the 4 top-level test() blocks; CI's postgres job confirms the
    // count on the first run after this commit.
    file: 'test/e2e.webrole.test.ts',
    minTests: 4,
    why: 'the provision/verify website-role CLIs themselves, not just the library calls underneath them',
  },
  {
    file: 'test/e2e.growthreview.test.ts',
    minTests: 4,
    why: 'growth-review CLI golden scores, kill/scale citations, red-gate refusal and sustained-effort guard',
  },
  {
    // TOG-6489 slice. The campaigns operator CLI executed end to end through
    // the real npm entry: --add creates the row, the bare list shows it, a
    // duplicate --add fails naming "already exists", and the new slug 302s
    // over loopback HTTP. Counted from the 4 top-level test() blocks; CI's
    // postgres job confirms the count on the first run after this commit.
    file: 'test/e2e.campaigns.test.ts',
    minTests: 4,
    why: 'the campaigns --add/--list operator path itself, not just the CampaignStore underneath it',
  },
  {
    // TOG-6491. The restore script that can wipe a database: three refusals
    // (no --force, no TWO_RESTORE_URL, no fallback to TWO_DATABASE_URL), a
    // dry run that writes nothing, and a target + --force restore of a canned
    // dump with identical rows back. Counted from the 5 top-level test()
    // blocks; 5/5 green in CI postgres runs 36344199113 and 36351823205.
    file: 'test/e2e.pgrestore.test.ts',
    minTests: 5,
    why: 'the pg-restore safety refusals - without this floor a silent skip re-opens the wrong-database data-loss gap',
  },
  {
    // TOG-7709. The web-views CLI executed end to end through the real npm
    // entry: `npm run web:views` applies all 9 views, a hardcoded column
    // fixture pins every view's exact shape (the code asserting against
    // itself is the gap this closes), and --status changes nothing. Counted
    // from the 3 top-level test() blocks; 3/3 green on first local run
    // against Postgres 18.4, CI's postgres job confirms on merge.
    file: 'test/e2e.webviews.test.ts',
    minTests: 3,
    why: 'the web-views contract CLI itself plus the exact web_v1 column fixture - without this floor a silent column drift breaks two-web',
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
    // TOG-3100. The residual check below catches an unregistered suite that
    // SKIPS or FAILS, but not one that reports nothing at all - and this suite
    // is the only place the env-only refusal is exercised against a real
    // Postgres, so it vanishing silently is the failure that matters.
    // Measured 2026-09-17 against Postgres 18.1, at f538689 + this commit.
    file: 'test/e2e.settingshotreload.test.ts',
    minTests: 8,
    why: 'a HOT key reloading without a restart, and the schema-level refusal of every env-only key',
  },
  {
    // TOG-3471. Provenance-guarded deletion and cleanup recovery, atomic caps,
    // serialized durable ownership, and permission refusal all need a real
    // Postgres to enforce. A run that quietly stopped including this file
    // would leave those guarantees unverified and green.
    file: 'test/unit.tempvoice.test.ts',
    minTests: 86,
    why: 'provenance-guarded deletion and cleanup recovery, atomic caps, serialized durable ownership, and permission refusal',
  },
  {
    // TOG-3481. Registered for the same reason as the suite above: this is the
    // only place the reward probe's "writes nothing" property is enforced
    // rather than asserted by reading the source, and it needs a real Postgres
    // to install the trigger that enforces it. A run that quietly stopped
    // including this file would leave that guarantee unverified and green.
    // Measured 2026-09-22 against Postgres 17.11, at 7c1135b + this commit.
    file: 'test/e2e.levelrewardprobe.test.ts',
    minTests: 8,
    why: 'the reward-role probe writing nothing, proved by a database that refuses the write',
  },
  {
    // TOG-4444. The staging reward-role apply path: grant/readback/revoke
    // through the CLI, its audit row, and the triggers that refuse a
    // reward-config write or a live-guild audit row. Floor is the file's test
    // count as written; not yet measured against a Postgres run.
    file: 'test/e2e.levelrewardroleapply.test.ts',
    minTests: 10,
    why: 'the staging reward-role apply writing only the staging guild, proved by a database that refuses the rest',
  },
  {
    file: 'test/e2e.stagingrestart.test.ts',
    minTests: 1,
    why: 'real entrypoint containment across three restarts, zero Discord mutations and pre-persistence actor filtering',
  },
  {
    // TOG-4230. The startup-to-handler wiring this card repairs: the tripwire
    // evaluates the actual startInternalActions call in src/index.ts, and the
    // round trip proves signed settings.set persists, audits, refreshes and
    // reaches the consumer over isolated Postgres. Deleting the file must red
    // the build rather than silently unpin the wiring.
    // Measured 2026-09-23 against Postgres 18.1, at 826c390 + this commit.
    file: 'test/e2e.settingsstartup.test.ts',
    minTests: 8,
    why: 'the settings-service startup injection and the signed settings round trip, or the TOG-4104 gap re-opens unnoticed',
  },
  {
    // TOG-5689. The RUNBOOK "Is it alive?" checks as an executable script: the
    // ready-line shape, health-before-ready ordering and one-JSON-object-per-line
    // logs against the mock harness, with host-only checks listed as skipped.
    // Measured 2026-09-27 against Postgres 18.4 (embedded), at this commit.
    file: 'test/e2e.runbook-health.test.ts',
    minTests: 3,
    why: 'the runbook liveness verdict going green against the mock harness, or its skips going unlisted',
  },
  {
    // TOG-7198. The moderation kill-switch flip cycle: all nine verbs execute
    // through the live signed endpoint, all nine refuse at the allowlist gate
    // with zero Discord calls after a disable restart, and all nine recover
    // on re-enable. Needs a real Postgres for the warn row and the durable
    // idempotency claim. A run that quietly stopped including this file would
    // leave the mid-flow disable unproved while the static gating in PR #216
    // stays green.
    // Measured 2026-09-27 against Postgres 17.11, at this commit.
    file: 'test/e2e.moderation-killswitch-flip.test.ts',
    minTests: 3,
    why: 'the moderation kill-switch refuse/recover cycle through the live endpoint, or a half-disabled slice ships unnoticed',
  },
  {
    // TOG-6481. The voice-sessions CLI executed end to end through the real
    // npm entry: paired + orphan starts count as sessions, known-start ends
    // average to 20m over 2 measured, and the two startKnown:false ends are
    // excluded from the mean and attributed to the one blind window. Counted
    // from the 2 top-level test() blocks; CI's postgres job confirms the
    // count on the first run after this commit.
    file: 'test/e2e.voicesessions-cli.test.ts',
    minTests: 2,
    why: 'the voice-sessions averages CLI itself, not just the helpers underneath it - without this floor a silent skip re-opens the startKnown averaging gap',
  },
  {
    // TOG-9993. The voice-reconcile sweep run twice end to end through the
    // real npm entry: byte-identical reports (3 resolved, 4 flagged, 1
    // complete) and an unchanged events table. Read-only by design, so the
    // double run is the property; without this floor a future write path or
    // unstable output would stay green while every re-run drifted. Counted
    // from the 2 top-level test() blocks; CI's postgres job confirms the
    // count on the first run after this commit.
    file: 'test/e2e.voicereconcile-idempotency.test.ts',
    minTests: 2,
    why: 'the voice-reconcile idempotency proof itself - without this floor a silent skip re-opens the double-run drift gap',
  },
  {
    // TOG-6493. The audit kill switch operated end to end through the real
    // CLI: disengaged status on a fresh schema, halt engages and a second
    // halt changes nothing, seeded pending rows are reported honestly, and
    // resume disengages without dropping evidence. Counted from the 3
    // top-level test() blocks; CI's postgres job confirms the count on the
    // first run after this commit.
    file: 'test/e2e.auditswitch.test.ts',
    minTests: 3,
    why: 'the audit halt/resume/status CLI path itself, not just the helpers underneath it - without this floor a silent skip re-opens the audit-script gap',
  },
  {
    // TOG-6488. The presence-trend CLI executed end to end through the real
    // script: closed text pins every seeded bucket row plus the tally and
    // verdict lines, --days slices the table but never the verdict, --json
    // is exactly one object with the count and verdict, --web-live on three
    // qualifying days fires with exit 2, and an empty window explains
    // itself. Counted from the 5 top-level test() blocks; CI's postgres job
    // confirms the count on the first run after this commit.
    file: 'test/e2e.presencetrend-cli.test.ts',
    minTests: 5,
    why: 'the presence-trend output CLI itself, not just the helpers underneath it - without this floor a silent skip re-opens the unpinned staffing/event-slot numbers gap',
  },
  {
    // TOG-9985. The moderation disable-preflight script executed end to end
    // through the real script: exit 0 CLEAR on empty state (plain and
    // --json), exit 1 REFUSED for each partial shape (unban-only,
    // lockdown-only, both plus a running claim with hand-release SQL) with
    // --json counts and stranded id lists, and exit 2 could-not-tell for a
    // missing URL, an unreachable database, a non-postgres URL, and a schema
    // without the tables. Counted from the 10 top-level test() blocks; CI's
    // postgres job confirms the count on the first run after this commit.
    file: 'test/e2e.moderation-disable-preflight.test.ts',
    minTests: 10,
    why: 'the moderation-disable-preflight exits themselves, not just the library underneath them - without this floor a silent skip re-opens the wave-through-disable gap',
  },
  {
    // TOG-9998. The dedupe-events repair script run end to end through the
    // real script: --dry-run counts without deleting, the real run deletes
    // exactly the copies (keeping the earliest of each cluster) and a second
    // run deletes nothing with a byte-identical digest. Counted from the 2
    // top-level test() blocks; CI's postgres job confirms the count on the
    // first run after this commit.
    file: 'test/e2e.dedupeevents.test.ts',
    minTests: 2,
    why: 'the dedupe-events duplicate-detection and idempotent-delete proof itself - without this floor a silent skip re-opens the phantom-join count gap',
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
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/require-suites.ts [--results <report.ndjson>]');
    process.exit(0);
  }
  const at = process.argv.indexOf('--results');
  const existing = at >= 0 ? process.argv[at + 1] : undefined;

  let exitCode = 0;
  let resultsPath: string;
  let temporary = false;

  if (existing) {
    resultsPath = existing;
  } else {
    // Fail before spawning dozens of files that all require the same URL —
    // and refuse a non-test host before any migration runs (TOG-9656). The
    // allowlist is inline here, not imported, because
    // test/unit.restartstorageci.test.ts executes this file from a bare
    // fixture tree containing only this file plus test-report.ts. Mirrors
    // scripts/test-db-guard.ts, including the query-string refusal:
    // node-postgres promotes ?host=/?port= over the hostname, so a query
    // string bypasses any hostname allowlist.
    const testDbUrl = process.env.TWO_TEST_DATABASE_URL?.trim() ?? '';
    const allowedTestDbHosts = new Set(['agent-testdb', '127.0.0.1', 'localhost', '::1', '[::1]', 'postgres']);
    let testDbHost = '';
    let testDbHasQuery = false;
    try {
      const parsedTestDbUrl = new URL(testDbUrl);
      testDbHost = parsedTestDbUrl.hostname.toLowerCase().replace(/\.$/, '');
      testDbHasQuery = parsedTestDbUrl.search !== '';
    } catch {
      testDbHost = '';
    }
    if (!testDbUrl) {
      console.error('require-suites: TWO_TEST_DATABASE_URL is not set. This suite requires Postgres.');
      process.exit(1);
    }
    if (testDbHasQuery) {
      console.error(
        'require-suites: TWO_TEST_DATABASE_URL carries a query string, which node-postgres promotes over ' +
          'the hostname (?host=/?port= retarget the connection), refusing to run. Pass a bare database URL.',
      );
      process.exit(1);
    }
    if (!allowedTestDbHosts.has(testDbHost)) {
      console.error(
        `require-suites: TWO_TEST_DATABASE_URL host "${testDbHost || '(unparsable)'}" is not an isolated test ` +
          'database, refusing to run. Tests may only target agent-testdb, 127.0.0.1/localhost, or the CI ' +
          '"postgres" service container; production and staging hosts are never valid test targets.',
      );
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
