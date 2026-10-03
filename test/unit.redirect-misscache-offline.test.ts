/**
 * Miss-cache expiry and stampede edges for unknown slugs (TOG-10012).
 *
 * Hermetic by construction: a counting in-memory Db with an optional read
 * delay, no Postgres, no token, no listener, no network. The properties being
 * proved live in `CampaignStore.lookup()` (src/redirect/campaigns.ts), where a
 * miss (null) is cached at a short negative TTL so a bot walking URLs cannot
 * turn every 404 into a database query (TOG-9926):
 *
 *   - an expired miss re-looks-up EXACTLY ONCE: one query past the negative
 *     TTL, and the fresh miss is re-cached so the next lookup is free;
 *   - the expiry boundary is pinned: 1ms before `expiresAt` serves cache,
 *     AT `expiresAt` re-queries (`expiresAt > now()`, not `>=`);
 *   - concurrent lookups for one unknown slug collapse to a single query.
 *     Without in-flight sharing, N concurrent 404s for the same slug are N
 *     queries - the same denial-of-service the negative TTL exists to bound,
 *     re-opened through concurrency;
 *   - collapsing is per slug: distinct unknown slugs still query independently;
 *   - a failed lookup is never cached and frees its in-flight slot, so the
 *     next lookup retries instead of hanging on a dead promise;
 *   - `ttlMs: 0` still means no caching at all (the negative TTL clamps to
 *     the hit TTL), and an explicit `negativeTtlMs` is honored.
 *
 * Runs without Postgres or a token:
 *   node --test test/unit.redirect-misscache-offline.test.ts
 *
 * The two-process flow (redirect holds a miss while the CLI adds the slug) is
 * pinned in test/unit.redirectconfig.test.ts; what is pinned here is the
 * per-entry lifecycle and the concurrent shape around it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CampaignStore } from '../src/redirect/campaigns.ts';
import type { Db, RunResult, Statement } from '../src/store/driver.ts';

interface CampaignRow {
  slug: string;
  invite_code: string;
  label: string;
  disabled_at: string | null;
  created_at: string;
}

const NOW = '2026-09-03T12:00:00.000Z';

/**
 * An in-memory invite_campaigns with counters, so cache behaviour is
 * observable - plus an optional read delay and a one-shot read failure.
 *
 * The delay is what makes concurrency deterministic: every lookup issued in
 * the same tick reaches `get()` before any timer fires, so without in-flight
 * sharing N concurrent lookups are observably N queries, and with it they are
 * observably one.
 */
