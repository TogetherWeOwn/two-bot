/**
 * TOG-8696: announcements feedHttp offline suite.
 *
 * Gap: `PublicFeedFetcher.read()` hardcoded `undiciFetch`, so the guarded
 * fetch path (SSRF pre-check, public-only dispatcher, 2 MB ceiling) had no
 * mock-transport coverage — only the guard helpers and `readLimitedText`
 * were pinned in `unit.announcements`. The fetcher now accepts an injected
 * fetch transport; this suite drives it with stubs.
 *
 * Hermetic by construction: an injected DNS lookup and an injected fetch
 * transport. A global fetch trap fails the run on any real network call.
 *
 * Runs without Postgres, a token, or network:
 *   node --test test/unit.feedhttp-offline.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { lookup as dnsLookup } from 'node:dns';
import { PublicFeedFetcher, readLimitedText } from '../src/announcements/feedHttp.ts';
import { XmlFeedReader } from '../src/announcements/discord.ts';
import type { FeedRelayRow } from '../src/announcements/store.ts';

// --- zero-live-call trap ---------------------------------------------------------

const fetchCalls: string[] = [];
let originalFetch: typeof fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`TOG-8696: offline suite attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

// --- mock DNS --------------------------------------------------------------------

type Lookup = typeof dnsLookup;

function lookupFor(addresses: Array<{ address: string; family: number }>): Lookup {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    void hostname;
    if ((options as { all?: boolean }).all) callback(null, addresses);
    else callback(null, addresses[0]?.address ?? '', addresses[0]?.family ?? 4);
  }) as Lookup;
}

const publicLookup = lookupFor([{ address: '93.184.216.34', family: 4 }]);
const privateLookup = lookupFor([{ address: '10.0.0.1', family: 4 }]);
const mixedLookup = lookupFor([
  { address: '93.184.216.34', family: 4 },
  { address: '169.254.169.254', family: 4 },
]);

// --- mock fetch transport --------------------------------------------------------
// Each case below inlines its own stub cast to the undici fetch signature; no
// shared helper, no live transport anywhere in this file.

type UndiciFetch = typeof import('undici').fetch;

const RSS = '<rss><channel><item><guid>x</guid><title>X</title><link>https://example.com/x</link></item></channel></rss>';
const signal = () => new AbortController().signal;

// --- PublicFeedFetcher: fetch/parse/error cases -----------------------------------

test('successful fetch returns status, copied headers, and full body', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const impl = (async (input: unknown, init: unknown) => {
    calls.push({ url: String(input), init: (init ?? {}) as Record<string, unknown> });
    return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  }) as unknown as typeof import('undici').fetch;
  const res = await new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', signal());
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/rss+xml');
  assert.equal(res.body, RSS);
  assert.equal(calls.length, 1);
});

test('fetch sends the feed user-agent, forbids redirects, and carries the signal', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const impl = (async (input: unknown, init: unknown) => {
    calls.push({ url: String(input), init: (init ?? {}) as Record<string, unknown> });
    return new Response('ok', { status: 200 });
  }) as unknown as typeof import('undici').fetch;
  const controller = new AbortController();
  await new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', controller.signal);
  const init = calls[0]?.init ?? {};
  assert.equal((init.headers as Record<string, string>)['User-Agent'], 'Owen/1.0 (+https://two.gg)');
  assert.equal(init.redirect, 'error');
  assert.equal(init.signal, controller.signal);
  assert.ok(init.dispatcher, 'guarded undici dispatcher must reach the transport');
});

test('non-OK status passes through instead of throwing', async () => {
  const impl = (async () => new Response('gone', { status: 410 })) as unknown as typeof import('undici').fetch;
  const res = await new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', signal());
  assert.equal(res.ok, false);
  assert.equal(res.status, 410);
  assert.equal(res.body, 'gone');
});

test('private-IP hostname is refused before the transport is touched', async () => {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response('', { status: 200 });
  }) as unknown as typeof import('undici').fetch;
  await assert.rejects(
    new PublicFeedFetcher(privateLookup, impl).read('https://metadata.internal/feed', signal()),
    /public IP/,
  );
  assert.equal(calls, 0, 'SSRF pre-check must run before any fetch');
});

test('mixed public and private resolutions are refused before the transport', async () => {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response('', { status: 200 });
  }) as unknown as typeof import('undici').fetch;
  await assert.rejects(
    new PublicFeedFetcher(mixedLookup, impl).read('https://feeds.example.com/rss', signal()),
    /public IP/,
  );
  assert.equal(calls, 0);
});

test('literal private-IP hostname is refused without a DNS call', async () => {
  let dnsCalls = 0;
  let fetchCallsCount = 0;
  const countingLookup = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    dnsCalls++;
    publicLookup(hostname, options as never, callback as never);
  }) as unknown as Lookup;
  const impl = (async () => {
    fetchCallsCount++;
    return new Response('', { status: 200 });
  }) as unknown as typeof import('undici').fetch;
  await assert.rejects(
    new PublicFeedFetcher(countingLookup, impl).read('https://169.254.169.254/feed', signal()),
    /public IP/,
  );
  assert.equal(dnsCalls, 0);
  assert.equal(fetchCallsCount, 0);
});

test('announced content-length above the ceiling aborts before streaming', async () => {
  const impl = (async () =>
    new Response('too big', { status: 200, headers: { 'content-length': '3000000' } })) as unknown as typeof import('undici').fetch;
  await assert.rejects(
    new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', signal()),
    /larger than 2 MB/,
  );
});

test('streamed body above the ceiling aborts mid-read', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_500_000));
      controller.enqueue(new Uint8Array(600_000));
      controller.close();
    },
  });
  const impl = (async () =>
    new Response(stream, { status: 200, headers: { 'content-type': 'application/xml' } })) as unknown as typeof import('undici').fetch;
  await assert.rejects(
    new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', signal()),
    /larger than 2 MB/,
  );
});

test('transport errors propagate to the caller', async () => {
  const impl = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof import('undici').fetch;
  await assert.rejects(
    new PublicFeedFetcher(publicLookup, impl).read('https://feeds.example.com/rss', signal()),
    /socket hang up/,
  );
});

test('non-URL source throws before any DNS or fetch', async () => {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response('', { status: 200 });
  }) as unknown as typeof import('undici').fetch;
  await assert.rejects(new PublicFeedFetcher(publicLookup, impl).read('not a url', signal()));
  assert.equal(calls, 0);
});

// --- readLimitedText edge cases ----------------------------------------------------

test('empty body resolves to an empty string', async () => {
  assert.equal(await readLimitedText(new Response(null, { status: 200 })), '');
});

test('announced length exactly at the ceiling streams fine', async () => {
  const body = 'x'.repeat(100);
  const res = await readLimitedText(
    new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }),
  );
  assert.equal(res, body);
});

// --- XmlFeedReader over the stub fetcher (fetch/parse/error) -----------------------

function feedRow(source: string): FeedRelayRow {
  return { source } as FeedRelayRow;
}

test('reader parses a stubbed RSS body end to end', async () => {
  const reader = new XmlFeedReader({
    read: async () => ({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      body: RSS,
    }),
  });
  assert.deepEqual(await reader.read(feedRow('https://feeds.example.com/rss')), [
    { key: 'x', title: 'X', url: 'https://example.com/x' },
  ]);
});

test('reader throws on error status without parsing', async () => {
  const reader = new XmlFeedReader({
    read: async () => ({
      ok: false, status: 500, headers: new Headers(), body: 'boom',
    }),
  });
  await assert.rejects(reader.read(feedRow('https://feeds.example.com/rss')), /HTTP 500/);
});

test('reader rejects an unsupported content type before parsing', async () => {
  const reader = new XmlFeedReader({
    read: async () => ({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: '<html></html>',
    }),
  });
  await assert.rejects(reader.read(feedRow('https://feeds.example.com/rss')), /unsupported content type/);
});

test('reader surfaces transport failures from the fetcher', async () => {
  const reader = new XmlFeedReader({
    read: async () => { throw new Error('socket hang up'); },
  });
  await assert.rejects(reader.read(feedRow('https://feeds.example.com/rss')), /socket hang up/);
});

// --- the zero-live-call pin ----------------------------------------------------------

test('offline suite made zero live network calls', () => {
  assert.deepEqual(fetchCalls, [], 'every transport in this file is a mock');
});
