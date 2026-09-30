/**
 * TOG-7197: voice session lifecycle matrix (join/leave/close-on-leave).
 *
 * Seeds open sessions, server-leaves, and partial halves through the real
 * FunnelHandlers against isolated test Postgres; asserts durations and
 * that no session is left dangling open.
 *
 * No Discord token or gateway; the card-scoped test DB exercises the shipping
 * membership projection and its PostgreSQL locking/JSON behavior.
 *
 * What this pins (all passing, all current behavior):
 *   A. full session: join -> leave carries duration + start, credited channel.
 *   B. move A -> B: end(A) then start(B), each credited to its own channel.
 *   C. server-leave mid-voice (c24113f2): end credited to the open channel,
 *      duration measured to leave time, tracker closed, member_leave lands.
 *   D. server-leave with no open session: no end row, tracker untouched.
 *   E. partial join: an open session with no leave yet is visible in the
 *      tracker with no end row; the leave that follows closes it honestly.
 *   F. partial leave: a leave with no seen start ends startKnown:false with
 *      a null duration, credited to the caller's channel.
 *   G. dangling-open scan: a start for a member with a later member_leave
 *      but no end at/after the start. Pre-c24113f2 every server-leave
 *      mid-voice landed here; the scan must be empty. The test also proves
 *      the scan bites: a synthetic dangling pair inserted past the handlers
 *      is found, then cleared by the matching leave.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import type { Db } from '../src/store/db.ts';
import { openTestDb } from './helpers/testDb.ts';

const G = 'g7197';
const CH_A = 'chan-a';
const CH_B = 'chan-b';

async function fixture() {
  const harness = await openTestDb(import.meta.filename);
  const db = harness.db;
  const store = new EventStore(db);
  const handlers = new FunnelHandlers(store);
  return { db, store, handlers, cleanup: harness.cleanup };
}

type EndMeta = { startKnown: boolean; startedAt: string | null; durationSeconds: number | null };
async function endMetas(db: Db, memberId: string): Promise<EndMeta[]> {
  const rows = await db
    .prepare(`SELECT metadata FROM events WHERE event_type='voice_session_end' AND member_id=? ORDER BY id`)
    .all<{ metadata: string }>(memberId);
  return rows.map((r) => JSON.parse(r.metadata) as EndMeta);
}
async function countByType(db: Db, type: string, memberId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type=? AND member_id=?`)
    .get<{ n: number }>(type, memberId);
  return Number(row?.n ?? 0);
}

/**
 * Dangling-open scan (the acceptance query).
 *
 * A `voice_session_start` for a member with a LATER `member_leave` but NO
 * `voice_session_end` at/after the start is a session the server-leave
 * orphaned: the member is gone, the tracker entry (pre-c24113f2) stayed open,
 * and no end row will ever account for the visit. ISO-8601 UTC compares
 * lexicographically, so `>=` on the raw column is a time comparison.
 */
export async function findDanglingVoiceStarts(
  db: Db,
): Promise<Array<{ member_id: string; started_at: string }>> {
  return db
    .prepare(
      `SELECT s.member_id AS member_id, s.occurred_at AS started_at
         FROM events s
        WHERE s.event_type = 'voice_session_start'
          AND EXISTS (
            SELECT 1 FROM events l
             WHERE l.event_type = 'member_leave'
               AND l.member_id = s.member_id
               AND l.occurred_at >= s.occurred_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.event_type = 'voice_session_end'
               AND e.member_id = s.member_id
               AND e.occurred_at >= s.occurred_at
          )
        ORDER BY s.occurred_at`,
    )
    .all<{ member_id: string; started_at: string }>();
}

// --- A. full session ---------------------------------------------------------

