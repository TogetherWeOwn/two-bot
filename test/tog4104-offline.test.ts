import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Both CI entrypoints discover *.test.ts. Keep the dependency-free executable
// fixtures in JS, but run them here so CI cannot silently omit the packet tests.
test('TOG-4104 shipped proof, recovery and operator wrapper fixtures', async () => {
  const env = { ...process.env };
  // Node otherwise suppresses nested test discovery and exits zero without
  // running a fixture. Do not let that become a green-but-empty CI check.
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--test', '--test-reporter=tap',
    fileURLToPath(new URL('./tog4104-settingspoof-offline.test.mjs', import.meta.url)),
    fileURLToPath(new URL('./tog4104-wrapper-offline.test.mjs', import.meta.url)),
  ], { timeout: 120_000, env });
  // Node counts an empty test file as a passing test. Assert the named cases,
  // not just a positive total, so emptied/removed fixture files cannot go green.
  const expected = [
    ...['both absent', 'both stored', 'key stored, mate absent', 'key absent, mate stored']
      .map((name) => `exact restore: ${name}`),
    'assertion failure after a confirmed write still restores both exact pre-states',
    ...['socket', '500', 'timeout'].map((loss) =>
      `ambiguous ${loss} after commit reconciles same idempotency key and restores`),
    'pre-action rate limit gets one bounded backoff without a duplicate mutation',
    'restore failure stays nonzero with encrypted journal; recovery restores exact values',
    'SIGKILL during applied write is recovered from the shipped encrypted journal',
    'old ambiguous intent refuses replay before the unfenced 60-second takeover boundary',
    'concurrent mate drift before mutation is not overwritten',
    'concurrent writer before cleanup is not silently overwritten or reported PASS',
    'cache lag cannot turn a presence-only read into a successful roundtrip',
    'container resource UUID grounds the app check without a forwarded app UUID',
    'own private interface address passes the URL check with full roundtrip',
    ...['wrong app', 'neither app UUID matches', 'malformed runtime', 'missing runtime', 'missing source',
      'wrong guild', 'missing guild', 'missing flag', 'malformed signing key', 'no exclusive window',
      'public endpoint', 'foreign private endpoint', 'DNS endpoint', 'URL credentials']
      .map((name) => `${name} refuses before mutation`),
    'malformed stored value refuses rather than writes an unreviewed recovery value',
    'redirect is not followed with signing headers',
    'unwired settings endpoint refuses before mutation with a settings-unavailable reason',
    ...['run', 'recover'].map((mode) => `wrapper runs ${mode} through the immutable container ID`),
    ...['malformed runtime', 'missing runtime declaration']
      .map((name) => `wrapper refuses ${name} before any Docker operation`),
    'wrapper refuses a touched surface after inspection but before copying',
    ...['wrong container', 'stopped container', 'wrong image', 'missing image receipt']
      .map((name) => `wrapper refuses ${name} before copying or executing`),
    'wrapper refuses unresolvable container address before copying or executing',
    'wrapper rejects dirty packet even with approved SHA',
    'wrapper requires explicit writer exclusion and full pinned source',
  ];
  const passed = [...stdout.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(passed.sort(), expected.sort(), 'all named fixture cases must execute');
  assert.match(stdout, /^# skipped 0$/m, 'all discovered fixtures must run');
});
