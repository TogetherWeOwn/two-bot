import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Both CI entrypoints discover *.test.ts. Keep the dependency-free executable
// fixtures in JS, but run them here so CI cannot silently omit the packet tests.
test('TOG-4104 shipped proof, recovery and operator wrapper fixtures', async () => {
  await promisify(execFile)(process.execPath, [
    '--test',
    fileURLToPath(new URL('./tog4104-settingspoof-offline.test.mjs', import.meta.url)),
    fileURLToPath(new URL('./tog4104-wrapper-offline.test.mjs', import.meta.url)),
  ], { timeout: 120_000 });
});
