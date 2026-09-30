import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Db, Statement } from '../src/store/driver.ts';
import { DUMP_TABLES, DUMP_VERSION, restore } from '../src/store/dump.ts';

function archive(t: TestContext, count: number): string {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'two-restore-batching-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'batch.ndjson.gz');
  const lines = [JSON.stringify({
    kind: 'manifest',
    version: DUMP_VERSION,
    createdAt: '2026-09-30T00:00:00.000Z',
    tables: DUMP_TABLES.map((name) => ({
      name,
      columns: name === 'events' ? ['id', 'guild_id'] : [],
      count: name === 'events' ? count : 0,
    })),
    eventsSequence: count,
    sequences: { events: count },
    schemaMigrations: ['001'],
  })];
  for (let id = 1; id <= count; id++) {
    // Object key order differs from manifest order; bindings must follow columns.
    lines.push(JSON.stringify({ kind: 'row', table: 'events', data: { guild_id: `guild-${id}`, id } }));
  }
  lines.push(JSON.stringify({ kind: 'end', rows: count }));
  writeFileSync(path, gzipSync(lines.join('\n') + '\n'));
  return path;
}

/** Strict SQL double: no driver, connection, migrations or live services. */
function target(batchRows: number[], failure?: Error) {
  const calls: string[] = [];
  const inserts: { rows: number; parameters: number }[] = [];
  let written = 0;
  let committed = false;
  let transactionCount = 0;
  const verification: string[] = [];

  const tx: Db = {
    prepare(sql): Statement {
      calls.push(sql.startsWith('INSERT INTO ') ? 'insert' : 'columns');
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          assert.match(sql, /^SELECT column_name FROM information_schema\.columns/);
          assert.equal(params.length, 1);
          assert.ok(DUMP_TABLES.includes(params[0] as (typeof DUMP_TABLES)[number]));
          return (params[0] === 'events' ? [{ column_name: 'id' }, { column_name: 'guild_id' }] : []) as T[];
        },
        async get<T>(): Promise<T | undefined> { throw new Error(`unexpected tx get: ${sql}`); },
        async run(...params: unknown[]) {
          const rows = batchRows[inserts.length];
          assert.notEqual(rows, undefined, 'no extra or empty INSERT batch');
          assert.equal(sql, `INSERT INTO events ("id", "guild_id") VALUES ${Array(rows).fill('(?, ?)').join(', ')}`,
            'exact tuple count and column order');
          assert.equal(params.length, rows * 2, 'two bound values per tuple');
          assert.ok(params.length <= 60_000, 'INSERT stays within the parameter ceiling');
          for (let row = 0; row < rows; row++) {
            const id = written + row + 1;
            assert.equal(params[row * 2], id, 'contiguous IDs, with no duplicates or omissions');
            assert.equal(params[row * 2 + 1], `guild-${id}`, 'row/column binding order');
          }
          inserts.push({ rows, parameters: params.length });
          if (failure && inserts.length === batchRows.length) throw failure;
          written += rows;
          return { changes: rows };
        },
      };
    },
    async exec(sql) {
      if (sql.startsWith('TRUNCATE ')) {
        assert.equal(sql, `TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
        calls.push('truncate');
      } else {
        assert.match(sql, /^SELECT setval\(pg_get_serial_sequence\('events', 'id'\),/);
        assert.equal(inserts.length, batchRows.length, 'sequence reset follows all batches');
        calls.push('setval');
      }
    },
    async transaction() { throw new Error('unexpected nested transaction'); },
    async close() { throw new Error('restore must not close the caller-owned Db'); },
  };
  const db: Db = {
    prepare(sql): Statement {
      calls.push('verification');
      assert.ok(committed, 'verification runs only after transaction success');
      const table = sql.match(/^SELECT COUNT\(\*\) AS n FROM (\w+)$/)?.[1];
      assert.ok(table && DUMP_TABLES.includes(table as (typeof DUMP_TABLES)[number]));
      verification.push(table);
      return {
        async get<T>(): Promise<T | undefined> { return { n: table === 'events' ? written : 0 } as T; },
        async all<T>(): Promise<T[]> { throw new Error(`unexpected outer all: ${sql}`); },
        async run() { throw new Error('INSERT must use the transaction handle'); },
      };
    },
    async exec() { throw new Error('writes must use the transaction handle'); },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      transactionCount++;
      calls.push('begin');
      try {
        const result = await fn(tx);
        committed = true;
        calls.push('commit');
        return result;
      } catch (error) {
        calls.push('rollback');
        throw error;
      }
    },
    async close() { throw new Error('restore must not close the caller-owned Db'); },
  };
  return { db, calls, inserts, verification, state: () => ({ written, committed, transactionCount }) };
}

describe('restore INSERT batching (offline)', () => {
  for (const [count, batchRows] of [[30_000, [30_000]], [30_001, [30_000, 1]]] as const) {
    test(`${count} two-column rows preserve every binding across the parameter boundary`, async (t) => {
      const fake = target([...batchRows]);
      const report = await restore(fake.db, archive(t, count));
      assert.deepEqual(fake.inserts, batchRows.map((rows) => ({ rows, parameters: rows * 2 })));
      assert.deepEqual(fake.state(), { written: count, committed: true, transactionCount: 1 });
      assert.deepEqual(fake.verification, [...DUMP_TABLES]);
      assert.equal(fake.calls.filter((call) => call === 'setval').length, 1);
      assert.ok(fake.calls.indexOf('setval') < fake.calls.indexOf('commit'));
      assert.ok(fake.calls.indexOf('commit') < fake.calls.indexOf('verification'));
      assert.equal(report.ok, true);
      assert.deepEqual(report.restored, Object.fromEntries(DUMP_TABLES.map((name) => [name, name === 'events' ? count : 0])));
      assert.deepEqual(report.droppedColumns, {});
    });
  }

  test('final partial-batch failure rejects the outer restore before reset or verification', async (t) => {
    const failure = new Error('injected final INSERT failure');
    const fake = target([30_000, 1], failure);
    let returnedReport = false;
    await assert.rejects(async () => {
      await restore(fake.db, archive(t, 30_001));
      returnedReport = true;
    }, (error: unknown) => error === failure);
    assert.equal(returnedReport, false);
    assert.deepEqual(fake.inserts, [{ rows: 30_000, parameters: 60_000 }, { rows: 1, parameters: 2 }]);
    assert.deepEqual(fake.state(), { written: 30_000, committed: false, transactionCount: 1 });
    assert.deepEqual(fake.calls, ['begin', 'truncate', 'columns', 'insert', 'insert', 'rollback'],
      'no later metadata reads, sequence resets, commit or verification');
    assert.deepEqual(fake.verification, []);
  });
});
