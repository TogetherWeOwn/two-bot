/**
 * The backup reader, against files it should refuse.
 *
 * `inspect()` touches no database, which is deliberate: every check that can be
 * made from the file alone is made before a connection is involved, so these
 * run in CI without Postgres and without the e2e suite's skip. The round trip
 * against a real database is test/e2e.backup.test.ts.
 *
 * The case that matters most here is a dump naming a table the bot does not
 * own. A backup file is not a trusted input - it is bytes off a disk, possibly
 * an off-box one - and `restore()` interpolates table names from it into SQL.
 * `TRUNCATE` was always scoped to DUMP_TABLES; the `INSERT` was not, so a
 * crafted dump could write rows into the website's tables. The gate is on the
 * read path now, and this is what holds it there.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { inspect, DUMP_TABLES, DUMP_VERSION } from '../src/store/dump.ts';

const dir = mkdtempSync(join(tmpdir(), 'two-dumpread-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

let seq = 0;

/** Write a gzipped NDJSON dump from raw objects, and return its path. */
function writeDump(objs: unknown[]): string {
  const p = join(dir, `d${seq++}.ndjson.gz`);
  writeFileSync(p, gzipSync(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'));
  return p;
}

function completeTables(
  overrides: Partial<Record<(typeof DUMP_TABLES)[number], { columns: string[]; count: number }>> = {},
) {
  return DUMP_TABLES.map((name) => ({ name, columns: [], count: 0, ...overrides[name] }));
}

function manifest(tables: { name: string; columns: string[]; count: number }[] = completeTables()) {
  return {
    kind: 'manifest',
    version: DUMP_VERSION,
    createdAt: '2026-08-25T00:00:00.000Z',
    tables,
    eventsSequence: 1,
    schemaMigrations: ['001'],
  };
}

/** A minimal well-formed dump: one events row, counts consistent throughout. */
function goodDump(): unknown[] {
  return [
    manifest(completeTables({ events: { columns: ['id', 'guild_id'], count: 1 } })),
    { kind: 'row', table: 'events', data: { id: 1, guild_id: 'g' } },
    { kind: 'end', rows: 1 },
  ];
}

describe('inspect: files it accepts', () => {
  test('a well-formed dump reads back with its rows', async () => {
    const got = await inspect(writeDump(goodDump()));
    assert.equal(got.rows, 1);
    assert.equal(got.manifest.tables[0].name, 'events');
    assert.deepEqual(got.buffers.get('events'), [{ id: 1, guild_id: 'g' }]);
  });

  test('an empty but complete dump is fine', async () => {
    const got = await inspect(writeDump([manifest(), { kind: 'end', rows: 0 }]));
    assert.equal(got.rows, 0);
  });
});

describe('inspect: table names it refuses', () => {
  test('a manifest naming a table the bot does not own', async () => {
    const objs = goodDump();
    (objs[0] as ReturnType<typeof manifest>).tables.push({
      name: 'website_users',
      columns: ['id', 'email'],
      count: 1,
    });
    await assert.rejects(() => inspect(writeDump(objs)), /website_users/);
  });

  test('a row naming a table the bot does not own', async () => {
    const objs = goodDump();
    objs.splice(2, 0, { kind: 'row', table: 'website_users', data: { id: 1 } });
    (objs[objs.length - 1] as { rows: number }).rows = 2;
    await assert.rejects(() => inspect(writeDump(objs)), /website_users/);
  });

  test('a table name carrying SQL rather than a name', async () => {
    // Columns are filtered and values are bound, so this was never arbitrary
    // SQL - but the name still reached string interpolation, and the answer to
    // "how bad is it exactly" should not have to be recomputed on every edit.
    for (const name of [
      'events; DROP TABLE members',
      'events"',
      'pg_catalog.pg_class',
      'EVENTS',
      '',
    ]) {
      const objs = goodDump();
      (objs[0] as ReturnType<typeof manifest>).tables.push({ name, columns: ['id'], count: 0 });
      await assert.rejects(
        () => inspect(writeDump(objs)),
        /not a table this backup format owns/,
        `expected ${JSON.stringify(name)} to be refused`,
      );
    }
  });

  test('a manifest with no table list at all', async () => {
    await assert.rejects(
      () => inspect(writeDump([{ ...manifest(), tables: undefined }, { kind: 'end', rows: 0 }])),
      /no table list/,
    );
  });
});

describe('inspect: files it refuses for shape', () => {
  test('legacy dumps cannot omit newly-owned tables', async () => {
    // TOG-9074: v3 is refused too - a v3 dump omits 36 tables and would fail
    // the manifest-completeness gate even if the version check let it past.
    // There is no v3 read path; `eventsSequence` survives only as a
    // structurally comparable manifest field (see src/store/dump.ts).
    for (const version of [1, 2, 3]) {
      const objs = goodDump();
      (objs[0] as { version: number }).version = version;
      await assert.rejects(
        () => inspect(writeDump(objs)),
        new RegExp(`dump version ${version}, this build reads ${DUMP_VERSION}`),
      );
    }
  });

  test('a dump written by a newer format', async () => {
    const objs = goodDump();
    (objs[0] as { version: number }).version = DUMP_VERSION + 1;
    await assert.rejects(() => inspect(writeDump(objs)), /dump version/);
  });

  test('no manifest', async () => {
    await assert.rejects(
      () => inspect(writeDump([{ kind: 'row', table: 'events', data: {} }, { kind: 'end', rows: 1 }])),
      /before the manifest/,
    );
  });

  test('no end marker - the disk-full case', async () => {
    const objs = goodDump().slice(0, -1);
    await assert.rejects(() => inspect(writeDump(objs)), /truncated/);
  });

  test('fewer rows than the end marker declares', async () => {
    const objs = goodDump();
    (objs[objs.length - 1] as { rows: number }).rows = 99;
    await assert.rejects(() => inspect(writeDump(objs)), /declares 99 rows, file contains 1/);
  });

  test('a manifest must contain every owned table exactly once', async () => {
    const missing = goodDump();
    const missingManifest = missing[0] as ReturnType<typeof manifest>;
    missingManifest.tables = missingManifest.tables.filter((table) => table.name !== 'operational_audit_log');
    await assert.rejects(() => inspect(writeDump(missing)), /missing tables: operational_audit_log/);

    const duplicate = goodDump();
    const duplicateManifest = duplicate[0] as ReturnType<typeof manifest>;
    duplicateManifest.tables.push({ ...duplicateManifest.tables[0] });
    await assert.rejects(() => inspect(writeDump(duplicate)), /manifest table events is duplicated/);
  });

  test('a legacy pre-0040/pre-0043 v4 backup is tolerated with its new tables empty', async () => {
    // The format version did not change when the capture tables were added,
    // so a backup from the previous v4 writer omits them without being
    // truncated. The reader accepts it and names the tolerated tables; any
    // other missing table is still refused (previous test).
    for (const omitted of [
      ['capture_pending_joins'],
      ['capture_retained_growth'],
      ['capture_pending_joins', 'capture_retained_growth'],
    ]) {
      const objs = goodDump();
      const m = objs[0] as ReturnType<typeof manifest>;
      m.tables = m.tables.filter((table) => !omitted.includes(table.name));
      const got = await inspect(writeDump(objs));
      assert.deepEqual([...(got.manifest.toleratedMissingTables ?? [])].sort(), [...omitted].sort());
      assert.equal(got.rows, 1);
    }
  });

  test('a current dump names no tolerated-missing tables', async () => {
    const got = await inspect(writeDump(goodDump()));
    assert.deepEqual(got.manifest.toleratedMissingTables ?? [], []);
  });

  test('per-table counts must match even when the aggregate count does', async () => {
    const objs = goodDump();
    const m = objs[0] as ReturnType<typeof manifest>;
    m.tables.find((table) => table.name === 'events')!.count = 0;
    m.tables.find((table) => table.name === 'members')!.count = 1;
    await assert.rejects(() => inspect(writeDump(objs)), /events: manifest declares 0 rows, file contains 1/);
  });

  test('rows cannot precede the manifest, follow the end, or share a second manifest', async () => {
    const before = goodDump();
    before.unshift(before.splice(1, 1)[0]);
    await assert.rejects(() => inspect(writeDump(before)), /row appears before the manifest/);

    const after = goodDump();
    after.push({ kind: 'row', table: 'events', data: { id: 2 } });
    await assert.rejects(() => inspect(writeDump(after)), /data after its end marker/);

    const duplicate = goodDump();
    duplicate.splice(1, 0, manifest());
    await assert.rejects(() => inspect(writeDump(duplicate)), /more than one manifest/);
  });
});
