import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRestartStorage } from '../src/staging/restartStorage.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rst-'));
  const scratch = join(root, 'run');
  const bin = join(root, 'bin');
  await mkdir(scratch, { mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  // Stand-ins only exercise pre-spawn refusal and failed-initialization cleanup.
  // Positive storage evidence lives in stagingRestartStorage.integration.ts.
  for (const name of ['initdb', 'postgres']) {
    await writeFile(join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
  return { root, scratch, bin, close: () => rm(root, { recursive: true, force: true }) };
}

for (const invalid of ['relative', 'symlink', 'readable', 'missing', 'bin-symlink', 'missing-binary']) {
  test(`storage refuses ${invalid} inputs without adopting a database or exposing paths`, async () => {
    const f = await fixture();
    try {
      let scratch = f.scratch;
      let bin = f.bin;
      if (invalid === 'relative') scratch = 'relative-sensitive-path';
      if (invalid === 'symlink') { scratch = join(f.root, 'alias'); await symlink(f.scratch, scratch); }
      if (invalid === 'readable') await chmod(scratch, 0o755);
      if (invalid === 'missing') scratch = join(f.root, 'missing-sensitive-path');
      if (invalid === 'bin-symlink') { bin = join(f.root, 'bin-alias'); await symlink(f.bin, bin); }
      if (invalid === 'missing-binary') await rm(join(bin, 'postgres'));
      await assert.rejects(createRestartStorage({ scratchDirectory: scratch, postgresBinDirectory: bin }),
        { message: 'Staging restart storage refused (setup); details withheld.' });
      assert.deepEqual(await readdir(f.scratch), [], 'preflight must create nothing');
    } finally { await f.close(); }
  });
}

test('ambient PostgreSQL controls refuse before creating or starting anything', async () => {
  const f = await fixture();
  const before = process.env.PGOPTIONS;
  try {
    process.env.PGOPTIONS = '-c search_path=public';
    await assert.rejects(createRestartStorage({ scratchDirectory: f.scratch, postgresBinDirectory: f.bin }),
      { message: 'Staging restart storage refused (setup); details withheld.' });
    assert.deepEqual(await readdir(f.scratch), []);
  } finally {
    if (before === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = before;
    await f.close();
  }
});

test('initialization failure removes only its own directory and does not inherit child environment', async () => {
  const f = await fixture();
  const names = ['LD_PRELOAD', 'NODE_OPTIONS', 'CREDENTIALS_DIRECTORY'];
  const before = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  try {
    await writeFile(join(f.scratch, 'sentinel'), 'pre-existing caller data');
    // If an ambient control escapes, exit zero; a later setup failure would mask
    // that, so write a marker outside the owned cluster for a discriminating check.
    await writeFile(join(f.bin, 'initdb'), `#!/bin/sh\nif [ -n "$PGDATA$PGHOST$LD_PRELOAD$NODE_OPTIONS$CREDENTIALS_DIRECTORY" ]; then\n  touch '${join(f.root, 'leaked')}'\nfi\nexit 1\n`, { mode: 0o700 });
    for (const key of names) process.env[key] = 'fixture-only-poison';
    await assert.rejects(createRestartStorage({ scratchDirectory: f.scratch, postgresBinDirectory: f.bin }),
      { message: 'Staging restart storage refused (setup); details withheld.' });
    assert.deepEqual(await readdir(f.scratch), ['sentinel']);
    assert.equal(await readFile(join(f.scratch, 'sentinel'), 'utf8'), 'pre-existing caller data');
    assert.ok(!(await readdir(f.root)).includes('leaked'));
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await f.close();
  }
});
