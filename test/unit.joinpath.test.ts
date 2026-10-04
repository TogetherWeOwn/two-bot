/**
 * Join→path mapping pins for TOG-8676 (parent TOG-8597).
 *
 * The card names `src/growth/joinPath.ts`: the tracked homepage link must
 * resolve to exactly `/join`, `/join` must serve the approved 200
 * interstitial, and `/discord` must redirect to the exact expected invite
 * without opening Discord. The "unknown-source bucket" half lives one layer
 * down and is documented in `docs/EVENTS.md` (§`source`): a join nobody can
 * attribute is `unknown`, a different fact from `ambiguous` and `vanity`
 * with a different fix. This file pins both halves and their linkage:
 *
 *   1. `trackedJoinPathFromHtml` mapping table - what resolves to /join and
 *      what does not (attribute order, quote style, tag case, absolute vs
 *      relative, trailing slash, query strings, cross-origin lookalikes).
 *   2. The observer branches the gate suite never exercises - fetch throws,
 *      non-redirect answers, a 200 that still carries a Location, and a
 *      homepage served off the approved hostname.
 *   3. The unknown-source linkage - every string the no-growth path can
 *      produce lands in the documented `unknown` bucket under both
 *      classifiers, while `vanity` stays out of it.
 *
 * Fully offline: every observer takes an injected `fetch`, the tracker is
 * constructed with a null db (`attribute()` touches no database), and no
 * test opens a socket or a guild.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  observeApprovedPublicSite,
  observeTrackedJoinPath,
  trackedJoinPathFromHtml,
} from '../src/growth/joinPath.ts';
import { InviteTracker, attributeJoins, attributionCategory } from '../src/core/inviteTracker.ts';
import { isUnknownBucket } from '../src/analytics/unknownAttribution.ts';

const SITE = 'https://togetherweown.com';
const EXPECTED_INVITE = 'https://discord.gg/4GwEDNRTtx';
const INTERSTITIAL = '<a href="/join/discord" data-testid="one-click-join">Join</a>';

// --- join→path mapping table ------------------------------------------------

test('the tracked link resolves to /join in either attribute order', () => {
  for (const html of [
    '<a href="/join" data-testid="discord-join">Join the Discord</a>',
    '<a data-testid="discord-join" href="/join">Join the Discord</a>',
  ]) {
    const url = trackedJoinPathFromHtml(SITE, html);
    assert.ok(url instanceof URL, `expected a URL for ${html}`);
    assert.equal(url.href, 'https://togetherweown.com/join');
  }
});

test('the tracked link parses single quotes and uppercase tags', () => {
  const single = "<a href='/join' data-testid='discord-join'>Join</a>";
  assert.equal(trackedJoinPathFromHtml(SITE, single)?.href, 'https://togetherweown.com/join');

  const loud = '<A HREF="/join" DATA-TESTID="discord-join">Join</A>';
  assert.equal(trackedJoinPathFromHtml(SITE, loud)?.href, 'https://togetherweown.com/join');
});

test('the tracked link accepts an absolute same-origin /join URL', () => {
  const url = trackedJoinPathFromHtml(SITE, '<a href="https://togetherweown.com/join" data-testid="discord-join">Join</a>');
  assert.ok(url instanceof URL);
  assert.equal(url.href, 'https://togetherweown.com/join');
});

test('the tracked link tolerates a trailing slash but not a query string', () => {
  // Same destination modulo the trailing slash - the interstitial route.
  const slashed = trackedJoinPathFromHtml(SITE, '<a href="/join/" data-testid="discord-join">Join</a>');
  assert.ok(slashed instanceof URL, 'a trailing slash is still the tracked path');

  // The tracked link is exactly /join; a query variant is a different route,
  // not the tracked one.
  assert.equal(trackedJoinPathFromHtml(SITE, '<a href="/join?ref=web" data-testid="discord-join">Join</a>'), undefined);
});

test('the tracked link rejects a cross-origin /join lookalike', () => {
  // An open-redirect-shaped anchor carrying the test id must never resolve.
  assert.equal(
    trackedJoinPathFromHtml(SITE, '<a href="https://evil.example/join" data-testid="discord-join">Join</a>'),
    undefined,
  );
});

test('the parser scans past earlier anchors for the tracked link', () => {
  const html = '<a href="/about">About</a><p>text</p><a href="/join" data-testid="discord-join">Join</a>';
  assert.equal(trackedJoinPathFromHtml(SITE, html)?.href, 'https://togetherweown.com/join');
});

test('the parser rejects untracked, wrong-path, and link-free HTML', () => {
  assert.equal(trackedJoinPathFromHtml(SITE, '<a href="/join">Untracked link</a>'), undefined);
  assert.equal(trackedJoinPathFromHtml(SITE, '<a data-testid="discord-join" href="/about">Join</a>'), undefined);
  assert.equal(trackedJoinPathFromHtml(SITE, '<h1>About us</h1>'), undefined);
  assert.equal(trackedJoinPathFromHtml(SITE, ''), undefined);
});

// --- observeTrackedJoinPath: the branches the gate suite skips ---------------

function joinThenDiscord(join: Response, discord: Response) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/join')) return join;
    if (url.endsWith('/discord')) return discord;
    throw new Error(`unexpected request: ${url}`);
  };
}

test('without homepage HTML the observer goes straight to /join then /discord', async () => {
  const requested: string[] = [];
  const result = await observeTrackedJoinPath(SITE, EXPECTED_INVITE, {
    fetch: async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/join')) return new Response(INTERSTITIAL, { status: 200 });
      return new Response(null, { status: 302, headers: { location: EXPECTED_INVITE } });
    },
  });

  assert.equal(result.works, true);
  assert.deepEqual(requested, ['https://togetherweown.com/join', 'https://togetherweown.com/discord']);
});

test('an unreachable /join fails as could-not-be-reached', async () => {
  const result = await observeTrackedJoinPath(SITE, EXPECTED_INVITE, {
    fetch: async () => {
      throw new Error('socket hangup');
    },
  });

  assert.equal(result.works, false);
  assert.match(result.detail, /https:\/\/togetherweown\.com\/join could not be reached/);
  assert.match(result.detail, /socket hangup/);
});

test('a /join that redirects instead of serving the interstitial fails', async () => {
  const result = await observeTrackedJoinPath(SITE, EXPECTED_INVITE, {
    homepageHtml: '<a data-testid="discord-join" href="/join">Join</a>',
    fetch: joinThenDiscord(
      new Response(null, { status: 302, headers: { location: 'https://togetherweown.com/other' } }),
      new Response(null, { status: 302, headers: { location: EXPECTED_INVITE } }),
    ),
  });

  assert.equal(result.works, false);
  assert.match(result.detail, /answered 302 instead of serving the approved 200 interstitial/);
});

test('a 200 at /join that still carries a Location is not the interstitial', async () => {
  let discordHit = false;
  const result = await observeTrackedJoinPath(SITE, EXPECTED_INVITE, {
    homepageHtml: '<a data-testid="discord-join" href="/join">Join</a>',
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/join')) {
        return new Response(INTERSTITIAL, { status: 200, headers: { location: 'https://togetherweown.com/x' } });
      }
      discordHit = true;
      return new Response(null, { status: 302, headers: { location: EXPECTED_INVITE } });
    },
  });

  assert.equal(result.works, false);
  assert.equal(discordHit, false);
  assert.match(result.detail, /answered 200 instead of serving the approved 200 interstitial/);
});

test('an unreachable /discord fails as could-not-be-reached', async () => {
  const result = await observeTrackedJoinPath(SITE, EXPECTED_INVITE, {
    homepageHtml: '<a data-testid="discord-join" href="/join">Join</a>',
    fetch: async (input) => {
      if (String(input).endsWith('/join')) return new Response(INTERSTITIAL, { status: 200 });
      throw new Error('connection refused');
    },
  });

  assert.equal(result.works, false);
  assert.match(result.detail, /https:\/\/togetherweown\.com\/discord could not be reached/);
  assert.match(result.detail, /connection refused/);
});

test('a /discord that answers 200 without redirecting fails', async () => {
  const result = await observeTrackedJoinPath(SITE, EXPECTED_INVITE, {
    homepageHtml: '<a data-testid="discord-join" href="/join">Join</a>',
    fetch: joinThenDiscord(new Response(INTERSTITIAL, { status: 200 }), new Response('<h1>ok</h1>', { status: 200 })),
  });

  assert.equal(result.works, false);
  assert.match(result.detail, /answered 200 without a redirect to/);
  assert.match(result.detail, new RegExp(EXPECTED_INVITE.replace(/\./g, '\\.')));
});

// --- observeApprovedPublicSite: the branches the gate suite skips -------------

test('an unreachable vanity domain fails as could-not-be-reached', async () => {
  const result = await observeApprovedPublicSite('https://two.gg', {
    fetch: async () => {
      throw new Error('DNS failure');
    },
  });

  assert.equal(result.live, false);
  assert.match(result.detail, /https:\/\/two\.gg\/ could not be reached/);
  assert.match(result.detail, /DNS failure/);
});

test('a vanity domain that answers 200 instead of redirecting fails', async () => {
  const result = await observeApprovedPublicSite('https://two.gg', {
    fetch: async () => new Response('<h1>parked</h1>', { status: 200 }),
  });

  assert.equal(result.live, false);
  assert.match(result.detail, /answered 200 instead of redirecting to/);
  assert.match(result.detail, /https:\/\/togetherweown\.com\//);
});

test('a redirect without a Location header fails as not-redirecting', async () => {
  const result = await observeApprovedPublicSite('https://two.gg', {
    fetch: async () => new Response(null, { status: 301 }),
  });

  assert.equal(result.live, false);
  assert.match(result.detail, /answered 301 instead of redirecting to/);
});

test('an unreachable Phase 1 host fails as could-not-be-reached', async () => {
  const result = await observeApprovedPublicSite('https://two.gg', {
    fetch: async (input) => {
      if (String(input) === 'https://two.gg/') {
        return new Response(null, { status: 301, headers: { location: 'https://togetherweown.com/' } });
      }
      throw new Error('connection reset');
    },
  });

  assert.equal(result.live, false);
  assert.match(result.detail, /https:\/\/togetherweown\.com\/ could not be reached/);
  assert.match(result.detail, /connection reset/);
});

test('a Phase 1 host that answers an error fails instead of reading as live', async () => {
  const result = await observeApprovedPublicSite('https://two.gg', {
    fetch: async (input) => {
      if (String(input) === 'https://two.gg/') {
        return new Response(null, { status: 301, headers: { location: 'https://togetherweown.com/' } });
      }
      return new Response('boom', { status: 500 });
    },
  });

  assert.equal(result.live, false);
  assert.match(result.detail, /returned 500 instead of serving Phase 1/);
});

test('a homepage served off the approved hostname fails the final-URL check', async () => {
  // A redirect chain that lands elsewhere must not read as Phase 1 live,
  // even with a 200 - the observer checks the URL it actually got.
  const result = await observeApprovedPublicSite('https://two.gg', {
    fetch: async (input) => {
      if (String(input) === 'https://two.gg/') {
        return new Response(null, { status: 301, headers: { location: 'https://togetherweown.com/' } });
      }
      const landed = new Response('<h1>Phase 1</h1>', { status: 200 });
      Object.defineProperty(landed, 'url', { value: 'https://phase1.example/' });
      return landed;
    },
  });

  assert.equal(result.live, false);
  assert.match(result.detail, /instead of serving Phase 1 on the approved hostname/);
});

// --- unknown-source bucket linkage -------------------------------------------

test('no-growth attribution produces unknown, and unknown sits in the documented bucket', () => {
  // docs/EVENTS.md §`source`: `unknown` means no invite grew and there is no
  // vanity URL - Discovery, or a join from while the bot was offline.
  const tracker = new InviteTracker(null as never); // attribute() touches no database
  const source = tracker.attribute([], false);
  assert.equal(source, 'unknown');
  assert.equal(attributionCategory(source), 'unknown');
  assert.equal(isUnknownBucket(source), true);
});

test('the windowed path agrees: no growth without vanity is all unknown', () => {
  const out = attributeJoins(new Map(), 2, false);
  assert.equal(out.length, 2);
  for (const join of out) {
    assert.equal(join.source, 'unknown');
    assert.equal(attributionCategory(join.source), 'unknown');
    assert.equal(isUnknownBucket(join.source), true);
  }
});

test('vanity is a different fact with a different fix and stays out of the unknown bucket', () => {
  // Same no-growth shape, but the server has a vanity URL - "probably that",
  // not "we do not know". Both classifiers must keep it apart from unknown.
  const tracker = new InviteTracker(null as never); // attribute() touches no database
  assert.equal(tracker.attribute([], true), 'vanity');
  assert.equal(attributionCategory('vanity'), 'other');
  assert.equal(isUnknownBucket('vanity'), false);

  for (const join of attributeJoins(new Map(), 1, true)) {
    assert.equal(isUnknownBucket(join.source), false);
  }
});

test('known and ambiguous sources never land in the unknown bucket', () => {
  assert.equal(attributionCategory('invite:aB3xY9'), 'other');
  assert.equal(isUnknownBucket('invite:aB3xY9'), false);
  assert.equal(attributionCategory('ambiguous:aaa+bbb'), 'ambiguous');
  assert.equal(isUnknownBucket('ambiguous:aaa+bbb'), false);
});
