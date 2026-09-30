/**
 * Trusted-proxy client-IP resolution for the invite redirect (TOG-9924).
 *
 * Pure unit tests - no listener, no database. The server-level proof (two
 * visitors behind one proxy socket get two buckets; a spoofed header from an
 * untrusted socket buys nothing) lives in test/unit.redirectproxy.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRUSTED_PROXIES,
  createTrustedProxyChecker,
  parseTrustedProxyList,
  resolveClientIp,
} from '../src/redirect/clientIp.ts';

const loopbackOnly = createTrustedProxyChecker(DEFAULT_TRUSTED_PROXIES);

// --- allowlist parsing -------------------------------------------------------

test('the default allowlist is loopback only', () => {
  assert.ok(loopbackOnly('127.0.0.1'));
  assert.ok(loopbackOnly('127.0.0.2'));
  assert.ok(loopbackOnly('::1'));
  assert.ok(!loopbackOnly('203.0.113.7'));
  assert.ok(!loopbackOnly('10.0.0.1'));
});

test('parsing accepts IPs and CIDRs, comma-separated with whitespace', () => {
  assert.deepEqual(parseTrustedProxyList('127.0.0.1, 10.0.0.0/8'), ['127.0.0.1', '10.0.0.0/8']);
  assert.deepEqual(parseTrustedProxyList('  ::1/128  , 203.0.113.7 '), ['::1/128', '203.0.113.7']);
  assert.deepEqual(parseTrustedProxyList(''), []);
});

test('parsing refuses anything that is not an IP or CIDR, naming it', () => {
  for (const bad of ['example.com', '999.1.1.1', '10.0.0.0/33', '2001:db8::/129', '10.0.0.0/', '/24']) {
    assert.throws(() => parseTrustedProxyList(bad), /TWO_REDIRECT_TRUSTED_PROXIES|entry|prefix|IP/i, bad);
  }
});

// --- resolution --------------------------------------------------------------

test('an untrusted socket ignores X-Forwarded-For entirely', () => {
  // A client talking to us directly cannot self-exempt with a spoofed header.
  const untrusted = createTrustedProxyChecker([]);
  assert.equal(resolveClientIp('203.0.113.7', '198.51.100.9', untrusted), '203.0.113.7');
  assert.equal(resolveClientIp('203.0.113.7', '198.51.100.9, 203.0.113.7', untrusted), '203.0.113.7');
});

test('a trusted socket resolves to the leftmost untrusted hop', () => {
  // Single proxy: exactly the client IP it saw.
  assert.equal(resolveClientIp('127.0.0.1', '198.51.100.9', loopbackOnly), '198.51.100.9');
  // Chain: right-to-left walk past trusted hops stops at the first untrusted one.
  const checker = createTrustedProxyChecker(['127.0.0.0/8', '203.0.113.0/24']);
  assert.equal(
    resolveClientIp('127.0.0.1', '198.51.100.9, 203.0.113.5', checker),
    '198.51.100.9',
  );
  // A spoofed leftmost entry appended in front of a trusted chain still loses:
  // the walk stops at the first untrusted hop from the right, which is the
  // attacker's own address, not their forgery.
  assert.equal(
    resolveClientIp('127.0.0.1', '1.2.3.4, 198.51.100.9, 203.0.113.5', checker),
    '198.51.100.9',
  );
});

test('a trusted socket with no usable header falls back to the socket', () => {
  assert.equal(resolveClientIp('127.0.0.1', undefined, loopbackOnly), '127.0.0.1');
  assert.equal(resolveClientIp('127.0.0.1', '', loopbackOnly), '127.0.0.1');
  // Non-IP garbage in the header is skipped, never trusted.
  assert.equal(resolveClientIp('127.0.0.1', 'garbage', loopbackOnly), '127.0.0.1');
  // Every hop trusted (or nothing at all): the leftmost claim is the best answer.
  assert.equal(resolveClientIp('127.0.0.1', '203.0.113.5', createTrustedProxyChecker(['127.0.0.0/8', '203.0.113.0/24'])), '203.0.113.5');
});

test('IPv4-mapped IPv6 loopback matches a v4 allowlist entry', () => {
  assert.equal(resolveClientIp('::ffff:127.0.0.1', '198.51.100.9', loopbackOnly), '198.51.100.9');
});
