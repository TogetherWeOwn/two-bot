/**
 * TOG-5981: back-to-back voice frames for one member must not race.
 *
 * discord.js dispatches every gateway event to its async listener without
 * awaiting the previous one, so two VOICE_STATE_UPDATE frames for one member
 * on the same tick interleaved: the move's `onVoiceLeave` chain-read the
 * tracker BEFORE the join's `onVoiceJoin` chain-wrote it, and the end landed
 * startKnown:false with a null duration even though the bot saw the start.
 * Burst variants also reordered (end before its start) and one round dropped
 * the destination-channel start entirely - that half was the idempotency key,
 * which keyed repeatable events by member+instant only, so two same-instant
 * starts for different channels shared one key and the second deduped.
 *
 * Offline by design (node:sqlite behind the narrow Db surface, same facade
 * pattern as unit.voiceonboarding-exploratory.test.ts): no Postgres, no
 * token, no gateway.
 *
 * What this pins:
 *   1. adapter serialization: a join whose handler is still in flight holds
 *      the same member's next frame behind it (per-member chain, TOG-3695
 *      precedent). Deterministic: the join handler waits on a gate the test
 *      owns, so on the old code the move's leave observably runs first.
 *   2. key disambiguation: two same-instant starts for different channels are
 *      two rows; replaying the same channel+instant is still one row.
 *   3. join+move on the same tick through the real adapter + real handlers:
 *      the end is startKnown:true and both starts land.
 *   4. double move A->B->A on the same tick after a settled open session:
 *      both ends are startKnown:true - no phantom unknown end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { registerHandlers } from '../src/discord/client.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers, type VoiceInput } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';
import type { Db, Statement } from '../src/store/db.ts';

const GUILD = '326474832151838731';
const MEMBER = '900000000000000009';
const CHAN_A = 'chan-a';
const CHAN_B = 'chan-b';

// --- offline Db facade (same pattern as unit.voiceonboarding-exploratory) ---

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

// --- small helpers ------------------------------------------------------------

const invites = {
  diffAndStore: async () => [],
  attribute: () => 'unknown',
  inviterFor: async () => null,
} as unknown as InviteTracker;

/** Minimal voice-state frame pair; the adapter reads id/guild/channelId/member. */
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

const countByType = (db: Db, type: string) =>
  db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = ?`)
    .get<{ n: number }>(type)
    .then((r) => Number(r?.n ?? 0));

type EndMeta = { startKnown: boolean; startedAt: string | null; durationSeconds: number | null };
async function endMetas(db: Db): Promise<EndMeta[]> {
  const rows = await db
    .prepare(`SELECT metadata FROM events WHERE event_type='voice_session_end' ORDER BY id`)
    .all<{ metadata: string }>();
  return rows.map((r) => JSON.parse(r.metadata) as EndMeta);
}

async function startSources(db: Db): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT source FROM events WHERE event_type='voice_session_start' ORDER BY id`)
    .all<{ source: string }>();
  return rows.map((r) => r.source);
}

// --- 1. the adapter serializes same-member frames -----------------------------

test('back-to-back frames for one member run in dispatch order, not interleave', async () => {
  const log: string[] = [];
  let releaseJoin!: () => void;
  const gate = new Promise<void>((resolve) => { releaseJoin = resolve; });
  const handlers = {
    onJoin: async () => null,
    onGateCleared: async () => null,
    onLeave: async () => null,
    onMessage: async () => null,
    onVoiceJoin: async (_i: VoiceInput) => {
      log.push('join-enter');
      await gate;
      log.push('join-write');
      return null;
    },
    onVoiceLeave: async (_i: VoiceInput) => {
      log.push('leave');
      return null;
    },
    voiceSessions: { openCount: 0, clear() {} },
  } as unknown as FunnelHandlers;
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { handlers, invites });

  // Join immediately followed by a move, same tick - the TOG-5981 shape.
  bus.emit(Events.VoiceStateUpdate, vs(null), vs(CHAN_A));
  bus.emit(Events.VoiceStateUpdate, vs(CHAN_A), vs(CHAN_B));

  // The chain defers through a promise, so drain microtasks - then the join
  // handler is gated mid-flight. If frames ran concurrently, the move's leave
  // would already be in the log; chained, it waits behind the join. The gated
  // promise never resolves here, so no further step can advance meanwhile.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['join-enter'], 'the move must not run ahead of the in-flight join');

  releaseJoin();
  await waitFor(async () => log.length >= 5, 'the move to finish (leave + its own join)');
  assert.deepEqual(
    log,
    // Frame 1 (join A): enter, write. Frame 2 (move A->B): leave, then its own
    // enter, write. The leave sits AFTER the join-write: the move could not
    // read the tracker before the join wrote it - the TOG-5981 interleaving.
    ['join-enter', 'join-write', 'leave', 'join-enter', 'join-write'],
    'the move lands after the join it follows, in dispatch order',
  );
});

