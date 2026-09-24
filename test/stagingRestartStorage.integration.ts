/** Explicit tooling integration, not part of the service-DB test glob.
 * Requires trusted local initdb/postgres via TWO_TEST_POSTGRES_BIN; absence fails,
 * never skips. Creates its own clusters, never consumes TWO_TEST_DATABASE_URL.
 * No Discord credentials, traffic or application startup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { createRestartStorage } from '../src/staging/restartStorage.ts';
import { openDb } from '../src/store/db.ts';
import { applyWebContract } from '../src/store/webContract.ts';

const bin = process.env.TWO_TEST_POSTGRES_BIN;
if (!bin) throw new Error('TWO_TEST_POSTGRES_BIN must identify trusted local PostgreSQL binaries.');

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'rsi-'));
  const storage = await createRestartStorage({ scratchDirectory: scratch, postgresBinDirectory: bin! });
  const [name] = await readdir(scratch);
  const directory = join(scratch, name);
  return { scratch, storage, directory, async close() {
    await storage.close();
    assert.deepEqual(await readdir(scratch), []);
    await rm(scratch, { recursive: true });
  } };
}

async function client(url: string) {
  const db = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1_000 });
  db.on('error', () => {});
  try { await db.connect(); return db; }
  catch (error) { await db.end().catch(() => {}); throw error; }
}

test('owned storage supports real migrations/web contract across three connections without public writes', { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.storage.bindings();
    assert.ok(Object.isFrozen(first));
    for (let boot = 0; boot < 3; boot++) {
      const binding = await f.storage.bindings();
      assert.ok(binding.databaseUrl === first.databaseUrl && binding.schema === first.schema, 'one owned storage lease across restarts');
      // Same no-schema-override path used by src/index.ts, not test schema auto-create.
      const db = await openDb(binding.databaseUrl);
      try {
        const contract = await applyWebContract(db);
        assert.equal(contract.botSchema, binding.schema);
        assert.equal(contract.webSchema, `${binding.schema}_web_v1`);
        assert.ok(Number((await db.prepare('SELECT count(*) AS n FROM schema_migrations').get<{ n: string }>())?.n) > 0);
        assert.equal(Number((await db.prepare("SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'").get<{ n: string }>())?.n), 0);
        assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM community_facts').get<{ n: string }>())?.n), 0);
        assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM operational_audit_log').get<{ n: string }>())?.n), 0);
        await assert.rejects(db.exec('CREATE TABLE public.forbidden(id integer)'), /permission denied/);
        await assert.rejects(db.exec('CREATE DATABASE forbidden'), /permission denied/);
        await assert.rejects(db.exec('CREATE ROLE forbidden'), /permission denied/);
      } finally { await db.close(); }
    }
    const otherDb = new URL(first.databaseUrl);
    otherDb.pathname = '/postgres';
    await assert.rejects(client(otherDb.toString()), /pg_hba.conf rejects connection/);
    const badPassword = new URL(first.databaseUrl);
    badPassword.password = 'wrong-fixture-password';
    await assert.rejects(client(badPassword.toString()), /password authentication failed/);
    await f.storage.close();
    await f.storage.close();
    await assert.rejects(f.storage.bindings(), /lease verification/);
    await assert.rejects(client(first.databaseUrl), /ECONNREFUSED/);
  } finally { await f.close(); }
});

test('ambient startup options added after creation cannot reach a lease connection', { timeout: 30_000 }, async () => {
  const f = await fixture();
  const previous = process.env.PGOPTIONS;
  try {
    process.env.PGOPTIONS = '-c search_path=public';
    await assert.rejects(f.storage.bindings(), { message: 'Staging restart storage refused (lease verification); details withheld.' });
    delete process.env.PGOPTIONS;
    await f.storage.bindings();
  } finally {
    if (previous === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previous;
    await f.close();
  }
});

test('missing owned schema is refused on reacquisition, never replaced by public', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const binding = await f.storage.bindings();
    const db = await client(binding.databaseUrl);
    try { await db.query(`DROP SCHEMA ${binding.schema}`); } finally { await db.end(); }
    await assert.rejects(f.storage.bindings(), { message: 'Staging restart storage refused (lease verification); details withheld.' });
  } finally { await f.close(); }
});

test('substituted postmaster identity refuses bindings without signaling a supplied PID', { timeout: 30_000 }, async () => {
  const f = await fixture();
  const path = join(f.directory, 'data/postmaster.pid');
  const original = await readFile(path, 'utf8');
  try {
    await writeFile(path, original.replace(/^\d+/, '0'));
    await assert.rejects(f.storage.bindings(), /lease verification/);
  } finally {
    await writeFile(path, original);
    await f.close();
  }
});

test('failed cleanup refuses bindings but can retry after directory privacy is restored', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await chmod(f.directory, 0o755);
    await assert.rejects(f.storage.close(), /cleanup/);
    await assert.rejects(f.storage.bindings(), /lease verification/);
    assert.equal((await readdir(f.scratch)).length, 1, 'do not remove an unsafe directory');
    await chmod(f.directory, 0o700);
    await f.storage.close();
    await f.storage.close();
  } finally { await f.close(); }
});
