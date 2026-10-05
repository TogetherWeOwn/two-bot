/**
 * TOG-8675: announcements service offline suite.
 *
 * Hermetic by construction: an in-memory node:sqlite Db behind the narrow
 * `Db` surface, a FakeDiscord transport, and a stub FeedReader. A global
 * fetch trap fails the run on any real network call, and every send path
 * asserts its transport counters explicitly — zero live Discord sends,
 * zero live guild writes.
 *
 * Runs without Postgres or a token:
 *   node --test test/unit.announcements-offline.test.ts
 *
 * The Postgres-backed `unit.announcements` suite covers the same service
 * against the real driver in CI; this file covers the validation and
 * outcome branches a reviewer must be able to run with no database.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  AnnouncementsService,
  FEED_READ_TIMEOUT_MS,
  MAX_FEED_READ_TIMEOUT_MS,
  normalizeFeedSource,
  parseRoleSpec,
  type FeedItem,
  type LfgRoleInput,
} from '../src/announcements/service.ts';
import { AnnouncementsStore, type FeedRelayRow } from '../src/announcements/store.ts';
import type { Db, Statement } from '../src/store/db.ts';

const GUILD = '1550000000000000001';
const CHANNEL = '1550000000000000002';
const EVENT = '1550000000000000003';
const USER = '1550000000000000004';
const OTHER = '1550000000000000005';
const THIRD = '1550000000000000006';
const NOW = new Date('2026-09-10T10:00:00.000Z');
const FUTURE = '2026-09-11T20:00:00.000Z';

// --- zero-live-call traps -----------------------------------------------------
// The service never touches fetch itself; the trap proves no dependency does
// either. Silence at the end of the suite is the pass.

const fetchCalls: string[] = [];
let originalFetch: typeof fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`TOG-8675: offline suite attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

// --- mock transport (no sends) ------------------------------------------------

class FakeDiscord {
  posts: Array<{ channelId: string; content: string; nonce?: string; components?: unknown[] }> = [];
  edits: Array<{ channelId: string; messageId: string; content: string; components?: unknown[] }> = [];
  statuses = new Map<string, number>([[EVENT, 1]]);

  async postMessage(channelId: string, content: string, options: { nonce?: string; components?: unknown[] } = {}) {
    this.posts.push({ channelId, content, ...options });
    return String(1600000000000000000n + BigInt(this.posts.length));
  }

  async editMessage(channelId: string, messageId: string, content: string, components?: unknown[]) {
    this.edits.push({ channelId, messageId, content, components });
  }

  async findMessageByNonce(_channelId: string, _nonce: string): Promise<string | null> {
    return null;
  }

  async getScheduledEventStatus(_guildId: string, eventId: string): Promise<number | null> {
    return this.statuses.get(eventId) ?? null;
  }
}

// --- offline Db over node:sqlite ----------------------------------------------
// Mirrors migrations/0024_announcements_feeds.sql (+0025 claim columns) in
// sqlite types. The one Postgres-ism in the store path — the advisory lock in
// signupLfg — is emulated as a no-op: the suite is single-threaded, so there
// is no rival transaction to serialize against.

function wrapStatement(db: DatabaseSync, sql: string): Statement {
  if (sql.includes('pg_advisory_xact_lock')) {
    return {
      get: async <T>(): Promise<T | undefined> => ({}) as T,
      all: async <T>(): Promise<T[]> => [],
      run: async () => ({ changes: 0 }),
    };
  }
  const stmt = db.prepare(sql);
  return {
    get: async <T>(...params: unknown[]): Promise<T | undefined> =>
      stmt.get(...(params as never[])) as T | undefined,
    all: async <T>(...params: unknown[]): Promise<T[]> =>
      stmt.all(...(params as never[])) as T[],
    run: async (...params: unknown[]): Promise<{ changes: number }> => {
      const r = stmt.run(...(params as never[]));
      return { changes: Number(r.changes) };
    },
  };
}

function openOfflineDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event_rsvps (
    guild_id TEXT NOT NULL, event_id TEXT NOT NULL, user_id TEXT NOT NULL,
    status TEXT NOT NULL, responded_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, event_id, user_id))`);
  db.exec(`CREATE TABLE lfg_posts (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    message_id TEXT, title TEXT NOT NULL, starts_at TEXT NOT NULL,
    status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
    closed_at TEXT)`);
  db.exec(`CREATE TABLE lfg_roles (
    lfg_id TEXT NOT NULL, role_key TEXT NOT NULL, label TEXT NOT NULL,
    slots INTEGER NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY (lfg_id, role_key), UNIQUE (lfg_id, position))`);
  db.exec(`CREATE TABLE lfg_signups (
    lfg_id TEXT NOT NULL, user_id TEXT NOT NULL, role_key TEXT NOT NULL,
    joined_at TEXT NOT NULL, PRIMARY KEY (lfg_id, user_id))`);
  db.exec(`CREATE TABLE feed_relays (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    kind TEXT NOT NULL, source TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    last_checked_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE feed_deliveries (
    feed_id TEXT NOT NULL, item_key TEXT NOT NULL, nonce TEXT NOT NULL,
    state TEXT NOT NULL, message_id TEXT, first_seen_at TEXT NOT NULL,
    delivered_at TEXT, claim_token TEXT, claimed_at TEXT,
    PRIMARY KEY (feed_id, item_key), UNIQUE (feed_id, nonce))`);
  db.exec(`CREATE TABLE announcements_audit_log (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT,
    action TEXT NOT NULL, target_key TEXT, outcome TEXT NOT NULL,
    reason TEXT, created_at TEXT NOT NULL)`);
  const facade: Db = {
    prepare: (sql) => wrapStatement(db, sql),
    exec: async (sql) => { db.exec(sql); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(facade),
    close: async () => { db.close(); },
  };
  return facade;
}

let db: Db;
let store: AnnouncementsStore;

before(() => {
  db = openOfflineDb();
  store = new AnnouncementsStore(db);
});

after(async () => {
  await db.close();
});

async function reset() {
  await db.exec(`DELETE FROM announcements_audit_log; DELETE FROM feed_deliveries;
    DELETE FROM feed_relays; DELETE FROM lfg_signups; DELETE FROM lfg_roles;
    DELETE FROM lfg_posts; DELETE FROM event_rsvps;`);
}

async function auditCount(action: string, outcome?: string): Promise<number> {
  const row = outcome === undefined
    ? await db.prepare(`SELECT COUNT(*) AS total FROM announcements_audit_log WHERE action = ?`).get<{ total: number }>(action)
    : await db.prepare(`SELECT COUNT(*) AS total FROM announcements_audit_log WHERE action = ? AND outcome = ?`).get<{ total: number }>(action, outcome);
  return Number(row?.total ?? 0);
}

function readerFor(items: FeedItem[]) {
  return { read: async (_feed: FeedRelayRow) => items };
}

async function createOpenLfg(discord: FakeDiscord, id = 'lfg-offline', roles = [{ key: 'any', label: 'Any', slots: 2 }]) {
  const service = new AnnouncementsService(store, discord);
  return service.createLfg({
    id, guildId: GUILD, channelId: CHANNEL, title: 'Offline raid',
    startsAt: FUTURE, roles, actorId: USER, now: NOW,
  });
}

// --- rsvp / attendance ---------------------------------------------------------

test('rsvp groups all three statuses and audits every response', async () => {
  await reset();
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  await service.rsvp({ guildId: GUILD, eventId: EVENT, userId: USER, status: 'going', now: NOW });
  await service.rsvp({ guildId: GUILD, eventId: EVENT, userId: OTHER, status: 'interested', now: NOW });
  await service.rsvp({ guildId: GUILD, eventId: EVENT, userId: THIRD, status: 'declined', now: NOW });
  assert.deepEqual(await service.attendance(GUILD, EVENT), {
    going: [USER], interested: [OTHER], declined: [THIRD],
  });
  assert.equal(await auditCount('event.rsvp'), 3);
  assert.equal(discord.posts.length, 0);
  assert.equal(discord.edits.length, 0);
});

test('rsvp rejects a non-snowflake event id before any transport call', async () => {
  await reset();
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  await assert.rejects(
    service.rsvp({ guildId: GUILD, eventId: 'not-an-id', userId: USER, status: 'going' }),
    /must be a Discord id/,
  );
  await assert.rejects(service.attendance(GUILD, 'short'), /must be a Discord id/);
  assert.equal(discord.posts.length, 0);
  assert.equal(discord.edits.length, 0);
  assert.equal(await auditCount('event.rsvp'), 0);
});

// --- createLfg validation (zero sends on every refusal) -------------------------

test('createLfg refuses bad titles, times and role sets with zero posts', async () => {
  await reset();
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  const goodRoles = [{ key: 'any', label: 'Any', slots: 2 }];
  const cases: Array<[string, { title?: string; startsAt?: string; roles?: LfgRoleInput[] }]> = [
    ['empty title', { title: '   ' }],
    ['overlong title', { title: 'x'.repeat(101) }],
    ['past starts-at', { startsAt: '2026-09-09T10:00:00.000Z' }],
    ['non-ISO starts-at', { startsAt: 'next friday-ish' }],
    ['no roles', { roles: [] }],
    ['too many roles', { roles: Array.from({ length: 21 }, (_, i) => ({ key: `r${i}`, label: `R${i}`, slots: 1 })) }],
    ['duplicate role key', { roles: [{ key: 'dps', label: 'DPS', slots: 1 }, { key: 'DPS', label: 'DPS 2', slots: 1 }] }],
    ['bad role key', { roles: [{ key: 'has space', label: 'X', slots: 1 }] }],
    ['empty role label', { roles: [{ key: 'x', label: '  ', slots: 1 }] }],
    ['zero slots', { roles: [{ key: 'x', label: 'X', slots: 0 }] }],
    ['non-integer slots', { roles: [{ key: 'x', label: 'X', slots: 1.5 }] }],
  ];
  for (const [name, patch] of cases) {
    await assert.rejects(
      service.createLfg({
        guildId: GUILD, channelId: CHANNEL,
        startsAt: FUTURE, roles: goodRoles, actorId: USER, now: NOW,
        title: 'Offline raid',
        ...patch,
      }),
      /.+/s,
      name,
    );
  }
  assert.equal(discord.posts.length, 0, 'refused LFG must never reach the transport');
  assert.equal(await auditCount('lfg.create'), 0);
});

test('createLfg posts once, persists the message id, and renders role lines', async () => {
  await reset();
  const discord = new FakeDiscord();
  const post = await createOpenLfg(discord, 'lfg-render');
  assert.match(post.messageId ?? '', /^\d{17,}$/);
  assert.equal(discord.posts.length, 1);
  assert.match(discord.posts[0]?.nonce ?? '', /^[a-f0-9]{24}$/);
  assert.ok(discord.posts[0]?.content.includes('Offline raid'));
  assert.equal((await store.getLfg(GUILD, 'lfg-render'))?.messageId, post.messageId);
  assert.equal(await auditCount('lfg.create', 'created'), 1);
});

// --- signup / leave / close outcomes --------------------------------------------

test('signup reports missing post, closed post and unknown role with no edits', async () => {
  await reset();
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  assert.equal(await service.signupLfg({ guildId: GUILD, id: 'no-such-post', roleKey: 'any', userId: USER }), 'missing');
  const post = await createOpenLfg(discord, 'lfg-outcomes');
  assert.equal(await service.signupLfg({ guildId: GUILD, id: post.id, roleKey: 'nope', userId: USER }), 'missing');
  assert.equal(await service.closeLfg(GUILD, post.id, USER), true);
  assert.equal(await service.signupLfg({ guildId: GUILD, id: post.id, roleKey: 'any', userId: USER }), 'closed');
  assert.equal(discord.posts.length, 1);
  assert.equal(discord.edits.length, 1, 'only the close refresh edits');
});

test('leave reports not_joined without an edit, then edits once on leave', async () => {
  await reset();
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  const post = await createOpenLfg(discord, 'lfg-leave');
  const editsAfterCreate = discord.edits.length;
  assert.equal(await service.leaveLfg(GUILD, post.id, USER), false);
  assert.equal(discord.edits.length, editsAfterCreate);
  assert.equal(await service.signupLfg({ guildId: GUILD, id: post.id, roleKey: 'any', userId: USER }), 'joined');
  assert.equal(await service.leaveLfg(GUILD, post.id, USER), true);
  assert.equal(discord.edits.length, editsAfterCreate + 2, 'signup refresh plus leave refresh');
  assert.equal(await auditCount('lfg.leave', 'not_joined'), 1);
  assert.equal(await auditCount('lfg.leave', 'left'), 1);
});

test('second close is a no-op with no extra edit', async () => {
  await reset();
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  const post = await createOpenLfg(discord, 'lfg-close-twice');
  assert.equal(await service.closeLfg(GUILD, post.id, USER, NOW), true);
  const editsAfterFirstClose = discord.edits.length;
  assert.equal(await service.closeLfg(GUILD, post.id, USER, NOW), false);
  assert.equal(discord.edits.length, editsAfterFirstClose);
  assert.equal(await auditCount('lfg.close', 'already_closed_or_missing'), 1);
});

// --- feeds: add / remove --------------------------------------------------------

test('addFeed normalizes a YouTube channel id and audits creation', async () => {
  await reset();
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  const row = await service.addFeed({
    id: 'feed-yt', guildId: GUILD, channelId: CHANNEL, kind: 'youtube',
    source: 'UC1234567890123456789012', actorId: USER, now: NOW,
  });
  assert.equal(row.source, 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890123456789012');
  assert.equal(discord.posts.length, 0);
  assert.equal(await auditCount('feed.create', 'youtube'), 1);
});

test('removeFeed reports removed then missing, never touching the transport', async () => {
  await reset();
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  await service.addFeed({
    id: 'feed-gone', guildId: GUILD, channelId: CHANNEL, kind: 'rss',
    source: 'https://example.com/feed.xml', actorId: USER, now: NOW,
  });
  assert.equal(await service.removeFeed(GUILD, 'feed-gone', USER), true);
  assert.equal(await service.removeFeed(GUILD, 'feed-gone', USER), false);
  assert.equal(discord.posts.length, 0);
  assert.equal(discord.edits.length, 0);
  assert.equal(await auditCount('feed.remove', 'removed'), 1);
  assert.equal(await auditCount('feed.remove', 'missing'), 1);
});

// --- pollFeeds -------------------------------------------------------------------

test('pollFeeds without a reader throws before any send', async () => {
  await reset();
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  await assert.rejects(service.pollFeeds(GUILD), /Feed reader is not configured/);
  assert.equal(discord.posts.length, 0);
});

test('pollFeeds advances past the 20-post cap across polls, then dedupes (TOG-9345)', async () => {
  await reset();
  const discord = new FakeDiscord();
  const items: FeedItem[] = Array.from({ length: 25 }, (_, i) => ({
    key: `k${i}`, title: `T${i}`, url: `https://example.com/${i}`,
  }));
  const service = new AnnouncementsService(store, discord, readerFor(items));
  await service.addFeed({
    id: 'feed-cap', guildId: GUILD, channelId: CHANNEL, kind: 'rss',
    source: 'https://example.com/feed.xml', actorId: USER, now: NOW,
  });
  // Poll 1: oldest 20 post (k24..k5), newest 5 defer — no silent drop.
  assert.equal(await service.pollFeeds(GUILD, NOW), 20);
  assert.equal(discord.posts.length, 20);
  assert.ok(discord.posts[0]?.content.includes('T24'), 'oldest of the listing posts first');
  assert.ok(discord.posts[19]?.content.includes('T5'));
  for (const post of discord.posts) assert.match(post.nonce ?? '', /^[a-f0-9]{24}$/);
  const firstPoll = await db.prepare(
    `SELECT outcome, reason FROM announcements_audit_log WHERE action = ? AND target_key = ? ORDER BY created_at LIMIT 1`,
  ).get<{ outcome: string; reason: string | null }>('feed.poll', 'feed-cap');
  assert.equal(firstPoll?.outcome, 'read 25');
  assert.match(firstPoll?.reason ?? '', /deferred 5 by per-poll cap/, 'overflow is distinguished from delivered');
  // Poll 2: the window advances onto the deferred tail (k4..k0), oldest first.
  assert.equal(await service.pollFeeds(GUILD, NOW), 5);
  assert.equal(discord.posts.length, 25);
  assert.ok(discord.posts[20]?.content.includes('T4'));
  assert.ok(discord.posts[24]?.content.includes('T0'));
  // Poll 3: everything delivered — dedupe holds.
  assert.equal(await service.pollFeeds(GUILD, NOW), 0, 'third poll delivers nothing new');
  assert.equal(discord.posts.length, 25);
  assert.equal(await auditCount('feed.poll'), 3);
});

test('pollFeeds bounds every read with an AbortSignal.timeout at or below 60s', async () => {
  assert.ok(FEED_READ_TIMEOUT_MS <= MAX_FEED_READ_TIMEOUT_MS, `FEED_READ_TIMEOUT_MS=${FEED_READ_TIMEOUT_MS} must stay <= 60s`);
  assert.equal(MAX_FEED_READ_TIMEOUT_MS, 60_000);
  // Oversized and non-positive overrides never widen the deadline.
  const discord = new FakeDiscord();
  assert.throws(() => new AnnouncementsService(store, discord, readerFor([]), { feedReadTimeoutMs: 0 }), /positive/);
  assert.throws(() => new AnnouncementsService(store, discord, readerFor([]), { feedReadTimeoutMs: NaN }), /positive/);
  const over = new AnnouncementsService(store, discord, readerFor([]), { feedReadTimeoutMs: 600_000 });
  assert.equal((over as unknown as { feedReadTimeoutMs: number }).feedReadTimeoutMs, 60_000);
});

test('pollFeeds times out a hung feed, audits failed, and still delivers the next feed', async () => {
  await reset();
  const discord = new FakeDiscord();
  const seenSignals: Array<AbortSignal | undefined> = [];
  const reader = {
    read: async (feed: FeedRelayRow, signal?: AbortSignal): Promise<FeedItem[]> => {
      seenSignals.push(signal);
      if (feed.id === 'feed-aaa-hung') return new Promise<FeedItem[]>(() => {});
      return [{ key: 'ok-1', title: 'Ok item', url: 'https://example.com/ok' }];
    },
  };
  const service = new AnnouncementsService(store, discord, reader, { feedReadTimeoutMs: 50 });
  await service.addFeed({
    id: 'feed-aaa-hung', guildId: GUILD, channelId: CHANNEL, kind: 'rss',
    source: 'https://example.com/hung.xml', actorId: USER, now: NOW,
  });
  await service.addFeed({
    id: 'feed-zzz-ok', guildId: GUILD, channelId: CHANNEL, kind: 'rss',
    source: 'https://example.com/ok.xml', actorId: USER, now: NOW,
  });
  assert.equal(await service.pollFeeds(GUILD, NOW), 1);
  assert.equal(discord.posts.length, 1);
  assert.ok(discord.posts[0]?.content.includes('Ok item'));
  assert.equal(await auditCount('feed.poll', 'failed'), 1);
  assert.equal(seenSignals.length, 2);
  for (const signal of seenSignals) assert.ok(signal instanceof AbortSignal, 'each read receives an AbortSignal');
});

test('pollFeeds audits a failed read without throwing and sends nothing', async () => {
  await reset();
  const discord = new FakeDiscord();
  const failing = { read: async (_feed: FeedRelayRow): Promise<FeedItem[]> => { throw new Error('feed down'); } };
  const service = new AnnouncementsService(store, discord, failing);
  await service.addFeed({
    id: 'feed-down', guildId: GUILD, channelId: CHANNEL, kind: 'rss',
    source: 'https://example.com/down.xml', actorId: USER, now: NOW,
  });
  assert.equal(await service.pollFeeds(GUILD, NOW), 0);
  assert.equal(discord.posts.length, 0);
  assert.equal(await auditCount('feed.poll', 'failed'), 1);
});

test('pollFeeds records a redirect refusal distinctly from a fetch failure', async () => {
  await reset();
  const discord = new FakeDiscord();
  const redirectRefusal = {
    read: async (_feed: FeedRelayRow): Promise<FeedItem[]> => {
      throw new Error('Feed redirect refused: cross-host redirect to https://www.example.com (HTTP 301).');
    },
  };
  const service = new AnnouncementsService(store, discord, redirectRefusal);
  await service.addFeed({
    id: 'feed-moved', guildId: GUILD, channelId: CHANNEL, kind: 'rss',
    source: 'https://example.com/moved.xml', actorId: USER, now: NOW,
  });
  assert.equal(await service.pollFeeds(GUILD, NOW), 0);
  assert.equal(discord.posts.length, 0);
  const row = await db.prepare(
    `SELECT outcome, reason FROM announcements_audit_log WHERE action = ? AND target_key = ?`,
  ).get<{ outcome: string; reason: string | null }>('feed.poll', 'feed-moved');
  assert.equal(row?.outcome, 'failed');
  assert.match(row?.reason ?? '', /^Feed redirect refused: cross-host redirect/);
});

test('pollFeeds isolates a poison post failure: later items still deliver (TOG-9346 B2a)', async () => {
  await reset();
  class PoisonDiscord extends FakeDiscord {
    override async postMessage(channelId: string, content: string, options: { nonce?: string; components?: unknown[] } = {}) {
      if (content.includes('POISON')) throw new Error('discord send exploded');
      return super.postMessage(channelId, content, options);
    }
  }
  const discord = new PoisonDiscord();
  // Reader order is newest-first; the loop delivers oldest-first, so the
  // poison item sits mid-batch with a healthy newer item behind it.
  const items: FeedItem[] = [
    { key: 'newest', title: 'Newest ok', url: 'https://example.com/newest' },
    { key: 'poison', title: 'POISON item', url: 'https://example.com/poison' },
    { key: 'oldest', title: 'Oldest ok', url: 'https://example.com/oldest' },
  ];
  const service = new AnnouncementsService(store, discord, readerFor(items));
  await service.addFeed({
    id: 'feed-poison', guildId: GUILD, channelId: CHANNEL, kind: 'rss',
    source: 'https://example.com/feed.xml', actorId: USER, now: NOW,
  });
  assert.equal(await service.pollFeeds(GUILD, NOW), 2);
  assert.equal(discord.posts.length, 2);
  assert.ok(discord.posts[0]?.content.includes('Oldest ok'), 'oldest posts first');
  assert.ok(discord.posts[1]?.content.includes('Newest ok'), 'healthy item behind the poison still delivers');
  assert.equal(await auditCount('feed.item', 'failed'), 1);
  assert.equal(await auditCount('feed.poll', 'failed'), 0, 'per-item isolation keeps the per-feed catch clear');
  // Second poll: poison fails again but healthy items stay delivered — no permanent starvation.
  assert.equal(await service.pollFeeds(GUILD, NOW), 0);
  assert.equal(discord.posts.length, 2);
  assert.equal(await auditCount('feed.item', 'failed'), 2);
  const checked = await db.prepare(
    `SELECT last_checked_at AS v FROM feed_relays WHERE id = ?`,
  ).get<{ v: string | null }>('feed-poison');
  assert.equal(checked?.v, NOW.toISOString(), 'markFeedChecked still runs despite the poison item');
});

test('pollFeeds reconciles an ambiguous post by nonce instead of duplicating (TOG-9347 B3)', async () => {
  await reset();
  let nonceLookups = 0;
  class AmbiguousDiscord extends FakeDiscord {
    nonceMessages = new Map<string, string>();
    override async postMessage(channelId: string, content: string, options: { nonce?: string; components?: unknown[] } = {}): Promise<string> {
      // Accept-then-reset: Discord stored the message, transport threw.
      const id = await super.postMessage(channelId, content, options);
      if (options.nonce) this.nonceMessages.set(options.nonce, id);
      throw new Error('connection reset after accept');
    }
    override async findMessageByNonce(_channelId: string, nonce: string): Promise<string | null> {
      nonceLookups++;
      return this.nonceMessages.get(nonce) ?? null;
    }
  }
  const discord = new AmbiguousDiscord();
  const service = new AnnouncementsService(store, discord, readerFor([
    { key: 'amb-1', title: 'Ambiguous', url: 'https://example.com/amb' },
  ]));
  await service.addFeed({
    id: 'feed-ambiguous', guildId: GUILD, channelId: CHANNEL, kind: 'rss',
    source: 'https://example.com/feed.xml', actorId: USER, now: NOW,
  });
  assert.equal(await service.pollFeeds(GUILD, NOW), 1, 'recovered send counts as delivered');
  assert.equal(discord.posts.length, 1, 'one transport attempt, no resend');
  assert.equal(nonceLookups, 1, 'reconciliation looked up the nonce once');
  assert.equal(await auditCount('feed.item', 'failed'), 0, 'recovered send is not a failure');
  const delivery = await db.prepare(
    `SELECT state, message_id FROM feed_deliveries WHERE feed_id = ?`,
  ).get<{ state: string; message_id: string }>('feed-ambiguous');
  assert.equal(delivery?.state, 'delivered');
  assert.match(delivery?.message_id ?? '', /^\d{17,}$/);
  // Second poll sends nothing new — no duplicate under the same nonce.
  assert.equal(await service.pollFeeds(GUILD, NOW), 0);
  assert.equal(discord.posts.length, 1);
});

test('pollFeeds skips a keyless item and still delivers the healthy items behind it (TOG-9346 B2b)', async () => {
  await reset();
  const discord = new FakeDiscord();
  const items: FeedItem[] = [
    { key: 'healthy-new', title: 'Healthy new', url: 'https://example.com/new' },
    { key: '   ', title: 'Keyless', url: '   ' },
    { key: 'healthy-old', title: 'Healthy old', url: 'https://example.com/old' },
  ];
  const service = new AnnouncementsService(store, discord, readerFor(items));
  await service.addFeed({
    id: 'feed-keyless', guildId: GUILD, channelId: CHANNEL, kind: 'rss',
    source: 'https://example.com/feed.xml', actorId: USER, now: NOW,
  });
  assert.equal(await service.pollFeeds(GUILD, NOW), 2);
  assert.equal(discord.posts.length, 2);
  assert.ok(discord.posts[0]?.content.includes('Healthy old'));
  assert.ok(discord.posts[1]?.content.includes('Healthy new'));
  assert.equal(await auditCount('feed.item', 'skipped'), 1);
  const row = await db.prepare(
    `SELECT outcome, reason FROM announcements_audit_log WHERE action = ? AND outcome = ?`,
  ).get<{ outcome: string; reason: string | null }>('feed.item', 'skipped');
  assert.match(row?.reason ?? '', /no stable key/);
  assert.equal(await auditCount('feed.poll', 'failed'), 0);
  // Next poll delivers nothing new and keeps the healthy items delivered.
  assert.equal(await service.pollFeeds(GUILD, NOW), 0);
  assert.equal(discord.posts.length, 2);
});

// --- pure validators ---------------------------------------------------------------

test('normalizeFeedSource refuses credentials, plain HTTP and loopback', () => {
  assert.throws(
    () => normalizeFeedSource('rss', 'https://user:pass@example.com/feed'),
    /without embedded credentials/,
  );
  assert.throws(() => normalizeFeedSource('rss', 'http://example.com/feed'), /HTTPS/);
  assert.throws(() => normalizeFeedSource('rss', 'https://127.0.0.1/feed'), /loopback/);
  assert.throws(() => normalizeFeedSource('rss', 'not a url'), /Invalid URL|HTTPS/);
});

test('parseRoleSpec refuses malformed entries', () => {
  assert.throws(() => parseRoleSpec('tank:Tank'), /separated by commas/);
  assert.throws(() => parseRoleSpec('tank:Tank:many'), /slots must be integers/);
  assert.throws(() => parseRoleSpec('tank:Tank:1,tank:Other:1'), /Duplicate/);
  assert.deepEqual(parseRoleSpec('tank:Tank:2,heal:Healer:1'), [
    { key: 'tank', label: 'Tank', slots: 2 },
    { key: 'heal', label: 'Healer', slots: 1 },
  ]);
});

// --- the zero-live-call pin -----------------------------------------------------------

test('offline suite made zero live network calls', () => {
  assert.deepEqual(fetchCalls, [], 'every transport in this file is a mock');
});
