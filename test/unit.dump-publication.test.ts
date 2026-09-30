import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import type { Db } from '../src/store/driver.ts';
import { dump, inspect } from '../src/store/dump.ts';

type Failure = 'metadata' | 'before-rows' | 'after-rows' | 'commit';
const events = [{ id: 1, payload: 'first' }, { id: 2, payload: 'second' }];

/** Only the dump's read queries are supported; no connection or credentials. */
function snapshot(failure?: Failure, onPage?: (offset: number) => void): Db {
  const db: Db = {
    prepare(sql) {
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          if (sql.includes('information_schema.columns')) {
            if (failure === 'metadata') throw new Error('injected metadata read failure');
            return (params[0] === 'events' ? [{ column_name: 'id' }, { column_name: 'payload' }] : []) as T[];
          }
          if (sql === 'SELECT id FROM schema_migrations ORDER BY id') return [{ id: '001' }] as T[];
          if (sql === 'SELECT "id", "payload" FROM events ORDER BY id LIMIT ? OFFSET ?') {
            const offset = Number(params[1]);
            onPage?.(offset);
            if (failure === 'before-rows' || (failure === 'after-rows' && offset > 0)) {
              throw new Error('injected row read failure');
            }
            return (offset === 0 ? events : []) as T[];
          }
          throw new Error(`unexpected dump query: ${sql}`);
        },
        async get<T>(): Promise<T | undefined> {
          if (sql === 'SELECT COALESCE(MAX(id), 0) AS n FROM events') return { n: 2 } as T;
          if (sql.startsWith('SELECT COUNT(*) AS n FROM ')) {
            return { n: sql.endsWith(' FROM events') ? events.length : 0 } as T;
          }
          throw new Error(`unexpected dump query: ${sql}`);
        },
        async run() { throw new Error('dump must not write to the database'); },
      };
    },
    async exec(sql) { assert.equal(sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const result = await fn(db);
      if (failure === 'commit') throw new Error('injected commit failure');
      return result;
    },
    async close() {},
  };
  return db;
}

function fixture() {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'two-dump-publication-'));
  return { dir, prior: join(dir, 'two-funnel-20000101T000000Z.ndjson.gz'),
    next: join(dir, 'two-funnel-20000102T000000Z.ndjson.gz') };
}

/** The restore drill's exact final-suffix/mtime selector, against local fixtures. */
function newest(dir: string): string {
  return execFileSync('bash', ['-c', 'latest=$(ls -1t "$1"/two-funnel-*.ndjson.gz | head -1); printf "%s" "$latest"', '_', dir],
    { encoding: 'utf8' });
}

