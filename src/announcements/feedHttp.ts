import { lookup as dnsLookup } from 'node:dns';
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
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
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

export interface FeedResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
}

export class PublicFeedFetcher {
  private lookup: FeedLookup;

  constructor(lookup: FeedLookup = dnsLookup) {
    this.lookup = lookup;
  }

  async read(source: string, signal: AbortSignal): Promise<FeedResponse> {
    const url = new URL(source);
    await assertPublicHostname(url.hostname, this.lookup);
    const connector = buildConnector({
      lookup: (hostname, options, callback) => {
        this.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error, null as never);
          const publicAddresses = addresses.filter(({ address }) => isPublicAddress(address));
          if (publicAddresses.length !== addresses.length || publicAddresses.length === 0) {
            return callback(new Error('Feed source resolved to a non-public IP address.'), null as never);
          }
          const selected = publicAddresses[0];
          callback(null, selected?.address ?? '', selected?.family ?? 0);
        });
      },
    });
    const dispatcher: Dispatcher = new Agent({ connect: connector, maxResponseSize: MAX_FEED_BYTES });
    try {
      const response = await undiciFetch(url, {
        headers: { 'User-Agent': 'Owen/1.0 (+https://two.gg)' },
        redirect: 'error',
        signal,
        dispatcher,
      });
      return {
        ok: response.ok,
        status: response.status,
        headers: new Headers([...response.headers.entries()]),
        body: await readLimitedText(response as unknown as Response),
      };
    } finally {
      await dispatcher.close();
    }
  }
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
