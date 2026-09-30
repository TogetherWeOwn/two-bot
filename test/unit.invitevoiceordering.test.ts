// TOG-8306: delayed voice frames must respect reconnects and newer activity.
// Real handlers and SQL projections, with an in-memory SQLite Db facade only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Events, type Client } from 'discord.js';
import { registerHandlers } from '../src/discord/client.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';
import type { Db, Statement } from '../src/store/db.ts';

const GUILD = '612300000000000001';
const MEMBER = '612300000000000009';
const START = Date.parse('2026-09-30T14:00:00Z');
const iso = (offset: number) => new Date(START + offset).toISOString();
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL, member_id TEXT, guild_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, metadata TEXT, idempotency_key TEXT NOT NULL UNIQUE
  ); CREATE TABLE members (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
    joined_at TEXT, join_source TEXT, gate_cleared_at TEXT, first_message_at TEXT,
    first_voice_at TEXT, last_active_at TEXT, left_at TEXT,
    inactive_flagged_at TEXT, is_bot INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, member_id)
  )`);
  const db: Db = {
    prepare(sql): Statement {
      const stmt = sqlite.prepare(sql);
      return {
        get: async <T>(...args: unknown[]) => stmt.get(...args as never[]) as T | undefined,
        all: async <T>(...args: unknown[]) => stmt.all(...args as never[]) as T[],
        run: async (...args: unknown[]) => ({ changes: Number(stmt.run(...args as never[]).changes) }),
      };
    },
    exec: async (sql) => { sqlite.exec(sql); },
    transaction: async (fn) => fn(db),
    close: async () => { sqlite.close(); },
  };
  const store = new EventStore(db);
  const handlers = new FunnelHandlers(store);
  const bus = new EventEmitter();
  const invites = {
    diffAndStore: async () => [], attribute: () => 'unknown', inviterFor: async () => null,
  } as unknown as InviteTracker;
  registerHandlers(bus as unknown as Client, { handlers, invites });
  const release = deferred();
  const started = deferred();
  const guild = {
    id: GUILD, vanityURLCode: null,
    invites: { fetch: async () => { started.resolve(); await release.promise; return []; } },
  };
  const member = { id: MEMBER, guild, user: { bot: false }, pending: true, joinedAt: new Date(START) };
  const voice = (from: string | null, to: string | null) => {
    const state = { id: MEMBER, guild, member };
    bus.emit(Events.VoiceStateUpdate, { ...state, channelId: from }, { ...state, channelId: to });
  };
  const ends = async () => {
    const rows = await db.prepare("SELECT metadata FROM events WHERE event_type='voice_session_end' ORDER BY id")
      .all<{ metadata: string }>();
    return rows.map((r) => JSON.parse(r.metadata));
  };
  return { db, store, handlers, bus, member, voice, ends, started, release };
}

for (const event of [Events.ShardResume, Events.ShardReady]) {
  test(`queued pre-outage voice start stays invalid after ${event}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: START });
    const f = fixture();
    try {
      f.bus.emit(Events.GuildMemberAdd, f.member);
      await f.started.promise;
      f.voice(null, 'voice-old');
      t.mock.timers.setTime(START + 60_000);
      f.bus.emit(event, 0, new Set());
      assert.equal(f.handlers.voiceSessions.openCount, 0);
      f.release.resolve();
      await flush();
      t.mock.timers.setTime(START + 120_000);
      f.voice('voice-old', null);
      await flush();
      const [end] = await f.ends();
      assert.equal(end.startKnown, false);
      assert.equal(end.startedAt, null);
      assert.equal(end.durationSeconds, null);
      // A fresh frame after recovery still establishes a measured session.
      f.voice(null, 'voice-new');
      await flush();
      t.mock.timers.setTime(START + 150_000);
      f.voice('voice-new', null);
      await flush();
      const [, freshEnd] = await f.ends();
      assert.equal(freshEnd.startKnown, true);
      assert.equal(freshEnd.durationSeconds, 30);
    } finally {
      f.release.resolve();
      await flush();
      await f.db.close();
    }
  });
}

