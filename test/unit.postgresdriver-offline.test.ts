/**
 * Postgres driver contract on in-memory pg constructor fakes (TOG-9135).
 * No database is needed: DB env is removed and real socket connects throw.
 * The driver's pg.types parsers stay real; no production code seam is added.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import pg from 'pg';
import { isPostgresSpec, openDb } from '../src/store/db.ts';
import { UNIQUE_VIOLATION, openPostgres } from '../src/store/postgresDriver.ts';
import { log } from '../src/core/log.ts';

const RealPool = pg.Pool;
const RealClient = pg.Client;
const realSocketConnect = Socket.prototype.connect;
const databaseEnv = {
  TWO_TEST_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL,
  TWO_DATABASE_URL: process.env.TWO_DATABASE_URL,
};

// --- fakes -----------------------------------------------------------------

interface RecordedQuery {
  text: string;
  values: unknown[] | undefined;
}

interface FakeResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

type QueryHandler = (
  text: string,
  values: unknown[] | undefined,
) => FakeResult | Promise<FakeResult>;

const defaultHandler: QueryHandler = () => ({ rows: [], rowCount: 0 });

class FakeClient {
  static instances: FakeClient[] = [];
  opts: unknown;
  queries: RecordedQuery[] = [];
  handler: QueryHandler = defaultHandler;
  connected = false;
  released = false;
  ended = false;
  /** True when checked out of a pool; false for a direct `new pg.Client`. */
  fromPool = false;

  constructor(opts: unknown) {
    this.opts = opts;
    FakeClient.instances.push(this);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async query(text: string, values?: unknown[]): Promise<FakeResult> {
    this.queries.push({ text, values });
    return await this.handler(text, values);
  }

  release(): void {
    this.released = true;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

class FakePool {
  static instances: FakePool[] = [];
  opts: Record<string, unknown>;
  clients: FakeClient[] = [];
  queryLog: RecordedQuery[] = [];
  handler: QueryHandler = defaultHandler;
  errorListener: ((err: Error) => void) | undefined;
  ended = false;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    FakePool.instances.push(this);
  }

  on(event: string, fn: (err: Error) => void): void {
    if (event === 'error') this.errorListener = fn;
  }

  async connect(): Promise<FakeClient> {
    // Delegate through a closure so a test can swap `pool.handler` after the
    // client was checked out (e.g. fail only ROLLBACK mid-transaction).
    const c = new FakeClient(this.opts);
    c.fromPool = true;
    c.handler = (text, values) => this.handler(text, values);
    this.clients.push(c);
    return c;
  }

  async query(text: string, values?: unknown[]): Promise<FakeResult> {
    this.queryLog.push({ text, values });
    return await this.handler(text, values);
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

function resetFakes(): void {
  FakePool.instances.length = 0;
  FakeClient.instances.length = 0;
}

function lastPool(): FakePool {
  const pool = FakePool.instances.at(-1);
  assert.ok(pool, 'expected a pool to have been constructed');
  return pool;
}

const URL = 'postgres://user:pass@localhost:5432/two_test';

before(() => {
  // Pin the hermetic guarantee: this suite must stay green with no database.
  delete process.env.TWO_TEST_DATABASE_URL;
  delete process.env.TWO_DATABASE_URL;
  pg.Pool = FakePool as unknown as typeof pg.Pool;
  pg.Client = FakeClient as unknown as typeof pg.Client;
  Socket.prototype.connect = () => {
    throw new Error('unexpected real network connection in offline test');
  };
});

after(() => {
  pg.Pool = RealPool;
  pg.Client = RealClient;
  Socket.prototype.connect = realSocketConnect;
  for (const [key, value] of Object.entries(databaseEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// --- constants and type parsers ---------------------------------------------

test('UNIQUE_VIOLATION is the Postgres unique_violation code', () => {
  assert.equal(UNIQUE_VIOLATION, '23505');
});

test('INT8 parses as a number (COUNT(*) results compare against numbers)', () => {
  const parse = pg.types.getTypeParser(pg.types.builtins.INT8);
  assert.equal(parse('3'), 3);
  assert.equal(typeof parse('3'), 'number');
});

test('TIMESTAMPTZ renders the ISO-8601 UTC string readers were written against', () => {
  const parse = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ);
  assert.equal(parse('2026-01-02 03:04:05.678+00'), '2026-01-02T03:04:05.678Z');
  // A non-UTC offset is normalized, not passed through with the offset.
  assert.equal(parse('2026-06-01 12:00:00+02'), '2026-06-01T10:00:00.000Z');
});

// --- connection-string parsing ----------------------------------------------

test('isPostgresSpec accepts both postgres schemes and nothing else', () => {
  const cases: Array<[string, boolean]> = [
    ['postgres://u@h/db', true],
    ['postgresql://u@h/db', true],
    ['postgres://u:p@h:5432/db?sslmode=require', true],
    ['', false],
    ['sqlite:data.db', false],
    ['mysql://u@h/db', false],
    ['http://h/db', false],
    // The check is a prefix match: leading whitespace is not trimmed here.
    [' postgres://u@h/db', false],
  ];
  for (const [spec, want] of cases) {
    assert.equal(isPostgresSpec(spec), want, spec || '(empty)');
  }
});

test('openDb rejects a missing or non-Postgres spec before touching pg', async () => {
  resetFakes();
  await assert.rejects(openDb(''), /Database URL is required/);
  await assert.rejects(openDb('   '), /Database URL is required/);
  await assert.rejects(openDb('sqlite:data.db'), /Only Postgres is supported/);
  await assert.rejects(openDb('mysql://u@h/db'), /Only Postgres is supported/);
  assert.equal(FakePool.instances.length, 0, 'validation must not construct a pool');
  assert.equal(FakeClient.instances.length, 0, 'validation must not construct a client');
});

test('openDb forwards the full connection string unchanged for pg to parse', async () => {
  resetFakes();
  for (const spec of [
    'postgres://user:p%40ss@db.invalid:5433/two%20test?sslmode=require&application_name=unit',
    'postgresql://user@db.invalid/two_test?connect_timeout=2',
  ]) {
    const db = await openDb(spec, { skipMigrations: true });
    assert.equal(lastPool().opts.connectionString, spec);
    await db.close();
  }
});

// --- schema-name allowlist ---------------------------------------------------

test('unsafe schema names throw before any Client is constructed', async () => {
  resetFakes();
  for (const schema of ['Bad-Name', 'UPPER', 'a;DROP TABLE x', 'a.b', 'a b', '0abc']) {
    await assert.rejects(
      openPostgres({ connectionString: URL, schema }),
      /unsafe schema name/,
      schema,
    );
  }
  // The pool checkout also builds a FakeClient; only direct setup Clients
  // (fromPool === false) matter here.
  assert.equal(
    FakeClient.instances.filter((c) => !c.fromPool).length,
    0,
    'rejected schemas must not connect',
  );
  assert.equal(FakePool.instances.length, 0, 'rejected schemas must not pool');
});

test('a safe schema is created and set as the search_path', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL, schema: 'test_ok9' });

  const direct = FakeClient.instances.filter((c) => !c.fromPool);
  assert.equal(direct.length, 1, 'exactly one direct setup Client besides the probe');
  const setup = direct[0]!;
  assert.ok(setup.connected, 'schema setup connects');
  assert.deepEqual(
    setup.queries.map((q) => q.text),
    ['CREATE SCHEMA IF NOT EXISTS test_ok9'],
  );
  assert.ok(setup.ended, 'schema setup client is closed');

  const pool = lastPool();
  assert.deepEqual((pool.opts as { connectionString?: string }).connectionString, URL);
  assert.equal((pool.opts as { options?: string }).options, '-c search_path=test_ok9');

  await db.close();
  assert.ok(pool.ended);
});

test('no schema means no setup client and no search_path option', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  assert.equal(
    FakeClient.instances.filter((c) => !c.fromPool).length,
    0,
    'no direct setup Client; the probe is pool-issued',
  );
  assert.ok(!('options' in lastPool().opts));
  await db.close();

  // An empty schema is falsy and takes the same path.
  resetFakes();
  const db2 = await openPostgres({ connectionString: URL, schema: '' });
  assert.equal(
    FakeClient.instances.filter((c) => !c.fromPool).length,
    0,
    'empty schema behaves like no schema',
  );
  await db2.close();
});

// --- pool wiring --------------------------------------------------------------

test('pool defaults keep the footprint small and fail fast', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  assert.equal(pool.opts.max, 5);
  assert.equal(pool.opts.connectionTimeoutMillis, 10_000);
  assert.equal(pool.opts.idleTimeoutMillis, 30_000);
  assert.equal(pool.opts.statement_timeout, 15_000);
  assert.equal(pool.opts.application_name, 'two-bot');
  await db.close();
});

test('pool overrides are honored', async () => {
  resetFakes();
  const db = await openPostgres({
    connectionString: URL,
    max: 2,
    connectionTimeoutMillis: 1,
    idleTimeoutMillis: 2,
    statementTimeoutMillis: 3,
    applicationName: 'probe',
  });
  const pool = lastPool();
  assert.equal(pool.opts.max, 2);
  assert.equal(pool.opts.connectionTimeoutMillis, 1);
  assert.equal(pool.opts.idleTimeoutMillis, 2);
  assert.equal(pool.opts.statement_timeout, 3);
  assert.equal(pool.opts.application_name, 'probe');
  await db.close();
});

test('the boot probe connects and releases instead of failing on first use', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  assert.equal(pool.clients.length, 1, 'exactly one probe checkout at boot');
  assert.ok(pool.clients[0]!.released, 'probe client is released');
  await db.close();
});

