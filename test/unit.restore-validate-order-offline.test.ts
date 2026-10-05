/**
 * TOG-10566: pg-restore must validate the backup before opening or migrating
 * the target.
 *
 * scripts/pg-restore.ts opened the target and ran migrations before
 * restore() inspected the file, so a wrong-version or truncated archive
 * changed target schema before being refused. The fix inspects the file
 * first; this proves the ordering through the real CLI with poison doubles
 * for openDb/migrate that record every call in a trace file.
 *
 * Fully hermetic (same --import hooks technique as
 * unit.backup-empty-events-offline): local fixture bytes only, no database,
 * no migrations on disk, no TWO_*_URL inherited into the child.
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
const hooks = fileURLToPath(new URL('./fixtures/restore-validate-order-hooks.mjs', import.meta.url));

interface Fixture {
  root: string;
  trace: string;
  run: (file: string) => { status: number; output: string };
}

/** A manifest covering every dumped table, with one events row by default. */
function manifestLines(version: number): Array<Record<string, unknown>> {
  return [
    {
      kind: 'manifest',
      version,
      createdAt: '2026-09-30T00:00:00.000Z',
      tables: DUMP_TABLES.map((name) => ({
        name,
        columns: ['id'],
        count: name === 'events' ? 1 : 0,
      })),
      eventsSequence: 1,
      sequences: { events: 1 },
      schemaMigrations: [],
    },
  ];
}

function gz(lines: Array<Record<string, unknown>> | string): Buffer {
  const text = typeof lines === 'string' ? lines : `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  return gzipSync(text);
}

function setup(): Fixture {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'restore-order-'));
  const trace = join(root, 'trace.txt');
  writeFileSync(trace, '');
  const columns: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  for (const t of DUMP_TABLES) {
    columns[t] = ['id'];
    counts[t] = t === 'events' ? 1 : 0;
  }
  const run = (file: string) => {
    const result = spawnSync(process.execPath, ['--import', hooks, cli, file, '--force'], {
      encoding: 'utf8',
      timeout: 60_000,
      // Explicit env: the child must never inherit a real database URL. The
      // target is a fake string the poison openDb ignores; if the CLI ever
      // opened a real target this env could not reach one.
      env: {
        PATH: process.env.PATH,
        TWO_RESTORE_URL: 'postgres://fake-test-target/restore_target',
        RESTORE_TEST_TRACE: trace,
        RESTORE_TEST_COLUMNS: JSON.stringify(columns),
        RESTORE_TEST_COUNTS: JSON.stringify(counts),
      },
    });
    assert.ifError(result.error);
    return { status: result.status ?? -1, output: (result.stdout ?? '') + (result.stderr ?? '') };
  };
  return { root, trace, run };
}

function writeFixture(root: string, name: string, payload: Buffer): string {
  const file = join(root, name);
  writeFileSync(file, payload);
  return file;
}

test('malformed JSON backup is refused before the target is opened or migrated', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const file = writeFixture(f.root, 'malformed.ndjson.gz', gz('this is not json{{{\n'));
  const result = f.run(file);
  assert.notEqual(result.status, 0, `expected refusal, got exit 0: ${result.output}`);
  assert.match(result.output, /RESTORE FAILED/);
  assert.match(result.output, /target was not opened or migrated/);
  assert.equal(readFileSync(f.trace, 'utf8'), '', 'refused backup must not open or migrate the target');
});

test('missing-end backup is refused before the target is opened or migrated', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const lines = [
    ...manifestLines(DUMP_VERSION),
    { kind: 'row', table: 'events', data: { id: 1 } },
    // No end marker: the disk-full case.
  ];
  const file = writeFixture(f.root, 'missing-end.ndjson.gz', gz(lines));
  const result = f.run(file);
  assert.notEqual(result.status, 0, `expected refusal, got exit 0: ${result.output}`);
  assert.match(result.output, /RESTORE FAILED/);
  assert.match(result.output, /target was not opened or migrated/);
  assert.equal(readFileSync(f.trace, 'utf8'), '', 'refused backup must not open or migrate the target');
});

test('wrong-version backup is refused before the target is opened or migrated', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const lines = [
    ...manifestLines(DUMP_VERSION + 1),
    { kind: 'row', table: 'events', data: { id: 1 } },
    { kind: 'end', rows: 1 },
  ];
  const file = writeFixture(f.root, 'wrong-version.ndjson.gz', gz(lines));
  const result = f.run(file);
  assert.notEqual(result.status, 0, `expected refusal, got exit 0: ${result.output}`);
  assert.match(result.output, /RESTORE FAILED/);
  assert.match(result.output, /target was not opened or migrated/);
  assert.equal(readFileSync(f.trace, 'utf8'), '', 'refused backup must not open or migrate the target');
});

test('valid backup still follows validate -> open -> migrate -> restore -> close', (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const lines = [
    ...manifestLines(DUMP_VERSION),
    { kind: 'row', table: 'events', data: { id: 1 } },
    { kind: 'end', rows: 1 },
  ];
  const file = writeFixture(f.root, 'valid.ndjson.gz', gz(lines));
  const result = f.run(file);
  assert.equal(result.status, 0, `valid restore failed: ${result.output}`);
  assert.match(result.output, /RESTORE VERIFIED/);
  const trace = readFileSync(f.trace, 'utf8').trimEnd().split('\n');
  assert.equal(trace[0], 'open', `target must open first, got: ${trace.join(',')}`);
  assert.equal(trace[1], 'migrate', `migrations run after open, got: ${trace.join(',')}`);
  assert.ok(trace.includes('transaction'), `restore must run a transaction, got: ${trace.join(',')}`);
  assert.ok(
    trace.indexOf('transaction') > trace.indexOf('migrate'),
    `transaction runs after migrate, got: ${trace.join(',')}`,
  );
  assert.equal(trace.at(-1), 'close', `database must close, got: ${trace.join(',')}`);
});
