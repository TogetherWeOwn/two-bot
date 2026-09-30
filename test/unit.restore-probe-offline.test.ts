/**
 * TOG-10570: target probe failures are not evidence of missing tables or a
 * corrupt backup. Run the actual CLI and dump reader with synthetic SQLSTATE
 * errors and traced openDb/COUNT/close doubles. No database, socket or network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { DUMP_TABLES, DUMP_VERSION } from '../src/store/dump.ts';

const cli = fileURLToPath(new URL('../scripts/pg-restore.ts', import.meta.url));
const hooks = fileURLToPath(new URL('./fixtures/restore-probe-hooks.mjs', import.meta.url));
const open = 'open {"skipMigrations":true,"applicationName":"two-bot-restore"}';
// The probe COUNT is deliberately unqualified: it reads through the same
// search_path the --force restore uses. A 42P01 from it is ambiguous (missing
// table vs USAGE-denied schema hidden from name resolution), so the CLI
// disambiguates with a catalog visibility query - which only ever runs on the
// 42P01 path, never on a successful or otherwise-failed COUNT.
const countOperations = DUMP_TABLES.flatMap((table) => [
  `prepare SELECT COUNT(*) AS n FROM ${table}`,
  `get ${table}`,
]);
const visibilityOperations = (table: string) => ['visibility-prepare', `visibility ${table}`];
function withVisibility(operations: string[], table: string): string[] {
  const at = operations.findLastIndex((operation) =>
    operation === `get ${table}` || operation === `prepare SELECT COUNT(*) AS n FROM ${table}`);
  assert.notEqual(at, -1);
  return [...operations.slice(0, at + 1), ...visibilityOperations(table), ...operations.slice(at + 1)];
}

interface Failure {
  phase: 'get' | 'prepare' | 'open' | 'close';
  code?: string;
  message: string;
  table?: string;
  /** Catalog visibility outcome for the 42P01 disambiguation query. */
  visibility?: 'absent' | 'hidden' | 'off-path' | 'fail';
}

