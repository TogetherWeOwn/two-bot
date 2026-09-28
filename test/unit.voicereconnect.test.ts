/**
 * TOG-6123: a fresh session after an unresumable disconnect must drop open
 * voice sessions, not just the ShardResume path.
 *
 * Only ShardResume cleared the tracker, so a full re-identify (READY after
 * InvalidSession with no stored session, a Reconnect opcode, or an
 * unrecoverable close) kept pre-outage starts: post-outage leaves then
 * reported measured durations that silently included the outage, defeating the
 * startKnown honesty rule. ShardReady fires only on a READY dispatch, never
 * on RESUMED, so wiring the same drop onto it cannot double-drop a resume.
 *
 * Offline by design (node:sqlite behind the narrow Db surface, EventEmitter
 * as the gateway bus - same pattern as unit.voiceburst.test.ts): no
 * Postgres, no token, no gateway.
 *
 * What this pins:
 *   1. ShardReady drops open sessions: a join, then a fresh session, then a
 *      leave ends startKnown:false with a null duration.
 *   2. ShardResume keeps its existing drop (the TOG-5695 section-A behavior,
 *      now pinned through the adapter rather than by calling clear() by hand).
 *   3. First-ever ShardReady with an empty tracker is a no-op.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { registerHandlers } from '../src/discord/client.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';
import type { Db, Statement } from '../src/store/db.ts';

const GUILD = '612300000000000001';
const MEMBER = '612300000000000009';
const CHAN_A = 'chan-a';

function wrapStatement(db: DatabaseSync, sql: string): Statement {
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
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL, member_id TEXT, guild_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, metadata TEXT, idempotency_key TEXT NOT NULL UNIQUE
  )`);
  db.exec(`CREATE TABLE members (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
    joined_at TEXT, join_source TEXT, first_message_at TEXT,
    first_voice_at TEXT, last_active_at TEXT, left_at TEXT,
    inactive_flagged_at TEXT, is_bot INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, member_id)
  )`);
  const facade: Db = {
    prepare: (sql) => wrapStatement(db, sql),
    exec: async (sql) => { db.exec(sql); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(facade),
    close: async () => { db.close(); },
  };
  return facade;
}

const invites = {
  diffAndStore: async () => [],
  attribute: () => 'unknown',
  inviterFor: async () => null,
} as unknown as InviteTracker;

/** Minimal voice-state frame; the adapter reads id/guild/channelId/member. */
const vs = (channelId: string | null) => ({
  id: MEMBER,
  guild: { id: GUILD },
  channelId,
  member: { user: { bot: false } },
});

async function waitFor(
  cond: () => Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function liveFixture() {
  const db = openOfflineDb();
  const store = new EventStore(db);
  const handlers = new FunnelHandlers(store);
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { handlers, invites });
  return { db, handlers, bus };
}

type EndMeta = { startKnown: boolean; startedAt: string | null; durationSeconds: number | null };
async function endMetas(db: Db): Promise<EndMeta[]> {
  const rows = await db
    .prepare(`SELECT metadata FROM events WHERE event_type='voice_session_end' ORDER BY id`)
    .all<{ metadata: string }>();
  return rows.map((r) => JSON.parse(r.metadata) as EndMeta);
}

const countByType = (db: Db, type: string) =>
  db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = ?`)
    .get<{ n: number }>(type)
    .then((r) => Number(r?.n ?? 0));

test('fresh session (ShardReady) drops open sessions: post-outage leave ends unknown-start', async () => {
  const { db, handlers, bus } = liveFixture();
  try {
    // Genuinely in voice before the outage: the tracker holds the start.
    bus.emit(Events.VoiceStateUpdate, vs(null), vs(CHAN_A));
    await waitFor(async () => (await countByType(db, 'voice_session_start')) >= 1, 'the pre-outage start');
    assert.equal(handlers.voiceSessions.openCount, 1);

    // Unresumable disconnect -> full re-identify -> READY -> ShardReady.
    bus.emit(Events.ShardReady, 0, new Set());
    assert.equal(handlers.voiceSessions.openCount, 0, 'the fresh session drops the unproven start');

    bus.emit(Events.VoiceStateUpdate, vs(CHAN_A), vs(null));
    await waitFor(async () => (await countByType(db, 'voice_session_end')) >= 1, 'the post-outage end');

    const [end] = await endMetas(db);
    assert.equal(end.startKnown, false, 'the bot did not see this session start');
    assert.equal(end.durationSeconds, null, 'no invented duration across the outage');
    assert.equal(end.startedAt, null);
  } finally {
    await db.close();
  }
});

test('resume (ShardResume) still drops open sessions', async () => {
  const { db, handlers, bus } = liveFixture();
  try {
    bus.emit(Events.VoiceStateUpdate, vs(null), vs(CHAN_A));
    await waitFor(async () => (await countByType(db, 'voice_session_start')) >= 1, 'the pre-resume start');
    assert.equal(handlers.voiceSessions.openCount, 1);

    bus.emit(Events.ShardResume, 0, 0);
    assert.equal(handlers.voiceSessions.openCount, 0);

    bus.emit(Events.VoiceStateUpdate, vs(CHAN_A), vs(null));
    await waitFor(async () => (await countByType(db, 'voice_session_end')) >= 1, 'the post-resume end');

    const [end] = await endMetas(db);
    assert.equal(end.startKnown, false);
    assert.equal(end.durationSeconds, null);
  } finally {
    await db.close();
  }
});

test('first-ever ShardReady with an empty tracker is a no-op', async () => {
  const { db, handlers, bus } = liveFixture();
  try {
    bus.emit(Events.ShardReady, 0, new Set());
    assert.equal(handlers.voiceSessions.openCount, 0);
    assert.equal(await countByType(db, 'voice_session_start'), 0);
    assert.equal(await countByType(db, 'voice_session_end'), 0);
  } finally {
    await db.close();
  }
});
