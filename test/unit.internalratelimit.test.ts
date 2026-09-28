import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADD_MEMBER_BUCKET, DEFAULT_BUCKET, TokenBuckets } from '../src/internal/rateLimit.ts';
import { discordRetryAfterMs } from '../src/discord/rateLimit.ts';

test('first use creates a full bucket and allows with zero retry-after', () => {
  const buckets = new TokenBuckets({ now: () => 0 });
  const decision = buckets.take('new-key', DEFAULT_BUCKET);
  assert.equal(decision.allowed, true);
  assert.equal(decision.retryAfter, 0);
});

test('denial never advertises a zero retry-after (no hot loop)', () => {
  let t = 0;
  const buckets = new TokenBuckets({ now: () => t });
  for (let i = 0; i < DEFAULT_BUCKET.capacity; i++) buckets.take('k', DEFAULT_BUCKET);
  const denied = buckets.take('k', DEFAULT_BUCKET);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfter >= 1, `retryAfter was ${denied.retryAfter}`);
});

test('default bucket denies with retry-after of 1s at 1 token/sec', () => {
  let t = 0;
  const buckets = new TokenBuckets({ now: () => t });
  for (let i = 0; i < DEFAULT_BUCKET.capacity; i++) buckets.take('k', DEFAULT_BUCKET);
  assert.equal(buckets.take('k', DEFAULT_BUCKET).retryAfter, 1);
});

test('add-member bucket denies with retry-after of 2s at 0.5 tokens/sec', () => {
  let t = 0;
  const buckets = new TokenBuckets({ now: () => t });
  for (let i = 0; i < ADD_MEMBER_BUCKET.capacity; i++) buckets.take('k', ADD_MEMBER_BUCKET);
  const denied = buckets.take('k', ADD_MEMBER_BUCKET);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 2);
});

test('partial refill below one token stays denied, a full second re-allows', () => {
  let t = 0;
  const buckets = new TokenBuckets({ now: () => t });
  for (let i = 0; i < DEFAULT_BUCKET.capacity; i++) buckets.take('k', DEFAULT_BUCKET);
  assert.equal(buckets.take('k', DEFAULT_BUCKET).allowed, false);

  t += 500;
  assert.equal(buckets.take('k', DEFAULT_BUCKET).allowed, false, 'half a token is not enough');

  t += 500;
  assert.equal(buckets.take('k', DEFAULT_BUCKET).allowed, true, 'one token per second');
});

test('long idle restores the full burst', () => {
  let t = 0;
  const buckets = new TokenBuckets({ now: () => t });
  for (let i = 0; i < DEFAULT_BUCKET.capacity; i++) buckets.take('k', DEFAULT_BUCKET);
  assert.equal(buckets.take('k', DEFAULT_BUCKET).allowed, false);

  t += 60_000;
  for (let i = 0; i < DEFAULT_BUCKET.capacity; i++) {
    assert.equal(buckets.take('k', DEFAULT_BUCKET).allowed, true, `burst request ${i} after idle`);
  }
  assert.equal(buckets.take('k', DEFAULT_BUCKET).allowed, false);
});

test('buckets are isolated per key', () => {
  let t = 0;
  const buckets = new TokenBuckets({ now: () => t });
  for (let i = 0; i < DEFAULT_BUCKET.capacity; i++) buckets.take('drained', DEFAULT_BUCKET);
  assert.equal(buckets.take('drained', DEFAULT_BUCKET).allowed, false);
  assert.equal(buckets.take('fresh', DEFAULT_BUCKET).allowed, true);
});

test('clock moving backwards grants no extra tokens', () => {
  let t = 10_000;
  const buckets = new TokenBuckets({ now: () => t });
  for (let i = 0; i < DEFAULT_BUCKET.capacity; i++) buckets.take('k', DEFAULT_BUCKET);
  assert.equal(buckets.take('k', DEFAULT_BUCKET).allowed, false);

  t = 0;
  assert.equal(buckets.take('k', DEFAULT_BUCKET).allowed, false, 'negative elapsed must clamp to 0');
});

test('bucket specs pin the documented rates', () => {
  assert.deepEqual(DEFAULT_BUCKET, { capacity: 20, refillPerSecond: 1 });
  assert.deepEqual(ADD_MEMBER_BUCKET, { capacity: 10, refillPerSecond: 0.5 });
});

test('discordRetryAfterMs prefers a finite body retry_after over the header', () => {
  const headers = new Headers({ 'retry-after': '1' });
  assert.equal(discordRetryAfterMs(headers, { retry_after: 1.5 }, 30_000), 1750);
});

test('discordRetryAfterMs falls back to the header and clamps to the cap', () => {
  const headers = new Headers({ 'retry-after': '2' });
  assert.equal(discordRetryAfterMs(headers, { message: 'rate limited' }, 30_000), 2250);
  const huge = new Headers({ 'retry-after': '86400' });
  assert.equal(discordRetryAfterMs(huge, { retry_after: 86_400 }, 30_000), 30_000);
});

test('discordRetryAfterMs sanitizes missing, negative and non-finite delays', () => {
  assert.equal(discordRetryAfterMs(new Headers(), null, 30_000), 1250);
  assert.equal(discordRetryAfterMs(new Headers({ 'retry-after': '-5' }), null, 30_000), 1250);
  assert.equal(discordRetryAfterMs(new Headers({ 'retry-after': 'abc' }), null, 30_000), 1250);
  assert.equal(discordRetryAfterMs(new Headers(), { retry_after: Number.NaN }, 30_000), 1250);
});
