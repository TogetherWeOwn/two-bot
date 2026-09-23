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
  assert.match(stdout, /^# tests [1-9][0-9]*$/m, 'fixture runner must actually discover tests');
  assert.match(stdout, /^# skipped 0$/m, 'all discovered fixtures must run');
});
