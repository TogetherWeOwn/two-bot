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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { CampaignStore, isValidSlug, isValidInviteCode } from '../src/redirect/campaigns.ts';
import { startRedirectServer, type ClickRecorder, type RedirectServer } from '../src/redirect/server.ts';
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

const run = promisify(execFile);
// fileURLToPath, not .pathname: a checkout path containing spaces produces a
// percent-escaped %20 that execFile/cwd would choke on (ENOENT).
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/funnel.ts', import.meta.url));

interface FunnelAccuracyJson {
  schema: number;
  funnel: { clicks: number; joins: number };
  campaigns: Array<{ slug: string; clicks: number; joins: number }>;
  totalEvents: number;
}

/**
 * The report exactly as the dashboard stopgap reads it: scripts/funnel.ts
 * --json in a subprocess pointed at this file's schema (PGOPTIONS) and guild
 * (DISCORD_GUILD_ID). Same pattern as test/e2e.funnel-json.test.ts, so the
 * subprocess counts this fixture's rows - and only this fixture's - with the
 * report's own guild/anomaly predicates, not a restatement of them.
 */
async function funnelJson(): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    // process.execPath, not 'node': the suite may run under an absolute Node
    // executable while PATH lacks node (or selects an older one), which would
    // fail with ENOENT before the report runs.
    const result = await run(process.execPath, [SCRIPT, '--json'], {
      cwd: REPO,
      env: {
        ...process.env,
        TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
        PGOPTIONS: `-c search_path=${t.schema}`,
        DISCORD_GUILD_ID: GUILD,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// --- campaign tracking accuracy (TOG-7199) -----------------------------------
//
// The number this whole feature exists to produce: N campaign clicks through
// the live redirect become exactly N attributed invite_click events that the
// funnel/attribution reports read. Ten is the acceptance count - large enough
// that a dedupe collapse, a dropped write, or an off-by-one cannot hide, small
// enough to stay sequential and deterministic (burst behaviour is pinned by
// the abuse-burst test below, not here).

test('ten seeded campaign clicks produce exactly ten attributed events', async () => {
  await addCampaign('acc-link', CODE, 'Accuracy listing');

  for (let i = 0; i < 10; i++) {
    const res = await get('/acc-link');
    assert.equal(res.status, 302, `click ${i} must redirect`);
    assert.equal(res.headers.get('location'), `https://discord.gg/${CODE}`);
  }

  const rows = await clicks();
  assert.equal(rows.length, 10, 'every seeded click must leave exactly one attributed event');
  assert.ok(rows.every((r) => r.source === `invite:${CODE}`), 'every click credits the invite code');
  assert.ok(
    rows.every((r) => JSON.parse(r.metadata ?? '{}').campaign === 'acc-link'),
    'every click carries the campaign it was posted as',
  );

  // Nothing else was written: the click is the whole footprint of a visit.
  const total = await t.db.prepare(`SELECT COUNT(*) AS n FROM events`).get<{ n: string }>();
  assert.equal(Number(total?.n), 10);

  // The real read path: scripts/funnel.ts --json over this fixture, with the
  // report's own guild-scoped, anomaly-aware queries (scripts/funnel.ts:84-88,
  // 245-267). A restated subselect here could pass while the report the
  // dashboard quotes shows zero - wrong guild being the obvious way - so the
  // assertions below read the report's own output, not a lookalike of it.
  const funnel = await funnelJson();
  assert.equal(funnel.code, 0, `funnel --json must run clean: ${funnel.stdout}${funnel.stderr}`);
  let report: FunnelAccuracyJson;
  assert.doesNotThrow(() => {
    report = JSON.parse(funnel.stdout) as FunnelAccuracyJson;
  }, 'funnel stdout must be exactly one JSON object');
  assert.equal(report!.schema, 1, 'the dashboard stopgap pins funnel schema 1');
  assert.equal(report!.funnel.clicks, 10, 'the report headline must see all ten clicks');
  assert.equal(report!.funnel.joins, 0, 'clicks with no joins are reach without conversion, not missing rows');
  const acc = report!.campaigns.find((c) => c.slug === 'acc-link');
  assert.ok(acc, 'the report must carry the seeded campaign row');
  assert.deepEqual(
    { clicks: acc.clicks, joins: acc.joins },
    { clicks: 10, joins: 0 },
    'the campaign row must read all ten clicks and no phantom joins',
  );
  assert.equal(report!.totalEvents, 10, 'a visit leaves only its click in the event log');
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

  // Full-row shape, not just a leak scan: SELECT * (minus the surrogate id)
  // so that any column added to the table in future fails this test instead
  // of silently escaping an explicit column list. Every allowed value is ours
  // (campaign slug, invite code, guild, server timestamps), never the visitor's.
  const rows = await t.db
    .prepare(`SELECT * FROM events WHERE event_type='invite_click'`)
    .all<Record<string, unknown>>();
  assert.equal(rows.length, 1);
  const { id, ...row } = rows[0];
  assert.equal(typeof id, 'number');
  assert.deepEqual(Object.keys(row).sort(), [
    'event_type',
    'guild_id',
    'idempotency_key',
    'member_id',
    'metadata',
    'occurred_at',
    'recorded_at',
    'source',
  ]);
  assert.equal(row.event_type, 'invite_click');
  assert.equal(row.member_id, null);
  assert.equal(row.guild_id, GUILD);
  assert.equal(row.source, `invite:${CODE}`);
  assert.deepEqual(JSON.parse(String(row.metadata ?? '{}')), { campaign: 'reddit' });
  assert.match(String(row.occurred_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(String(row.recorded_at), /^\d{4}-\d{2}-\d{2}T/);

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

// --- error paths: still no PII, still no row ----------------------------------
//
// TOG-5705. The privacy assertion must hold when the request does NOT produce
// a click: none of these paths may store, log or write anything about the
// visitor, and none may leave a partial click row behind.

/**
 * Everything written to stdout/stderr while `fn` runs.
 *
 * The redirect logs lookup and record failures through src/core/log.ts, which
 * writes JSON lines to these streams. Swallowing the streams would lose the
 * test runner's own protocol (it shares them), so non-log lines are forwarded
 * unmodified and only our log lines are held back.
 */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const relay =
    (real: (c: unknown, ...rest: unknown[]) => boolean) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      lines.push(text);
      if (text.includes('"msg":"invite_redirect_') || text.includes('"msg":"invite_click_')) return true;
      return real(chunk, ...rest);
    }) as typeof process.stdout.write;

  process.stdout.write = relay(realOut as never);
  process.stderr.write = relay(realErr as never);
  try {
    await fn();
    // The record-failure log is written after the 302 is flushed; the
    // lookup-failure log before it - either way, drain() only waits for the
    // click write, so let the handler finish its tick before listening stops.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return lines.join('');
}

const PII = ['Mozilla', 'example.com/somewhere', 'session=secret', '203.0.113.44', '127.0.0.1'];

const identifying = () => ({
  headers: {
    'user-agent': 'Mozilla/5.0 (very identifying)',
    referer: 'https://example.com/somewhere',
    cookie: 'session=secret',
    'x-forwarded-for': '203.0.113.44',
  },
});

test('a failed click write still redirects and leaks nothing to logs or rows', async () => {
  await addCampaign('reddit');
  const failing: ClickRecorder = {
    onInviteClick: async () => {
      throw new Error('simulated store outage');
    },
  };
  const srv = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns,
    recorder: failing,
    fallbackInviteCode: 'fallbackCode',
  });
  try {
    const logs = await captureLogs(async () => {
      const res = await fetch(`${`http://127.0.0.1:${srv.port}`}/reddit`, {
        redirect: 'manual',
        ...identifying(),
      });
      // The member matters more than the measurement: a lost click is a
      // slightly low number, a lost member is a lost member.
      assert.equal(res.status, 302);
      await srv.drain();
    });
    assert.equal((await clicks()).length, 0);
    for (const leak of PII) {
      assert.ok(!logs.includes(leak), `failure log must not contain ${leak}: ${logs}`);
    }
  } finally {
    await srv.close();
  }
});

test('a lookup outage redirects to the fallback and records nothing', async () => {
  await addCampaign('reddit');
  // Started outside the capture window: the listening line carries the bind
  // address by design, and the leak check below is about request-time logs.
  const down = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    // A store whose lookup always throws looks exactly like a dead database.
    campaigns: { lookup: async () => { throw new Error('simulated outage'); } } as never,
    recorder: handlers,
    fallbackInviteCode: 'fallbackCode',
  });
  try {
    const logs = await captureLogs(async () => {
      const res = await fetch(`${`http://127.0.0.1:${down.port}`}/reddit`, {
        redirect: 'manual',
        ...identifying(),
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'https://discord.gg/fallbackCode');
      await down.drain();
    });
    assert.equal((await clicks()).length, 0);
    for (const leak of PII) {
      assert.ok(!logs.includes(leak), `outage log must not contain ${leak}: ${logs}`);
    }
  } finally {
    await down.close();
  }
});

