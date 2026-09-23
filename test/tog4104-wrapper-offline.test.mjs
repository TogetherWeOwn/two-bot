import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const packet = fileURLToPath(new URL('../ops/tog-4104/', import.meta.url));
const APP = 'uy4d9ndeygjcem6lgayhxgub';
const RUNTIME = 'f5fd3e1d6d08847589d3bf48ebc0b0e198196e90';
const image = `sha256:${'a'.repeat(64)}`;
const container = 'b'.repeat(64);

async function fixture(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'tog4104-wrapper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ops = join(root, 'ops/tog-4104'), bin = join(root, 'bin'), log = join(root, 'docker.calls');
  await mkdir(ops, { recursive: true }); await mkdir(bin);
  for (const name of ['run-proof.sh', 'settings-signed-proof.mjs']) await copyFile(join(packet, name), join(ops, name));
  // No network or credential broker belongs in these throwaway local Git fixtures.
  const env = { PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Offline Fixture', GIT_AUTHOR_EMAIL: 'offline@example.invalid',
    GIT_COMMITTER_NAME: 'Offline Fixture', GIT_COMMITTER_EMAIL: 'offline@example.invalid',
    MOCK_LOG: log, MOCK_IDENTITY: `${container}|/bot-${APP}|${APP}_bot:${RUNTIME}|true|${image}`,
    PROOF_EXCLUSIVE_WINDOW: 'staging-writers-quiesced' };
  await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
 inspect) printf '%s\\n' "$MOCK_IDENTITY" ;;
 cp) : ;;
 exec) printf '%s\\n' 'OFFLINE-EXECUTED' ;;
 *) exit 99 ;;
esac
`, { mode: 0o755 });
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const git = (...args) => exec('git', ['-C', root, ...args], { env });
  await git('init', '--quiet'); await git('add', 'ops');
  await git('-c', 'user.name=Offline Fixture', '-c', 'user.email=offline@example.invalid', 'commit', '-qm', 'fixture');
  const sha = (await git('rev-parse', 'HEAD')).stdout.trim();
  const run = async (overrides = {}, source = sha, mode = 'run') => {
    try { return { code: 0, ...await exec('bash', [join(ops, 'run-proof.sh'), mode, source], { env: { ...env, ...overrides } }) }; }
    catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  };
  const calls = () => readFile(log, 'utf8').catch((e) => { if (e.code === 'ENOENT') return ''; throw e; });
  return { run, calls, ops, sha };
}

for (const mode of ['run', 'recover']) {
  test(`wrapper holds ${mode} before any Docker operation`, async (t) => {
    const f = await fixture(t);
    const r = await f.run({}, f.sha, mode);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /HOLD: runtime .* has no internal settings wiring/);
    assert.ok(r.stderr.includes(RUNTIME));
    assert.equal(await f.calls(), '', 'not even Docker inspection is authorized by this held packet');
    assert.equal(r.stdout, '');
  });
}
for (const [name, identity] of [
  ['wrong runtime', `${container}|/bot-${APP}|${APP}_bot:wrong|true|${image}`],
  ['wrong container', `${container}|/bot-production|${APP}_bot:${RUNTIME}|true|${image}`],
  ['stopped container', `${container}|/bot-${APP}|${APP}_bot:${RUNTIME}|false|${image}`],
]) {
  test(`wrapper refuses ${name} before copying or executing`, async (t) => {
    const f = await fixture(t);
    const r = await f.run({ MOCK_IDENTITY: identity });
    assert.equal(r.code, 2);
    assert.ok(!(await f.calls()).includes('cp ')); assert.ok(!(await f.calls()).includes('exec '));
  });
}
test('wrapper rejects dirty packet even with approved SHA', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.ops, 'settings-signed-proof.mjs'), 'throw new Error("edited");');
  const r = await f.run();
  assert.equal(r.code, 2); assert.equal(await f.calls(), '');
});
test('wrapper requires explicit writer exclusion and full pinned source', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run({ PROOF_EXCLUSIVE_WINDOW: '' })).code, 2);
  assert.equal((await f.run({}, 'main')).code, 2);
  assert.equal(await f.calls(), '');
});