test("an idle-client pool error is logged, not thrown at the bot's feet", async (t) => {
  resetFakes();
  const logged: string[] = [];
  t.mock.method(log, 'error', (msg: string) => {
    logged.push(msg);
  });
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  assert.ok(pool.errorListener, 'driver registers an error listener on the pool');
  pool.errorListener!(new Error('server restarted'));
  assert.deepEqual(logged, ['pg_pool_client_error']);
  // The handle still works afterwards: the pool discards the bad client.
  await db.prepare('SELECT 1').get();
  await db.close();
});

// --- statement surface ----------------------------------------------------------

test('prepare rewrites ? to $n and leaves string literals alone', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  await db.prepare(`SELECT * FROM t WHERE a = ? AND b = '?' AND d = ?`).all(1, 2);
  const last = pool.queryLog.at(-1)!;
  assert.equal(last.text, `SELECT * FROM t WHERE a = $1 AND b = '?' AND d = $2`);
  assert.deepEqual(last.values, [1, 2]);
  await db.close();
});

test("prepare treats '' as an escaped quote, not a literal terminator", async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  await db.prepare(`SELECT * FROM t WHERE c = 'it''s ?' AND d = ?`).all(1);
  assert.equal(pool.queryLog.at(-1)!.text, `SELECT * FROM t WHERE c = 'it''s ?' AND d = $1`);
  await db.close();
});

