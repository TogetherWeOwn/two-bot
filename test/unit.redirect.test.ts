/**
 * The tracked invite redirect (TOG-116).
 *
 * A real listener on a real socket, driven with real fetch calls. The thing
 * being proved is end-to-end: a GET produces a 302 to the right place AND an
 * `invite_click` row with nothing personal in it. Stubbing the HTTP layer would
 * leave the two halves that matter - the status code and the recorded event -
 * untested against each other.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { CampaignStore, isValidSlug, isValidInviteCode } from '../src/redirect/campaigns.ts';
import { startRedirectServer, type RedirectServer } from '../src/redirect/server.ts';
import { idempotencyKey } from '../src/core/events.ts';

const GUILD = '111222333444555666';
const CODE = 'aB3xY9';
const NOW = '2026-09-03T12:00:00.000Z';

let t: TestDb;
let server: RedirectServer;
let campaigns: CampaignStore;
let handlers: FunnelHandlers;

before(async () => {
  t = await openTestDb(import.meta.filename);
  campaigns = new CampaignStore(t.db, { ttlMs: 0 }); // no caching in tests
  handlers = new FunnelHandlers(new EventStore(t.db));
  server = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns,
    recorder: handlers,
    fallbackInviteCode: 'fallbackCode',
  });
});

after(async () => {
  await server.close();
  await t.cleanup();
});

beforeEach(async () => {
  await t.reset();
  await t.db.exec(`DELETE FROM invite_campaigns`);
});

const base = () => `http://127.0.0.1:${server.port}`;

/**
 * A request, plus a wait for the click write it started.
 *
 * The server redirects first and records after - deliberately, so nobody waits
 * on a database to reach Discord - which means the 302 arrives while the insert
 * is still in flight. Reading the row straight back is therefore a race that
 * SQLite hides (the write lands in the same tick) and Postgres does not (it is
 * a round trip). `drain()` closes that window here without weakening the
 * property being tested: the assertions below still check what was recorded,
 * they just wait until recording is over first.
 */
const get = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${base()}${path}`, { redirect: 'manual', ...init });
  await server.drain();
  return res;
};

async function addCampaign(slug: string, code = CODE, label = 'a place we post') {
  await campaigns.add({ slug, inviteCode: code, label, createdAt: NOW });
}

async function clicks() {
  return t.db
    .prepare(`SELECT source, member_id, metadata FROM events WHERE event_type='invite_click'`)
    .all<{ source: string; member_id: string | null; metadata: string | null }>();
}

// --- the happy path ---------------------------------------------------------

test('a tracked link redirects to the invite and records one click', async () => {
  await addCampaign('reddit');
  const res = await get('/reddit');

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `https://discord.gg/${CODE}`);

  const rows = await clicks();
  assert.equal(rows.length, 1);
  // The same string a join through this code is attributed to, so clicks and
  // joins line up with no special case in the report.
  assert.equal(rows[0].source, `invite:${CODE}`);
  assert.equal(rows[0].member_id, null);
  assert.deepEqual(JSON.parse(rows[0].metadata ?? '{}'), { campaign: 'reddit' });
});

test('the redirect is 302 and uncacheable, so a second click still counts', async () => {
  await addCampaign('reddit');
  const res = await get('/reddit');
  // A 301 would be cached forever by the browser and every proxy in between,
  // and the campaign would silently stop counting after the first visit.
  assert.equal(res.status, 302);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

  await get('/reddit');
  assert.equal((await clicks()).length, 2);
});

test('two clicks in the same millisecond are two clicks', async () => {
  // The failure this guards: invite_click has no member id, so its idempotency
  // key is guild+type+timestamp. Without a per-request token the second click
  // collides with the first and is dropped as a duplicate - which would
  // under-count the denominator and make conversion look better than it is.
  await addCampaign('reddit');
  const fixed = { occurredAt: NOW, campaign: 'reddit' };
  await handlers.onInviteClick(GUILD, CODE, { ...fixed, dedupeToken: 'one' });
  await handlers.onInviteClick(GUILD, CODE, { ...fixed, dedupeToken: 'two' });
  assert.equal((await clicks()).length, 2);
});

test('a click with no dedupe token still collapses, as every other event does', () => {
  const e = {
    guildId: GUILD,
    memberId: null,
    eventType: 'invite_click' as const,
    occurredAt: NOW,
    source: `invite:${CODE}`,
  };
  assert.equal(idempotencyKey(e), idempotencyKey({ ...e }));
  assert.notEqual(idempotencyKey({ ...e, dedupeToken: 'a' }), idempotencyKey({ ...e, dedupeToken: 'b' }));
});

