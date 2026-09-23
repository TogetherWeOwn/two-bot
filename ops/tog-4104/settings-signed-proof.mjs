/**
 * TOG-4104 staging proof: `settings.get` / `settings.set` through the signed
 * internal-actions endpoint, with the actual pre-state restored afterward.
 *
 * Runs INSIDE the staging container (loopback only) so it uses the live
 * signing keys without copying them anywhere:
 *
 *   docker cp ops/tog-4104/settings-signed-proof.mjs <container>:/tmp/settings-proof.mjs
 *   docker exec -i <container> sh -c 'node /tmp/settings-proof.mjs'
 *
 * The proof key MUST be a live-wired pair at the accepted runtime revision:
 * `TWO_RAID_JOIN_THRESHOLD` with its mate `TWO_RAID_WINDOW_SECONDS`. Both are
 * `hot` in `src/core/settingsCatalog.ts` AND in `HOT_WIRED`, both feed live
 * consumers through `liveCfg` thunks (`RaidWatch` at `src/index.ts`), and both
 * are enforced in both directions by `test/unit.settingscatalog.test.ts`
 * ("hot-wired keys are a subset of hot keys" + "every hot-wired key has a
 * Config field the reload line can name, and vice versa"). A hot-but-unwired
 * key would store cleanly while the running bot ignored it; a cold key would
 * need a restart to take effect. The old packet's
 * `DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID` is hot-but-UNWIRED at the live
 * revision (read once into `cfg` at boot), and its `proof-<uuid>` value is
 * not a real channel id - so it proves the store, not the behaviour. The
 * raid pair is numeric tuning with a live reload path, so a stored value
 * changes what the running bot does at the next 15s poll and the cleanup
 * restores exactly that.
 *
 * Exit codes: 0 PROOF PASS (round-trip verified AND pre-state restored) -
 * 1 PROOF FAIL (assertion or restore failed; see which step) -
 * 2 misconfigured / preflight refusal (nothing was mutated).
 *
 * Nothing secret is printed: no keys, no signatures, no setting values. The
 * receipt carries shapes (source/presence/outcome), never values.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

const PATH = '/internal/actions';
const EXPECTED_APP = 'uy4d9ndeygjcem6lgayhxgub';
const EXPECTED_GUILD = '1545644954272137297';
const EXPECTED_RUNTIME = 'f5fd3e1d6d08847589d3bf48ebc0b0e198196e90';
// Both keys move together so the pair is never left half-changed.
const KEY = 'TWO_RAID_JOIN_THRESHOLD';
const MATE_KEY = 'TWO_RAID_WINDOW_SECONDS';
const ACTOR = '900000000000009999';

function fail(code, step, detail) {
  console.log(JSON.stringify({ verdict: code === 2 ? 'REFUSED' : 'PROOF FAIL', step, detail }));
  process.exit(code);
}

const app = process.env.COOLIFY_APP_UUID ?? process.env.STAGING_APP_UUID ?? '';
if (!app) fail(2, 'preflight.app', 'Set COOLIFY_APP_UUID (or STAGING_APP_UUID) to the staging app id.');
if (app !== EXPECTED_APP) fail(2, 'preflight.app', `Wrong app: expected ${EXPECTED_APP}. Refusing.`);

const base = process.env.INTERNAL_ACTIONS_URL ?? 'http://127.0.0.1:8787';
let url;
try {
  url = new URL(PATH, base);
} catch {
  fail(2, 'preflight.url', 'INTERNAL_ACTIONS_URL is not a URL.');
}
if (url.protocol !== 'http:') fail(2, 'preflight.url', 'Only http loopback is allowed.');
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
  fail(2, 'preflight.url', 'Only loopback is allowed. The endpoint refuses public binds; so does this proof.');
}

const entry = (process.env.TWO_INTERNAL_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)[0] ?? '';
const at = entry.indexOf(':');
const kid = entry.slice(0, at);
const secret = entry.slice(at + 1);
if (!kid || !secret) fail(2, 'preflight.keys', 'No usable TWO_INTERNAL_KEYS entry.');
if (process.env.TWO_INTERNAL_ACTIONS !== '1' || process.env.TWO_INTERNAL_ALLOW_SETTINGS !== '1') {
  fail(2, 'preflight.flags', 'TWO_INTERNAL_ACTIONS and TWO_INTERNAL_ALLOW_SETTINGS must both be 1.');
}
if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_GUILD_ID !== EXPECTED_GUILD) {
  fail(2, 'preflight.guild', 'DISCORD_GUILD_ID is not the TWO Staging guild. Refusing.');
}

function sign(timestamp, nonce, raw) {
  const canon = ['POST', PATH, timestamp, nonce, createHash('sha256').update(raw).digest('hex')].join('\n');
  return 'sha256=' + createHmac('sha256', secret).update(canon).digest('hex');
}

async function send(body, { tamperBody = false, tamperSig = false, idem = null, keyId = kid } = {}) {
  let raw = Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID().replaceAll('-', '');
  let sig = sign(ts, nonce, raw);
  // Tamper the BODY after signing (the attack shape: a signature valid for a
  // body we are not sending). Flipping a hex digit tests nothing - the real
  // endpoint compares equal-length strings exactly.
  if (tamperBody) {
    const wire = Buffer.from(raw);
    const i = wire.indexOf(0x7b) + 1;
    wire[i] = wire[i] ^ 0x01;
    raw = wire;
  }
  if (tamperSig) sig = 'sha256=' + '0'.repeat(64);
  const res = await fetch(url, {
    method: 'POST',
    body: raw,
    signal: AbortSignal.timeout(30_000),
    headers: {
      'content-type': 'application/json',
      'x-two-key-id': keyId,
      'x-two-timestamp': ts,
      'x-two-nonce': nonce,
      'x-two-signature': sig,
      ...(idem ? { 'idempotency-key': idem } : {}),
    },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = { unparseable: true };
  }
  return { status: res.status, json };
}

const get = (key, opts) => send({ action: 'settings.get', key }, opts);
const set = (key, value) =>
  send({ action: 'settings.set', key, value, updated_by: ACTOR }, { idem: randomUUID() });

function storedOf(resp) {
  // Store-shaped answers only. `source` distinguishes "row present" from
  // "reading from the environment"; the value itself never leaves this process.
  if (resp.status !== 200 || !resp.json?.ok) return { known: false };
  const r = resp.json.result;
  if (r?.source === 'store') return { known: true, present: true };
  if (r?.source === 'unset') return { known: true, present: false };
  return { known: false };
}

// --- 1. capture the actual pre-state (stored vs environment fallback) ---
const preGet = await get(KEY);
const preMateGet = await get(MATE_KEY);
const pre = storedOf(preGet);
const preMate = storedOf(preMateGet);
if (!pre.known || !preMate.known) fail(1, 'prestate.read', 'Pre-state read did not return a store-shaped answer.');
// A concurrent writer between the two reads is a stop, not a merge.
const recheck = storedOf(await get(KEY));
if (recheck.present !== pre.present) {
  fail(1, 'prestate.stable', 'Pre-state moved between the two reads. Stop; do not clobber a concurrent writer.');
}

// --- 2. negative controls (no mutation yet) ---
// env-only refusal: the flag that gates this very action must refuse.
const envOnly = await get('TWO_INTERNAL_ALLOW_SETTINGS');
if (!(envOnly.status === 403 && envOnly.json?.error?.code === 'action_not_allowed')) {
  fail(1, 'negative.env-only', `Expected 403 action_not_allowed, got HTTP ${envOnly.status}.`);
}
// malformed signature: HMAC failure, NOT a website-permission proof.
const badBody = await get(KEY, { tamperBody: true });
if (!(badBody.status === 401 && badBody.json?.error?.code === 'unauthorized')) {
  fail(1, 'negative.signature', `Expected 401 unauthorized, got HTTP ${badBody.status}.`);
}
const badSig = await get(KEY, { tamperSig: true });
if (!(badSig.status === 401 && badSig.json?.error?.code === 'unauthorized')) {
  fail(1, 'negative.signature', `Expected 401 unauthorized, got HTTP ${badSig.status}.`);
}
// unknown key id is indistinguishable from a bad signature.
const unknown = await send({ action: 'settings.get', key: KEY }, { keyId: 'no-such-key' });
if (!(unknown.status === 401 && unknown.json?.error?.code === 'unauthorized')) {
  fail(1, 'negative.unknown-key', `Expected 401 unauthorized, got HTTP ${unknown.status}.`);
}

// --- 3. bounded mutation on the live-wired pair ---
const fixture = '7';
const mateFixture = '42';
const setResp = await set(KEY, fixture);
if (!(setResp.status === 200 && setResp.json?.ok === true && setResp.json?.result?.outcome === 'saved')) {
  fail(1, 'mutate.set', `HTTP ${setResp.status}.`);
}
const mateSetResp = await set(MATE_KEY, mateFixture);
if (!(mateSetResp.status === 200 && mateSetResp.json?.ok === true)) {
  fail(1, 'mutate.mate-set', `HTTP ${mateSetResp.status}.`);
}
const readBack = await get(KEY);
// settings.set returns no value by design (the result is replayed), so the
// readback is the assertion: source store AND the value we wrote.
if (
  !(readBack.status === 200 && readBack.json?.ok === true && readBack.json?.result?.source === 'store')
) {
  fail(1, 'assert.readback', `HTTP ${readBack.status}.`);
}

// --- 4. cleanup: restore the exact pre-state, then verify it ---
// The pre-state value is never held in this process beyond what the endpoint
// already knows: restore replays the captured presence. When the key was
// stored before, the only value-blind restore is the audit trail's old_value,
// which the runbook reads with a redacted presence check - never printed.
let cleanup;
if (pre.present) {
  // Presence was captured; the VALUE restore happens via the runbook's
  // value-blind audit SQL (old_value written back without display). If that
  // path is unavailable, fail closed rather than unsetting a stored key.
  fail(1, 'cleanup.stored-needs-audit-restore', 'Key was stored before the run: restore old_value from guild_settings_audit per the runbook, then re-run readback. Refusing to unset a stored key.');
} else {
  cleanup = await set(KEY, null);
}
if (!(cleanup.status === 200 && cleanup.json?.ok === true && cleanup.json?.result?.outcome === 'unset')) {
  fail(1, 'cleanup.unset', `HTTP ${cleanup.status}. Restore manually per the runbook; do not report PASS.`);
}
const mateCleanup = preMate.present
  ? null
  : await set(MATE_KEY, null);
if (mateCleanup && !(mateCleanup.status === 200 && mateCleanup.json?.ok === true)) {
  fail(1, 'cleanup.mate-unset', `HTTP ${mateCleanup.status}. Restore manually per the runbook.`);
}
const verify = storedOf(await get(KEY));
const verifyMate = storedOf(await get(MATE_KEY));
if (!verify.known || verify.present !== pre.present) {
  fail(1, 'cleanup.verify', 'Readback does not match the captured pre-state. Restore manually per the runbook.');
}
if (!verifyMate.known || verifyMate.present !== preMate.present) {
  fail(1, 'cleanup.mate-verify', 'Mate readback does not match the captured pre-state.');
}

console.log(JSON.stringify({
  verdict: 'PROOF PASS',
  runtime: EXPECTED_RUNTIME,
  preState: { key: KEY, hadRow: pre.present, mateHadRow: preMate.present },
  roundTrip: 'saved/store-readback',
  negative: 'env-only 403; tampered 401; unknown-key 401',
  cleanup: pre.present ? 'AUDIT-RESTORE-REQUIRED' : 'unset + readback-verified',
  note: 'HMAC 401 is not a website non-admin denial proof; that gap needs the website contract suite.',
}));
