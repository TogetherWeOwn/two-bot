/**
 * Redirect config and campaign-store edges at unit level (TOG-5698).
 *
 * The HTTP behaviour of the redirect lives in test/unit.redirect.test.ts; what
 * it deliberately disables is the lookup cache (ttlMs: 0) and it never calls
 * list(), loadRedirectConfig() or disable(). Those are pinned here against a
 * counting in-memory Db, which is also what proves the cache bounds database
 * traffic: a second lookup for the same slug must not touch the database, and
 * an invalid slug must never reach it at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRedirectConfig } from '../src/redirect/config.ts';
import { CampaignStore } from '../src/redirect/campaigns.ts';
import type { Db, RunResult, Statement } from '../src/store/driver.ts';

interface CampaignRow {
  slug: string;
  invite_code: string;
  label: string;
  disabled_at: string | null;
  created_at: string;
}

/** An in-memory invite_campaigns with counters, so cache behaviour is observable. */
function fakeDb(seed: CampaignRow[] = []): { db: Db; calls: { get: number; all: number; run: number } } {
  const rows = new Map(seed.map((r) => [r.slug, { ...r }]));
  const calls = { get: 0, all: 0, run: 0 };
  const statement = (sql: string): Statement => ({
    async get<T>(...params: unknown[]): Promise<T | undefined> {
      calls.get++;
      if (sql.includes('WHERE slug = ?')) {
        const row = rows.get(String(params[0]));
        return (row ? { ...row } : undefined) as T | undefined;
      }
      return undefined;
    },
    async all<T>(): Promise<T[]> {
      calls.all++;
      // Mimic ORDER BY slug in the real query.
      return [...rows.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map((r) => ({ ...r })) as T[];
    },
    async run(...params: unknown[]): Promise<RunResult> {
      calls.run++;
      if (sql.startsWith('INSERT INTO invite_campaigns')) {
        const [slug, inviteCode, label, createdAt] = params as [string, string, string, string];
        if (rows.has(slug)) return { changes: 0 };
        rows.set(slug, { slug, invite_code: inviteCode, label, disabled_at: null, created_at: createdAt });
        return { changes: 1 };
      }
      if (sql.startsWith('UPDATE invite_campaigns')) {
        const [at, slug] = params as [string, string];
        const row = rows.get(slug);
        if (!row || row.disabled_at !== null) return { changes: 0 };
        row.disabled_at = at;
        return { changes: 1 };
      }
      return { changes: 0 };
    },
  });
  const db: Db = {
    prepare: (sql: string) => statement(sql),
    exec: async () => {},
    transaction: async <T>(fn: (tx: Db) => Promise<T>) => fn(db),
    close: async () => {},
  };
  return { db, calls };
}

const NOW = '2026-09-03T12:00:00.000Z';

// --- config --------------------------------------------------------------------

test('the redirect refuses to start without a guild to record against', () => {
  assert.throws(() => loadRedirectConfig({} as NodeJS.ProcessEnv), /DISCORD_GUILD_ID/);
});

test('redirect config defaults to loopback and reads its overrides', () => {
  const base = loadRedirectConfig({ DISCORD_GUILD_ID: 'g1' } as NodeJS.ProcessEnv);
  assert.deepEqual(base, { host: '127.0.0.1', port: 8088, guildId: 'g1', fallbackInviteCode: null });

  const over = loadRedirectConfig({
    DISCORD_GUILD_ID: 'g1',
    TWO_REDIRECT_BIND_HOST: '10.0.0.5',
    TWO_REDIRECT_PORT: '8090',
    TWO_REDIRECT_FALLBACK_CODE: 'fallback',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(over, { host: '10.0.0.5', port: 8090, guildId: 'g1', fallbackInviteCode: 'fallback' });
});

test('the redirect refuses to start with an invalid TWO_REDIRECT_PORT', () => {
  for (const port of ['abc', '', '99999', '8088.5', '0', '-1']) {
    assert.throws(
      () => loadRedirectConfig({ DISCORD_GUILD_ID: 'g1', TWO_REDIRECT_PORT: port } as NodeJS.ProcessEnv),
      /TWO_REDIRECT_PORT/,
      `port "${port}" must throw`,
    );
  }
});

test('the redirect refuses to start with an invalid TWO_REDIRECT_FALLBACK_CODE', () => {
  for (const code of ['has space', 'https://discord.gg/aB3xY9', 'a/b', '']) {
    // '' is falsy and behaves as no fallback, so only non-empty values throw.
    if (code === '') continue;
    assert.throws(
      () =>
        loadRedirectConfig({
          DISCORD_GUILD_ID: 'g1',
          TWO_REDIRECT_FALLBACK_CODE: code,
        } as NodeJS.ProcessEnv),
      /TWO_REDIRECT_FALLBACK_CODE/,
      `fallback "${code}" must throw`,
    );
  }
});

// --- store ---------------------------------------------------------------------

test('list() returns every campaign in slug order', async () => {
  const { db } = fakeDb([
    { slug: 'twitch', invite_code: 'B', label: 'panel', disabled_at: null, created_at: NOW },
    { slug: 'reddit', invite_code: 'A', label: 'post', disabled_at: null, created_at: NOW },
  ]);
  const store = new CampaignStore(db);
  assert.deepEqual(
    (await store.list()).map((c) => c.slug),
    ['twitch', 'reddit'].sort(),
  );
  const reddit = (await store.list()).find((c) => c.slug === 'reddit')!;
  assert.deepEqual(reddit, {
    slug: 'reddit',
    inviteCode: 'A',
    label: 'post',
    disabledAt: null,
    createdAt: NOW,
  });
});

test('a cached lookup does not touch the database twice', async () => {
  let now = 1_000_000;
  const { db, calls } = fakeDb([
    { slug: 'reddit', invite_code: 'A', label: 'post', disabled_at: null, created_at: NOW },
  ]);
  const store = new CampaignStore(db, { ttlMs: 30_000, now: () => now });

  assert.equal((await store.lookup('reddit'))?.inviteCode, 'A');
  assert.equal((await store.lookup('reddit'))?.inviteCode, 'A');
  assert.equal(calls.get, 1);

  now += 31_000;
  assert.equal((await store.lookup('reddit'))?.inviteCode, 'A');
  assert.equal(calls.get, 2, 'an expired entry is looked up again');
});

test('misses are cached too, and invalid slugs never reach the database', async () => {
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 30_000 });

  assert.equal(await store.lookup('never-created'), null);
  assert.equal(await store.lookup('never-created'), null);
  assert.equal(calls.get, 1, 'a repeated miss must not query again');

  assert.equal(await store.lookup('HAS SPACE'), null);
  assert.equal(await store.lookup('x'), null);
  assert.equal(calls.get, 1, 'an invalid slug must never reach the database');
});

test('add() refuses repointing and invalid shapes, and invalidates the cache', async () => {
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 30_000 });

  await store.add({ slug: 'reddit', inviteCode: 'A', label: 'post', createdAt: NOW });
  await assert.rejects(
    store.add({ slug: 'reddit', inviteCode: 'B', label: 'other', createdAt: NOW }),
    /already exists/,
  );
  await assert.rejects(store.add({ slug: 'Bad Slug', inviteCode: 'A', label: 'l', createdAt: NOW }), /Invalid campaign slug/);
  await assert.rejects(
    store.add({ slug: 'ok', inviteCode: 'https://discord.gg/A', label: 'l', createdAt: NOW }),
    /Invalid Discord invite code/,
  );

  const getsBefore = calls.get;
  assert.equal((await store.lookup('reddit'))?.inviteCode, 'A');
  assert.equal(calls.get, getsBefore + 1, 'add() must invalidate the cached entry');
});

test('disable() retires a campaign once, and the lookup sees it', async () => {
  const { db } = fakeDb([
    { slug: 'reddit', invite_code: 'A', label: 'post', disabled_at: null, created_at: NOW },
  ]);
  const store = new CampaignStore(db, { ttlMs: 30_000 });

  assert.equal(await store.disable('reddit', NOW), true);
  assert.equal(await store.disable('reddit', NOW), false, 'a second disable changes nothing');
  assert.equal(await store.disable('nope', NOW), false);

  // Disabled campaigns still resolve: the link keeps redirecting.
  assert.equal((await store.lookup('reddit'))?.disabledAt, NOW);
});