test('lifecycle: join then leave carries its duration and its start', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onVoiceJoin({ guildId: G, memberId: 'full', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:00:00.000Z' });
    await handlers.onVoiceLeave({ guildId: G, memberId: 'full', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T20:30:00.000Z' });
    const [end] = await endMetas(db, 'full');
    assert.equal(end.startKnown, true);
    assert.equal(end.startedAt, '2026-08-02T19:00:00.000Z');
    assert.equal(end.durationSeconds, 90 * 60);
    const row = await db
      .prepare(`SELECT source FROM events WHERE event_type='voice_session_end' AND member_id=?`)
      .get<{ source: string }>('full');
    assert.equal(row?.source, 'channel:chan-a');
    assert.equal(handlers.voiceSessions.openCount, 0, 'nothing left open');
  } finally {
    await cleanup();
  }
});

// --- B. channel move ----------------------------------------------------------

test('lifecycle: move A to B ends A and starts B with split durations', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onVoiceJoin({ guildId: G, memberId: 'mover', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:00:00.000Z' });
    // What the adapter does on a move: leave old, join new, same instant.
    await handlers.onVoiceLeave({ guildId: G, memberId: 'mover', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:20:00.000Z' });
    await handlers.onVoiceJoin({ guildId: G, memberId: 'mover', isBot: false, channelId: CH_B, occurredAt: '2026-08-02T19:20:00.000Z' });
    await handlers.onVoiceLeave({ guildId: G, memberId: 'mover', isBot: false, channelId: CH_B, occurredAt: '2026-08-02T19:50:00.000Z' });
    const ends = await endMetas(db, 'mover');
    assert.equal(ends.length, 2);
    assert.deepEqual(ends.map((e) => e.durationSeconds), [20 * 60, 30 * 60]);
    assert.ok(ends.every((e) => e.startKnown), 'both halves measured');
    assert.equal(handlers.voiceSessions.openCount, 0, 'nothing left open');
  } finally {
    await cleanup();
  }
});

// --- C. server-leave mid-voice (c24113f2) --------------------------------------

test('lifecycle: server-leave mid-voice closes the session to leave time', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onVoiceJoin({ guildId: G, memberId: 'leaver', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:00:00.000Z' });
    await handlers.onLeave(G, 'leaver', '2026-08-02T19:30:00.000Z');
    const [end] = await endMetas(db, 'leaver');
    assert.equal(end.startKnown, true, 'the bot saw this session start');
    assert.equal(end.startedAt, '2026-08-02T19:00:00.000Z');
    assert.equal(end.durationSeconds, 30 * 60, 'measured to leave time');
    const row = await db
      .prepare(`SELECT source FROM events WHERE event_type='voice_session_end' AND member_id=?`)
      .get<{ source: string }>('leaver');
    assert.equal(row?.source, 'channel:chan-a', 'credited to the open channel');
    assert.equal(handlers.voiceSessions.isOpen(G, 'leaver'), false, 'tracker entry closed, not leaked');
    assert.equal(await countByType(db, 'member_leave', 'leaver'), 1, 'the gone marker still lands');
  } finally {
    await cleanup();
  }
});

// --- D. server-leave with no open session ---------------------------------------

test('lifecycle: server-leave with no open session writes no end row', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onLeave(G, 'quiet', '2026-08-02T19:30:00.000Z');
    assert.equal(await countByType(db, 'voice_session_end', 'quiet'), 0, 'no session open, nothing to close');
    assert.equal(await countByType(db, 'member_leave', 'quiet'), 1);
    assert.equal(handlers.voiceSessions.openCount, 0);
  } finally {
    await cleanup();
  }
});

// --- E. partial join: open until the leave lands ---------------------------------

test('lifecycle: a join with no leave yet is open, not dangling', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onVoiceJoin({ guildId: G, memberId: 'partial', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:00:00.000Z' });
    assert.equal(handlers.voiceSessions.isOpen(G, 'partial'), true, 'the session is open');
    assert.equal(await countByType(db, 'voice_session_end', 'partial'), 0, 'no end yet, honestly');
    assert.deepEqual(await findDanglingVoiceStarts(db), [], 'open is not dangling: the member has not left');
    await handlers.onVoiceLeave({ guildId: G, memberId: 'partial', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:45:00.000Z' });
    const [end] = await endMetas(db, 'partial');
    assert.equal(end.durationSeconds, 45 * 60);
    assert.equal(handlers.voiceSessions.openCount, 0);
  } finally {
    await cleanup();
  }
});

// --- F. partial leave: unknown start ----------------------------------------------

test('lifecycle: a leave with no seen start ends unknown-start with no duration', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    // The bot came up while this member was already sitting in voice.
    await handlers.onVoiceLeave({ guildId: G, memberId: 'unknown', isBot: false, channelId: CH_B, occurredAt: '2026-08-02T20:30:00.000Z' });
    const [end] = await endMetas(db, 'unknown');
    assert.equal(end.startKnown, false, 'the flag is what makes this filterable');
    assert.equal(end.durationSeconds, null, 'no invented duration');
    assert.equal(end.startedAt, null);
    const row = await db
      .prepare(`SELECT source FROM events WHERE event_type='voice_session_end' AND member_id=?`)
      .get<{ source: string }>('unknown');
    assert.equal(row?.source, 'channel:chan-b', 'no open session: credit the caller channel');
    assert.equal(await countByType(db, 'voice_session_start', 'unknown'), 0);
  } finally {
    await cleanup();
  }
});

// --- F2. malformed leave timestamp (TOG-7512) -----------------------------------------
//
// A garbage occurredAt on the leave must not write the lying row:
// startKnown:true with a null duration. Date.parse garbage is NaN, NaN
// survived Math.max/Math.round (still !== null, so the leveling branch fired
// with amount NaN), and JSON.stringify(NaN) stored null. The honest row is
// the bot-down unknown-start one: startKnown:false, nulls, tracker closed,
// and a parseable occurred_at (raw garbage would throw on Postgres
// timestamptz, so "no throw" must hold on both backends).

test('lifecycle: a malformed leave timestamp ends unknown-start, never the lying row', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onVoiceJoin({ guildId: G, memberId: 'garbage-leave', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:00:00.000Z' });
    const end = await handlers.onVoiceLeave({ guildId: G, memberId: 'garbage-leave', isBot: false, channelId: CH_A, occurredAt: 'not-a-date' });
    const [meta] = await endMetas(db, 'garbage-leave');
    assert.equal(meta.startKnown, false, 'unmeasurable, not a KNOWN start with no duration');
    assert.equal(meta.durationSeconds, null);
    assert.equal(meta.startedAt, null);
    assert.equal(handlers.voiceSessions.isOpen(G, 'garbage-leave'), false, 'tracker entry closed, not leaked');
    const row = await db
      .prepare(`SELECT occurred_at, source FROM events WHERE event_type='voice_session_end' AND member_id=?`)
      .get<{ occurred_at: string; source: string }>('garbage-leave');
    assert.ok(Number.isFinite(Date.parse(row?.occurred_at ?? '')), 'occurred_at is a real timestamp, not the raw garbage');
    assert.deepEqual(
      (end?.metadata ?? {}) as object,
      { startKnown: false, startedAt: null, durationSeconds: null },
      'returned metadata matches the stored row',
    );
    assert.equal(row?.source, 'channel:chan-a', 'credited to the open channel');
  } finally {
    await cleanup();
  }
});

test('lifecycle: a malformed join start is equally unmeasurable on the way out', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    // Corrupt the in-memory tracker only: Postgres correctly rejects invalid event timestamps.
    handlers.voiceSessions.start(G, 'garbage-start', CH_A, 'also-not-a-date');
    await handlers.onVoiceLeave({ guildId: G, memberId: 'garbage-start', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T20:30:00.000Z' });
    const [meta] = await endMetas(db, 'garbage-start');
    assert.equal(meta.startKnown, false, 'a start we could never read is not a KNOWN start');
    assert.equal(meta.durationSeconds, null);
    assert.equal(meta.startedAt, null);
    assert.equal(handlers.voiceSessions.isOpen(G, 'garbage-start'), false);
  } finally {
    await cleanup();
  }
});

// --- G. dangling-open scan ----------------------------------------------------------

test('lifecycle: dangling-open scan is empty across the matrix and bites on a synthetic orphan', async () => {
  const { db, store, handlers, cleanup } = await fixture();
  try {
    // The matrix: a full session, a server-leave close, a quiet leave, and an
    // unknown-start leave. None of these may leave a start unaccounted for.
    await handlers.onVoiceJoin({ guildId: G, memberId: 'm-full', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:00:00.000Z' });
    await handlers.onVoiceLeave({ guildId: G, memberId: 'm-full', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T20:00:00.000Z' });
    await handlers.onVoiceJoin({ guildId: G, memberId: 'm-leaver', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:00:00.000Z' });
    await handlers.onLeave(G, 'm-leaver', '2026-08-02T19:30:00.000Z');
    await handlers.onLeave(G, 'm-quiet', '2026-08-02T19:30:00.000Z');
    await handlers.onVoiceLeave({ guildId: G, memberId: 'm-unknown', isBot: false, channelId: CH_B, occurredAt: '2026-08-02T20:30:00.000Z' });
    assert.equal(handlers.voiceSessions.openCount, 0, 'no tracker entry left open');
    assert.deepEqual(await findDanglingVoiceStarts(db), [], 'no start left unaccounted for');

    // The scan is not vacuous: a start + later leave with no end (the exact
    // pre-c24113f2 shape), inserted past the handlers, is found.
    await store.record({ guildId: G, memberId: 'm-orphan', eventType: 'voice_session_start', occurredAt: '2026-08-02T19:00:00.000Z', source: 'channel:chan-a' });
    await store.record({ guildId: G, memberId: 'm-orphan', eventType: 'member_leave', occurredAt: '2026-08-02T19:30:00.000Z', source: 'gateway' });
    const found = await findDanglingVoiceStarts(db);
    assert.equal(found.length, 1, 'the synthetic orphan is caught');
    assert.equal(found[0].member_id, 'm-orphan');
    assert.equal(found[0].started_at, '2026-08-02T19:00:00.000Z');

    // And the matching leave clears it: the end lands unknown-start with no
    // invented duration, and the scan is green again.
    await handlers.onVoiceLeave({ guildId: G, memberId: 'm-orphan', isBot: false, channelId: CH_A, occurredAt: '2026-08-02T19:30:00.000Z' });
    const [orphanEnd] = await endMetas(db, 'm-orphan');
    assert.equal(orphanEnd.startKnown, false);
    assert.equal(orphanEnd.durationSeconds, null);
    assert.deepEqual(await findDanglingVoiceStarts(db), [], 'scan green again');
  } finally {
    await cleanup();
  }
});