function fakeDb(
  seed: CampaignRow[] = [],
  opts: { getDelayMs?: number; getGate?: Promise<void> | ((read: number) => Promise<void>) } = {},
): {
  db: Db;
  calls: { get: number; all: number; run: number };
  failNextGet: (err: Error) => void;
} {
  const rows = new Map(seed.map((r) => [r.slug, { ...r }]));
  const calls = { get: 0, all: 0, run: 0 };
  let nextFailure: Error | null = null;
  const statement = (sql: string): Statement => ({
    async get<T>(...params: unknown[]): Promise<T | undefined> {
      calls.get++;
      assert.ok(sql.includes('WHERE slug = ?'));
      // Snapshot before yielding, like a read which finishes after a write.
      const row = rows.get(String(params[0]));
      const snapshot = row ? { ...row } : undefined;
      const failure = nextFailure;
      nextFailure = null;
      if (opts.getDelayMs) await new Promise((r) => setTimeout(r, opts.getDelayMs));
      if (opts.getGate) {
        await (typeof opts.getGate === 'function' ? opts.getGate(calls.get) : opts.getGate);
      }
      if (failure) throw failure;
      return snapshot as T | undefined;
    },
    async all<T>(): Promise<T[]> {
      calls.all++;
      return [...rows.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map((r) => ({ ...r })) as T[];
    },
    async run(...params: unknown[]): Promise<RunResult> {
      calls.run++;
      if (sql.includes('INSERT INTO invite_campaigns')) {
        const [slug, inviteCode, label, createdAt] = params.map(String);
        if (rows.has(slug)) return { changes: 0 };
        rows.set(slug, { slug, invite_code: inviteCode, label, disabled_at: null, created_at: createdAt });
        return { changes: 1 };
      }
      assert.ok(sql.includes('UPDATE invite_campaigns SET disabled_at'));
      const row = rows.get(String(params[1]));
      if (!row || row.disabled_at !== null) return { changes: 0 };
      row.disabled_at = String(params[0]);
      return { changes: 1 };
    },
  });
  const db: Db = {
    prepare: (sql: string) => statement(sql),
    exec: async () => {},
    transaction: async <T>(fn: (tx: Db) => Promise<T>) => fn(db),
    close: async () => {},
  };
  return { db, calls, failNextGet: (err: Error) => { nextFailure = err; } };
}

function readGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// --- expiry: the acceptance ---------------------------------------------------

test('an expired miss re-looks-up exactly once, then serves the fresh miss from cache', async () => {
  let now = 1_000_000;
  const { db, calls } = fakeDb();
  // Default negative TTL: min(2000, 30000).
  const store = new CampaignStore(db, { ttlMs: 30_000, now: () => now });

  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 1);
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 1, 'a live miss must not query again');

  // 1ms before the negative TTL lapses: still cached.
  now += 1_999;
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 1, 'a miss 1ms before expiry must not query again');

  // AT expiresAt the entry is expired (`expiresAt > now()`, not `>=`): the
  // acceptance - exactly one re-lookup, no more.
  now += 1;
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 2, 'an expired miss must re-look-up exactly once');

  // The re-lookup re-cached the miss: the burst right after is free.
  assert.equal(await store.lookup('nope'), null);
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 2, 'the refreshed miss must be cached again');
});

test('ttlMs 0 still means no caching: every miss queries', async () => {
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });

  assert.equal(await store.lookup('nope'), null);
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 2, 'with no TTL even a repeated miss must query every time');
});

test('an explicit negative TTL is honored', async () => {
  let now = 1_000_000;
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 30_000, negativeTtlMs: 500, now: () => now });

  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 1);

  now += 499;
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 1, 'a miss inside the explicit negative TTL must not query');

  now += 1;
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 2, 'a miss past the explicit negative TTL must re-query');
});

// --- stampede: concurrent misses ----------------------------------------------

test('concurrent lookups for one unknown slug cost a single query', async () => {
  const { db, calls } = fakeDb([], { getDelayMs: 20 });
  const store = new CampaignStore(db, { ttlMs: 30_000 });

  // Issued in the same tick: without in-flight sharing this is observably N
  // queries once the delay elapses, which is the stampede - every concurrent
  // 404 for the same slug its own database round trip.
  const results = await Promise.all(Array.from({ length: 10 }, () => store.lookup('nope')));
  assert.ok(results.every((r) => r === null));
  assert.equal(calls.get, 1, 'one in-flight miss must be shared, not queried per waiter');
});

test('concurrent lookups after a miss expires cost one re-query', async () => {
  let now = 1_000_000;
  const { db, calls } = fakeDb([], { getDelayMs: 20 });
  const store = new CampaignStore(db, { ttlMs: 30_000, now: () => now });

  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 1);

  // Past the negative TTL: the whole burst re-checks, but only one query
  // goes out - the rest share it.
  now += 2_500;
  const results = await Promise.all(Array.from({ length: 10 }, () => store.lookup('nope')));
  assert.ok(results.every((r) => r === null));
  assert.equal(calls.get, 2, 'an expired miss must re-look-up exactly once even under burst');
});

test('concurrent lookups for distinct unknown slugs each query once', async () => {
  const { db, calls } = fakeDb([], { getDelayMs: 20 });
  const store = new CampaignStore(db, { ttlMs: 30_000 });

  const slugs = Array.from({ length: 5 }, (_, i) => `nope-${i}`);
  const results = await Promise.all(slugs.map((s) => store.lookup(s)));
  assert.ok(results.every((r) => r === null));
  assert.equal(calls.get, 5, 'sharing is per slug: distinct misses must each query');
});

