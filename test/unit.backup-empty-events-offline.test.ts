/** Empty-event rejection must not evict or upload recovery history (TOG-10240). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const cli = fileURLToPath(new URL('../scripts/pg-backup.ts', import.meta.url));
const hooks = fileURLToPath(new URL('./fixtures/backup-empty-event-hooks.mjs', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'backup empty-'));
  const dest = join(root, 'backups');
  mkdirSync(dest);
  const prior = join(dest, 'two-funnel-20000101T000000Z.ndjson.gz');
  const bytes = gzipSync([
    { kind: 'manifest', version: 4, createdAt: '2000-01-01T00:00:00Z',
      tables: [{ name: 'events', columns: ['id'], count: 1 }],
      eventsSequence: 1, sequences: { events: 1 }, schemaMigrations: [] },
    { kind: 'row', table: 'events', data: { id: 1 } },
    { kind: 'end', rows: 1 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(prior, bytes);
  utimesSync(prior, new Date('2000-01-01'), new Date('2000-01-01'));
  const trace = join(root, 'trace.txt');
  const receipt = join(root, 'uploaded.json');
  const uploader = join(root, 'uploader.mjs');
  writeFileSync(uploader, `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    const out = process.argv.at(-1);
    appendFileSync(process.env.BACKUP_TEST_TRACE, 'upload\\n');
    writeFileSync(process.env.BACKUP_TEST_RECEIPT, JSON.stringify({
      out, priorExists: existsSync(process.env.BACKUP_TEST_PRIOR),
      bytes: readFileSync(out).toString('base64'),
    }));
  `);
  const run = (count: number) => spawnSync(process.execPath, ['--import', hooks, cli], {
    encoding: 'utf8',
    timeout: 10_000,
    // Explicit env: never inherit a real database URL, uploader or credential.
    env: {
      PATH: process.env.PATH,
      TWO_DATABASE_URL: 'postgres://agent_test@agent-testdb/two_bot_test_tog10240',
      TWO_BACKUP_DIR: dest,
      TWO_BACKUP_KEEP: '1',
      // The production command splits on whitespace; pass the recorder URL via env.
      TWO_BACKUP_UPLOAD_CMD: `${process.execPath} -e import(process.env.BACKUP_TEST_UPLOADER)`,
      BACKUP_TEST_UPLOADER: pathToFileURL(uploader).href,
      BACKUP_TEST_EVENT_COUNT: String(count),
      BACKUP_TEST_TRACE: trace,
      BACKUP_TEST_RECEIPT: receipt,
      BACKUP_TEST_PRIOR: prior,
    },
  });
  return { root, dest, prior, bytes, trace, receipt, run };
}

test('empty-event backup exits before pruning/upload and leaves the last valid archive byte-identical', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (let i = 1; i <= 3; i++) {
    const result = f.run(0);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /event log is empty/);
    assert.doesNotMatch(result.stdout, /backup: pruning|backup: uploaded|backup: done/);
    assert.equal(existsSync(f.receipt), false, 'rejected archive was uploaded');
    assert.deepEqual(readFileSync(f.prior), f.bytes, 'valid recovery bytes were changed');
    assert.deepEqual(readdirSync(f.dest), ['two-funnel-20000101T000000Z.ndjson.gz'],
      'rejected snapshot must not remain eligible for newest-backup selection');
    assert.equal(readFileSync(f.trace, 'utf8'), 'open\ndump\nclose\n'.repeat(i),
      'the database must close on every rejection');
  }
});

test('nonempty-event backup still prunes to keep=1 and uploads the new archive after closing the DB', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = f.run(1);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /backup: pruning two-funnel-20000101T000000Z/);
  assert.match(result.stdout, /backup: uploaded/);
  assert.match(result.stdout, /backup: done/);
  assert.equal(existsSync(f.prior), false);
  const remaining = readdirSync(f.dest);
  assert.equal(remaining.length, 1);
  const out = join(f.dest, remaining[0]!);
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
  assert.equal(receipt.out, out, 'the uploader receives the current archive path');
  assert.equal(receipt.priorExists, false, 'normal retention still runs before upload');
  assert.equal(receipt.bytes, readFileSync(out).toString('base64'));
  const manifest = JSON.parse(gunzipSync(readFileSync(out)).toString('utf8').split('\n')[0]!);
  assert.equal(manifest.tables[0].count, 1);
  assert.equal(readFileSync(f.trace, 'utf8'), 'open\ndump\nclose\nupload\n');
});
