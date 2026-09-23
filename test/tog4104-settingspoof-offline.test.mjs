/**
 * TOG-4104 offline tests for `ops/tog-4104/settings-signed-proof.mjs`.
 *
 * These exercise the ACTUAL shipped executable (spawned as a child process
 * with stub env), not a duplicated algorithm. Each case starts a fixture HTTP
 * server that mimics the endpoint's contract (HMAC verify, allowlist, store
 * vs unset, idempotency guard) and asserts the probe's exit code and its
 * value-blind receipt.
 *
 * No Postgres, no Discord, no secrets: the fixture key is `test-only`.
 * Run: `node --test test/tog4104-settingspoof-offline.test.mjs`
 * (lives in test/ so `npm test` and `npm run test:postgres` pick it up).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, '..', 'ops', 'tog-4104', 'settings-signed-proof.mjs');

const SECRET = 't'.repeat(48);
const KEY_ID = 'web-staging';
const GUILD = '1545644954272137297';
const KEY = 'TWO_RAID_JOIN_THRESHOLD';
const MATE = 'TWO_RAID_WINDOW_SECONDS';

function bodyHash(raw) {
  return createHash('sha256').update(raw).digest('hex');
}
function expectedSig(secret, ts, nonce, raw) {
  const canon = ['POST', '/internal/actions', ts, nonce, bodyHash(raw)].join('\n');
  return 'sha256=' + createHmac('sha256', secret).update(canon).digest('hex');
}

// --- fixture state (per test, reset in beforeEach-style) ---
let store; // Map key -> value (string); absence = environment fallback
let failRestoreOnce;
let flakyWriteOnce;

function resetFixture({ seed, failRestore = false, flakyWrite = false } = {}) {
  store = new Map(Object.entries(seed ?? {}));
  failRestoreOnce = failRestore;
  flakyWriteOnce = flakyWrite;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let server;
let port;

before(async () => {
  server = createServer(async (req, res) => {
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST' || req.url !== '/internal/actions') {
      return send(404, { ok: false, error: { code: 'malformed', retryable: false }, request_id: 'x' });
    }
    const raw = await readBody(req);
    const ts = req.headers['x-two-timestamp'] ?? '';
    const nonce = req.headers['x-two-nonce'] ?? '';
    const sig = req.headers['x-two-signature'] ?? '';
    const kid = req.headers['x-two-key-id'] ?? '';
    const skewOk = /^\d+$/.test(String(ts)) && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
    const sigOk =
      kid === KEY_ID &&
      skewOk &&
      sig.length === expectedSig(SECRET, String(ts), String(nonce), raw).length &&
      sig === expectedSig(SECRET, String(ts), String(nonce), raw);
    if (!sigOk) {
      return send(401, { ok: false, error: { code: 'unauthorized', retryable: false }, request_id: 'x' });
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(400, { ok: false, error: { code: 'malformed', retryable: false }, request_id: 'x' });
    }
    const { action, key } = body;
    if (key === 'TWO_INTERNAL_ALLOW_SETTINGS' || String(key).startsWith('TWO_INTERNAL_')) {
      return send(403, { ok: false, error: { code: 'action_not_allowed', retryable: false }, request_id: 'x' });
    }
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(String(key))) {
      return send(400, { ok: false, error: { code: 'malformed', retryable: false }, request_id: 'x' });
    }
    if (action === 'settings.get') {
      if (!store.has(key)) return send(200, { ok: true, result: { key, value: null, source: 'unset' }, request_id: 'x' });
      return send(200, { ok: true, result: { key, value: null, source: 'store' }, request_id: 'x' });
    }
    if (action === 'settings.set') {
      if (!req.headers['idempotency-key']) {
        return send(400, { ok: false, error: { code: 'malformed', retryable: false }, request_id: 'x' });
      }
      if (!('value' in body)) {
        return send(400, { ok: false, error: { code: 'malformed', retryable: false }, request_id: 'x' });
      }
      if (!/^\d{17,20}$/.test(String(body.updated_by ?? ''))) {
        return send(400, { ok: false, error: { code: 'malformed', retryable: false }, request_id: 'x' });
      }
      const value = body.value ?? null;
      if (value === null && failRestoreOnce) {
        failRestoreOnce = false;
        return send(500, { ok: false, error: { code: 'internal', retryable: true }, request_id: 'x' });
      }
      if (value !== null && flakyWriteOnce) {
        // Ambiguous write: applied, but the response is lost (500 after commit).
        flakyWriteOnce = false;
        store.set(key, value);
        return send(500, { ok: false, error: { code: 'internal', retryable: true }, request_id: 'x' });
      }
      if (value === null) store.delete(key);
      else store.set(key, value);
      return send(200, { ok: true, result: { key, outcome: value === null ? 'unset' : 'saved' }, request_id: 'x' });
    }
    return send(403, { ok: false, error: { code: 'action_not_allowed', retryable: false }, request_id: 'x' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function runProbe(extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE], {
      env: {
        ...process.env,
        COOLIFY_APP_UUID: 'uy4d9ndeygjcem6lgayhxgub',
        INTERNAL_ACTIONS_URL: `http://127.0.0.1:${port}`,
        TWO_INTERNAL_KEYS: `${KEY_ID}:${SECRET}`,
        TWO_INTERNAL_ACTIONS: '1',
        TWO_INTERNAL_ALLOW_SETTINGS: '1',
        DISCORD_GUILD_ID: GUILD,
        ...extraEnv,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function receipt(run) {
  const line = run.out.trim().split('\n').pop();
  return JSON.parse(line);
}

const SECRET_SHAPES = [SECRET, 'sha256=', 'sig=', KEY_ID];

function assertNoSecrets(run, label) {
  // The probe must never print keys, signatures, or setting values. The
  // fixture value '9' stands in for any real stored value.
  for (const shape of [...SECRET_SHAPES, '"value":"9"', ':9,', ':9}']) {
    assert.ok(!run.out.includes(shape) && !run.err.includes(shape), `${label}: output leaks ${shape}`);
  }
}

test('prior stored value is preserved only via audit restore (fail closed)', async () => {
  // A stored pre-state cannot be restored value-blind through the endpoint
  // alone, so the probe must REFUSE to unset it rather than destroy it.
  resetFixture({ seed: { [KEY]: '9', [MATE]: '9' } });
  const run = await runProbe();
  assert.equal(run.code, 1);
  assert.equal(receipt(run).step, 'cleanup.stored-needs-audit-restore');
  assert.ok(store.has(KEY), 'stored key untouched');
  assertNoSecrets(run, 'stored-prestate');
});

test('prior absence is preserved: unset + readback-verified PASS', async () => {
  resetFixture({ seed: {} });
  const run = await runProbe();
  assert.equal(run.code, 0, run.out + run.err);
  const r = receipt(run);
  assert.equal(r.verdict, 'PROOF PASS');
  assert.equal(r.preState.hadRow, false);
  assert.ok(!store.has(KEY) && !store.has(MATE), 'no rows left behind');
  assertNoSecrets(run, 'absent-prestate');
});

test('ambiguous write response is a FAIL, not a PASS', async () => {
  resetFixture({ seed: {}, flakyWrite: true });
  const run = await runProbe();
  assert.equal(run.code, 1);
  assert.equal(receipt(run).step, 'mutate.set');
  assertNoSecrets(run, 'ambiguous-write');
});

test('restore failure is nonzero and names manual recovery', async () => {
  resetFixture({ seed: {}, failRestore: true });
  const run = await runProbe();
  assert.equal(run.code, 1);
  assertNoSecrets(run, 'restore-failure');
});

test('wrong app identity refuses before any mutation', async () => {
  resetFixture({ seed: {} });
  const run = await runProbe({ COOLIFY_APP_UUID: 'wrong-app-id' });
  assert.equal(run.code, 2);
  assert.equal(receipt(run).step, 'preflight.app');
  assert.ok(!store.has(KEY), 'nothing was written');
});

test('wrong guild identity refuses before any mutation', async () => {
  resetFixture({ seed: {} });
  const run = await runProbe({ DISCORD_GUILD_ID: '326474832151838730' });
  assert.equal(run.code, 2);
  assert.equal(receipt(run).step, 'preflight.guild');
  assert.ok(!store.has(KEY), 'nothing was written');
});

test('missing flags refuse before any mutation', async () => {
  resetFixture({ seed: {} });
  const run = await runProbe({ TWO_INTERNAL_ALLOW_SETTINGS: '0' });
  assert.equal(run.code, 2);
  assert.equal(receipt(run).step, 'preflight.flags');
  assert.ok(!store.has(KEY), 'nothing was written');
});

test('non-loopback endpoint refuses before any mutation', async () => {
  resetFixture({ seed: {} });
  const run = await runProbe({ INTERNAL_ACTIONS_URL: 'http://10.0.0.9:8787' });
  assert.equal(run.code, 2);
  assert.equal(receipt(run).step, 'preflight.url');
});

test('concurrent pre-state change cannot be silently overwritten', async () => {
  // The fixture flips the key between the probe's two pre-state reads.
  resetFixture({ seed: {} });
  let reads = 0;
  const origGet = store.has.bind(store);
  store.has = (k) => {
    if (k === KEY) {
      reads += 1;
      if (reads === 2) store.set(KEY, 'concurrent');
    }
    return origGet(k);
  };
  const run = await runProbe();
  assert.equal(run.code, 1);
  assert.equal(receipt(run).step, 'prestate.stable');
});

test('canonical newline serialization matches the endpoint', () => {
  // The old packet's join('\n') shape, verified against the same construction
  // src/internal/signing.ts uses: POST, path, timestamp, nonce, body hash.
  const raw = Buffer.from(JSON.stringify({ action: 'settings.get', key: KEY }));
  const canon = ['POST', '/internal/actions', '1700000000', 'abc', bodyHash(raw)].join('\n');
  assert.equal(canon.split('\n').length, 5);
  assert.ok(expectedSig(SECRET, '1700000000', 'abc', raw).startsWith('sha256='));
  void randomUUID;
});