test('get returns the first row and undefined when there are none', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  pool.handler = () => ({ rows: [{ id: 7 }], rowCount: 1 });
  assert.deepEqual(await db.prepare('SELECT id FROM t WHERE id = ?').get(7), { id: 7 });
  pool.handler = () => ({ rows: [], rowCount: 0 });
  assert.equal(await db.prepare('SELECT id FROM t WHERE id = ?').get(8), undefined);
  await db.close();
});

test('all returns every row, run returns the affected count', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  pool.handler = () => ({
    rows: [{ id: 1 }, { id: 2 }],
    rowCount: 2,
  });
  assert.deepEqual(await db.prepare('SELECT id FROM t').all(), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await db.prepare('DELETE FROM t WHERE id = ?').run(1), { changes: 2 });
  pool.handler = () => ({ rows: [], rowCount: null });
  assert.deepEqual(await db.prepare('DELETE FROM t WHERE id = ?').run(9), { changes: 0 });
  await db.close();
});

test('exec sends raw SQL through with no parameters', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  await db.exec('VACUUM t');
  assert.deepEqual(pool.queryLog.at(-1), { text: 'VACUUM t', values: undefined });
  await db.close();
});

// --- error propagation ------------------------------------------------------------

test('statement methods preserve pg error identity, code and detail', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  const error = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: UNIQUE_VIOLATION,
    detail: 'Key (id)=(1) already exists.',
    constraint: 't_pkey',
  });
  pool.handler = () => { throw error; };
  const stmt = db.prepare('INSERT INTO t (a) VALUES (?)');
  for (const invoke of [() => stmt.get(1), () => stmt.all(1), () => stmt.run(1), () => db.exec('SELECT 1')]) {
    await assert.rejects(invoke, (err) => err === error);
  }
  await db.close();
});

test('boot connection failures propagate without remapping', async (t) => {
  resetFakes();
  const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  t.mock.method(FakePool.prototype, 'connect', async () => { throw error; });
  await assert.rejects(openPostgres({ connectionString: URL }), (err) => err === error);
});

test('schema query failures close the setup client and preserve the pg error', async (t) => {
  resetFakes();
  const error = Object.assign(new Error('permission denied'), { code: '42501' });
  t.mock.method(FakeClient.prototype, 'query', async () => { throw error; });
  await assert.rejects(
    openPostgres({ connectionString: URL, schema: 'test_schema' }),
    (err) => err === error,
  );
  assert.equal(FakeClient.instances.length, 1);
  assert.ok(FakeClient.instances[0]!.ended, 'setup client closes even on failure');
  assert.equal(FakePool.instances.length, 0, 'failed setup must not construct a pool');
});

// --- transactions -------------------------------------------------------------------

test('a transaction commits on success and releases the client', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  const out = await db.transaction(async (tx) => {
    await tx.prepare('INSERT INTO t (a) VALUES (?)').run(7);
    return 'done';
  });
  assert.equal(out, 'done');
  const client = pool.clients.at(-1)!;
  assert.deepEqual(
    client.queries.map((q) => q.text),
    ['BEGIN', 'INSERT INTO t (a) VALUES ($1)', 'COMMIT'],
  );
  assert.deepEqual(client.queries[1]!.values, [7]);
  assert.ok(client.released, 'transaction client is released');
  await db.close();
});