function setup() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'restore-probe-'));
  const file = join(root, 'valid.ndjson.gz');
  const trace = join(root, 'trace.txt');
  const lines = [
    {
      kind: 'manifest',
      version: DUMP_VERSION,
      createdAt: '2026-09-30T00:00:00.000Z',
      tables: DUMP_TABLES.map((name) => ({ name, columns: ['id'], count: name === 'events' ? 1 : 0 })),
      eventsSequence: 1,
      sequences: { events: 1 },
      schemaMigrations: [],
    },
    { kind: 'row', table: 'events', data: { id: 1 } },
    { kind: 'end', rows: 1 },
  ];
  writeFileSync(file, gzipSync(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`));
  const run = (failure?: Failure) => {
    writeFileSync(trace, '');
    const result = spawnSync(process.execPath, ['--import', hooks, cli, file, '--dry-run'], {
      encoding: 'utf8',
      timeout: 60_000,
      // Explicit child env prevents any inherited real target/credentials.
      env: {
        PATH: process.env.PATH,
        TWO_RESTORE_URL: 'postgres://fake-test-target/restore_target',
        RESTORE_PROBE_TRACE: trace,
        RESTORE_PROBE_PHASE: failure?.phase,
        RESTORE_PROBE_CODE: failure?.code,
        RESTORE_PROBE_MESSAGE: failure?.message,
        RESTORE_PROBE_TABLE: failure?.table ?? 'events',
        RESTORE_PROBE_VISIBILITY: failure?.visibility,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'CLI must exit normally');
    assert.notEqual(result.status, null);
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      operations: readFileSync(trace, 'utf8').split('\n').filter(Boolean),
    };
  };
  return { root, run };
}

function assertReadOnly(operations: string[], counts = countOperations) {
  assert.deepEqual(operations, [open, ...counts, 'close'],
    'only skip-migrations open, allowlisted COUNT/catalog reads and exactly one close; no migration/transaction/write');
}

function assertProbeFailure(result: { status: number | null; output: string }) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /target probe failed/i);
  assert.match(result.output, /1 rows read and verified\. Nothing was written\./);
  assert.match(result.output, /DRY RUN TARGET PROBE FAILED - the backup file was verified/);
  assert.doesNotMatch(result.output, /DRY RUN VERIFIED|no such table|migrate first|file does not hold|backup is invalid/);
}

test('configured dry-run reports successful counts and closes without writes', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = f.run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /events\s+manifest\s+1\s+in file\s+1\s+ok\s+target now 17/);
  assert.match(result.output, /DRY RUN VERIFIED/);
  assertReadOnly(result.operations);
});

for (const phase of ['get', 'prepare'] as const) {
  test(`42P01 from ${phase} with catalog-confirmed absence remains informational`, (t) => {
    const f = setup();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const result = f.run({ phase, code: '42P01', message: 'synthetic localized message', visibility: 'absent' });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /events\s+.*target now \(no such table - the restore would migrate first\)/);
    assert.match(result.output, /members\s+.*target now 3/);
    assert.match(result.output, /DRY RUN VERIFIED/);
    assert.doesNotMatch(result.output, /target probe failed/i);
    const counts = phase === 'prepare'
      ? countOperations.filter((operation) => operation !== 'get events')
      : countOperations;
    assertReadOnly(result.operations, withVisibility(counts, 'events'));
  });
}

const countFailures: Array<{ name: string; failure: Failure }> = [
  { name: '42501 permission denial', failure: { phase: 'get', code: '42501', message: 'permission denied' } },
  { name: '42P01 hiding schema-USAGE denial', failure: { phase: 'get', code: '42P01', message: 'synthetic invisible relation', visibility: 'hidden' } },
  { name: '42P01 with an off-path relation', failure: { phase: 'get', code: '42P01', message: 'synthetic off-path relation', visibility: 'off-path' } },
  { name: '42P01 with failed catalog lookup', failure: { phase: 'get', code: '42P01', message: 'synthetic unknown visibility', visibility: 'fail' } },
  { name: '08006 connection failure', failure: { phase: 'get', code: '08006', message: 'connection failure', table: 'members' } },
  { name: 'ECONNRESET transport failure', failure: { phase: 'get', code: 'ECONNRESET', message: 'connection reset' } },
  { name: 'uncoded runtime failure', failure: { phase: 'get', message: 'synthetic runtime rejection' } },
  { name: 'missing-table text without SQLSTATE', failure: { phase: 'get', message: 'relation events does not exist' } },
  { name: 'synchronous prepare failure', failure: { phase: 'prepare', message: 'synthetic prepare failure' } },
];

for (const { name, failure } of countFailures) {
  test(`${name} fails the requested target probe, not backup verification`, (t) => {
    const f = setup();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const result = f.run(failure);
    assertProbeFailure(result);
    const table = failure.table ?? 'events';
    assert.match(result.output, new RegExp(`${table}\\s+.*target now \\(target probe failed\\)`));
    assert.match(result.output, new RegExp(`target probe failed for ${table}:.*${failure.message}`));
    const counts = failure.phase === 'prepare'
      ? countOperations.filter((operation) => operation !== `get ${table}`)
      : countOperations;
    assertReadOnly(result.operations, failure.code === '42P01' ? withVisibility(counts, table) : counts);
    if (failure.visibility === 'hidden' || failure.visibility === 'off-path') {
      assert.match(result.output, /same-named relation exists but is not visible through the target search_path/);
    }
    if (failure.visibility === 'fail') {
      assert.match(result.output, /visibility check failed: Error: synthetic visibility failure/);
    }
  });
}

test('open failure reports a failed probe while preserving the file verdict', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = f.run({ phase: 'open', code: '08006', message: 'synthetic open failure' });
  assertProbeFailure(result);
  assert.match(result.output, /target probe failed:.*synthetic open failure/);
  assert.deepEqual(result.operations, [open], 'no Db was returned, so there is nothing to close or write');
});

test('close failure is a failed target probe and never retries close', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = f.run({ phase: 'close', message: 'synthetic close failure' });
  assertProbeFailure(result);
  assert.match(result.output, /target probe failed:.*synthetic close failure/);
  assertReadOnly(result.operations);
});
