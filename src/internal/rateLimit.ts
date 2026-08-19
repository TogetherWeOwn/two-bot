/**
 * Per-key token buckets. docs/INTERNAL_ACTIONS.md §1.
 *
 * 60 requests/minute sustained with a burst of 20, and a tighter 30/minute on
 * guild.add_member. The point is not to punish the website; it is that a loop
 * bug over there should cost us an annoying afternoon rather than get our bot
 * rate-limited or flagged by Discord.
 *
 * Buckets are keyed after the signature verifies, never before. Rate-limiting
 * an unverified key id would let anyone who can reach the private interface
 * lock out a legitimate caller by spamming its key id.
 */

export interface BucketSpec {
  /** Tokens the bucket holds - the burst. */
  capacity: number;
  /** Tokens added per second - the sustained rate. */
  refillPerSecond: number;
}

export const DEFAULT_BUCKET: BucketSpec = { capacity: 20, refillPerSecond: 1 };
/** 30/minute, with a burst of 10 so a handful of simultaneous signups pass. */
export const ADD_MEMBER_BUCKET: BucketSpec = { capacity: 10, refillPerSecond: 0.5 };

export interface Decision {
  allowed: boolean;
  /** Seconds until one token is available. Only meaningful when denied. */
  retryAfter: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBuckets {
  private buckets = new Map<string, Bucket>();
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Take one token from `key`'s bucket, creating it full on first use. */
  take(key: string, spec: BucketSpec): Decision {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: spec.capacity, updatedAt: t };
    const elapsed = Math.max(0, (t - b.updatedAt) / 1000);
    b.tokens = Math.min(spec.capacity, b.tokens + elapsed * spec.refillPerSecond);
    b.updatedAt = t;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { allowed: true, retryAfter: 0 };
    }
    this.buckets.set(key, b);
    // Round up, and never advertise 0 - a Retry-After of 0 invites a hot loop.
    const wait = Math.ceil((1 - b.tokens) / spec.refillPerSecond);
    return { allowed: false, retryAfter: Math.max(1, wait) };
  }
}
