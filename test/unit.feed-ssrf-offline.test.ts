/**
 * TOG-9120: PublicFeedFetcher adversarial SSRF/cap suite.
 *
 * Hermetic by construction: stub DNS lookups (no `node:dns` call ever fires),
 * URL-keyed stub fetch (unknown URLs throw), and stubbed `ReadableStream`
 * sockets for the 2MB cap. The global fetch trap fails the run on any real
 * network call. No Postgres, no token:
 *
 *   env -u TWO_TEST_DATABASE_URL node --test test/unit.feed-ssrf-offline.test.ts
 *
 * What this pins that the sibling suites do not:
 * - the connect-time connector lookup (`createPublicLookup`) refuses a
 *   DNS-rebinding-shaped answer (resolution saw public, connect sees
 *   private), even though every `fetchImpl`-stubbed suite bypasses it;
 * - the SSRF table boundaries exactly (100.64/10 edges, all of ::ffff/96);
 * - the 2MB cap on announced and streamed bodies through `fetcher.read`,
 *   not just `readLimitedText` in isolation.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { lookup as dnsLookup } from 'node:dns';
import type { fetch as undiciFetch } from 'undici';
import {
  assertPublicHostname,
  createPublicLookup,
  isPublicAddress,
  PublicFeedFetcher,
  readLimitedText,
} from '../src/announcements/feedHttp.ts';

const PUBLIC_IP = '93.184.216.34';
const PRIVATE_IP = '10.0.0.1';
const CAP = 2_000_000;

// --- zero-live-call trap ---------------------------------------------------------

const fetchCalls: string[] = [];
let originalFetch: typeof fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`TOG-9120: offline suite attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

// --- stubs -----------------------------------------------------------------------

type LookupOptions = { all?: boolean };

function lookupFor(resolutions: Record<string, string[]> | (() => string[])): typeof dnsLookup {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const addresses = typeof resolutions === 'function' ? resolutions() : (resolutions[hostname] ?? [PUBLIC_IP]);
    const found = addresses.map((address) => ({ address, family: 4 }));
    if ((options as LookupOptions).all) callback(null, found);
    else callback(null, found[0]?.address ?? '', 4);
  }) as unknown as typeof dnsLookup;
}

function fetchStub(routes: Record<string, Response>, seen: string[]): typeof undiciFetch {
  return (async (input: unknown, init?: unknown) => {
    const url = String(input);
    seen.push(`${(init as { redirect?: unknown } | undefined)?.redirect ?? ''} ${url}`);
    const response = routes[url];
    if (!response) throw new Error(`TOG-9120: unstubbed fetch to ${url}`);
    return response;
  }) as unknown as typeof undiciFetch;
}

function chunkedStream(chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

function signal(): AbortSignal {
  return AbortSignal.timeout(5_000);
}

// --- SSRF table pins ---------------------------------------------------------------

test('SSRF table blocks every pinned private range', () => {
  for (const address of [
    // IPv4: loopback, RFC1918, link-local, metadata-adjacent, TEST-NET, multicast+.
    '0.0.0.5', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    // IPv6: unspecified, loopback, NAT64 wells, discard, documentation, 6to4,
    // 3fff discard, ORCHIDv2, ULA, link-local, multicast.
    '::', '::1', '64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b:1::a00:1',
    '100::1', '100:0:0:1::1', '2001::1', '2001:db8::1', '2002:0a00:0001::',
    '3fff::1', '5f00::1', 'fd00::1', 'fe80::1', 'ff02::1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of [
    '1.0.0.1', '8.8.8.8', PUBLIC_IP,
    '2606:2800:220:1:248:1893:25c8:1946', '2001:4860:4860::8888', '4000::', '6000::',
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('SSRF table pins the 100.64/10 shared-address boundaries exactly', () => {
  assert.equal(isPublicAddress('100.63.255.255'), true, 'just below the range stays public');
  assert.equal(isPublicAddress('100.64.0.0'), false, 'range start blocked');
  assert.equal(isPublicAddress('100.64.0.1'), false, 'range interior blocked');
  assert.equal(isPublicAddress('100.127.255.255'), false, 'range end blocked');
  assert.equal(isPublicAddress('100.128.0.0'), true, 'just above the range stays public');
});

test('SSRF table blocks all ::ffff/96, even when the mapped v4 is public', () => {
  // Conservative by design: the whole ::ffff:0:0/96 subnet is blocked, so a
  // v4-mapped public address is refused rather than unwrapped and re-checked.
  assert.equal(isPublicAddress('::ffff:10.0.0.1'), false);
  assert.equal(isPublicAddress('::ffff:100.64.0.1'), false);
  assert.equal(isPublicAddress(`::ffff:${PUBLIC_IP}`), false);
});

test('isPublicAddress rejects non-IPs and strips zone ids before checking', () => {
  assert.equal(isPublicAddress('example.com'), false);
  assert.equal(isPublicAddress(''), false);
  assert.equal(isPublicAddress('not an ip'), false);
  assert.equal(isPublicAddress('fe80::1%eth0'), false, 'zoned link-local stays blocked');
});

// --- resolution-time gate ------------------------------------------------------------

test('assertPublicHostname refuses private IP literals without touching DNS', async () => {
  let dnsCalls = 0;
  const lookup = ((...args: unknown[]) => {
    dnsCalls++;
    (args[2] as (...cb: unknown[]) => void)(null, [{ address: PUBLIC_IP, family: 4 }]);
  }) as unknown as typeof dnsLookup;
  await assert.rejects(assertPublicHostname(PRIVATE_IP, lookup), /public IP/);
  await assert.rejects(assertPublicHostname('[::1]', lookup), /public IP/);
  assert.equal(dnsCalls, 0, 'literal path must not resolve');
  await assertPublicHostname(PUBLIC_IP, lookup);
});

test('assertPublicHostname refuses when any resolved address is private', async () => {
  const mixed = lookupFor({ 'feeds.example': [PUBLIC_IP, PRIVATE_IP] });
  await assert.rejects(assertPublicHostname('feeds.example', mixed), /public IP/);
  const empty = lookupFor({ 'feeds.example': [] });
  await assert.rejects(assertPublicHostname('feeds.example', empty), /public IP/);
});

// --- connect-time gate: DNS-rebinding shape --------------------------------------------
// The fetcher gates twice: `assertPublicHostname` at resolution time and the
// undici connector (`createPublicLookup`) at connect time. Suites that stub
// `fetchImpl` never execute the second gate, so a rebinding answer (public at
// resolve, private at connect) would slip through untested. These tests drive
// the connector lookup directly with a flipping stub.

test('connect-time lookup refuses a rebound private answer after a public resolution', async () => {
  let calls = 0;
  const rebinding = lookupFor(() => (calls++ === 0 ? [PUBLIC_IP] : [PRIVATE_IP]));
  // Resolution phase passes on the public snapshot.
  await assertPublicHostname('feeds.example', rebinding);
  // Connect phase sees the rebound private answer and refuses.
  const guarded = createPublicLookup(rebinding);
  await assert.rejects(
    new Promise((resolve, reject) => {
      guarded('feeds.example', { all: true }, (error) => (error ? reject(error) : resolve(undefined)));
    }),
    /non-public IP/,
  );
});

test('connect-time lookup refuses direct private answers in both callback shapes', async () => {
  for (const privateAddress of [PRIVATE_IP, '100.64.0.1', '169.254.169.254', '::ffff:10.0.0.1', '::1']) {
    const guarded = createPublicLookup(lookupFor({ 'feeds.example': [privateAddress] }));
    await assert.rejects(
      new Promise((resolve, reject) => {
        guarded('feeds.example', { all: true }, (error) => (error ? reject(error) : resolve(undefined)));
      }),
      /non-public IP/,
      `all:true ${privateAddress}`,
    );
    await assert.rejects(
      new Promise((resolve, reject) => {
        guarded('feeds.example', {}, (error) => (error ? reject(error) : resolve(undefined)));
      }),
      /non-public IP/,
      `single-address ${privateAddress}`,
    );
  }
});

test('connect-time lookup refuses empty answers and passes public ones through', async () => {
  const empty = createPublicLookup(lookupFor({ 'feeds.example': [] }));
  await assert.rejects(
    new Promise((resolve, reject) => {
      empty('feeds.example', { all: true }, (error) => (error ? reject(error) : resolve(undefined)));
    }),
    /non-public IP/,
  );
  const guarded = createPublicLookup(lookupFor({}));
  const addresses = await new Promise<unknown[]>((resolve, reject) => {
    guarded('feeds.example', { all: true }, (error, found) => (error ? reject(error) : resolve(found as unknown[])));
  });
  assert.deepEqual(addresses, [{ address: PUBLIC_IP, family: 4 }]);
});

// --- fetcher-level pins ---------------------------------------------------------------

test('fetcher refuses a private IP literal before any fetch', async () => {
  const seen: string[] = [];
  let dnsCalls = 0;
  const lookup = ((...args: unknown[]) => {
    dnsCalls++;
    (args[2] as (...cb: unknown[]) => void)(null, [{ address: PUBLIC_IP, family: 4 }]);
  }) as unknown as typeof dnsLookup;
  const fetcher = new PublicFeedFetcher(lookup, fetchStub({}, seen));
  await assert.rejects(fetcher.read(`https://${PRIVATE_IP}/feed.xml`, signal()), /public IP/);
  assert.equal(seen.length, 0);
  assert.equal(dnsCalls, 0, 'literal refusal happens before DNS and fetch');
});

// --- 2MB cap ----------------------------------------------------------------------------

test('cap refuses an announced oversize body before consuming it', async () => {
  const announced = new Response(null, { status: 200, headers: { 'content-length': String(CAP + 1) } });
  await assert.rejects(readLimitedText(announced), /larger than 2 MB/);
});

test('cap refuses streamed oversize bodies accumulated over many chunks', async () => {
  const trickle = new Response(chunkedStream(new Array(33).fill(64 * 1024)), {
    status: 200,
    headers: { 'content-type': 'application/rss+xml' },
  });
  await assert.rejects(readLimitedText(trickle), /larger than 2 MB/);
});

test('cap accepts a body of exactly 2MB', async () => {
  const exact = new Response(chunkedStream([1_000_000, 1_000_000]), {
    status: 200,
    headers: { 'content-type': 'application/rss+xml' },
  });
  assert.equal((await readLimitedText(exact)).length, CAP);
});

test('fetcher refuses announced and streamed oversize bodies end to end', async () => {
  const announcedSeen: string[] = [];
  const announcedFetcher = new PublicFeedFetcher(
    lookupFor({}),
    fetchStub(
      { 'https://example.com/feed.xml': new Response(null, { status: 200, headers: { 'content-length': String(CAP + 1) } }) },
      announcedSeen,
    ),
  );
  await assert.rejects(announcedFetcher.read('https://example.com/feed.xml', signal()), /larger than 2 MB/);
  assert.equal(announcedSeen.length, 1, 'refusal surfaces from the single stubbed fetch');

  const streamedSeen: string[] = [];
  const streamedFetcher = new PublicFeedFetcher(
    lookupFor({}),
    fetchStub(
      {
        'https://example.com/feed.xml': new Response(chunkedStream([1_500_000, 600_000]), {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        }),
      },
      streamedSeen,
    ),
  );
  await assert.rejects(streamedFetcher.read('https://example.com/feed.xml', signal()), /larger than 2 MB/);
  assert.equal(streamedSeen.length, 1, 'streamed refusal surfaces from the single stubbed fetch');
});

// --- the zero-live-call pin -----------------------------------------------------------------

test('offline suite made zero live network calls', () => {
  assert.deepEqual(fetchCalls, [], 'every fetch in this file is a stub');
});