test('a transaction rolls back, releases, and rethrows the original error', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  const boom = new Error('fn failed');
  try {
    await db.transaction(async () => {
      throw boom;
    });
    assert.fail('expected the transaction to throw');
  } catch (err) {
    assert.equal(err, boom, 'the original error is rethrown, not wrapped');
  }
  const client = pool.clients.at(-1)!;
  assert.deepEqual(
    client.queries.map((q) => q.text),
    ['BEGIN', 'ROLLBACK'],
  );
  assert.ok(client.released, 'failed-transaction client is still released');
  await db.close();
});

test('a failed ROLLBACK is swallowed so the original error still surfaces', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  pool.handler = (text) => {
    // The connection is already gone: ROLLBACK itself blows up.
    if (text === 'ROLLBACK') throw new Error('connection terminated');
    return { rows: [], rowCount: 0 };
  };
  const boom = new Error('fn failed');
  try {
    await db.transaction(async () => {
      throw boom;
    });
    assert.fail('expected the transaction to throw');
  } catch (err) {
    assert.equal(err, boom, 'rollback failure must not replace the original error');
  }
  assert.ok(pool.clients.at(-1)!.released, 'client is released even when rollback fails');
  await db.close();
});

test('a nested transaction reuses the same connection without a second BEGIN', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  // The boot probe already checked out one client; the outer transaction adds
  // exactly one more, and the nested call must add zero beyond that.
  assert.equal(pool.clients.length, 1);
  await db.transaction(async (tx) => {
    assert.equal(pool.clients.length, 2, 'outer transaction checks out one client');
    let inner: unknown;
    await tx.transaction(async (tx2) => {
      inner = tx2;
    });
    assert.equal(inner, tx, 'nested handle is the same connection');
    assert.equal(pool.clients.length, 2, 'nesting checks out no additional client');
  });
  const client = pool.clients.at(-1)!;
  assert.deepEqual(
    client.queries.map((q) => q.text),
    ['BEGIN', 'COMMIT'],
  );
  await db.close();
});

test('close ends the pool; closing a transaction handle is a no-op', async () => {
  resetFakes();
  const db = await openPostgres({ connectionString: URL });
  const pool = lastPool();
  await db.transaction(async (tx) => {
    await tx.close();
  });
  assert.equal(pool.ended, false, 'transaction handle must not end the shared pool');
  await db.close();
  assert.ok(pool.ended, 'closing the root handle ends the pool');
});

// --- openDb over fakes ------------------------------------------------------------------

test('openDb with skipMigrations opens without running migrations', async () => {
  resetFakes();
  const db = await openDb(URL, { skipMigrations: true, poolMax: 2 });
  const pool = lastPool();
  assert.equal(pool.opts.max, 2);
  // Only the boot probe touched the pool; no migration statements ran.
  assert.equal(pool.queryLog.length, 0);
  assert.equal(pool.clients.length, 1);
  await db.close();
});

test('openDb migrates on fakes and returns a working handle', async () => {
  resetFakes();
  const db = await openDb(URL, { skipMigrations: false });
  const pool = lastPool();
  const texts = [
    ...pool.queryLog.map((q) => q.text),
    ...pool.clients.flatMap((c) => c.queries.map((q) => q.text)),
  ];
  assert.ok(
    texts.some((t) => t.includes('CREATE TABLE IF NOT EXISTS schema_migrations')),
    'migrate creates the bookkeeping table',
  );
  assert.ok(texts.includes('BEGIN'), 'migrate runs inside a transaction');
  assert.ok(texts.includes('COMMIT'), 'migrate commits');
  assert.equal(pool.ended, false, 'a successful open leaves the pool running');
  // The returned handle is live: statements flow to the pool.
  const before = pool.queryLog.length;
  await db.prepare('SELECT 1').get();
  assert.equal(pool.queryLog.length, before + 1);
  await db.close();
});

test('openDb closes the pool when migrate fails, then rethrows', async () => {
  resetFakes();
  // Everything up to the first await inside openPostgres (pool construction,
  // error-listener registration, probe checkout) runs synchronously, so the
  // pool exists the instant openDb returns its promise and the failing
  // handler is installed before any migration statement can run. No polling.
  const pending = openDb(URL);
  const pool = lastPool();
  pool.handler = (text) => {
    if (text.includes('schema_migrations')) {
      throw new Error('injected migrate failure');
    }
    return { rows: [], rowCount: 0 };
  };
  await assert.rejects(pending, /injected migrate failure/);
  assert.ok(pool.ended, 'failed migrate closes the pool');
});