test('a stuck frame for one member never stalls an unrelated member', async () => {
  const log: string[] = [];
  let releaseJoin!: () => void;
  const gate = new Promise<void>((resolve) => { releaseJoin = resolve; });
  const handlers = {
    onJoin: async () => null,
    onGateCleared: async () => null,
    onLeave: async () => null,
    onMessage: async () => null,
    onVoiceJoin: async (i: VoiceInput) => {
      log.push(`join-enter:${i.memberId}`);
      if (i.memberId === MEMBER) await gate;
      log.push(`join-write:${i.memberId}`);
      return null;
    },
    onVoiceLeave: async () => null,
    voiceSessions: { openCount: 0, clear() {} },
  } as unknown as FunnelHandlers;
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { handlers, invites });

  const other = (channelId: string | null) => ({
    id: '900000000000000010',
    guild: { id: GUILD },
    channelId,
    member: { user: { bot: false } },
  });
  bus.emit(Events.VoiceStateUpdate, vs(null), vs(CHAN_A)); // stuck behind the gate
  bus.emit(Events.VoiceStateUpdate, other(null), other(CHAN_A)); // unrelated member

  await waitFor(
    async () => log.includes('join-write:900000000000000010'),
    'the unrelated member to finish',
  );
  assert.ok(!log.includes('join-write:' + MEMBER), 'the stuck member is still gated');
  releaseJoin();
  await waitFor(async () => log.includes('join-write:' + MEMBER), 'the stuck member to finish');
});

// --- 2. the key tells same-instant starts apart by channel --------------------

test('same-instant starts for different channels are two rows; a same-channel replay is one', async () => {
  const db = openOfflineDb();
  try {
    const store = new EventStore(db);
    const at = '2026-08-02T19:00:00.000Z';
    const start = (channelId: string) =>
      store.record({
        guildId: GUILD, memberId: MEMBER, eventType: 'voice_session_start',
        occurredAt: at, source: `channel:${channelId}`,
      });
    await start(CHAN_A);
    await start(CHAN_B);
    assert.equal(
      await countByType(db, 'voice_session_start'), 2,
      'a move is two visits at one instant - dropping either loses a session',
    );
    await start(CHAN_A); // the gateway repeated itself
    assert.equal(
      await countByType(db, 'voice_session_start'), 2,
      'same member, same instant, same channel is still a replay, not a visit',
    );
  } finally {
    await db.close();
  }
});

// --- 3+4. real adapter + real handlers over the offline store -----------------

function liveFixture() {
  const db = openOfflineDb();
  const store = new EventStore(db);
  const handlers = new FunnelHandlers(store);
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { handlers, invites });
  return { db, handlers, bus };
}

test('join+move on the same tick: the end knows its start and both starts land', async () => {
  const { db, bus } = liveFixture();
  try {
    bus.emit(Events.VoiceStateUpdate, vs(null), vs(CHAN_A));
    bus.emit(Events.VoiceStateUpdate, vs(CHAN_A), vs(CHAN_B));

    await waitFor(async () => (await countByType(db, 'voice_session_end')) >= 1, 'the end row');
    await waitFor(async () => (await countByType(db, 'voice_session_start')) >= 2, 'both start rows');

    const [end] = await endMetas(db);
    assert.equal(end.startKnown, true, 'the bot saw the start on the previous frame');
    assert.ok(
      typeof end.durationSeconds === 'number' && end.durationSeconds >= 0,
      `a live end carries a real duration, got ${end.durationSeconds}`,
    );
    assert.deepEqual(
      await startSources(db),
      [`channel:${CHAN_A}`, `channel:${CHAN_B}`],
      'both visits are recorded, in occurred order',
    );
  } finally {
    await db.close();
  }
});

test('double move A->B->A on the same tick: both ends know their starts', async () => {
  const { db, handlers, bus } = liveFixture();
  try {
    // Settle the opening session first: the member is genuinely in A.
    await handlers.onVoiceJoin({
      guildId: GUILD, memberId: MEMBER, isBot: false,
      channelId: CHAN_A, occurredAt: '2026-08-02T19:00:00.000Z',
    });
    bus.emit(Events.VoiceStateUpdate, vs(CHAN_A), vs(CHAN_B));
    bus.emit(Events.VoiceStateUpdate, vs(CHAN_B), vs(CHAN_A));

    await waitFor(async () => (await countByType(db, 'voice_session_end')) >= 2, 'both end rows');

    const ends = await endMetas(db);
    assert.equal(ends.length, 2, 'two moves close two sessions - no phantom third end');
    assert.ok(
      ends.every((e) => e.startKnown === true),
      'every racing end was preceded by its start in the same chain',
    );
  } finally {
    await db.close();
  }
});