test('two campaigns on one invite code are told apart by campaign', async () => {
  await addCampaign('reddit', CODE, 'r/MMORPG');
  await addCampaign('twitch', CODE, 'Twitch panel');
  await get('/reddit');
  await get('/twitch');

  const rows = await clicks();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => JSON.parse(r.metadata ?? '{}').campaign).sort(),
    ['reddit', 'twitch'],
  );
  // Both still credit the same code, because that is what a join will carry.
  assert.ok(rows.every((r) => r.source === `invite:${CODE}`));
});

// --- what must NOT be recorded ----------------------------------------------

test('nothing about the visitor is stored', async () => {
  await addCampaign('reddit');
  await get('/reddit', {
    headers: {
      'user-agent': 'Mozilla/5.0 (very identifying)',
      referer: 'https://reddit.com/r/MMORPG/comments/xyz',
      cookie: 'session=secret',
      'x-forwarded-for': '203.0.113.44',
    },
  });

  const rows = await t.db
    .prepare(`SELECT * FROM events WHERE event_type='invite_click'`)
    .all<Record<string, unknown>>();
  assert.equal(rows.length, 1);
  const blob = JSON.stringify(rows[0]);
  for (const leak of ['Mozilla', 'reddit.com/r', 'secret', '203.0.113.44']) {
    assert.ok(!blob.includes(leak), `recorded event must not contain ${leak}: ${blob}`);
  }
  // No cookie is set on the way out either.
  assert.equal((await get('/reddit')).headers.get('set-cookie'), null);
});

test('a stored click is campaign + timestamps and nothing else', async () => {
  await addCampaign('reddit');
  await get('/reddit', {
    headers: {
      'user-agent': 'Mozilla/5.0 (very identifying)',
      referer: 'https://example.com/somewhere',
      cookie: 'session=secret',
      'x-forwarded-for': '203.0.113.44',
    },
  });

  // Full-row shape, not just a leak scan: the record is allowed exactly these
  // values, and every one of them is ours (campaign slug, invite code, guild,
  // server timestamps), never the visitor's.
  const rows = await t.db
    .prepare(
      `SELECT event_type, member_id, guild_id, occurred_at, recorded_at, source, metadata, idempotency_key
         FROM events WHERE event_type='invite_click'`,
    )
    .all<{
      event_type: string;
      member_id: string | null;
      guild_id: string;
      occurred_at: string;
      recorded_at: string;
      source: string;
      metadata: string | null;
      idempotency_key: string;
    }>();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.event_type, 'invite_click');
  assert.equal(row.member_id, null);
  assert.equal(row.guild_id, GUILD);
  assert.equal(row.source, `invite:${CODE}`);
  assert.deepEqual(JSON.parse(row.metadata ?? '{}'), { campaign: 'reddit' });
  assert.match(row.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(row.recorded_at, /^\d{4}-\d{2}-\d{2}T/);

  // The socket address exists only to pick a rate-limit bucket (see
  // src/redirect/server.ts); it must not survive into the stored row. In this
  // suite every request arrives from loopback, so its absence here is the proof.
  const blob = JSON.stringify(row);
  for (const leak of ['Mozilla', 'example.com/somewhere', 'secret', '203.0.113.44', '127.0.0.1']) {
    assert.ok(!blob.includes(leak), `recorded event must not contain ${leak}: ${blob}`);
  }
});

test('the query string is dropped, not recorded', async () => {
  await addCampaign('reddit');
  const res = await get('/reddit?fbclid=abc123&utm_source=somewhere');
  assert.equal(res.status, 302);
  const rows = await clicks();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows[0]).includes('fbclid'));
});

// --- things that are not people ---------------------------------------------

test('HEAD redirects but does not count - link previews are not clicks', async () => {
  // Discord itself HEADs a URL when someone pastes it in a channel. Counting
  // that would inflate every campaign the moment it is shared.
  await addCampaign('reddit');
  const res = await get('/reddit', { method: 'HEAD' });
  assert.equal(res.status, 302);
  assert.equal((await clicks()).length, 0);
});

test('favicon and robots.txt never reach the click count', async () => {
  await addCampaign('reddit');
  assert.equal((await get('/favicon.ico')).status, 404);
  assert.equal((await get('/robots.txt')).status, 404);
  assert.equal((await clicks()).length, 0);
});

test('healthz is a plain 200 and not a click', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.equal((await clicks()).length, 0);
});

