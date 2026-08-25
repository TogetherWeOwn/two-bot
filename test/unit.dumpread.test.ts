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
import { inspect, DUMP_VERSION } from '../src/store/dump.ts';

const dir = mkdtempSync(join(tmpdir(), 'two-dumpread-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

let seq = 0;

/** Write a gzipped NDJSON dump from raw objects, and return its path. */
function writeDump(objs: unknown[]): string {
  const p = join(dir, `d${seq++}.ndjson.gz`);
  writeFileSync(p, gzipSync(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'));
  return p;
}

function manifest(tables: { name: string; columns: string[]; count: number }[]) {
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
    manifest([{ name: 'events', columns: ['id', 'guild_id'], count: 1 }]),
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
    const got = await inspect(writeDump([manifest([]), { kind: 'end', rows: 0 }]));
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
      () => inspect(writeDump([{ ...manifest([]), tables: undefined }, { kind: 'end', rows: 0 }])),
      /no table list/,
    );
  });
});

describe('inspect: files it refuses for shape', () => {
  test('a dump written by a newer format', async () => {
    const objs = goodDump();
    (objs[0] as { version: number }).version = DUMP_VERSION + 1;
    await assert.rejects(() => inspect(writeDump(objs)), /dump version/);
  });

  test('no manifest', async () => {
    await assert.rejects(
      () => inspect(writeDump([{ kind: 'row', table: 'events', data: {} }, { kind: 'end', rows: 1 }])),
      /no manifest/,
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
});
