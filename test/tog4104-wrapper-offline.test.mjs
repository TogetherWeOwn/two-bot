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
const RUNTIME = '5f57256d41130b056389f3098f3b0c84a9d9e261';
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
    MOCK_IP: '10.0.10.3', MOCK_PORT: '8787',
    PROOF_EXCLUSIVE_WINDOW: 'staging-writers-quiesced',
    PROOF_RUNTIME_REVISION: RUNTIME, PROOF_IMAGE_ID: image };
  await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
 inspect)
  case "$*" in
   *NetworkSettings*) printf '%s \\n' "$MOCK_IP" ;;
   *) printf '%s\\n' "$MOCK_IDENTITY" ;;
  esac ;;
 cp) : ;;
 exec)
  case "$*" in
   *printenv*) printf '%s\\n' "$MOCK_PORT" ;;
   *node*settings-signed-proof*) printf '%s\\n' 'OFFLINE-EXECUTED' ;;
   *) : ;;
  esac ;;
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
  test(`wrapper runs ${mode} through the immutable container ID`, async (t) => {
    const f = await fixture(t);
    const r = await f.run({}, f.sha, mode);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, new RegExp(
      `PROOF TARGET app=${APP} container=${container} image=${image} ref=\\S+ runtime=${RUNTIME} source=${f.sha} mode=${mode} url=http://10\\.0\\.10\\.3:8787`));
    assert.ok(r.stdout.includes('OFFLINE-EXECUTED'), 'the engine exec actually ran');
    const lines = (await f.calls()).trim().split('\n');
    assert.ok(lines[0].startsWith('inspect '), 'the container is resolved by exact name exactly once');
    const post = lines.slice(1);
    assert.ok(post.length >= 3, 'mkdir, copy and engine exec all run');
    for (const line of post) {
      assert.ok(line.includes(container), `post-resolve Docker op addresses the container ID: ${line}`);
      assert.ok(!line.includes(`bot-${APP}`), `mutable name is never reused after resolve: ${line}`);
    }
    assert.ok(post.some((l) => l.startsWith('cp ')), 'the proof file is copied into the container');
    const engineExec = post.filter((l) => l.startsWith('exec ') && l.includes('settings-signed-proof'));
    assert.equal(engineExec.length, 1, 'exactly one engine exec runs');
    for (const value of [`PROOF_SOURCE_SHA=${f.sha}`, `STAGING_APP_UUID=${APP}`,
      `PROOF_RUNTIME_REVISION=${RUNTIME}`, 'PROOF_EXCLUSIVE_WINDOW=staging-writers-quiesced',
      'INTERNAL_ACTIONS_URL=http://10.0.10.3:8787']) {
      assert.ok(engineExec[0].includes(value), `the engine exec forwards the validated value: ${value}`);
    }
    assert.ok(!engineExec[0].includes('TWO_INTERNAL_KEYS'),
      'signing keys are never forwarded into the container');
  });
}
for (const [name, overrides] of [
  ['wrong runtime', { PROOF_RUNTIME_REVISION: 'f5fd3e1d6d08847589d3bf48ebc0b0e198196e90' }],
  ['missing runtime declaration', { PROOF_RUNTIME_REVISION: '' }],
]) {
  test(`wrapper refuses ${name} before any Docker operation`, async (t) => {
    const f = await fixture(t);
    const r = await f.run(overrides);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /REFUSED/);
    assert.equal(await f.calls(), '', 'a runtime mismatch refuses before even Docker inspection');
    assert.ok(!r.stdout.includes('OFFLINE-EXECUTED'));
  });
}
for (const [name, identity, overrides] of [
  ['wrong container', `${container}|/bot-production|${APP}_bot:${RUNTIME}|true|${image}`, {}],
  ['stopped container', `${container}|/bot-${APP}|${APP}_bot:${RUNTIME}|false|${image}`, {}],
  ['wrong image', `${container}|/bot-${APP}|${APP}_bot:${RUNTIME}|true|sha256:${'0'.repeat(64)}`, {}],
  ['missing image receipt', `${container}|/bot-${APP}|${APP}_bot:${RUNTIME}|true|${image}`, { PROOF_IMAGE_ID: '' }],
]) {
  test(`wrapper refuses ${name} before copying or executing`, async (t) => {
    const f = await fixture(t);
    const r = await f.run({ MOCK_IDENTITY: identity, ...overrides });
    assert.equal(r.code, 2);
    const lines = (await f.calls()).trim().split('\n');
    assert.ok(lines[0].startsWith('inspect '));
    assert.ok(!lines.slice(1).some((l) => l.startsWith('cp ') || l.startsWith('exec ')),
      'nothing is copied or executed after a failed identity check');
  });
}
test('wrapper refuses unresolvable container address before copying or executing', async (t) => {
  const f = await fixture(t);
  const r = await f.run({ MOCK_IP: '' });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /REFUSED/);
  const lines = (await f.calls()).trim().split('\n');
  assert.ok(lines[0].startsWith('inspect '));
  assert.ok(!lines.slice(1).some((l) => l.startsWith('cp ') || l.includes('settings-signed-proof')),
    'nothing is copied and the engine never executes without a measured listener address');
});
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