test('a non-GET method is refused', async () => {
  await addCampaign('reddit');
  const res = await get('/reddit', { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal((await clicks()).length, 0);
});

// --- abuse bursts -----------------------------------------------------------

// Per-caller (IP), not per-campaign: this bucket is keyed by socket address,
// so a burst from many addresses against one campaign is NOT throttled today.
// Throttling that would need cross-IP campaign counters; the gap is tracked
// as TOG-5895 and documented in docs/INVITE_TRACKING.md (Design notes).

test('an abuse burst from one caller is throttled at 429 and never recorded', async () => {
  await addCampaign('reddit');
  // A private listener with a tiny bucket and a frozen clock: every request
  // lands in the same instant, so refill cannot rescue the burst and the
  // verdict is deterministic instead of timing-dependent.
  let now = 1_000_000;
  const burst = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns,
    recorder: handlers,
    fallbackInviteCode: 'fallbackCode',
    bucket: { capacity: 5, refillPerSecond: 1 },
    now: () => now,
  });
  try {
    const burstGet = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${burst.port}${path}`, { redirect: 'manual' });
      await burst.drain();
      return res;
    };
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await burstGet('/reddit')).status);
    assert.deepEqual(statuses, [302, 302, 302, 302, 302, 429, 429, 429]);

    const throttled = await burstGet('/no-such-campaign');
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get('retry-after'), '1');

    // The refused requests never touched the database: the cap runs before
    // lookup, so a crawler cannot turn a burst into load OR into rows.
    assert.equal((await clicks()).length, 5);

    // A minute later the bucket has refilled and a human clicks again.
    now += 61_000;
    assert.equal((await burstGet('/reddit')).status, 302);
    assert.equal((await clicks()).length, 6);
  } finally {
    await burst.close();
  }
});

// --- unknown and malformed slugs --------------------------------------------

test('an unknown slug is a 404 with no redirect target and records nothing', async () => {
  const res = await get('/never-created');
  assert.equal(res.status, 404);
  // No Location header: an unknown slug must not bounce anywhere an attacker
  // chooses — there is no open redirect here to launder a phishing link through.
  assert.equal(res.headers.get('location'), null);
  assert.equal((await clicks()).length, 0);
});

test('an unknown slug under burst stays 404 and still records nothing', async () => {
  await addCampaign('reddit');
  const seen = new Set<number>();
  for (let i = 0; i < 10; i++) {
    const res = await get(`/no-such-campaign-${i}`);
    seen.add(res.status);
    assert.equal(res.headers.get('location'), null);
  }
  assert.deepEqual([...seen].sort(), [404]);
  assert.equal((await clicks()).length, 0);
});

test('the bare domain redirects to the fallback without counting a click', async () => {
  // Nobody clicked a tracked link, so crediting a campaign would be a lie -
  // but sending a typed-in domain to a 404 loses a member for nothing.
  const res = await get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://discord.gg/fallbackCode');
  assert.equal((await clicks()).length, 0);
});

test('slug lookup is case-insensitive and tolerates a trailing slash', async () => {
  await addCampaign('reddit');
  assert.equal((await get('/Reddit')).status, 302);
  assert.equal((await get('/reddit/')).status, 302);
  assert.equal((await clicks()).length, 2);
});

test('a malformed percent-escape is a 404, not a crash', async () => {
  const res = await get('/%E0%A4%A');
  assert.equal(res.status, 404);
});

test('a path traversal attempt is just an unknown slug', async () => {
  const res = await get('/../../etc/passwd');
  assert.ok(res.status === 404 || res.status === 400, `got ${res.status}`);
  assert.equal((await clicks()).length, 0);
});

// --- retired links ----------------------------------------------------------

test('a retired campaign still redirects, because the post cannot be edited', async () => {
  await addCampaign('reddit');
  await campaigns.disable('reddit', NOW);
  const res = await get('/reddit');
  assert.equal(res.status, 302);
  assert.equal((await clicks()).length, 1);
});

// --- the store --------------------------------------------------------------

test('slugs are never repointed', async () => {
  await addCampaign('reddit', CODE);
  await assert.rejects(() => addCampaign('reddit', 'differentCode'), /already exists/);
  const found = await campaigns.lookup('reddit');
  assert.equal(found?.inviteCode, CODE);
});

test('an invalid slug or code is refused at the door', async () => {
  await assert.rejects(() => addCampaign('Reddit'), /Invalid campaign slug/);
  await assert.rejects(() => addCampaign('has space'), /Invalid campaign slug/);
  await assert.rejects(() => addCampaign('a'), /Invalid campaign slug/);
  await assert.rejects(
    () => campaigns.add({ slug: 'ok', inviteCode: 'https://discord.gg/x', label: 'l', createdAt: NOW }),
    /Invalid Discord invite code/,
  );
});

test('slug and code validators agree with the shapes we accept', () => {
  for (const good of ['reddit', 'r-mmorpg', 'twitch-panel-2', 'ab']) {
    assert.ok(isValidSlug(good), good);
  }
  for (const bad of ['a', 'UPPER', 'has space', '-lead', 'trail-', 'a'.repeat(41), '']) {
    assert.ok(!isValidSlug(bad), bad);
  }
  for (const good of ['aB3xY9', 'two-gaming']) assert.ok(isValidInviteCode(good), good);
  for (const bad of ['has space', 'a/b', '', 'x'.repeat(65)]) {
    assert.ok(!isValidInviteCode(bad), bad);
  }
});