for (const event of [Events.ShardResume, Events.ShardReady]) {
  test(`in-flight move cannot open its destination after ${event}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: START });
    const f = fixture();
    const moving = deferred();
    const releaseMove = deferred();
    const onLeave = f.handlers.onVoiceLeave.bind(f.handlers);
    f.handlers.onVoiceLeave = async (input) => {
      const result = await onLeave(input);
      moving.resolve();
      await releaseMove.promise;
      return result;
    };
    try {
      f.voice(null, 'voice-old');
      await flush();
      t.mock.timers.setTime(START + 30_000);
      f.voice('voice-old', 'voice-stale');
      await moving.promise;
      t.mock.timers.setTime(START + 60_000);
      f.bus.emit(event, 0, new Set());
      assert.equal(f.handlers.voiceSessions.openCount, 0);
      releaseMove.resolve();
      await flush();
      assert.equal(f.handlers.voiceSessions.openCount, 0, 'old move must not resurrect a session');
      f.voice('voice-stale', 'voice-fresh');
      await flush();
      assert.equal(f.handlers.voiceSessions.peek(GUILD, MEMBER)?.channelId, 'voice-fresh');
      assert.equal(f.handlers.voiceSessions.peek(GUILD, MEMBER)?.startedAt, iso(60_000));
      const [, gap] = await f.ends();
      assert.equal(gap.startKnown, false);
    } finally {
      releaseMove.resolve();
      await flush();
      await f.db.close();
    }
  });
}

for (const event of [Events.ShardResume, Events.ShardReady]) {
  test(`in-flight start cannot reopen the tracker after ${event}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: START });
    const f = fixture();
    const writing = deferred();
    const releaseWrite = deferred();
    const record = f.store.record.bind(f.store);
    f.store.record = async (input) => {
      const result = await record(input);
      if (input.eventType === 'voice_session_start') {
        writing.resolve();
        await releaseWrite.promise;
      }
      return result;
    };
    try {
      f.voice(null, 'voice-old');
      await writing.promise;
      t.mock.timers.setTime(START + 60_000);
      f.bus.emit(event, 0, new Set());
      assert.equal(f.handlers.voiceSessions.openCount, 0);
      releaseWrite.resolve();
      await flush();
      assert.equal(f.handlers.voiceSessions.openCount, 0, 'in-flight persistence cannot undo recovery');
      t.mock.timers.setTime(START + 120_000);
      f.voice('voice-old', null);
      await flush();
      const [end] = await f.ends();
      assert.equal(end.startKnown, false);
      assert.equal(end.startedAt, null);
      assert.equal(end.durationSeconds, null);
      assert.equal(await f.store.hasEvent(GUILD, MEMBER, 'voice_session_start'), true,
        'already-observed historical writes are not erased by recovery');
    } finally {
      releaseWrite.resolve();
      await flush();
      await f.db.close();
    }
  });
}

for (const eventType of ['first_message', 'first_voice_session'] as const) {
  test(`${eventType} projection preserves newer activity`, async () => {
    const f = fixture();
    try {
      await f.store.touchActivity(GUILD, MEMBER, iso(60_000));
      await f.store.record({ guildId: GUILD, memberId: MEMBER, eventType,
        occurredAt: iso(0), source: 'channel:test' });
      const row = await f.db.prepare('SELECT last_active_at, first_message_at, first_voice_at FROM members WHERE member_id = ?')
        .get<{ last_active_at: string; first_message_at: string | null; first_voice_at: string | null }>(MEMBER);
      assert.equal(row?.last_active_at, iso(60_000));
      assert.equal(eventType === 'first_message' ? row?.first_message_at : row?.first_voice_at, iso(0));
    } finally { await f.db.close(); }
  });
}

test('delayed voice receipt does not rewind newer message recency', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const f = fixture();
  const recency = () => f.db.prepare('SELECT last_active_at FROM members WHERE member_id = ?')
    .get<{ last_active_at: string }>(MEMBER);
  try {
    f.bus.emit(Events.GuildMemberAdd, f.member);
    await f.started.promise;
    f.voice(null, 'voice-old');
    t.mock.timers.setTime(START + 60_000);
    f.bus.emit(Events.MessageCreate, {
      guildId: GUILD, channelId: 'text', id: 'message-after-voice',
      author: { id: MEMBER, bot: false }, member: null, webhookId: null,
      createdTimestamp: START + 60_000,
    });
    await flush();
    assert.equal((await recency())?.last_active_at, iso(60_000));
    t.mock.timers.setTime(START + 120_000);
    f.release.resolve();
    await flush();
    assert.equal((await recency())?.last_active_at, iso(60_000));
    assert.equal(f.handlers.voiceSessions.peek(GUILD, MEMBER)?.startedAt, iso(0));
  } finally {
    f.release.resolve();
    await flush();
    await f.db.close();
  }
});
