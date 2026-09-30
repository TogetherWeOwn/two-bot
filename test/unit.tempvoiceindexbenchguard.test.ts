/**
 * Offline refusal proof for the temp-voice index benchmark (TOG-10236).
 * Run the real entry point with openDb replaced by a counting tripwire;
 * no database driver or connection is used, even if the guard regresses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertTestDatabaseHost, isAllowedTestDatabaseUrl } from '../scripts/test-db-guard.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OPEN_DB_CALL = 'temp-voice-bench-test: openDb called';
const BOOTSTRAP = `
  import { registerHooks } from 'node:module';
  const dbUrl = new URL('./src/store/db.ts', import.meta.url).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url === dbUrl) {
        return {
          format: 'module', shortCircuit: true,
          source: ${JSON.stringify(`export async function openDb() {
            console.log(${JSON.stringify(OPEN_DB_CALL)});
            throw new Error('offline openDb tripwire');
          }`)},
        };
      }
      return nextLoad(url, context);
    },
  });
`;

function runBenchmark(env: NodeJS.ProcessEnv, entry = "await import('./scripts/temp-voice-index-bench.ts')") {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', BOOTSTRAP + entry], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(run.error);
  assert.equal(run.signal, null, 'entry point must exit, not time out');
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const openDbCalls = (run.stdout ?? '').split('\n').filter((line) => line === OPEN_DB_CALL).length;
  return { status: run.status, output, openDbCalls };
}

test('offline openDb tripwire counts calls without loading the database driver', () => {
  const run = runBenchmark({}, "const { openDb } = await import('./src/store/db.ts'); await openDb()");
  assert.notEqual(run.status, 0);
  assert.match(run.output, /offline openDb tripwire/);
  assert.equal(run.openDbCalls, 1);
});

for (const [name, url, refusal] of [
  ['production host without prod in its name', 'postgres://agent_test@db:5432/paperclip', /not an isolated test database/],
  ['staging host', 'postgres://agent_test@staging.internal:5432/two', /not an isolated test database/],
  ['public host', 'postgres://agent_test@db.example.com:5432/two', /not an isolated test database/],
  ['unparsable URL', 'not-a-url', /not an isolated test database/],
  ['loopback host override', 'postgres://agent_test@127.0.0.1:5432/two_test?host=db.internal', /query string/],
  ['sandbox port override', 'postgres://agent_test@agent-testdb:5432/two_test?port=5433', /query string/],
  ['benign-looking query', 'postgres://agent_test@localhost:5432/two_test?sslmode=require', /query string/],
] as const) {
  test(`assertTestDatabaseHost refuses ${name} before openDb (zero calls)`, () => {
    const run = runBenchmark({
      TWO_DATABASE_URL: url,
      DATABASE_URL: 'postgres://agent_test@agent-testdb:5432/two_bot_test_tog10236',
    });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /assertTestDatabaseHost/, 'refusal must come from the shared guard');
    assert.match(run.output, /temp-voice-index-bench: TWO_DATABASE_URL/);
    assert.match(run.output, refusal);
    assert.equal(run.openDbCalls, 0, 'no schema creation or migration may start');
  });
}

for (const spec of [undefined, '', '   ']) {
  test(`benchmark ignores ambient DATABASE_URL with ${JSON.stringify(spec)} explicit input`, () => {
    const run = runBenchmark({
      TWO_DATABASE_URL: spec,
      DATABASE_URL: 'postgres://agent_test@agent-testdb:5432/two_bot_test_tog10236',
    });
    assert.equal(run.status, 2);
    assert.match(run.output, /set TWO_DATABASE_URL explicitly/);
    assert.match(run.output, /DATABASE_URL is ignored/);
    assert.equal(run.openDbCalls, 0);
  });
}

for (const host of ['agent-testdb', '127.0.0.1', 'localhost', '[::1]', 'postgres']) {
  test(`assertTestDatabaseHost classifies ${host} as allowed without connecting`, () => {
    const url = `postgres://agent_test@${host}:5432/two_bot_test_tog10236`;
    assert.equal(isAllowedTestDatabaseUrl(url), true);
    assert.equal(assertTestDatabaseHost(url), url);
  });
}
