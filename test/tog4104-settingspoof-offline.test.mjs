/** Offline HTTP/state fixtures spawning the actual shipped proof and recovery.
 * Never substitute a second implementation for the executable under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE = fileURLToPath(new URL('../ops/tog-4104/settings-signed-proof.mjs', import.meta.url));
const KEY = 'TWO_RAID_JOIN_THRESHOLD', MATE = 'TWO_RAID_WINDOW_SECONDS';
const SECRET = 'offline-only-signing-material-not-a-real-key';
const SOURCE = 'b03c6232a75fe4655964c1f0b523ff9c8e1ae7fe';
const RUNTIME = '47c48197d46647e34132544523e863e3c92d82ff';
const kid = 'offline-key-id';

async function fixture(t, seed = {}, hooks = {}) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'tog4104-offline-'));
  const stateDir = join(root, 'private');
  const store = new Map(Object.entries(seed)), idempotency = new Map(), reads = new Map();
  const writes = [], signatures = [];
  let getCount = 0;
  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const deny = (status, code) => send(status, { ok: false, error: { code } });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    // Independently reconstruct the live canonical input, including literal LF.
    const h = req.headers;
    const canonical = `POST\n/internal/actions\n${h['x-two-timestamp']}\n${h['x-two-nonce']}\n${createHash('sha256').update(raw).digest('hex')}`;
    const signature = 'sha256=' + createHmac('sha256', SECRET).update(canonical).digest('hex');
    signatures.push(signature);
    if (h['x-two-signature'] !== signature || h['x-two-key-id'] !== kid) return deny(401, 'unauthorized');
    const body = JSON.parse(raw.toString());
    if (!['settings.get', 'settings.set'].includes(body.action) || ![KEY, MATE].includes(body.key)) return deny(403, 'action_not_allowed');
    const { key } = body;
    const ctx = { req, res, body, key, send, deny, store, writes, reads, idempotency };
    if (body.action === 'settings.get') {
      getCount++;
      reads.set(key, (reads.get(key) ?? 0) + 1);
      if (hooks.get?.({ ...ctx, getCount })) return;
      // The live contract RETURNS exact stored values, not a presence-only null.
      const result = store.has(key) ? { key, source: 'store', value: store.get(key) } : { key, source: 'unset', value: null };
      send(200, { ok: true, result });
      hooks.afterGet?.({ ...ctx, getCount });
      return;
    }
    assert.ok(h['idempotency-key']);
    const idem = h['idempotency-key'];
    if (idempotency.has(idem)) {
      const entry = idempotency.get(idem);
      assert.equal(raw.toString(), entry.raw, 'reconciliation must reuse exact request body');
      return send(200, entry.response);
    }
    if (hooks.beforeSet?.(ctx)) return;
    if (body.value === null) store.delete(key); else store.set(key, body.value);
    writes.push({ key, value: body.value, idem });
    const response = { ok: true, result: { key, outcome: body.value === null ? 'unset' : 'saved' } };
    idempotency.set(idem, { raw: raw.toString(), response });
    if (hooks.afterSet?.(ctx)) return;
    send(200, response);
  });
  // Listen on all interfaces so the own-private-address case below dials the
  // same signed fixture server over a non-loopback URL. The default proof URL
  // stays loopback; only that one test overrides it.
  await new Promise((resolve) => server.listen(0, resolve));
  const internalUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    STAGING_APP_UUID: 'uy4d9ndeygjcem6lgayhxgub', PROOF_RUNTIME_REVISION: RUNTIME,
    PROOF_SOURCE_SHA: SOURCE, PROOF_EXCLUSIVE_WINDOW: 'staging-writers-quiesced',
    PROOF_STATE_DIR: stateDir, INTERNAL_ACTIONS_URL: internalUrl,
    TWO_INTERNAL_KEYS: `${kid}:${SECRET}`, TWO_INTERNAL_ACTIONS: '1', TWO_INTERNAL_ALLOW_SETTINGS: '1',
    DISCORD_GUILD_ID: '1545644954272137297',
  };
  function start(extra = {}, mode = 'run', nodeOptions = []) {
    const child = spawn(process.execPath, [...nodeOptions, PROBE, mode], { env: { ...env, ...extra } });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { err += b; });
    const done = new Promise((resolve) => child.on('close', (code, signal) => {
      for (const forbidden of [SECRET, kid, 'sha256=', '"value":', '003001', ...signatures]) {
        assert.ok(!out.includes(forbidden) && !err.includes(forbidden), 'sensitive output');
      }
      resolve({ code, signal, out, err, receipt: out.trim() ? JSON.parse(out.trim()) : null });
    }));
    return { child, done };
  }
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const { networkInterfaces } = await import('node:os');
  // Mirror the engine's allowlist (ops/tog-4104/settings-signed-proof.mjs):
  // any 127/8 loopback alias plus this process's own *private* interface
  // addresses. Selecting the first non-internal address unfiltered picks the
  // runner's public NIC on self-hosted CI, which the engine correctly REFUSEs
  // at preflight.url (main red at #209, run 36333108881); filtering to private
  // alone fails on runners with no private NIC at all (PR #220, runner4).
  // Prefer the first own *private* IPv4 (mirrors the container-NIC topology in
  // staging); fall back to deterministic 127.0.0.2, a distinct loopback alias
  // in 127/8 that never leaves the host.
  const isPrivateIPv4 = (host) => {
    const v4 = String(host ?? '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!v4) return false;
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  };
  const all = Object.values(networkInterfaces()).flat();
  const ownPrivate = all
    .find((a) => (a?.family === 'IPv4' || a?.family === 4) && !a.internal && isPrivateIPv4(a?.address))?.address ?? null;
  // Distinct loopback alias: exercises the non-127.0.0.1 branch on hosts with
  // no private NIC. Distinct from the default 127.0.0.1 fixture URL, so the
  // case still covers more than the default path.
  const ownAddress = ownPrivate ?? '127.0.0.2';
  // Same signed fixture server, reachable over this host's own private
  // interface address (or a loopback alias where there is none): mirrors the
  // container-NIC topology in staging.
  const ownAddressUrl = `http://${ownAddress}:${server.address().port}`;
  return { root, store, writes, stateDir, start, ownAddress, ownAddressUrl,
    run: (extra, mode, nodeOptions) => start(extra, mode, nodeOptions).done };
}

for (const [name, seed] of [
  ['both absent', {}], ['both stored', { [KEY]: '003001', [MATE]: 9 }],
  ['key stored, mate absent', { [KEY]: 9 }], ['key absent, mate stored', { [MATE]: '9' }],
]) {
  test(`exact restore: ${name}`, async (t) => {
    const f = await fixture(t, seed);
    const r = await f.run();
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.receipt.verdict, 'PROOF PASS');
    assert.equal(r.receipt.cleanup, 'exact-prestate-verified');
    assert.deepEqual(f.store, new Map(Object.entries(seed)));
    assert.equal(f.writes.length, 4);
    assert.deepEqual(await readdir(f.stateDir), []);
  });
}

test('assertion failure after a confirmed write still restores both exact pre-states', async (t) => {
  let corrupt = true;
  const seed = { [KEY]: '003001', [MATE]: 9 };
  const f = await fixture(t, seed, { get({ writes, send }) {
    if (writes.length === 1 && corrupt) { corrupt = false; send(200, { ok: true, result: {} }); return true; }
  } });
  const r = await f.run();
  assert.equal(r.code, 1); assert.equal(r.receipt.cleanup, 'exact-prestate-verified');
  assert.deepEqual(f.store, new Map(Object.entries(seed)));
});

for (const loss of ['socket', '500', 'timeout']) {
  test(`ambiguous ${loss} after commit reconciles same idempotency key and restores`, async (t) => {
    const f = await fixture(t, { [MATE]: '9' }, { afterSet({ writes, req, deny }) {
      if (writes.length !== 1) return;
      if (loss === 'socket') req.socket.destroy();
      if (loss === '500') deny(500, 'internal');
      // Timeout case intentionally holds the response past the executable's 30s deadline.
      return true;
    } });
    const r = await f.run();
    assert.equal(r.code, 1); assert.equal(r.receipt.responseUncertainty, true);
    assert.equal(r.receipt.cleanup, 'exact-prestate-verified');
    assert.deepEqual(f.store, new Map([[MATE, '9']]));
    assert.equal(f.writes.length, 4, 'no duplicate committed writes');
  });
}

test('pre-action rate limit gets one bounded backoff without a duplicate mutation', async (t) => {
  let limited = true;
  const f = await fixture(t, {}, { beforeSet({ deny }) {
    if (limited) { limited = false; deny(429, 'rate_limited'); return true; }
  } });
  const r = await f.run();
  assert.equal(r.code, 0); assert.equal(f.writes.length, 4); assert.equal(f.store.size, 0);
});

test('restore failure stays nonzero with encrypted journal; recovery restores exact values', async (t) => {
  let refuse = true;
  const seed = { [KEY]: '003001', [MATE]: 9 };
  const f = await fixture(t, seed, { beforeSet({ body, deny }) {
    if (body.value === 9 && refuse) { deny(500, 'internal'); return true; }
  } });
  const r = await f.run();
  assert.equal(r.code, 1); assert.equal(r.receipt.cleanup, 'recovery-required');
  const file = join(f.stateDir, 'recovery.enc');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const bytes = await readFile(file);
  assert.ok(!bytes.includes(Buffer.from('003001')) && !bytes.includes(Buffer.from(SECRET)));
  const noRerun = await f.run();
  assert.equal(noRerun.code, 2, 'never replace outstanding recovery');
  refuse = false;
  const recovery = await f.run({}, 'recover');
  assert.equal(recovery.code, 0, recovery.out + recovery.err);
  assert.equal(recovery.receipt.verdict, 'RECOVERED');
  assert.deepEqual(f.store, new Map(Object.entries(seed)));
});

test('SIGKILL during applied write is recovered from the shipped encrypted journal', async (t) => {
  let signal;
  const applied = new Promise((resolve) => { signal = resolve; });
  const f = await fixture(t, { [KEY]: '003001' }, { afterSet({ writes }) {
    if (writes.length === 1) { signal(); return true; }
  } });
  const running = f.start();
  await applied;
  assert.equal((await f.run({}, 'recover')).code, 2, 'live PID lock must refuse recovery');
  running.child.kill('SIGKILL');
  assert.equal((await running.done).signal, 'SIGKILL');
  const recovery = await f.run({}, 'recover');
  assert.equal(recovery.code, 0, recovery.out + recovery.err);
  assert.deepEqual(f.store, new Map([[KEY, '003001']]));
});

test('old ambiguous intent refuses replay before the unfenced 60-second takeover boundary', async (t) => {
  let signal;
  const applied = new Promise((resolve) => { signal = resolve; });
  const f = await fixture(t, { [KEY]: '9' }, { afterSet({ writes }) {
    if (writes.length === 1) { signal(); return true; }
  } });
  const running = f.start();
  await applied; running.child.kill('SIGKILL'); await running.done;
  const clock = join(f.root, 'advanced-clock.mjs');
  await writeFile(clock, 'const now = Date.now; Date.now = () => now() + 46000;');
  const r = await f.run({}, 'recover', ['--import', clock]);
  assert.equal(r.code, 1); assert.equal(r.receipt.failure, 'write.reconciliation-expired');
  assert.equal(f.writes.length, 1, 'no stale-claim takeover or restore is sent');
  assert.equal(f.store.get(KEY), '7');
  assert.ok((await readdir(f.stateDir)).includes('recovery.enc'));
});

test('concurrent mate drift before mutation is not overwritten', async (t) => {
  const f = await fixture(t, { [MATE]: '9' }, { afterGet({ key, reads, store }) {
    if (key === MATE && reads.get(MATE) === 1) store.set(MATE, '11');
  } });
  const r = await f.run();
  assert.notEqual(r.code, 0); assert.equal(f.writes.length, 0); assert.equal(f.store.get(MATE), '11');
});

test('concurrent writer before cleanup is not silently overwritten or reported PASS', async (t) => {
  const f = await fixture(t, {}, { afterGet({ key, writes, store }) {
    if (key === MATE && writes.length === 2) store.set(MATE, '11');
  } });
  const r = await f.run();
  assert.equal(r.code, 1); assert.equal(r.receipt.cleanup, 'recovery-required');
  assert.equal(f.store.get(MATE), '11'); assert.equal(f.writes.length, 2);
});

test('cache lag cannot turn a presence-only read into a successful roundtrip', async (t) => {
  let lag = 2;
  const f = await fixture(t, { [KEY]: 9 }, { get({ key, writes, send }) {
    if (key === KEY && writes.length === 1 && lag > 0) {
      lag--;
      send(200, { ok: true, result: { key, source: 'store', value: 9 } }); return true;
    }
  } });
  const r = await f.run();
  assert.equal(r.code, 0); assert.equal(lag, 0);
  assert.deepEqual(f.store, new Map([[KEY, 9]]));
});

test('container resource UUID grounds the app check without a forwarded app UUID', async (t) => {
  const f = await fixture(t);
  const r = await f.run({ STAGING_APP_UUID: '', COOLIFY_RESOURCE_UUID: 'uy4d9ndeygjcem6lgayhxgub' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.receipt.verdict, 'PROOF PASS');
  assert.deepEqual(f.store, new Map());
});

test('own private interface address passes the URL check with full roundtrip', async (t) => {
  const f = await fixture(t);
  // Same signed fixture server, dialed over the host's own private address
  // (or a 127/8 loopback alias where the host has no private NIC) instead of
  // the default 127.0.0.1: mirrors the container-NIC topology in staging.
  // Full PROOF PASS with exact cleanup, so the new branch is not a
  // preflight-only exemption.
  const r = await f.run({ INTERNAL_ACTIONS_URL: f.ownAddressUrl });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.receipt.verdict, 'PROOF PASS');
  assert.equal(r.receipt.cleanup, 'exact-prestate-verified');
  assert.deepEqual(f.store, new Map());
  assert.equal(f.writes.length, 4);
});

for (const [name, overrides] of [
  ['wrong app', { STAGING_APP_UUID: 'production' }],
  ['neither app UUID matches', { STAGING_APP_UUID: '', COOLIFY_RESOURCE_UUID: '00000000-0000-4000-8000-000000000000' }],
  ['wrong runtime', { PROOF_RUNTIME_REVISION: SOURCE }],
  ['missing runtime', { PROOF_RUNTIME_REVISION: '' }],
  ['missing source', { PROOF_SOURCE_SHA: '' }],
  ['wrong guild', { DISCORD_GUILD_ID: '326474832151838730' }],
  ['missing guild', { DISCORD_GUILD_ID: '' }],
  ['missing flag', { TWO_INTERNAL_ALLOW_SETTINGS: '0' }],
  ['malformed signing key', { TWO_INTERNAL_KEYS: 'no-colon' }],
  ['no exclusive window', { PROOF_EXCLUSIVE_WINDOW: '' }],
  ['public endpoint', { INTERNAL_ACTIONS_URL: 'https://example.invalid' }],
  ['foreign private endpoint', { INTERNAL_ACTIONS_URL: 'http://10.255.255.1:8787' }],
  ['DNS endpoint', { INTERNAL_ACTIONS_URL: 'http://internal.example.invalid:8787' }],
  ['URL credentials', { INTERNAL_ACTIONS_URL: 'http://user:secret@127.0.0.1:8787' }],
]) {
  test(`${name} refuses before mutation`, async (t) => {
    const f = await fixture(t);
    const r = await f.run(overrides);
    assert.equal(r.code, 2); assert.equal(f.writes.length, 0);
  });
}

test('malformed stored value refuses rather than writes an unreviewed recovery value', async (t) => {
  const f = await fixture(t, { [MATE]: { unsafe: 'not numeric' } });
  const r = await f.run();
  assert.equal(r.code, 2); assert.equal(f.writes.length, 0);
});

test('unwired settings endpoint refuses before mutation with a settings-unavailable reason', async (t) => {
  const f = await fixture(t, {}, { get({ deny }) {
    deny(403, 'action_not_allowed'); return true;
  } });
  const r = await f.run();
  assert.equal(r.code, 2); assert.equal(r.receipt.failure, 'runtime.settings-unavailable');
  assert.equal(r.receipt.cleanup, 'not-started'); assert.equal(f.writes.length, 0);
});

test('redirect is not followed with signing headers', async (t) => {
  let requests = 0;
  const f = await fixture(t, {}, { get({ res }) {
    requests++; res.writeHead(307, { location: '/stolen' }); res.end(); return true;
  } });
  const r = await f.run();
  assert.equal(r.code, 2); assert.equal(requests, 1); assert.equal(f.writes.length, 0);
});
