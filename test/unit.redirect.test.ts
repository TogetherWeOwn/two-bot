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
const get = (path: string, init?: RequestInit) =>
  fetch(`${base()}${path}`, { redirect: 'manual', ...init });

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

// --- unknown and malformed slugs --------------------------------------------

test('an unknown slug is a 404 and records nothing', async () => {
  const res = await get('/never-created');
  assert.equal(res.status, 404);
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
