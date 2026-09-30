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
import { inspect, restore, DUMP_TABLES, DUMP_VERSION } from '../src/store/dump.ts';
import type { Db, RunResult, Statement } from '../src/store/driver.ts';

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
    sequences: { events: 1 },
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

/**
 * A Db that records every call without doing anything. The restore path must
 * refuse a malformed dump before its transaction begins, so a passing refusal
 * leaves every counter at zero.
 */
function recordingDb() {
  const calls = { transaction: 0, exec: 0, prepare: 0, run: 0 };
  const statement: Statement = {
    get: async <T>(): Promise<T | undefined> => undefined,
    all: async <T>(): Promise<T[]> => [] as T[],
    run: async (): Promise<RunResult> => {
      calls.run++;
      throw new Error('recordingDb: refused dump must never reach a write');
    },
  };
  const db: Db = {
    prepare: (_sql: string) => {
      calls.prepare++;
      return statement;
    },
    exec: async () => {
      calls.exec++;
    },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      calls.transaction++;
      return fn(db);
    },
    close: async () => {},
  };
  return { db, calls };
}

/** Every malformed dump a restore attempt must refuse without touching the Db. */
function malformedDumps(): { name: string; objs: unknown[]; match: RegExp }[] {
  const cases: { name: string; objs: unknown[]; match: RegExp }[] = [];
  const good = () => goodDump() as Record<string, unknown>[];

  for (const data of [null, ['id', 1], 'not-an-object', 42, true]) {
    const objs = good();
    objs[1] = { kind: 'row', table: 'events', data };
    cases.push({
      name: `row.data of ${JSON.stringify(data)}`,
      objs,
      match: /data payload that is not an object/,
    });
  }
  {
    const objs = good();
    delete objs[1].data;
    cases.push({ name: 'row with data omitted', objs, match: /data payload that is not an object/ });
  }
  {
    const objs = good();
    objs.splice(1, 0, { kind: 'checkpoint', at: 1 });
    cases.push({ name: 'unknown record kind', objs, match: /unknown record kind/ });
  }
  for (const rows of [undefined, null, '1', 1.5, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const objs = good();
    if (rows === undefined) delete (objs[objs.length - 1] as { rows?: unknown }).rows;
    else (objs[objs.length - 1] as { rows: unknown }).rows = rows;
    cases.push({
      name: `end.rows of ${String(rows)}`,
      objs,
      match: /invalid row count/,
    });
  }
  for (const line of [42, 'str', null, [1]]) {
    const objs = good();
    (objs as unknown[]).splice(1, 0, line);
    cases.push({
      name: `non-object line ${JSON.stringify(line)}`,
      objs,
      match: /not an object/,
    });
  }
  const noManifestField = (
    name: string,
    mutate: (m: Record<string, unknown>) => void,
    match: RegExp,
  ) => {
    const objs = good();
    mutate(objs[0] as Record<string, unknown>);
    cases.push({ name, objs, match });
  };
  noManifestField('manifest with schemaMigrations omitted', (m) => void delete m.schemaMigrations, /schemaMigrations/);
  noManifestField(
    'manifest with schemaMigrations of non-strings',
    (m) => void (m.schemaMigrations = [1, 2]),
    /schemaMigrations/,
  );
  noManifestField('manifest with createdAt omitted', (m) => void delete m.createdAt, /createdAt/);
  noManifestField('manifest with eventsSequence omitted', (m) => void delete m.eventsSequence, /eventsSequence/);
  noManifestField(
    'manifest with negative eventsSequence',
    (m) => void (m.eventsSequence = -1),
    /eventsSequence/,
  );
  noManifestField('manifest with sequences omitted', (m) => void delete m.sequences, /sequences/);
  noManifestField(
    'manifest with a foreign sequence table',
    (m) => void (m.sequences = { website_users: 3 }),
    /not a table this backup format owns/,
  );
  noManifestField(
    'manifest with a negative sequence mark',
    (m) => void (m.sequences = { events: -2 }),
    /high-water mark/,
  );
  return cases;
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

  test('JSON values inside a legitimate row object are data, not a shape error', async () => {
    // Nested objects and arrays are ordinary column values (json/jsonb); the
    // shape gate applies to the row payload itself, not what it contains.
    const objs = goodDump();
    (objs[1] as { data: unknown }).data = {
      id: 1,
      guild_id: 'g',
      nested: { list: [1, 2], deep: { ok: true } },
    };
    const got = await inspect(writeDump(objs));
    assert.equal(got.rows, 1);
  });
});

describe('inspect: non-table record shapes it refuses', () => {
  for (const { name, objs, match } of malformedDumps()) {
    test(name, async () => {
      // Refused by the reader, before any database is involved.
      await assert.rejects(() => inspect(writeDump(objs)), match, `expected ${name} to be refused`);
      // And refused by restore without opening a transaction: the force path
      // must never commit first and report the shape error after.
      const { db, calls } = recordingDb();
      await assert.rejects(() => restore(db, writeDump(objs)), match);
      assert.deepEqual(calls, { transaction: 0, exec: 0, prepare: 0, run: 0 });
    });
  }

  test('schemaMigrations survives the round trip for the restore report', async () => {
    const got = await inspect(writeDump(goodDump()));
    assert.deepEqual(got.manifest.schemaMigrations, ['001']);
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
