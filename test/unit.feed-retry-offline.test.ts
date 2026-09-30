/**
 * TOG-9990: announcements feedHttp retry/backoff offline suite.
 *
 * Gap (round-5 gap list C10): retry/backoff behavior of
 * `src/announcements/feedHttp.ts` was untested (fetch/parse covered by #326).
 *
 * Finding pinned here: `PublicFeedFetcher.read()` has NO retry/backoff —
 * one fetch attempt per hop, transport/DNS/abort failures propagate
 * immediately, 5xx/429 statuses pass through untouched, and no
 * Retry-After sleep exists. Retry responsibility lives one layer up, at the
 * fixed-interval feed poller (`startFeedPoller`) and the per-poll delivery
 * claims. This suite pins the single-attempt semantics with stub DNS and
 * stub fetch transports so a future retry change shows up as a loud diff.
 *
 * Hermetic by construction: an injected DNS lookup and an injected fetch
 * transport. A global fetch trap fails the run on any real network call.
 *
 * Runs without Postgres, a token, or network:
 *   node --test test/unit.feed-retry-offline.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { lookup as dnsLookup } from 'node:dns';
import type { fetch as undiciFetch } from 'undici';
import { PublicFeedFetcher } from '../src/announcements/feedHttp.ts';
import { XmlFeedReader } from '../src/announcements/discord.ts';

// --- zero-live-call trap ---------------------------------------------------------

const fetchCalls: string[] = [];
let originalFetch: typeof fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`TOG-9990: offline suite attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

// --- stubs -----------------------------------------------------------------------

function lookupFor(addresses: Array<{ address: string; family: number }>): typeof dnsLookup {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    void hostname;
    if ((options as { all?: boolean }).all) callback(null, addresses);
    else callback(null, addresses[0]?.address ?? '', addresses[0]?.family ?? 4);
  }) as unknown as typeof dnsLookup;
}

const publicLookup = lookupFor([{ address: '93.184.216.34', family: 4 }]);

const signal = () => AbortSignal.timeout(5_000);

interface SeenRequest {
  url: string;
  signal: unknown;
}

function throwingStub(seen: SeenRequest[], message = 'socket hang up'): typeof undiciFetch {
  return (async (input: unknown, init?: unknown) => {
    seen.push({ url: String(input), signal: (init as { signal?: unknown } | undefined)?.signal });
    throw new Error(message);
  }) as unknown as typeof undiciFetch;
}

// --- single-attempt pins ---------------------------------------------------------

test('transient transport failure makes exactly one attempt and propagates', async () => {
  const seen: SeenRequest[] = [];
  await assert.rejects(
    new PublicFeedFetcher(publicLookup, throwingStub(seen)).read('https://feeds.example.com/rss', signal()),
    /socket hang up/,
  );
  assert.equal(seen.length, 1, 'no hidden retry loop inside the fetcher');
  assert.equal(seen[0]?.url, 'https://feeds.example.com/rss');
});

test('HTTP 503 passes through once with no retry', async () => {
  const seen: SeenRequest[] = [];
  const impl = (async (input: unknown) => {
    seen.push({ url: String(input), signal: null });
    return new Response('unavailable', { status: 503 });
  }) as unknown as typeof undiciFetch;
  const res = await new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', signal());
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
  assert.equal(res.body, 'unavailable');
  assert.equal(seen.length, 1, '5xx is a pass-through, not a retry trigger');
});

test('HTTP 429 with retry-after passes through once; the fetcher does not sleep', async () => {
  const seen: SeenRequest[] = [];
  const impl = (async (input: unknown) => {
    seen.push({ url: String(input), signal: null });
    return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
  }) as unknown as typeof undiciFetch;
  const started = performance.now();
  const res = await new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', signal());
  const elapsed = performance.now() - started;
  assert.equal(res.status, 429);
  assert.equal(seen.length, 1, 'Retry-After is not honored with a sleep-and-retry');
  assert.ok(elapsed < 1000, `429 surfaced in ${elapsed.toFixed(0)}ms without backoff delay`);
});

test('a flaky transport that would succeed on retry still fails the read', async () => {
  const seen: SeenRequest[] = [];
  let calls = 0;
  const impl = (async (input: unknown) => {
    seen.push({ url: String(input), signal: null });
    calls++;
    if (calls === 1) throw new Error('connection reset');
    return new Response('<rss></rss>', { status: 200 });
  }) as unknown as typeof undiciFetch;
  await assert.rejects(
    new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', signal()),
    /connection reset/,
  );
  assert.equal(seen.length, 1, 'first failure is final; the healthy second attempt never happens');
});

test('failing read surfaces fast: no backoff delay before the error', async () => {
  const seen: SeenRequest[] = [];
  const started = performance.now();
  await assert.rejects(
    new PublicFeedFetcher(publicLookup, throwingStub(seen)).read('https://feeds.example.com/rss', signal()),
    /socket hang up/,
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `transport error surfaced in ${elapsed.toFixed(0)}ms without backoff`);
});

test('DNS failure makes zero fetch attempts and is not retried', async () => {
  let dnsCalls = 0;
  let fetchCount = 0;
  const failingLookup = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    void hostname;
    void options;
    dnsCalls++;
    callback(new Error('getaddrinfo ENOTFOUND feeds.example.com'));
  }) as unknown as typeof dnsLookup;
  const impl = (async () => {
    fetchCount++;
    return new Response('', { status: 200 });
  }) as unknown as typeof undiciFetch;
  await assert.rejects(
    new PublicFeedFetcher(failingLookup, impl).read('https://feeds.example.com/rss', signal()),
    /ENOTFOUND/,
  );
  assert.equal(dnsCalls, 1, 'one lookup, no DNS-level retry');
  assert.equal(fetchCount, 0, 'failed DNS never reaches the transport');
});

test('aborted signal surfaces one error with one attempt', async () => {
  const seen: SeenRequest[] = [];
  const controller = new AbortController();
  const impl = (async (input: unknown, init?: unknown) => {
    seen.push({ url: String(input), signal: (init as { signal?: unknown } | undefined)?.signal });
    throw new DOMException('This operation was aborted', 'AbortError');
  }) as unknown as typeof undiciFetch;
  await assert.rejects(
    new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', controller.signal),
    /abort/i,
  );
  assert.equal(seen.length, 1, 'abort is final; no retry after cancellation');
  assert.equal(seen[0]?.signal, controller.signal, 'the caller signal reaches the transport');
});

test('redirect-hop failure propagates after one attempt per hop', async () => {
  const seen: SeenRequest[] = [];
  const impl = (async (input: unknown) => {
    const url = String(input);
    seen.push({ url, signal: null });
    if (url === 'https://example.com/a') {
      return new Response(null, { status: 301, headers: { location: 'https://example.com/b' } });
    }
    throw new Error('hop boom');
  }) as unknown as typeof undiciFetch;
  await assert.rejects(
    new PublicFeedFetcher(publicLookup, impl).read('https://example.com/a', signal()),
    /hop boom/,
  );
  assert.deepEqual(
    seen.map((request) => request.url),
    ['https://example.com/a', 'https://example.com/b'],
    'each redirect hop is attempted exactly once',
  );
});

test('consecutive reads do not back off: every call attempts once', async () => {
  const seen: SeenRequest[] = [];
  const fetcher = new PublicFeedFetcher(publicLookup, throwingStub(seen, 'still down'));
  await assert.rejects(fetcher.read('https://feeds.example.com/rss', signal()), /still down/);
  await assert.rejects(fetcher.read('https://feeds.example.com/rss', signal()), /still down/);
  assert.equal(seen.length, 2, 'no circuit breaker or escalating backoff across calls');
});

// --- XmlFeedReader over a failing stub fetcher ------------------------------------

test('reader surfaces a 503 distinctly without retrying the fetcher', async () => {
  let calls = 0;
  const reader = new XmlFeedReader({
    read: async () => {
      calls++;
      return { ok: false, status: 503, headers: new Headers(), body: 'unavailable' };
    },
  });
  await assert.rejects(
    reader.read({ source: 'https://feeds.example.com/rss' } as never),
    /HTTP 503/,
  );
  assert.equal(calls, 1, 'error statuses are thrown once, never retried by the reader');
});

// --- the zero-live-call pin --------------------------------------------------------

test('offline suite made zero live network calls', () => {
  assert.deepEqual(fetchCalls, [], 'every transport in this file is a mock');
});
