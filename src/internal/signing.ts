/**
 * HMAC verification for the internal actions endpoint.
 * docs/INTERNAL_ACTIONS.md §1.
 *
 *   canonical = "POST\n/internal/actions\n{timestamp}\n{nonce}\n{sha256_hex(raw_body)}"
 *   signature = "sha256=" + hex(hmac_sha256(shared_secret, canonical))
 *
 * We sign a hash of the body rather than the body, so the canonical string is
 * short and there is no argument about encoding or key order. Verification
 * runs over the raw bytes we received - the body is never re-serialised
 * between here and the signature check.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ACTIONS_PATH = '/internal/actions';

/** One caller. `id` is the value of X-TWO-Key-Id; secrets rotate per caller. */
export interface SigningKey {
  id: string;
  secret: string;
}

export function bodyHash(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function canonicalString(timestamp: string, nonce: string, raw: Buffer): string {
  return ['POST', ACTIONS_PATH, timestamp, nonce, bodyHash(raw)].join('\n');
}

export function sign(secret: string, timestamp: string, nonce: string, raw: Buffer): string {
  const mac = createHmac('sha256', secret).update(canonicalString(timestamp, nonce, raw)).digest('hex');
  return `sha256=${mac}`;
}

/**
 * Constant-time compare of two `sha256=<hex>` strings.
 *
 * timingSafeEqual throws on a length mismatch, which would itself be a timing
 * signal, so unequal lengths are compared against a same-length dummy first.
 */
export function signaturesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * A secret used when the key id is unknown.
 *
 * We still compute a full HMAC against it so an unknown key id costs the same
 * work as a wrong signature. Combined with the shared AUTH_FAILURE_MESSAGE,
 * an attacker learns nothing about which key ids exist.
 */
const DECOY_SECRET = 'unknown-key-id-decoy';

export class KeyRing {
  private keys: Map<string, string>;

  constructor(keys: SigningKey[]) {
    this.keys = new Map(keys.map((k) => [k.id, k.secret]));
  }

  get size(): number {
    return this.keys.size;
  }

  has(id: string): boolean {
    return this.keys.has(id);
  }

  /**
   * True only for a known key id whose signature verifies. The caller gets one
   * boolean and no way to tell the two failures apart.
   */
  verify(keyId: string, signature: string, timestamp: string, nonce: string, raw: Buffer): boolean {
    const secret = this.keys.get(keyId);
    const expected = sign(secret ?? DECOY_SECRET, timestamp, nonce, raw);
    const matched = signaturesMatch(expected, signature);
    return secret !== undefined && matched;
  }
}

/**
 * Parse TWO_INTERNAL_KEYS: `id:secret,id:secret`.
 *
 * Secrets can contain anything except a comma, so we split on the first colon
 * only. An entry without a colon is a config mistake and is rejected loudly -
 * silently dropping a key id would present as intermittent 401s later.
 */
export function parseKeys(spec: string): SigningKey[] {
  const out: SigningKey[] = [];
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = entry.indexOf(':');
    const id = at === -1 ? '' : entry.slice(0, at).trim();
    const secret = at === -1 ? '' : entry.slice(at + 1).trim();
    if (!id || !secret) {
      throw new Error('TWO_INTERNAL_KEYS entries must be "key-id:secret". See docs/SECRETS.md.');
    }
    if (secret.length < 32) {
      throw new Error(`TWO_INTERNAL_KEYS: secret for "${id}" is shorter than 32 characters.`);
    }
    out.push({ id, secret });
  }
  return out;
}
