/**
 * TOG-9117: feed redirect follow policy offline suite.
 *
 * Hermetic by construction: a stub DNS lookup (public IP unless told
 * otherwise) and a stub fetch (URL-keyed routes, unknown URLs throw), so no
 * packet ever leaves the process. The global fetch trap fails the run on any
 * real network call through the ambient fetch.
 *
 * Runs without Postgres or a token:
 *   node --test test/unit.feed-redirect-offline.test.ts
 *
 * Pins the policy documented on `PublicFeedFetcher`: same-host redirects
 * that keep or upgrade the scheme are followed (bounded); cross-host
 * targets, downgrades, and hop overflow are refused with a stable
 * `Feed redirect refused:` prefix that lands in the `feed.poll` audit
 * `reason`; `assertPublicHostname` still gates the initial URL and every
 * redirect hop.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { lookup as dnsLookup } from 'node:dns';
import type { fetch as undiciFetch } from 'undici';
import { FeedRedirectError, PublicFeedFetcher } from '../src/announcements/feedHttp.ts';

const PUBLIC_IP = '93.184.216.34';
const PRIVATE_IP = '10.0.0.1';
const RSS_DOC = '<rss><channel><item><guid>x</guid><title>X</title><link>https://example.com/x</link></item></channel></rss>';

// --- zero-live-call trap ---------------------------------------------------------

const fetchCalls: string[] = [];
let originalFetch: typeof fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`TOG-9117: offline suite attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

// --- stubs -----------------------------------------------------------------------

type LookupOptions = { all?: boolean };

function lookupFor(resolutions: Record<string, string[]> | (() => string)): typeof dnsLookup {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const addresses = typeof resolutions === 'function' ? [resolutions()] : (resolutions[hostname] ?? [PUBLIC_IP]);
    const found = addresses.map((address) => ({ address, family: 4 }));
    if ((options as LookupOptions).all) callback(null, found);
    else callback(null, found[0]?.address ?? '', 4);
  }) as unknown as typeof dnsLookup;
}

interface SeenRequest {
  url: string;
  redirect: unknown;
}

function fetchStub(routes: Record<string, Response>, seen: SeenRequest[]): typeof undiciFetch {
  return (async (input: unknown, init?: unknown) => {
    const url = String(input);
    seen.push({ url, redirect: (init as { redirect?: unknown } | undefined)?.redirect });
    const response = routes[url];
    if (!response) throw new Error(`TOG-9117: unstubbed fetch to ${url}`);
    return response;
  }) as unknown as typeof undiciFetch;
}

function redirectTo(status: number, location: string | null): Response {
  const headers = new Headers();
  if (location !== null) headers.set('location', location);
  return new Response(null, { status, headers });
}

function feedOk(): Response {
  return new Response(RSS_DOC, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
}

function signal(): AbortSignal {
  return AbortSignal.timeout(5_000);
}

// --- policy ----------------------------------------------------------------------

test('follows a same-host http→https upgrade and passes redirect:manual every hop', async () => {
  const seen: SeenRequest[] = [];
  const fetcher = new PublicFeedFetcher(
    lookupFor({}),
    fetchStub({
      'http://example.com/feed.xml': redirectTo(301, 'https://example.com/feed.xml'),
      'https://example.com/feed.xml': feedOk(),
    }, seen),
  );
  const res = await fetcher.read('http://example.com/feed.xml', signal());
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<guid>x</guid>'));
  assert.deepEqual(seen.map((request) => request.url), [
    'http://example.com/feed.xml',
    'https://example.com/feed.xml',
  ]);
  for (const request of seen) assert.equal(request.redirect, 'manual');
});

test('refuses a cross-host redirect with a stable audit-distinct prefix', async () => {
  const seen: SeenRequest[] = [];
  const fetcher = new PublicFeedFetcher(
    lookupFor({}),
    fetchStub({ 'https://example.com/feed.xml': redirectTo(301, 'https://www.example.com/feed.xml') }, seen),
  );
  await assert.rejects(fetcher.read('https://example.com/feed.xml', signal()), (error: unknown) => {
    assert.ok(error instanceof FeedRedirectError);
    assert.match((error as Error).message, /^Feed redirect refused: cross-host redirect/);
    return true;
  });
  assert.equal(seen.length, 1, 'refusal happens before any second fetch');
});

test('refuses scheme downgrades, missing locations, and hop overflow', async () => {
  const downgrade: SeenRequest[] = [];
  await assert.rejects(
    new PublicFeedFetcher(
      lookupFor({}),
      fetchStub({ 'https://example.com/feed.xml': redirectTo(301, 'http://example.com/feed.xml') }, downgrade),
    ).read('https://example.com/feed.xml', signal()),
    /Feed redirect refused: scheme downgrade/,
  );

  const noLocation: SeenRequest[] = [];
  await assert.rejects(
    new PublicFeedFetcher(
      lookupFor({}),
      fetchStub({ 'https://example.com/feed.xml': redirectTo(301, null) }, noLocation),
    ).read('https://example.com/feed.xml', signal()),
    /Feed redirect refused:.*has no location/,
  );

  const looping: SeenRequest[] = [];
  await assert.rejects(
    new PublicFeedFetcher(
      lookupFor({}),
      fetchStub({
        'https://example.com/a': redirectTo(301, 'https://example.com/b'),
        'https://example.com/b': redirectTo(301, 'https://example.com/c'),
        'https://example.com/c': redirectTo(301, 'https://example.com/d'),
        'https://example.com/d': redirectTo(301, 'https://example.com/e'),
      }, looping),
    ).read('https://example.com/a', signal()),
    /Feed redirect refused: too many redirects/,
  );
  assert.equal(looping.length, 4, 'three hops followed, fourth refused');
});

// --- SSRF guard unchanged ----------------------------------------------------------

test('SSRF guard rejects the initial URL before any fetch', async () => {
  const seen: SeenRequest[] = [];
  const fetcher = new PublicFeedFetcher(
    lookupFor({ 'feeds.example': [PRIVATE_IP] }),
    fetchStub({}, seen),
  );
  await assert.rejects(fetcher.read('https://feeds.example/feed.xml', signal()), /public IP/);
  assert.equal(seen.length, 0);
});

test('SSRF guard re-gates every redirect hop against DNS rebinding', async () => {
  let calls = 0;
  const seen: SeenRequest[] = [];
  const fetcher = new PublicFeedFetcher(
    lookupFor(() => (calls++ === 0 ? PUBLIC_IP : PRIVATE_IP)),
    fetchStub({ 'https://example.com/a': redirectTo(301, 'https://example.com/b') }, seen),
  );
  await assert.rejects(fetcher.read('https://example.com/a', signal()), /public IP/);
  assert.equal(seen.length, 1, 'first hop fetched, rebound target refused before its fetch');
});

// --- the zero-live-call pin ----------------------------------------------------------

test('offline suite made zero live network calls', () => {
  assert.deepEqual(fetchCalls, [], 'every fetch in this file is a stub');
});