describe('dump publication (offline)', () => {
  for (const failure of ['metadata', 'before-rows', 'after-rows', 'commit'] as const) {
    for (const replacePrior of [false, true]) {
      test(`${failure} failure leaves no incomplete archive (${replacePrior ? 'existing' : 'new'} destination)`, async () => {
        const f = fixture();
        try {
          await dump(snapshot(), f.prior);
          const priorBytes = readFileSync(f.prior);
          const priorMtime = statSync(f.prior).mtimeMs;
          let pages = 0;
          await assert.rejects(dump(snapshot(failure, () => { pages++; }), replacePrior ? f.prior : f.next), /injected/);
          assert.deepEqual(readdirSync(f.dir), ['two-funnel-20000101T000000Z.ndjson.gz'], 'failed run must clean up its temporary output');
          assert.deepEqual(readFileSync(f.prior), priorBytes, 'prior archive bytes must not change');
          assert.equal(statSync(f.prior).mtimeMs, priorMtime, 'prior archive must not become newest-looking');
          assert.equal((await inspect(f.prior)).rows, events.length);
          assert.equal(newest(f.dir), f.prior);
          if (failure === 'after-rows') assert.equal(pages, 2, 'failure follows a written page');
        } finally { rmSync(f.dir, { recursive: true, force: true }); }
      });
    }
  }

  test('publishes a readable complete dump, never the in-flight prefix', async () => {
    const f = fixture();
    try {
      await dump(snapshot(), f.prior);
      utimesSync(f.prior, new Date('2000-01-01'), new Date('2000-01-01'));
      const priorBytes = readFileSync(f.prior);
      const manifest = await dump(snapshot(undefined, () => {
        assert.equal(newest(f.dir), f.prior, 'an in-flight dump must not be selected');
        assert.ok(!readdirSync(f.dir).includes('two-funnel-20000102T000000Z.ndjson.gz'));
      }), f.next);
      assert.deepEqual(readdirSync(f.dir).sort(), [f.prior, f.next].map((p) => p.slice(f.dir.length + 1)).sort());
      assert.deepEqual(readFileSync(f.prior), priorBytes);
      const contents = await inspect(f.next);
      assert.deepEqual(contents.manifest, manifest);
      assert.deepEqual(contents.buffers.get('events'), events);
      assert.equal(contents.rows, events.length);
      const lines = gunzipSync(readFileSync(f.next)).toString().trim().split('\n');
      assert.deepEqual(JSON.parse(lines.at(-1)!), { kind: 'end', rows: events.length });
      // A killed process can leave a newer temp file. Neither restore nor retention sees it.
      const abandoned = `${f.next}.abandoned.tmp`;
      writeFileSync(abandoned, 'incomplete');
      utimesSync(abandoned, new Date('2100-01-01'), new Date('2100-01-01'));
      assert.equal(newest(f.dir), f.next);
      assert.deepEqual(readdirSync(f.dir).filter((name) => /^two-funnel-.*\.ndjson\.gz$/.test(name)).sort(),
        [f.prior, f.next].map((p) => p.slice(f.dir.length + 1)).sort());
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  for (const outputFails of [false, true]) {
    test(`waits for output completion before publication (${outputFails ? 'failed' : 'successful'} stream)`, async () => {
      const f = fixture();
      const create = fs.createWriteStream;
      let mocked: ReturnType<typeof mock.method> | undefined;
      try {
        await dump(snapshot(), f.prior);
        const priorBytes = readFileSync(f.prior);
        mocked = mock.method(fs, 'createWriteStream', (
          path: Parameters<typeof fs.createWriteStream>[0],
          options: Parameters<typeof fs.createWriteStream>[1],
        ) => {
          const output = create(path, options);
          output._final = (callback) => {
            // Gzip has delivered all bytes, including the end marker, but the
            // destination has not yet reported success. It must stay temporary.
            assert.ok(!readdirSync(f.dir).includes('two-funnel-20000102T000000Z.ndjson.gz'));
            assert.equal(newest(f.dir), f.prior);
            setImmediate(() => callback(outputFails ? new Error('injected output failure') : undefined));
          };
          return output;
        });
        syncBuiltinESMExports();
        if (outputFails) {
          await assert.rejects(dump(snapshot(), f.next), /injected output failure/);
          assert.deepEqual(readdirSync(f.dir), ['two-funnel-20000101T000000Z.ndjson.gz']);
        } else {
          await dump(snapshot(), f.next);
          assert.equal((await inspect(f.next)).rows, events.length);
        }
        assert.deepEqual(readFileSync(f.prior), priorBytes);
      } finally {
        mocked?.mock.restore();
        syncBuiltinESMExports();
        rmSync(f.dir, { recursive: true, force: true });
      }
    });
  }

  test('publication failure removes the completed temporary file', async () => {
    const f = fixture();
    try {
      mkdirSync(f.next);
      writeFileSync(join(f.next, 'keep'), 'existing destination');
      await assert.rejects(dump(snapshot(), f.next), { code: 'EISDIR' });
      assert.deepEqual(readdirSync(f.dir), ['two-funnel-20000102T000000Z.ndjson.gz']);
      assert.equal(readFileSync(join(f.next, 'keep'), 'utf8'), 'existing destination');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('output-open failure rejects cleanly even while a database read is pending', async () => {
    const f = fixture();
    try {
      const db = snapshot();
      const exec = db.exec;
      db.exec = async (sql) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await exec(sql);
      };
      await assert.rejects(dump(db, join(f.dir, 'missing', 'two-funnel-next.ndjson.gz')), { code: 'ENOENT' });
      assert.deepEqual(readdirSync(f.dir), []);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
