/**
 * Replay guard. docs/INTERNAL_ACTIONS.md §1.
 *
 * A nonce is remembered for 240 seconds - twice the ±120s skew window - so a
 * request that is still fresh enough to be accepted is still recent enough to
 * be recognised as a repeat.
 *
 * KNOWN LIMIT, carried forward from TWO-59: this cache is in-process. A bot
 * restart forgets every nonce and re-opens a replay window of up to 240
 * seconds. That is survivable only because the two actions shipping in this
 * slice - role.assign and guild.add_member - are naturally idempotent, so a
 * replay is a no-op at Discord. It must be backed by a table before
 * announcement.post or event.upsert ship (TWO-18 -> TWO-24). Do not widen the
 * allowlist while this is still in memory.
 */

export interface NonceCacheOptions {
  ttlSeconds?: number;
  /** Injectable clock, milliseconds. Tests use it to age entries. */
  now?: () => number;
}

export class NonceCache {
  private seen = new Map<string, number>();
  private ttlMs: number;
  private now: () => number;

  constructor(opts: NonceCacheOptions = {}) {
    this.ttlMs = (opts.ttlSeconds ?? 240) * 1000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record a nonce. Returns false if it was already present and still live,
   * which is a replay. Check-and-insert is one call on purpose: two callers
   * doing "check then insert" would race.
   */
  offer(nonce: string): boolean {
    const t = this.now();
    this.sweep(t);
    const prev = this.seen.get(nonce);
    if (prev !== undefined && t - prev < this.ttlMs) return false;
    this.seen.set(nonce, t);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  /**
   * Drop expired entries. Called on every offer, so the map stays bounded by
   * the request rate over 240s rather than growing forever. At the endpoint's
   * own rate limit that ceiling is a few hundred entries.
   */
  private sweep(t: number): void {
    for (const [nonce, at] of this.seen) {
      if (t - at >= this.ttlMs) this.seen.delete(nonce);
    }
  }
}

/**
 * Is this timestamp inside the skew window? `timestamp` is unix *seconds* as
 * sent; a non-numeric value is not fresh.
 */
export function withinSkew(timestamp: string, skewSeconds = 120, nowMs = Date.now()): boolean {
  if (!/^\d{1,15}$/.test(timestamp)) return false;
  const delta = Math.abs(nowMs / 1000 - Number(timestamp));
  return delta <= skewSeconds;
}