test('a lookup outage with no fallback is a 503 that records nothing', async () => {
  // Started outside the capture window: see the fallback test above.
  const down = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns: { lookup: async () => { throw new Error('simulated outage'); } } as never,
    recorder: handlers,
  });
  try {
    const logs = await captureLogs(async () => {
      const res = await fetch(`${`http://127.0.0.1:${down.port}`}/reddit`, {
        redirect: 'manual',
        ...identifying(),
      });
      assert.equal(res.status, 503);
      await down.drain();
    });
    assert.equal((await clicks()).length, 0);
    for (const leak of PII) {
      assert.ok(!logs.includes(leak), `503 log must not contain ${leak}: ${logs}`);
    }
  } finally {
    await down.close();
  }
});

test('a misconfigured campaign code is a 500 that records nothing', async () => {
  // A code this bad cannot be written through add(), which validates — but a
  // directly-inserted row (or a code Discord later rejects) reaches the
  // handler, which refuses to put it in a Location header.
  await t.db.exec(
    `INSERT INTO invite_campaigns (slug, invite_code, label, disabled_at, created_at)
     VALUES ('badcode', 'has space', 'hand-edited', NULL, '${NOW}')`,
  );
  const res = await get('/badcode', identifying());
  assert.equal(res.status, 500);
  assert.equal((await clicks()).length, 0);
});

