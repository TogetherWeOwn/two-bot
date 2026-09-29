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
// Surface baseline the wrapper checks container bytes against. The declared
// running revision is a separate full SHA; the surface check decides whether
// that commit may run.
const BASELINE = 'c2a00876d9772c0e341e7aed643518cf02d100a3';
// A newer staging SHA with (in the fixture) identical bytes: proves the pin
// no longer goes stale on redeploy. Distinct from BASELINE on purpose.
const RUNNING = 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3';
const image = `sha256:${'a'.repeat(64)}`;
const container = 'b'.repeat(64);

async function fixture(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'tog4104-wrapper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ops = join(root, 'ops/tog-4104'), bin = join(root, 'bin'), log = join(root, 'docker.calls');
  await mkdir(ops, { recursive: true }); await mkdir(bin);
  for (const name of ['run-proof.sh', 'verify-surface.sh', 'settings-signed-proof.mjs']) await copyFile(join(packet, name), join(ops, name));
  // verify-surface.sh reads its expected blobs from the packet SOURCE commit's
  // fixture object, so the throwaway repo commits a test/ tree carrying the
  // live fixture. The byte-check in run-proof.sh covers these paths.
  const { readFileSync } = await import('node:fs');
  const liveFixture = JSON.parse(readFileSync(new URL('./fixtures/tog4104-runtime-source.json', import.meta.url), 'utf8'));
  const testDir = join(root, 'test', 'fixtures');
  await mkdir(testDir, { recursive: true });
  await copyFile(fileURLToPath(new URL('./fixtures/tog4104-runtime-source.json', import.meta.url)), join(testDir, 'tog4104-runtime-source.json'));
  for (const n of ['tog4104-offline.test.ts', 'tog4104-discovery.test.ts', 'tog4104-runtime-wiring.test.ts', 'tog4104-settingspoof-offline.test.mjs', 'tog4104-wrapper-offline.test.mjs']) {
    await copyFile(fileURLToPath(new URL(`./${n}`, import.meta.url)), join(root, 'test', n));
  }
  // No network or credential broker belongs in these throwaway local Git fixtures.
  const env = { PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Offline Fixture', GIT_AUTHOR_EMAIL: 'offline@example.invalid',
    GIT_COMMITTER_NAME: 'Offline Fixture', GIT_COMMITTER_EMAIL: 'offline@example.invalid',
    MOCK_LOG: log, MOCK_IDENTITY: `${container}|/bot-${APP}|${APP}_bot:${BASELINE}|true|${image}`,
    MOCK_IP: '10.0.10.3', MOCK_PORT: '8787', MOCK_BASELINE: liveFixture.baseline,
    MOCK_BLOBS: JSON.stringify(Object.fromEntries(
      [...new Set(Object.values(liveFixture.blocks).map((b) => b.path))].sort()
        .map((p) => [p, liveFixture.blocks[Object.keys(liveFixture.blocks).find((k) => liveFixture.blocks[k].path === p)].blob]))),
    PROOF_EXCLUSIVE_WINDOW: 'staging-writers-quiesced',
    PROOF_RUNTIME_REVISION: RUNNING, PROOF_IMAGE_ID: image };
  await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
 inspect)
  case "$*" in
   *NetworkSettings*) printf '%s \\n' "$MOCK_IP" ;;
   *) printf '%s\\n' "$MOCK_IDENTITY" ;;
  esac ;;
 cp)
  # Surface check copies: materialize the fixture bytes the mock stands in
  # for. The path after /app/ selects the blob; MOCK_DIRTY_PATH (one path)
  # writes drifted bytes to prove a touched surface refuses. POSIX sh only
  # (this mock runs under dash): take the last two args without bashisms.
  dest=""; src=""
  for a in "$@"; do src="$dest"; dest="$a"; done
  case "$src" in */app/*) rel="\${src##*/app/}" ;; *) rel="" ;; esac
  if [ -n "$rel" ]; then
    if [ "$rel" = "$MOCK_DIRTY_PATH" ]; then printf 'drifted-bytes\\n' > "$dest";
    else printf '%s\\n' "$rel" > "$dest"; fi
  else :; fi ;;
 exec)
  case "$*" in
   *printenv*) printf '%s\\n' "$MOCK_PORT" ;;
   *node*settings-signed-proof*) printf '%s\\n' 'OFFLINE-EXECUTED' ;;
   *) : ;;
  esac ;;
 *) exit 99 ;;
