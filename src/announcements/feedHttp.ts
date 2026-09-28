import { lookup as dnsLookup, type LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher } from 'undici';

const MAX_FEED_BYTES = 2_000_000;
const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedIpv4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['100:0:0:1::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blockedIpv6.addSubnet(network, prefix, 'ipv6');

export type FeedLookup = typeof dnsLookup;

export function isPublicAddress(address: string): boolean {
  const normalized = address.split('%')[0] ?? '';
  const family = isIP(normalized);
  if (family === 4) return !blockedIpv4.check(normalized, 'ipv4');
  if (family === 6) return !blockedIpv6.check(normalized, 'ipv6');
  return false;
}

export async function assertPublicHostname(hostname: string, lookup: FeedLookup = dnsLookup): Promise<void> {
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal)) {
    if (!isPublicAddress(literal)) throw new Error('Feed source must resolve only to public IP addresses.');
    return;
  }
  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (error, found) => {
      if (error) reject(error);
      else resolve(found as Array<{ address: string; family: number }>);
    });
  });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Feed source must resolve only to public IP addresses.');
  }
}

export function createPublicLookup(lookup: FeedLookup = dnsLookup): FeedLookup {
  return ((hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void) => {
    lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      const publicAddresses = addresses.filter(({ address }) => isPublicAddress(address));
      if (publicAddresses.length !== addresses.length || publicAddresses.length === 0) {
        return callback(new Error('Feed source resolved to a non-public IP address.'));
      }
      if (options.all) callback(null, publicAddresses);
      else {
        const selected = publicAddresses[0];
        callback(null, selected?.address ?? '', selected?.family ?? 0);
      }
    });
  }) as FeedLookup;
}

export interface FeedResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
}

/**
 * Redirect policy for feed fetching.
 *
 * Legitimate feeds move: http→https upgrades, trailing-slash and path
 * normalization on the same host. The fetcher passes `redirect: 'manual'`
 * to undici and follows those same-host hops itself (bounded), instead of
 * the previous `redirect: 'error'` which hard-failed every poll of a moved
 * feed. Auto-follow is not used because it would resolve and connect to
 * redirect targets outside the SSRF gate.
 *
 * Followed: same-host redirects that keep or upgrade the scheme
 * (http→https, https→https, http→http), up to MAX_REDIRECT_HOPS hops.
 * Refused with FeedRedirectError: cross-host targets (including www
 * additions), scheme downgrades (https→http), non-HTTP(S) schemes,
 * embedded credentials, missing/invalid Location, and hop overflow.
 * Refusals carry a stable `Feed redirect refused:` message prefix so the
 * `feed.poll` audit `reason` distinguishes them from fetch failures.
 *
 * SSRF guard: unchanged. `assertPublicHostname` gates the initial URL and
 * every redirect target with the injected lookup, and the undici connector
 * re-checks at connect time against DNS-rebinding races.
 */
const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export class FeedRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedRedirectError';
  }
}

export class PublicFeedFetcher {
  private lookup: FeedLookup;
  private fetchImpl: typeof undiciFetch;

  constructor(lookup: FeedLookup = dnsLookup, fetchImpl: typeof undiciFetch = undiciFetch) {
    this.lookup = lookup;
    this.fetchImpl = fetchImpl;
  }

  async read(source: string, signal: AbortSignal): Promise<FeedResponse> {
    let current = new URL(source);
    const connector = buildConnector({ lookup: createPublicLookup(this.lookup) });
    const dispatcher: Dispatcher = new Agent({ connect: connector, maxResponseSize: MAX_FEED_BYTES });
    try {
      for (let hop = 0; ; hop++) {
        await assertPublicHostname(current.hostname, this.lookup);
        const response = await this.fetchImpl(current, {
          headers: { 'User-Agent': 'Owen/1.0 (+https://two.gg)' },
          redirect: 'manual',
          signal,
          dispatcher,
        });
        if (!REDIRECT_STATUSES.has(response.status)) {
          return {
            ok: response.ok,
            status: response.status,
            headers: new Headers([...response.headers.entries()]),
            body: await readLimitedText(response as unknown as Response),
          };
        }
        try {
          await response.body?.cancel();
        } catch {
          // Redirect bodies carry nothing we need; ignore drain errors.
        }
        if (hop >= MAX_REDIRECT_HOPS) {
          throw new FeedRedirectError(
            `Feed redirect refused: too many redirects (over ${MAX_REDIRECT_HOPS} hops) from ${current}.`,
          );
        }
        current = resolveRedirectTarget(current, response.status, response.headers.get('location'));
      }
    } finally {
      await dispatcher.close();
    }
  }
}

function resolveRedirectTarget(current: URL, status: number, location: string | null): URL {
  if (!location) {
    throw new FeedRedirectError(
      `Feed redirect refused: HTTP ${status} from ${current} has no location.`,
    );
  }
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw new FeedRedirectError(
      `Feed redirect refused: invalid redirect location from ${current} (HTTP ${status}).`,
    );
  }
  if (target.username || target.password) {
    throw new FeedRedirectError(
      `Feed redirect refused: redirect target has embedded credentials (HTTP ${status}).`,
    );
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new FeedRedirectError(
      `Feed redirect refused: unsafe redirect scheme ${target.protocol} (HTTP ${status}).`,
    );
  }
  if (current.protocol === 'https:' && target.protocol !== 'https:') {
    throw new FeedRedirectError(
      `Feed redirect refused: scheme downgrade to ${target.protocol} (HTTP ${status}).`,
    );
  }
  if (target.hostname !== current.hostname) {
    throw new FeedRedirectError(
      `Feed redirect refused: cross-host redirect to ${target.origin} (HTTP ${status}).`,
    );
  }
  return target;
}

export async function readLimitedText(response: Response, maxBytes = MAX_FEED_BYTES): Promise<string> {
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) throw new Error('Feed is larger than 2 MB.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel('Feed is larger than 2 MB.');
        throw new Error('Feed is larger than 2 MB.');
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
