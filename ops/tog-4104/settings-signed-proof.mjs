#!/usr/bin/env node
/** Staging-only signed proof. Run through run-proof.sh; never print response bodies.
 * The live API has no compare-and-set. An externally exclusive writer window is
 * REQUIRED, including recovery. Read guards detect drift, not atomic exclusion.
 * Exact pre-state is retained in an authenticated encrypted, container-local
 * journal before any write. Recovery uses the same signed API, not ad-hoc SQL.
 */
import { createHash, createHmac, randomUUID, randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { open, mkdir, lstat, rename, unlink, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const APP = 'uy4d9ndeygjcem6lgayhxgub';
const GUILD = '1545644954272137297';
const RUNTIME = 'f5fd3e1d6d08847589d3bf48ebc0b0e198196e90';
const PATH = '/internal/actions';
const ACTOR = '900000000000009999';
const KEYS = ['TWO_RAID_JOIN_THRESHOLD', 'TWO_RAID_WINDOW_SECONDS'];
const FIXTURES = ['7', '42'];
const mode = process.argv[2] ?? 'run';
let stage = 'preflight', state, secret, kid, url, encryptionKey;
let dir, journal, lock, lockOwned = false, interrupted = false, uncertain = false, journalHealthy = true;
class ProofError extends Error {
  constructor(code) { super(); this.code = code; }
}
let failure = null;
const noteFailure = (error) => { failure = error instanceof ProofError ? error.code : 'operation.failed'; };
const check = (condition, code) => { if (!condition) throw new ProofError(code); };
const same = isDeepStrictEqual;
const fixture = (i) => ({ source: 'store', value: FIXTURES[i] });
const validValue = (value) => (typeof value === 'string' && /^\d{1,6}$/.test(value) || typeof value === 'number') &&
  Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 3600;
const uuid = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);

function preflight() {
  check(['run', 'recover'].includes(mode), 'preflight.mode');
  check(process.env.STAGING_APP_UUID === APP, 'preflight.app');
  check(process.env.PROOF_RUNTIME_REVISION === RUNTIME, 'preflight.runtime');
  check(process.env.DISCORD_GUILD_ID === GUILD, 'preflight.guild');
  check(/^[a-f0-9]{40}$/.test(process.env.PROOF_SOURCE_SHA ?? ''), 'preflight.source');
  check(process.env.PROOF_EXCLUSIVE_WINDOW === 'staging-writers-quiesced', 'preflight.exclusivity');
  check(process.env.TWO_INTERNAL_ACTIONS === '1' && process.env.TWO_INTERNAL_ALLOW_SETTINGS === '1', 'preflight.flags');
  const entry = (process.env.TWO_INTERNAL_KEYS ?? '').split(',')[0].trim();
  const at = entry.indexOf(':');
  check(at > 0 && at < entry.length - 1, 'preflight.keys');
  kid = entry.slice(0, at); secret = entry.slice(at + 1);
  check(/^[A-Za-z0-9_-]+$/.test(kid), 'preflight.keys');
  url = new URL(process.env.INTERNAL_ACTIONS_URL ?? 'http://127.0.0.1:8787');
  check(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'preflight.url');
  url.pathname = PATH;
  encryptionKey = hkdfSync('sha256', secret, APP, 'tog-4104-private-recovery-v2', 32);
}

async function privateFile(path) {
  const s = await lstat(path);
  check(s.isFile() && s.uid === process.getuid() && (s.mode & 0o777) === 0o600 && s.nlink === 1, 'journal.permissions');
}
async function acquire() {
  dir = process.env.PROOF_STATE_DIR ?? '/tmp/tog-4104-private';
  check(dir.startsWith('/'), 'journal.path');
  await mkdir(dir, { mode: 0o700, recursive: false }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
  const s = await lstat(dir);
  check(s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700, 'journal.permissions');
  journal = join(dir, 'recovery.enc'); lock = join(dir, 'process.lock');
  if (mode === 'recover') {
    try {
      await privateFile(lock);
      const pid = Number(await readFile(lock, 'utf8'));
      check(Number.isSafeInteger(pid) && pid > 0, 'journal.lock');
      let dead = false;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') dead = true; }
      check(dead, 'journal.busy');
      await unlink(lock);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const f = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  lockOwned = true;
  try { await f.writeFile(String(process.pid)); await f.sync(); } finally { await f.close(); }
}
async function save() {
  try { await persist(); }
  catch (e) { journalHealthy = false; throw e; }
}
async function persist() {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  const bytes = Buffer.concat([iv, cipher.getAuthTag(), data]);
  const tmp = join(dir, `journal-${randomUUID()}.enc`);
  const f = await open(tmp, 'wx', 0o600);
  try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  await rename(tmp, journal);
  const d = await open(dir, 'r');
  try { await d.sync(); } finally { await d.close(); }
}
async function load() {
  await privateFile(journal);
  const bytes = await readFile(journal);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  check(data.version === 2 && data.runtime === RUNTIME && data.source === process.env.PROOF_SOURCE_SHA &&
    data.endpoint === url.href && uuid(data.run) && Array.isArray(data.entries) && data.entries.length === 2, 'journal.identity');
  data.entries.forEach((e, i) => {
    check(e.key === KEYS[i] && uuid(e.writeId) && uuid(e.restoreId) &&
      ['captured', 'writePending', 'written', 'restorePending', 'restored'].includes(e.phase) &&
      (e.phase === 'captured' || Number.isSafeInteger(e.writeAt) && e.writeAt > 0) &&
      (!['restorePending', 'restored'].includes(e.phase) || Number.isSafeInteger(e.restoreAt) && e.restoreAt > 0) &&
      (e.pre?.source === 'unset' && e.pre.value === null || e.pre?.source === 'store' && validValue(e.pre.value)), 'journal.schema');
  });
  return data;
}

async function send(body, { idem, badSignature = false, badBody = false, unknownKey = false } = {}, rateRetry = true) {
  let raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID().replaceAll('-', '');
  const canonical = ['POST', PATH, ts, nonce, createHash('sha256').update(raw).digest('hex')].join('\n');
  const sig = 'sha256=' + createHmac('sha256', secret).update(canonical).digest('hex');
  if (badBody) raw += ' ';
  const res = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), body: raw,
    headers: { 'content-type': 'application/json', 'x-two-key-id': unknownKey ? 'tog4104-unknown' : kid,
      'x-two-timestamp': ts, 'x-two-nonce': nonce, 'x-two-signature': badSignature ? 'invalid' : sig,
      ...(idem ? { 'idempotency-key': idem } : {}) },
  });
  const json = await res.json();
  // Live bucket: burst 20, refill 1/s; rate_limited precedes the action/claim.
  // One bounded retry, with a fresh nonce and the same operation ID/body.
  if (res.status === 429 && json?.error?.code === 'rate_limited' && rateRetry) {
    await sleep(1100);
    return send(body, { idem, badSignature, badBody, unknownKey }, false);
  }
  return { status: res.status, json };
}
async function read(i) {
  const r = await send({ action: 'settings.get', key: KEYS[i] });
  check(r.status === 200 && r.json?.ok === true && r.json.result?.key === KEYS[i], 'read.contract');
  const { source, value } = r.json.result;
  check(source === 'unset' && value === null || source === 'store' && validValue(value), 'read.state');
  return { source, value };
}
async function readEquals(i, expected) {
  // settings.get reads a cache; SettingsStore.set does NOT refresh it. Give the
  // real 15s poll time to observe a completed write, but never accept presence only.
  for (let n = 0; n < 11; n++) {
    if (same(await read(i), expected)) return;
    if (n < 10) await sleep(2000);
  }
  throw new ProofError('readback.mismatch');
}
async function guard() {
  for (let i = 0; i < 2; i++) {
    const e = state.entries[i];
    const current = await read(i);
    const expected = ['written', 'writePending'].includes(e.phase) ? fixture(i) : e.pre;
    check(same(current, expected), 'guard.concurrent-change');
  }
}
async function write(i, restoring = false) {
  check(journalHealthy, 'journal.unavailable');
  const e = state.entries[i];
  const value = restoring ? e.pre.value : FIXTURES[i];
  // Reuse exactly the body and idempotency key on response loss. At most one
  // reconciliation attempt; never declare success from a mere matching read.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Live claims are unfenced and stealable at 60s. Never automatically replay
    // an old ambiguous intent across that lease, including after interruption.
    const age = Date.now() - (restoring ? e.restoreAt : e.writeAt);
    check(Number.isFinite(age) && age >= 0 && age < 45_000, 'write.reconciliation-expired');
    try {
      const r = await send({ action: 'settings.set', key: e.key, value, updated_by: ACTOR },
        { idem: restoring ? e.restoreId : e.writeId });
      check(r.status === 200 && r.json?.ok === true && r.json.result?.key === e.key &&
        r.json.result.outcome === (value === null ? 'unset' : 'saved'), 'write.contract');
      return;
    } catch {
      uncertain = true;
    }
  }
  throw new ProofError('write.unconfirmed');
}
async function cleanup() {
  for (let i = 1; i >= 0; i--) {
    const e = state.entries[i];
    if (e.phase === 'captured' || e.phase === 'restored') continue;
    if (e.phase === 'writePending') {
      const current = await read(i);
      check(same(current, fixture(i)) || same(current, e.pre), 'guard.concurrent-change');
      await write(i);
      e.phase = 'written'; await save();
      await readEquals(i, fixture(i));
    }
    if (e.phase === 'written') {
      // No value- or presence-only restore, including the mate. Refuse unknown
      // state rather than overwriting a writer that violated the exclusive window.
      check(same(await read(i), fixture(i)), 'guard.concurrent-change');
      e.phase = 'restorePending'; e.restoreAt = Date.now(); await save();
    } else {
      const current = await read(i);
      check(same(current, fixture(i)) || same(current, e.pre), 'guard.concurrent-change');
    }
    await write(i, true);
    await readEquals(i, e.pre);
    e.phase = 'restored'; await save();
  }
  for (let i = 0; i < 2; i++) check(same(await read(i), state.entries[i].pre), 'cleanup.verify');
  await unlink(journal);
}
async function negatives() {
  const cases = [
    [{ action: 'settings.get', key: 'TWO_INTERNAL_ALLOW_SETTINGS' }, {}, 403, 'action_not_allowed'],
    [{ action: 'settings.get', key: 'TWO_PROOF_UNREVIEWED_KEY' }, {}, 403, 'action_not_allowed'],
    [{ action: 'proof.not_allowlisted' }, {}, 403, 'action_not_allowed'],
    [{ action: 'settings.get', key: KEYS[0] }, { badSignature: true }, 401, 'unauthorized'],
    [{ action: 'settings.get', key: KEYS[0] }, { badBody: true }, 401, 'unauthorized'],
    [{ action: 'settings.get', key: KEYS[0] }, { unknownKey: true }, 401, 'unauthorized'],
  ];
  for (const [body, options, status, code] of cases) {
    const r = await send(body, options);
    check(r.status === status && r.json?.error?.code === code, 'negative.control');
  }
}