esac
`, { mode: 0o755 });
  // verify-surface.sh hashes the mock-copied bytes with `git hash-object` and
  // compares against the MOCK_BLOBS map. The shim answers hash-object from
  // that map (keyed by the mock-copy content, which is the surface path) and
  // delegates every other git invocation to the real binary, so the wrapper's
  // own rev-parse/diff/ls-files preconditions still execute for real.
  await writeFile(join(bin, 'git'), `#!/bin/sh
if [ "$1" = "hash-object" ]; then
  rel="$(cat "$2")"; rel="$(printf '%s' "$rel")"
  blob="$(printf '%s' "$MOCK_BLOBS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);const rel=process.argv[1];const dirty=process.env.MOCK_DIRTY_PATH;process.stdout.write(dirty&&rel===dirty?'0000000000000000000000000000000000000000':(m[rel]||'missing'))})" "$rel")"
  printf '%s\\n' "$blob"; exit 0
fi
exec /usr/bin/git "$@"
`, { mode: 0o755 });
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The wrapper and verify-surface.sh call `node` for fixture reads; the
  // fixture PATH only carries bin/, /usr/bin and /bin, so link the real node.
  // execFile does not run a shell: pass argv directly.
  const { execFile: execFileLn } = await import('node:child_process');
  await promisify(execFileLn)('ln', ['-sf', process.execPath, join(bin, 'node')]);
  const git = (...args) => exec('git', ['-C', root, ...args], { env });
  await git('init', '--quiet'); await git('add', 'ops', 'test');
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
    // The declared running revision is newer than the surface baseline; the
    // surface check (mocked byte-identical here) lets it run, and PROOF
    // TARGET records the running revision, not the baseline.
    assert.match(r.stderr, new RegExp(
      `PROOF TARGET app=${APP} container=${container} image=${image} ref=\\S+ runtime=${RUNNING} source=${f.sha} mode=${mode} url=http://10\\.0\\.10\\.3:8787`));
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
      `PROOF_RUNTIME_REVISION=${RUNNING}`, 'PROOF_EXCLUSIVE_WINDOW=staging-writers-quiesced',
      'INTERNAL_ACTIONS_URL=http://10.0.10.3:8787']) {
      assert.ok(engineExec[0].includes(value), `the engine exec forwards the validated value: ${value}`);
    }
    assert.ok(!engineExec[0].includes('TWO_INTERNAL_KEYS'),
      'signing keys are never forwarded into the container');
  });
}
for (const [name, overrides] of [
  ['malformed runtime', { PROOF_RUNTIME_REVISION: 'not-a-sha' }],
  ['missing runtime declaration', { PROOF_RUNTIME_REVISION: '' }],
]) {
  test(`wrapper refuses ${name} before any Docker operation`, async (t) => {
    const f = await fixture(t);
    const r = await f.run(overrides);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /REFUSED/);
    assert.equal(await f.calls(), '', 'a malformed runtime refuses before even Docker inspection');
    assert.ok(!r.stdout.includes('OFFLINE-EXECUTED'));
  });
}
test('wrapper refuses a touched surface after inspection but before copying', async (t) => {
  const f = await fixture(t);
  const r = await f.run({ MOCK_DIRTY_PATH: 'src/internal/actions.ts' });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /REFUSED/);
  const lines = (await f.calls()).trim().split('\n');
  assert.ok(lines[0].startsWith('inspect '));
  assert.ok(!lines.slice(1).some((l) => l.startsWith('exec ') && l.includes('settings-signed-proof')),
    'the engine never executes once the surface check fails');
  assert.ok(!r.stdout.includes('OFFLINE-EXECUTED'));
});
for (const [name, identity, overrides] of [
  ['wrong container', `${container}|/bot-production|${APP}_bot:${BASELINE}|true|${image}`, {}],
  ['stopped container', `${container}|/bot-${APP}|${APP}_bot:${BASELINE}|false|${image}`, {}],
  ['wrong image', `${container}|/bot-${APP}|${APP}_bot:${BASELINE}|true|sha256:${'0'.repeat(64)}`, {}],
  ['missing image receipt', `${container}|/bot-${APP}|${APP}_bot:${BASELINE}|true|${image}`, { PROOF_IMAGE_ID: '' }],
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