test('throttled, malformed and unknown requests record nothing and leak nothing', async () => {
  await addCampaign('reddit');
  const tiny = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns,
    recorder: handlers,
    fallbackInviteCode: 'fallbackCode',
    bucket: { capacity: 1, refillPerSecond: 0 },
    now: () => 1_000_000,
  });
  try {
    const burstGet = async (path: string, init?: RequestInit) => {
      const res = await fetch(`${`http://127.0.0.1:${tiny.port}`}${path}`, { redirect: 'manual', ...init });
      await tiny.drain();
      return res;
    };
    assert.equal((await burstGet('/reddit', identifying())).status, 302);
    // Second request from the same caller: 429, and the cap runs before the
    // database is touched, so nothing is written.
    assert.equal((await burstGet('/reddit', identifying())).status, 429);
    assert.equal((await clicks()).length, 1);
  } finally {
    await tiny.close();
  }

  assert.equal((await get('/%E0%A4%A', identifying())).status, 404);
  assert.equal((await get('/never-created', identifying())).status, 404);
  assert.equal((await clicks()).length, 1);

  // The one row in the table is still just campaign + timestamps: the error
  // traffic above added no columns, no metadata keys, no visitor data. SELECT
  // * again, so a future column fails here too (see the stored-click test).
  const rows = await t.db
    .prepare(`SELECT * FROM events WHERE event_type='invite_click'`)
    .all<Record<string, unknown>>();
  assert.equal(rows.length, 1);
  const { id: _id, ...rest } = rows[0] ?? {};
  assert.deepEqual(Object.keys(rest).sort(), [
    'event_type',
    'guild_id',
    'idempotency_key',
    'member_id',
    'metadata',
    'occurred_at',
    'recorded_at',
    'source',
  ]);
  assert.equal(rows[0]?.member_id, null);
  assert.deepEqual(JSON.parse(String(rows[0]?.metadata ?? '{}')), { campaign: 'reddit' });
  const blob = JSON.stringify(rows[0]);
  for (const leak of PII) {
    assert.ok(!blob.includes(leak), `stored row must not contain ${leak}: ${blob}`);
  }
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

// Per-caller, not per-campaign: the bucket is keyed by the resolved client IP
// (the socket address, or the leftmost untrusted X-Forwarded-For hop behind a
// trusted proxy - TOG-9924), so a burst from many callers against one campaign
// is NOT throttled today. Throttling that would need cross-caller campaign
// counters; the gap is tracked as TOG-5895 and documented in
// docs/INVITE_TRACKING.md (Design notes).

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

test('malicious campaign variants are 404s with no redirect target and record nothing', async () => {
  // TOG-7196. The acceptance set: scheme, protocol-relative and encoded-slash
  // variants must all fail closed. The Location header is only ever built from
  // a validated invite code on a fixed host (inviteUrl in
  // src/redirect/campaigns.ts), never from the path, so there is no
  // attacker-controlled target to compare against — the assertion is "none".
  await addCampaign('reddit');
  // A private listener with a fresh bucket: fifteen rapid 404s must each be a
  // 404 verdict, never a 429 from sharing the main server's burst budget.
  const audit = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns,
    recorder: handlers,
    fallbackInviteCode: 'fallbackCode',
  });
  try {
    const malicious = [
      '//evil.example',
      '///evil.example',
      '/%2fevil.example',
      '/%2Fevil.example',
      '/%252fevil.example',
      '/javascript:alert(1)',
      '/JaVaScRiPt:alert(1)',
      '/https://evil.example',
      '/http://evil.example/reddit',
      '/reddit%2f..',
      '/reddit%00',
      '/reddit%0d%0aLocation:https://evil.example',
      '/.evil.example',
      '/-evil',
      '/a',
    ];
    for (const path of malicious) {
      const res = await fetch(`http://127.0.0.1:${audit.port}${path}`, { redirect: 'manual' });
      await audit.drain();
      assert.equal(res.status, 404, `${path} must be a 404, got ${res.status}`);
      assert.equal(res.headers.get('location'), null, `${path} must not redirect anywhere`);
    }
    assert.equal((await clicks()).length, 0);
  } finally {
    await audit.close();
  }
});

test('an encoded known slug still redirects only to the fixed invite host', async () => {
  // Decoding happens before lookup, so prove the decoded path cannot escape
  // the host either: even a fully valid slug resolves to discord.gg + code.
  await addCampaign('reddit');
  const res = await get('/%72eddit'); // %72 == 'r'
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `https://discord.gg/${CODE}`);
  assert.equal((await clicks()).length, 1);
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
