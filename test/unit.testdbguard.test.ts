/**
 * Host-guard proof for scripts/test-db-guard.ts (TOG-9656).
 *
 * WHY THIS EXISTS. After the 2026-09-29 production DB wipe (TOG-9646),
 * agents must never test against production services. The guard allowlists
 * test hosts and refuses everything else before any connection opens. These
 * tests pin the allowlist and, by spawning the real suite wrapper and a real
 * helper import against a non-allowlisted host, prove the refusal happens
 * before any migration runs. No database, no network: the refused runs must
 * fail without connecting (the URLs are unroutable), and the allowed cases
 * assert on pure string classification only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ALLOWED_TEST_DATABASE_HOSTS,
  assertTestDatabaseHost,
  isAllowedTestDatabaseUrl,
  testDatabaseHost,
} from '../scripts/test-db-guard.ts';

const ROOT = resolve(import.meta.dirname, '..');

test('allowlist is exactly the sandbox, loopback, and CI service hosts', () => {
  assert.deepEqual(
    [...ALLOWED_TEST_DATABASE_HOSTS].sort(),
    ['127.0.0.1', '::1', '[::1]', 'agent-testdb', 'localhost', 'postgres'],
  );
});

for (const url of [
  'postgres://agent_test@agent-testdb:5432/two_bot_test_tog9656',
  'postgresql://agent_test@agent-testdb:5432/two_bot_test_tog9656',
  'postgres://two:two@127.0.0.1:5432/two_test',
  'postgres://localhost:5432/two_bot_test',
  'postgres://two:two@postgres:5432/two_test',
  'postgres://127.0.0.1:1/two_scratch_must_not_connect',
]) {
  test(`allows isolated test host: ${new URL(url).hostname}`, () => {
    assert.equal(isAllowedTestDatabaseUrl(url), true);
    assert.equal(assertTestDatabaseHost(url), url);
  });
}

for (const [name, url] of [
  ['production paperclip host', 'postgres://agent_test@db:5432/paperclip'],
  ['named production host', 'postgres://agent_test@paperclip-db:5432/paperclip'],
  ['staging host', 'postgres://bot:botpw@staging.internal:5432/two'],
  ['public host', 'postgres://u:p@db.example.com:5432/two'],
  ['unparsable value', 'not-a-url'],
  ['wrong scheme', 'sqlite:///tmp/not-postgres.db'],
] as Array<[string, string]>) {
  test(`refuses ${name} before any connection`, () => {
    assert.equal(isAllowedTestDatabaseUrl(url), false);
    assert.throws(() => assertTestDatabaseHost(url), /not an isolated test database/);
  });
}

// TOG-9740: node-postgres (pg-connection-string) promotes ?host=/?port= over
// the hostname — proven live: the URL below parses as host=db.internal — so a
// hostname-only allowlist is bypassable. Any query string is refused instead.
// No legitimate query-param use exists (CI sets bare URLs; schema selection
// uses driver options, e.g. PGOPTIONS in e2e.rotaprocess.test.ts).
for (const [name, url] of [
  ['query-param host override on allowlisted hostname', 'postgres://agent_test@127.0.0.1:5432/two_bot_test_tog9656?host=db.internal'],
  ['query-param host override on sandbox hostname', 'postgres://agent_test@agent-testdb:5432/two_bot_test_tog9656?host=db.internal'],
  ['query-param port override', 'postgres://agent_test@127.0.0.1:5432/two_bot_test?port=5433'],
  ['benign-looking option', 'postgres://agent_test@127.0.0.1:5432/two_bot_test?sslmode=require'],
] as Array<[string, string]>) {
  test(`refuses ${name} before any connection`, () => {
    assert.equal(isAllowedTestDatabaseUrl(url), false);
    assert.throws(() => assertTestDatabaseHost(url), /query string/);
  });
}

test('helper import against a non-allowlisted host throws before connecting', () => {
  // Unroutable host: if the helper tried to connect instead of refusing, this
  // would hang or fail with a connection error, not the guard message.
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('./test/helpers/testDb.ts')"],
    {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        TWO_TEST_DATABASE_URL: 'postgres://agent_test@db.invalid:5432/paperclip',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.notEqual(run.status, 0, `helper import exited 0: ${output.slice(0, 1000)}`);
  assert.match(output, /not an isolated test database/, 'refusal must name the guard');
});

test('require-suites against a non-allowlisted host refuses before spawning suites', () => {
  const run = spawnSync(process.execPath, ['scripts/require-suites.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      TWO_TEST_DATABASE_URL: 'postgres://agent_test@db.invalid:5432/paperclip',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.notEqual(run.status, 0, `wrapper exited 0: ${output.slice(0, 1000)}`);
  assert.match(output, /not an isolated test database/, 'refusal must name the guard');
  assert.doesNotMatch(output, /passing, .* skipped/, 'no suite may have run');
});

test('require-suites against a query-param host override refuses before spawning suites', () => {
  // TOG-9740: the hostname looks allowlisted, so only the query-string check
  // can refuse this URL — it proves the wrapper mirrors the shared guard.
  const run = spawnSync(process.execPath, ['scripts/require-suites.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      TWO_TEST_DATABASE_URL: 'postgres://agent_test@127.0.0.1:5432/two_bot_test?host=db.invalid',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.notEqual(run.status, 0, `wrapper exited 0: ${output.slice(0, 1000)}`);
  assert.match(output, /query string/, 'refusal must name the query-string bypass');
  assert.doesNotMatch(output, /passing, .* skipped/, 'no suite may have run');
});

test('host parsing lowercases and tolerates trailing dots and whitespace', () => {
  assert.equal(testDatabaseHost('  postgres://Agent-TestDB:5432/x  '), 'agent-testdb');
  assert.equal(testDatabaseHost('postgres://127.0.0.1.:5432/x'), '127.0.0.1');
});
