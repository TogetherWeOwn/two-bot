/**
 * TOG-3191 acceptance, by execution.
 *
 * Two properties carry the card and are asserted against the real CLI against a
 * real Postgres:
 *
 *  1. Mutating one row of the export changes the sha256 AND the totals. A
 *     manifest whose only moving part is the checksum is not reconciling
 *     anything - it is hashing a file and reporting constants.
 *  2. A row that would lower an existing member's imported XP is reported as
 *     skipped with its reason. Silent drops are how an import looks clean and
 *     loses data.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { LevelingService } from '../src/leveling/service.ts';
import { inventory, parseMee6Export, sha256, Mee6ExportError } from '../src/leveling/importManifest.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/levels-import-mee6.ts', import.meta.url).pathname;
const GUILD = '1545644954272137297';
const ALICE = '100000000000000001';
const BOB = '100000000000000002';

let harness: TestDb;
let dbEnv: Record<string, string>;
let dir: string;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  dbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };
  dir = mkdtempSync(join(tmpdir(), 'two-bot-import-manifest-'));
});

after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await harness.cleanup();
});

beforeEach(() => harness.reset());

function exportFile(name: string, players: Array<{ id: string; xp: number }>): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ players }));
  return path;
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env: { ...process.env, ...dbEnv } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function manifestFrom(args: string[]) {
  const result = await cli(args);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test('one mutated row moves the checksum and every total derived from the data', async () => {
  const base = exportFile('base.json', [
    { id: ALICE, xp: 100 },
    { id: BOB, xp: 250 },
  ]);
  const mutated = exportFile('mutated.json', [
    { id: ALICE, xp: 100 },
    { id: BOB, xp: 900 },
  ]);

  const a = await manifestFrom(['--guild', GUILD, '--file', base]);
  const b = await manifestFrom(['--guild', GUILD, '--file', mutated]);

  assert.notEqual(a.file.sha256, b.file.sha256);
  assert.match(a.file.sha256, /^[0-9a-f]{64}$/);

  // The manifest's checksum must be of the bytes it actually imported, not of
  // whatever a second read of the path returned.
  const { readFileSync } = await import('node:fs');
  assert.equal(a.file.sha256, sha256(readFileSync(base)));
  assert.equal(a.file.bytes, readFileSync(base).byteLength);
  assert.equal(b.file.sha256, sha256(readFileSync(mutated)));

  // The point of the card: the totals move too, because they are computed from
  // the rows rather than restated from the file's shape.
  assert.equal(a.totalXpIn, 350);
  assert.equal(b.totalXpIn, 1000);
  assert.equal(a.uniqueXpIn, 350);
  assert.equal(b.uniqueXpIn, 1000);
  assert.equal(a.importedXpWritten, 350);
  assert.equal(b.importedXpWritten, 1000);
  assert.equal(a.totalXpAfterProjected, 350);
  assert.equal(b.totalXpAfterProjected, 1000);

  for (const m of [a, b]) {
    assert.equal(m.mode, 'dry-run');
    assert.equal(m.rowsWritten, 2);
    assert.equal(m.accounting.rowsIn, 2);
    assert.equal(m.accounting.balances, true);
    assert.equal(m.reconciled, true);
    assert.equal(m.totalXpAfterMeasured, null);
    assert.deepEqual(m.skipped, []);
  }

  assert.equal(
    Number((await harness.db.prepare(`SELECT COUNT(*) AS c FROM member_levels`).get<{ c: number }>())?.c),
    0,
    'neither dry run may write',
  );
});

test('a row that would lower an existing member is skipped with its reason, and organic XP survives', async () => {
  const service = new LevelingService(harness.db);

  // Alice arrives from MEE6 with 900, then earns 15 organically after the
  // migration. Bob has never been imported.
  await manifestFrom(['--guild', GUILD, '--file', exportFile('seed.json', [{ id: ALICE, xp: 900 }]), '--apply']);
  await service.awardMessage(GUILD, ALICE, '2026-09-17T04:00:00.000Z');
  const seeded = await inventory(harness.db, GUILD);
  assert.deepEqual(seeded, {
    guildId: GUILD,
    memberRows: 1,
    totalXp: 915,
    totalOrganicXp: 15,
    totalImportedXp: 900,
  });

  // A stale export re-lists Alice at 100 and introduces Bob.
  const stale = exportFile('stale.json', [
    { id: ALICE, xp: 100 },
    { id: BOB, xp: 40 },
  ]);

  const dry = await manifestFrom(['--guild', GUILD, '--file', stale]);
  assert.deepEqual(dry.skippedByReason, {
    duplicate_row: 0,
    would_lower_imported_xp: 1,
    exceeds_xp_ceiling: 0,
  });
  assert.equal(dry.skipped.length, 1);
  assert.equal(dry.skipped[0].memberId, ALICE);
  assert.equal(dry.skipped[0].reason, 'would_lower_imported_xp');
  assert.match(dry.skipped[0].detail, /export XP 100 is below the 900 already imported/);
  assert.equal(dry.accounting.rowsIn, 2);
  assert.equal(dry.accounting.skippedMembers, 1);
  assert.equal(dry.accounting.inserted, 1);
  assert.equal(dry.accounting.balances, true);
  assert.equal(dry.rowsWritten, 1);
  assert.equal(dry.totalXpAfterProjected, 955); // 915 untouched + Bob's 40

  const applied = await manifestFrom(['--guild', GUILD, '--file', stale, '--apply']);
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.reconciled, true);
  assert.deepEqual(applied.reconciliationErrors, []);
  assert.equal(applied.totalXpAfterMeasured, 955);
  assert.equal(applied.totalXpAfterMeasured, applied.totalXpAfterProjected);
  assert.equal(applied.skipped[0].reason, 'would_lower_imported_xp');

  // Alice kept both halves: the import that was declined and the XP she earned.
  const alice = await service.profile(GUILD, ALICE);
  assert.equal(alice.xp, 915);
  assert.equal(alice.importedXp, 900);
  assert.equal(alice.messageXp, 15);

  // TOG-9915: the audit row describes the source file, not the post-decline
  // rows. The second run saw 2 file rows / 2 file members even though Alice
  // was declined and only Bob was written.
  const runs = await harness.db
    .prepare(
      `SELECT source_rows, unique_members, inserted, updated, unchanged, duplicate_rows
         FROM level_import_runs WHERE guild_id = ? ORDER BY id`,
    )
    .all<Record<string, number>>(GUILD);
  assert.equal(runs.length, 2);
  assert.deepEqual({ ...runs[1] }, {
    source_rows: 2,
    unique_members: 2,
    inserted: 1,
    updated: 0,
    unchanged: 0,
    duplicate_rows: 0,
  });
});

test('--allow-lower applies the same row, and says so in the totals', async () => {
  await manifestFrom(['--guild', GUILD, '--file', exportFile('high.json', [{ id: ALICE, xp: 900 }]), '--apply']);
  await new LevelingService(harness.db).awardMessage(GUILD, ALICE, '2026-09-17T04:00:00.000Z');

  const low = exportFile('low.json', [{ id: ALICE, xp: 100 }]);
  const applied = await manifestFrom(['--guild', GUILD, '--file', low, '--apply', '--allow-lower']);

  assert.deepEqual(applied.skipped, []);
  assert.equal(applied.accounting.updated, 1);
  assert.equal(applied.totalXpAfterMeasured, 115); // organic 15 + imported 100
  assert.equal(applied.reconciled, true);
  assert.equal((await inventory(harness.db, GUILD)).totalImportedXp, 100);
});

test('re-applying the same export is a no-op the manifest reports as unchanged', async () => {
  const path = exportFile('idem.json', [
    { id: ALICE, xp: 900 },
    { id: BOB, xp: 40 },
  ]);
  const first = await manifestFrom(['--guild', GUILD, '--file', path, '--apply']);
  const second = await manifestFrom(['--guild', GUILD, '--file', path, '--apply']);

  assert.equal(first.file.sha256, second.file.sha256);
  assert.equal(first.accounting.inserted, 2);
  assert.equal(second.accounting.inserted, 0);
  assert.equal(second.accounting.unchanged, 2);
  assert.equal(second.rowsWritten, 0);
  assert.equal(second.totalXpAfterMeasured, first.totalXpAfterMeasured);
  assert.equal(second.reconciled, true);
});

test('duplicate rows collapse max-wins and the loser is named, not silently dropped', async () => {
  const path = exportFile('dupes.json', [
    { id: ALICE, xp: 100 },
    { id: ALICE, xp: 900 },
  ]);
  const manifest = await manifestFrom(['--guild', GUILD, '--file', path, '--apply']);

  assert.equal(manifest.accounting.rowsIn, 2);
  assert.equal(manifest.accounting.duplicateRows, 1);
  assert.equal(manifest.accounting.uniqueMembersIn, 1);
  assert.equal(manifest.accounting.balances, true);
  assert.equal(manifest.skipped.length, 1);
  assert.equal(manifest.skipped[0].reason, 'duplicate_row');
  assert.equal(manifest.skipped[0].xp, 100);
  assert.equal(manifest.totalXpIn, 1000);
  assert.equal(manifest.uniqueXpIn, 900);
  assert.equal(manifest.totalXpAfterMeasured, 900);
});

test('the inventory subcommand reports the live rows an import would land on', async () => {
  await manifestFrom(['--guild', GUILD, '--file', exportFile('inv.json', [{ id: ALICE, xp: 900 }]), '--apply']);
  await new LevelingService(harness.db).awardMessage(GUILD, ALICE, '2026-09-17T04:00:00.000Z');

  const result = await cli(['inventory', '--guild', GUILD]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    guildId: GUILD,
    memberRows: 1,
    totalXp: 915,
    totalOrganicXp: 15,
    totalImportedXp: 900,
  });
});

test('--manifest writes the same JSON to disk for evidence', async () => {
  const out = join(dir, 'manifest.json');
  const path = exportFile('ev.json', [{ id: ALICE, xp: 100 }]);
  const printed = await manifestFrom(['--guild', GUILD, '--file', path, '--manifest', out]);
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), printed);
});

test('--manifest pointing at a directory refuses before touching the database (TOG-9914)', async () => {
  const path = exportFile('dir-guard.json', [{ id: ALICE, xp: 100 }]);
  const result = await cli(['--guild', GUILD, '--file', path, '--apply', '--manifest', dir]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /--manifest destination is a directory, refusing to import/);
  assert.equal(
    Number((await harness.db.prepare(`SELECT COUNT(*) AS c FROM member_levels`).get<{ c: number }>())?.c),
    0,
    'a doomed evidence write must not mutate member_levels first',
  );
});

test('an unwritable --manifest still prints the manifest to stdout (TOG-9914)', async () => {
  const path = exportFile('unwritable.json', [{ id: ALICE, xp: 100 }]);
  const bad = join(dir, 'no-such-dir', 'manifest.json');
  const result = await cli(['--guild', GUILD, '--file', path, '--apply', '--manifest', bad]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Failed to write --manifest/);
  // The mutation landed, but the evidence survived: stdout holds the manifest.
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.mode, 'apply');
  assert.equal(manifest.rowsWritten, 1);
  assert.equal(manifest.reconciled, true);
  assert.equal(
    Number((await harness.db.prepare(`SELECT COUNT(*) AS c FROM member_levels`).get<{ c: number }>())?.c),
    1,
  );
});

test('a malformed export fails with every bad row at once, and writes nothing', async () => {
  const path = join(dir, 'bad.json');
  writeFileSync(
    path,
    JSON.stringify({
      players: [
        { id: ALICE, xp: 100 },
        { id: 'not-a-snowflake', xp: 5 },
        { id: BOB, xp: -1 },
        { id: BOB, xp: 100, level: 9 },
      ],
    }),
  );

  const result = await cli(['--guild', GUILD, '--file', path, '--apply']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /row 2 has an invalid Discord member id/);
  assert.match(result.stderr, /row 3 has invalid xp/);
  assert.match(result.stderr, /row 4 states level 9 but 100 XP is level 1/);
  assert.equal(
    Number((await harness.db.prepare(`SELECT COUNT(*) AS c FROM member_levels`).get<{ c: number }>())?.c),
    0,
  );
});

test('parseMee6Export collects problems rather than dying on the first', () => {
  assert.throws(
    () => parseMee6Export(JSON.stringify([{ xp: 1 }, { id: 'x', xp: 1 }])),
    (error: unknown) => {
      assert.ok(error instanceof Mee6ExportError);
      assert.equal(error.problems.length, 2);
      return true;
    },
  );
  // 100 XP is exactly the level-1 threshold, so this row is self-consistent.
  assert.deepEqual(parseMee6Export(JSON.stringify([{ user_id: ALICE, xp: 100, level: 1 }])), [
    { memberId: ALICE, xp: 100, level: 1 },
  ]);
});