let exit = 2, cleanupResult = 'not-started', failed = false;
try {
  preflight(); await acquire();
  if (mode === 'recover') {
    stage = 'recovery'; state = await load();
    await cleanup(); cleanupResult = 'exact-prestate-verified'; exit = 0;
  } else {
    try { await lstat(journal); throw new ProofError('journal.recovery-required'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    stage = 'capture';
    const pre = [await read(0), await read(1)];
    state = { version: 2, runtime: RUNTIME, source: process.env.PROOF_SOURCE_SHA, endpoint: url.href,
      run: randomUUID(), entries: KEYS.map((key, i) => ({ key, pre: pre[i], phase: 'captured',
        writeId: randomUUID(), restoreId: randomUUID() })) };
    await guard();
    stage = 'negative'; await negatives();
    await save();
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { interrupted = true; });
    try {
      for (let i = 0; i < 2; i++) {
        stage = 'mutation'; check(!interrupted, 'interrupted'); await guard();
        state.entries[i].phase = 'writePending'; state.entries[i].writeAt = Date.now(); await save();
        await write(i);
        state.entries[i].phase = 'written'; await save();
        stage = 'roundtrip'; await readEquals(i, fixture(i));
      }
    } catch (e) { failed = true; noteFailure(e); }
    finally {
      stage = 'cleanup';
      try { await cleanup(); cleanupResult = 'exact-prestate-verified'; }
      catch (e) { cleanupResult = 'recovery-required'; failed = true; noteFailure(e); }
    }
    exit = failed || uncertain || interrupted ? 1 : 0;
  }
} catch (e) {
  noteFailure(e);
  if (state?.entries.some((e) => e.phase !== 'captured')) { exit = 1; cleanupResult = 'recovery-required'; }
  // Deliberately do not print exception text, stack, URL, response, or journal.
} finally {
  if (lockOwned) await unlink(lock).catch(() => { exit = 1; });
}
console.log(JSON.stringify({
  verdict: exit === 0 ? (mode === 'recover' ? 'RECOVERED' : 'PROOF PASS') : exit === 2 ? 'REFUSED' : 'PROOF FAIL',
  stage, runtime: RUNTIME, proofSource: process.env.PROOF_SOURCE_SHA?.match(/^[a-f0-9]{40}$/)?.[0] ?? null,
  preState: state?.entries.map((e) => ({ key: e.key, hadRow: e.pre.source === 'store' })) ?? null,
  cleanup: cleanupResult, responseUncertainty: uncertain, failure,
  note: 'Requires exclusive staging writers; no website non-admin or full-runtime acceptance claim.',
}));
process.exitCode = exit;