test('concurrent lookups for a known slug collapse to one query', async () => {
  const { db, calls } = fakeDb(
    [{ slug: 'reddit', invite_code: 'A', label: 'post', disabled_at: null, created_at: NOW }],
    { getDelayMs: 20 },
  );
  const store = new CampaignStore(db, { ttlMs: 30_000 });

  const results = await Promise.all(Array.from({ length: 10 }, () => store.lookup('reddit')));
  assert.ok(results.every((r) => r?.inviteCode === 'A'));
  assert.equal(calls.get, 1, 'in-flight sharing is uniform, not miss-only');
});

// --- failures: never cached, never stuck --------------------------------------

test('a failed lookup is never cached and frees its in-flight slot', async () => {
  const { db, calls, failNextGet } = fakeDb([], { getDelayMs: 20 });
  const store = new CampaignStore(db, { ttlMs: 30_000 });

  // The whole burst shares the one failing query - and every waiter sees the
  // failure, not a hang.
  failNextGet(new Error('simulated outage'));
  const settled = await Promise.allSettled(Array.from({ length: 5 }, () => store.lookup('nope')));
  assert.ok(settled.every((s) => s.status === 'rejected'), 'every waiter must see the failure');
  assert.equal(calls.get, 1, 'the failing burst must still be one query');

  // Nothing was cached and the slot was freed: the retry goes out again and,
  // with the database back, resolves to a miss that IS cached.
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 2, 'a failed lookup must be retried, not served from cache');
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 2, 'the retried miss is cached again');
});

test('zero TTL shares concurrent misses but does not cache the completed result', async () => {
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });
  const results = await Promise.all(Array.from({ length: 10 }, () => store.lookup('nope')));
  assert.deepEqual(results, Array(10).fill(null));
  assert.equal(calls.get, 1);
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 2);
});

test('negative TTL starts when the query completes, not when it starts', async () => {
  let now = 1_000_000;
  const gate = readGate();
  const { db, calls } = fakeDb([], { getGate: gate.promise });
  const store = new CampaignStore(db, { now: () => now });
  const pending = store.lookup('nope');
  now += 5_000;
  gate.release();
  assert.equal(await pending, null);
  now += 1_999;
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 1);
  now += 1;
  assert.equal(await store.lookup('nope'), null);
  assert.equal(calls.get, 2);
});

test('adding a slug invalidates its pending miss without losing the newer read', async () => {
  const oldGate = readGate();
  const newGate = readGate();
  const { db, calls } = fakeDb([], {
    getGate: (read) => read === 1 ? oldGate.promise : newGate.promise,
  });
  const store = new CampaignStore(db);
  const stale = store.lookup('reddit');
  await store.add({ slug: 'reddit', inviteCode: 'A', label: 'post', createdAt: NOW });
  const fresh = store.lookup('reddit');
  assert.equal(calls.get, 2, 'the post-write lookup must not join the old miss');
  oldGate.release();
  assert.equal(await stale, null);
  const joining = store.lookup('reddit');
  assert.equal(calls.get, 2, 'old cleanup must leave the newer pending query shareable');
  newGate.release();
  assert.equal((await fresh)?.inviteCode, 'A');
  assert.equal((await joining)?.inviteCode, 'A');
  assert.equal((await store.lookup('reddit'))?.inviteCode, 'A');
  assert.equal(calls.get, 2, 'old cleanup must neither cache a miss nor remove the new read');
});

test('disabling a slug invalidates its pending hit instead of caching its old state', async () => {
  const gate = readGate();
  const { db, calls } = fakeDb(
    [{ slug: 'reddit', invite_code: 'A', label: 'post', disabled_at: null, created_at: NOW }],
    { getGate: gate.promise },
  );
  const store = new CampaignStore(db);
  const stale = store.lookup('reddit');
  assert.equal(await store.disable('reddit', NOW), true);
  const fresh = store.lookup('reddit');
  assert.equal(calls.get, 2);
  gate.release();
  assert.equal((await stale)?.disabledAt, null);
  assert.equal((await fresh)?.disabledAt, NOW);
  assert.equal((await store.lookup('reddit'))?.disabledAt, NOW);
  assert.equal(calls.get, 2);
});
