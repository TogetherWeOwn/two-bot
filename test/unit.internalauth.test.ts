/**
 * The parts of the internal actions endpoint that have nothing to do with HTTP:
 * the signature, the freshness window, the replay cache, the token buckets,
 * the bind guard and the error table.
 *
 * These are unit-tested separately from the endpoint because they are where a
 * quiet mistake is most expensive - a compare that is not constant time, or a
 * nonce cache that forgets early, does not fail visibly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyRing, canonicalString, parseKeys, sign, signaturesMatch } from '../src/internal/signing.ts';
import { NonceCache, withinSkew } from '../src/internal/nonce.ts';
import { ADD_MEMBER_BUCKET, DEFAULT_BUCKET, TokenBuckets } from '../src/internal/rateLimit.ts';
import { assertPrivateBind, isPrivateAddress } from '../src/internal/bind.ts';
import { retryableFor, statusFor, type ErrorCode } from '../src/internal/errors.ts';
import { buildRoleKeys } from '../src/internal/actions.ts';

const SECRET = 'a'.repeat(48);

test('canonical string is exactly the five documented lines', () => {
  const raw = Buffer.from('{"action":"role.assign"}');
  const canonical = canonicalString('1787173135', 'f'.repeat(32), raw);
  const lines = canonical.split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'POST');
  assert.equal(lines[1], '/internal/actions');
  assert.equal(lines[2], '1787173135');
  assert.equal(lines[3], 'f'.repeat(32));
  assert.match(lines[4], /^[0-9a-f]{64}$/);
});

test('signature covers the body bytes, the timestamp and the nonce', () => {
  const raw = Buffer.from('{"a":1}');
  const base = sign(SECRET, '100', 'a'.repeat(32), raw);
  assert.notEqual(base, sign(SECRET, '101', 'a'.repeat(32), raw));
  assert.notEqual(base, sign(SECRET, '100', 'b'.repeat(32), raw));
  assert.notEqual(base, sign(SECRET, '100', 'a'.repeat(32), Buffer.from('{"a":2}')));
  assert.notEqual(base, sign('b'.repeat(48), '100', 'a'.repeat(32), raw));
  assert.match(base, /^sha256=[0-9a-f]{64}$/);
});

test('signaturesMatch survives a length mismatch instead of throwing', () => {
  // timingSafeEqual throws on unequal lengths; a throw here would surface as a
  // 500 for anyone who sent a truncated header.
  assert.equal(signaturesMatch('sha256=abc', 'sha256=abcdef'), false);
  assert.equal(signaturesMatch('sha256=abc', 'sha256=abc'), true);
});

test('a wrong signature and an unknown key id are the same boolean', () => {
  const ring = new KeyRing([{ id: 'web-prod', secret: SECRET }]);
  const raw = Buffer.from('{"action":"role.assign"}');
  const good = sign(SECRET, '100', 'c'.repeat(32), raw);

  assert.equal(ring.verify('web-prod', good, '100', 'c'.repeat(32), raw), true);
  assert.equal(ring.verify('web-prod', good.replace(/.$/, '0'), '100', 'c'.repeat(32), raw), false);
  // Correctly signed, but with a key id we have never heard of.
  assert.equal(ring.verify('web-staging', good, '100', 'c'.repeat(32), raw), false);
});

test('parseKeys rejects config that would present as intermittent 401s', () => {
  assert.deepEqual(parseKeys(` web-prod:${SECRET} `), [{ id: 'web-prod', secret: SECRET }]);
  // A secret containing a colon survives - we split on the first one only.
  assert.deepEqual(parseKeys(`web:${'x'.repeat(20)}:${'y'.repeat(20)}`), [
    { id: 'web', secret: `${'x'.repeat(20)}:${'y'.repeat(20)}` },
  ]);
  assert.deepEqual(parseKeys(''), []);
  assert.throws(() => parseKeys('web-prod'), /key-id:secret/);
  assert.throws(() => parseKeys('web-prod:short'), /shorter than 32/);
});

test('skew window is ±120 seconds and a non-numeric timestamp is not fresh', () => {
  const now = 1_787_173_135_000;
  assert.equal(withinSkew(String(now / 1000), 120, now), true);
  assert.equal(withinSkew(String(now / 1000 - 119), 120, now), true);
  assert.equal(withinSkew(String(now / 1000 - 121), 120, now), false);
  assert.equal(withinSkew(String(now / 1000 + 121), 120, now), false);
  assert.equal(withinSkew('not-a-number', 120, now), false);
  assert.equal(withinSkew('', 120, now), false);
  // Milliseconds instead of seconds is the mistake a caller actually makes.
  assert.equal(withinSkew(String(now), 120, now), false);
});

test('a nonce is remembered for 240s and forgotten after', () => {
  let t = 1_000_000;
  const cache = new NonceCache({ ttlSeconds: 240, now: () => t });

  assert.equal(cache.offer('n1'), true);
  assert.equal(cache.offer('n1'), false, 'immediate repeat is a replay');

  t += 239_000;
  assert.equal(cache.offer('n1'), false, 'still inside the window');

  t += 2_000;
  assert.equal(cache.offer('n1'), true, 'outside the window, and the entry is gone');
});

test('the nonce cache sweeps itself instead of growing forever', () => {
  let t = 0;
  const cache = new NonceCache({ ttlSeconds: 240, now: () => t });
  for (let i = 0; i < 500; i++) {
    t += 1_000;
    cache.offer(`n${i}`);
  }
  // 240s of traffic at one per second, not 500 entries.
  assert.ok(cache.size <= 241, `cache grew to ${cache.size}`);
});

test('token bucket gives the burst, then the sustained rate, with Retry-After', () => {
  let t = 0;
  const buckets = new TokenBuckets({ now: () => t });

  for (let i = 0; i < DEFAULT_BUCKET.capacity; i++) {
    assert.equal(buckets.take('web-prod', DEFAULT_BUCKET).allowed, true, `burst request ${i}`);
  }
  const denied = buckets.take('web-prod', DEFAULT_BUCKET);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfter >= 1, 'Retry-After of 0 would invite a hot loop');

  // A second key id has its own bucket.
  assert.equal(buckets.take('web-staging', DEFAULT_BUCKET).allowed, true);

  t += 1_000;
  assert.equal(buckets.take('web-prod', DEFAULT_BUCKET).allowed, true, 'one token per second');
});

test('guild.add_member gets the tighter bucket', () => {
  let t = 0;
  const buckets = new TokenBuckets({ now: () => t });
  for (let i = 0; i < ADD_MEMBER_BUCKET.capacity; i++) {
    assert.equal(buckets.take('k', ADD_MEMBER_BUCKET).allowed, true);
  }
  assert.equal(buckets.take('k', ADD_MEMBER_BUCKET).allowed, false);
  t += 1_000;
  // 30/minute is half a token per second, so a single second is not enough.
  assert.equal(buckets.take('k', ADD_MEMBER_BUCKET).allowed, false);
  t += 1_000;
  assert.equal(buckets.take('k', ADD_MEMBER_BUCKET).allowed, true);
});

test('the bind guard knows private from public', () => {
  for (const addr of ['127.0.0.1', '10.4.1.9', '192.168.1.20', '172.16.0.1', '172.31.255.255', '::1', 'fd00::5', '100.64.0.1']) {
    assert.equal(isPrivateAddress(addr), true, `${addr} should be private`);
  }
  for (const addr of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.10', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(addr), false, `${addr} should be public`);
  }
});

test('binding to a public or wildcard address is a startup crash', () => {
  assert.doesNotThrow(() => assertPrivateBind('127.0.0.1'));
  assert.doesNotThrow(() => assertPrivateBind('10.0.0.5'));
  // The actual mistake: 0.0.0.0 looks local in a config file and is not.
  assert.throws(() => assertPrivateBind('0.0.0.0'), /wildcard/);
  assert.throws(() => assertPrivateBind('::'), /wildcard/);
  assert.throws(() => assertPrivateBind(''), /wildcard/);
  assert.throws(() => assertPrivateBind('203.0.113.10'), /public address/);
});

test('every error code has the status and retryable flag the spec published', () => {
  const table: [ErrorCode, number, boolean][] = [
    ['malformed', 400, false],
    ['unauthorized', 401, false],
    ['stale_request', 401, false],
    ['action_not_allowed', 403, false],
    ['replayed', 409, false],
    ['discord_rejected', 422, false],
    ['rate_limited', 429, true],
    ['internal', 500, true],
    ['discord_unavailable', 502, true],
    ['upstream_timeout', 504, true],
  ];
  for (const [code, status, retryable] of table) {
    assert.equal(statusFor(code), status, `${code} status`);
    assert.equal(retryableFor(code), retryable, `${code} retryable`);
  }
});

test('the role-key map starts from the self-assignable roles only', () => {
  const map = buildRoleKeys();
  // Keys a member can already pick for themselves in the onboarding menu, so
  // handing them to the website grants no privilege that did not exist.
  assert.equal(map.get('rocketleague'), '1065438504521322526');
  assert.equal(map.get('pc'), '1092247753574330458');
  assert.equal(map.has('admin'), false);

  const extended = buildRoleKeys('member:1078755185423286372');
  assert.equal(extended.get('member'), '1078755185423286372');
  assert.throws(() => buildRoleKeys('member:not-a-snowflake'), /role-key/);
});
