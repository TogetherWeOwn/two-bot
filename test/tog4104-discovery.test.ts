import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const [name, contents] of [
  ['empty files', '// No fixture cases. Node still counts this file as a passing test.\n'],
  ['unrelated named cases', "import { test } from 'node:test'; test('decoy', () => {});\n"],
]) {
  test(`TOG-4104 CI entrypoint rejects ${name}`, async (t) => {
    const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'tog4104-discovery-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const entry = join(root, 'tog4104-offline.test.ts');
    await copyFile(fileURLToPath(new URL('./tog4104-offline.test.ts', import.meta.url)), entry);
    for (const file of ['tog4104-settingspoof-offline.test.mjs', 'tog4104-wrapper-offline.test.mjs']) {
      await writeFile(join(root, file), contents);
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    await assert.rejects(promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', entry],
      { env, timeout: 15_000 }), (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /all named fixture cases must execute/);
      return true;
    });
  });
}
