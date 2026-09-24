/** Runs the existing mock-Discord/real-entrypoint restart test against a cluster
 * created by the ownership helper. Local synthetic evidence, never real staging.
 * This wrapper does not accept or connect to an inherited test database URL.
 */
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestartStorage } from '../src/staging/restartStorage.ts';

const bin = process.env.TWO_TEST_POSTGRES_BIN;
if (!bin) throw new Error('TWO_TEST_POSTGRES_BIN must identify trusted local PostgreSQL binaries.');
const scratch = await mkdtemp(join(tmpdir(), 'rse-'));
const storage = await createRestartStorage({ scratchDirectory: scratch, postgresBinDirectory: bin });
const previous = process.env.TWO_TEST_DATABASE_URL;
async function close() {
  if (previous === undefined) delete process.env.TWO_TEST_DATABASE_URL;
  else process.env.TWO_TEST_DATABASE_URL = previous;
  await storage.close();
  assert.deepEqual(await readdir(scratch), []);
  await rm(scratch, { recursive: true });
}
try {
  // The existing fixture creates its own private test schema within this owned
  // database; it does not use the lease's default schema. The direct migration
  // integration separately verifies that default-schema entrypoint contract.
  process.env.TWO_TEST_DATABASE_URL = (await storage.bindings()).databaseUrl;
  await import('./e2e.stagingrestart.test.ts');
  after(close);
} catch {
  await close();
  throw new Error('Owned storage entrypoint fixture setup failed; details withheld.');
}
