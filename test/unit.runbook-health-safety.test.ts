import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const probePath = fileURLToPath(new URL('./helpers/runbookHealthProbe.ts', import.meta.url));
const allowedUrl = 'postgres://synthetic:synthetic@agent-testdb/two_bot_test_tog10233';
const zeroCounts = { mockStarts: 0, spawns: 0, portHolds: 0, connects: 0, credentialReads: 0 };
interface ProbeResult {
  counts: typeof zeroCounts;
  error: string;
  env?: Record<string, string | null>;
  effectiveDatabase: string | null;
  effectiveToken: string | null;
}

function probe(mode: string, databaseUrl: string) {
  const child = spawnSync(process.execPath, [probePath, mode], {
    // Do not pass through any real credential, preload, or database variables.
    env: {
      PATH: process.env.PATH,
      TWO_DATABASE_URL: databaseUrl,
      CREDENTIALS_DIRECTORY: '/__runbook_probe_credentials/inherited',
      DISCORD_BOT_TOKEN: 'hostile.inherited.bot.token',
      DISCORD_TOKEN: 'hostile.inherited.token',
      PGOPTIONS: '-c search_path=card_test_schema',
    },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  const line = child.stdout.split('\n').find((s) => s.startsWith('RUNBOOK_PROBE '));
  assert.ok(line, `probe did not report: ${child.stderr}`);
  return { child, result: JSON.parse(line.slice('RUNBOOK_PROBE '.length)) as ProbeResult };
}

const refusedUrls = [
  ['non-test host', 'postgres://private-user:private-password@db.invalid/private-db'],
  ['malformed URL', 'not-a-url private-user private-password'],
  ['query host override', 'postgres://private-user:private-password@127.0.0.1/private-db?host=db.invalid'],
] as const;

for (const mode of ['direct', 'cli']) {
  for (const [label, url] of refusedUrls) {
    test(`${mode} refuses ${label} before any startup or connection`, () => {
      const { child, result } = probe(mode, url);
      assert.equal(child.status, mode === 'cli' ? 2 : 0, child.stderr);
      assert.match(result.error + child.stderr, /not an isolated test database|carries a query string/);
      assert.deepEqual(result.counts, zeroCounts);
      assert.equal(result.env, undefined);
      const output = child.stdout + child.stderr;
      for (const secret of ['private-user', 'private-password', 'private-db', url]) {
        assert.ok(!output.includes(secret), 'refusal must not disclose URL secrets');
      }
    });
  }
  test(`${mode} allows an isolated URL to reach a fake startup without connecting`, () => {
    const { child, result } = probe(mode, allowedUrl);
    assert.equal(child.status, mode === 'cli' ? 1 : 0, child.stderr);
    assert.equal(result.error, 'synthetic startup reached');
    assert.deepEqual(result.counts, { ...zeroCounts, mockStarts: 1 });
  });
}

for (const mode of ['environment-inherited', 'environment']) {
  test(`${mode}: inherited credentials and extraEnv cannot retarget the bot child`, () => {
    const { child, result } = probe(mode, allowedUrl);
    assert.equal(child.status, 0, result.error);
    assert.equal(result.error, 'synthetic spawn reached');
    assert.deepEqual(result.counts, { ...zeroCounts, mockStarts: 1, spawns: 1, portHolds: 1 });
    assert.equal(result.env?.CREDENTIALS_DIRECTORY || null, null);
    assert.equal(result.env?.DISCORD_BOT_TOKEN, 'mock.token.value');
    assert.equal(result.env?.DISCORD_TOKEN, 'mock.token.value');
    assert.equal(result.env?.DISCORD_API_BASE, 'http://127.0.0.1:43211/api/v10');
    assert.equal(result.env?.DISCORD_GUILD_ID, 'synthetic-guild');
    assert.equal(result.env?.TWO_DATABASE_URL, allowedUrl);
    assert.equal(result.env?.TWO_HEALTH_BIND_HOST, '127.0.0.1');
    assert.equal(result.env?.TWO_HEALTH_PORT, '43210');
    assert.equal(result.env?.NODE_OPTIONS || null, null);
    assert.equal(result.env?.PGOPTIONS, '-c search_path=card_test_schema');
    assert.equal(result.effectiveDatabase, allowedUrl);
    assert.equal(result.effectiveToken, 'mock.token.value');
  });
}
