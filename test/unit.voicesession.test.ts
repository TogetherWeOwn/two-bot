/**
 * Repeatable voice sessions (TOG-99).
 *
 * The two things this event pair exists to make answerable, and which
 * members.last_active_at cannot answer, are asserted directly:
 *
 *   - how OFTEN somebody turns up   -> one start row per visit, forever
 *   - WHEN they turn up             -> occurred_at is the join time, per visit
 *
 * Everything else here is about not lying: a duration we did not measure is
 * null rather than wrong, and adding these rows must not have moved
 * first_voice_session, which the activation funnel is built on.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { EVENT_TYPES, idempotencyKey } from '../src/core/events.ts';
import { VoiceSessionTracker } from '../src/core/voiceSessions.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = '326474832151838730';
const M = '900000000000000001';
const CH = 'c-voice-1';

let harness: TestDb;
let store: EventStore;
let handlers: FunnelHandlers;

before(async () => {
  harness = await openTestDb(import.meta.filename);
});
after(async () => {
  await harness.cleanup();
});
beforeEach(async () => {
  await harness.reset();
  store = new EventStore(harness.db);
  handlers = new FunnelHandlers(store);
});

type Row = {
  event_type: string;
  member_id: string | null;
  occurred_at: string;
  source: string;
  metadata: string | null;
};

const rows = async (type: string): Promise<Row[]> =>
  harness.db
    .prepare(`SELECT * FROM events WHERE event_type = ? ORDER BY occurred_at, id`)
    .all<Row>(type);

const meta = (r: Row): Record<string, unknown> => JSON.parse(r.metadata ?? '{}');

const join = (at: string, channelId = CH) =>
  handlers.onVoiceJoin({ guildId: G, memberId: M, isBot: false, channelId, occurredAt: at });
const leave = (at: string, channelId = CH) =>
  handlers.onVoiceLeave({ guildId: G, memberId: M, isBot: false, channelId, occurredAt: at });

// --- the vocabulary --------------------------------------------------------

test('both session types are in the vocabulary and both repeat', () => {
  assert.ok(EVENT_TYPES.includes('voice_session_start'));
  assert.ok(EVENT_TYPES.includes('voice_session_end'));

  // Repeatability lives in the idempotency key, so that is where it is checked:
  // a repeatable key carries the timestamp, a once-only key does not.
  const at = '2026-08-23T19:00:00.000Z';
  const base = { guildId: G, memberId: M, occurredAt: at, source: `channel:${CH}` };
  // Voice keys also carry the channel (TOG-5981): a move is an end and a
  // start at the SAME instant, so time alone cannot tell two starts apart and
  // the second silently deduped. Same member, same instant, same channel is
  // still one key, so a replayed gateway event still dedupes.
  assert.equal(
    idempotencyKey({ ...base, eventType: 'voice_session_start' }),
    `${G}:${M}:voice_session_start:${at}:channel:${CH}`,
  );
  assert.equal(
    idempotencyKey({ ...base, eventType: 'voice_session_end' }),
    `${G}:${M}:voice_session_end:${at}:channel:${CH}`,
  );
  assert.notEqual(
    idempotencyKey({ ...base, eventType: 'voice_session_start' }),
    idempotencyKey({ ...base, eventType: 'voice_session_start', source: 'channel:chan-b' }),
    'same instant, other channel: a different visit, a different key',
  );
  assert.ok(!idempotencyKey({ ...base, eventType: 'first_voice_session' }).includes(at));
});

// --- session counts: the thing last_active_at cannot do --------------------

test('three visits over three weeks are three rows, not one', async () => {
  const sundays = ['2026-08-02T19:00:00.000Z', '2026-08-09T19:00:00.000Z', '2026-08-16T19:00:00.000Z'];
  for (const s of sundays) {
    await join(s);
    await leave(new Date(Date.parse(s) + 45 * 60_000).toISOString());
  }

  const starts = await rows('voice_session_start');
  assert.equal(starts.length, 3, 'one start per visit');
  assert.deepEqual(starts.map((r) => r.occurred_at), sundays);
  assert.equal((await rows('voice_session_end')).length, 3);

  // The whole point: the member who came back every week is now
  // distinguishable from the member who came back once.
  assert.equal(await store.countByType('voice_session_start'), 3);
  assert.equal(await store.countMembersWith('voice_session_start'), 1);
});

test('the milestone stayed once-per-member while sessions repeated', async () => {
  await join('2026-08-02T19:00:00.000Z');
  await leave('2026-08-02T20:00:00.000Z');
  await join('2026-08-09T19:00:00.000Z');
  await leave('2026-08-09T20:00:00.000Z');

  const first = await rows('first_voice_session');
  assert.equal(first.length, 1, 'activation must not inflate');
  assert.equal(first[0].occurred_at, '2026-08-02T19:00:00.000Z');

  // And the second call returns null, exactly as it did before TOG-99.
  assert.equal(
    await handlers.onVoiceJoin({ guildId: G, memberId: M, isBot: false, channelId: CH }),
    null,
  );
});

// --- time of day / day of week: the other thing it is for ------------------

test('occurred_at carries the real join time, per visit', async () => {
  // A Sunday 19:00 UTC regular and one stray Tuesday lunchtime.
  await join('2026-08-02T19:00:00.000Z');
  await leave('2026-08-02T20:30:00.000Z');
  await join('2026-08-04T12:15:00.000Z');
  await leave('2026-08-04T12:20:00.000Z');

  const hours = (await rows('voice_session_start')).map((r) => new Date(r.occurred_at).getUTCHours());
  assert.deepEqual(hours, [19, 12]);
  const days = (await rows('voice_session_start')).map((r) => new Date(r.occurred_at).getUTCDay());
  assert.deepEqual(days, [0, 2], 'Sunday then Tuesday');
});

// --- durations, and refusing to invent one --------------------------------

test('a full session carries its duration and its start', async () => {
  await join('2026-08-02T19:00:00.000Z');
  await leave('2026-08-02T20:30:00.000Z');

  const end = (await rows('voice_session_end'))[0];
  const m = meta(end);
  assert.equal(m.durationSeconds, 90 * 60);
  assert.equal(m.startedAt, '2026-08-02T19:00:00.000Z');
  assert.equal(m.startKnown, true);
  assert.equal(end.source, `channel:${CH}`);
});

test('a leave we never saw the start of reports null, not a made-up number', async () => {
  // The bot came up while this member was already sitting in voice.
  await leave('2026-08-02T20:30:00.000Z');

  const end = (await rows('voice_session_end'))[0];
  const m = meta(end);
  assert.equal(m.startKnown, false, 'the flag is what makes this filterable');
  assert.equal(m.durationSeconds, null);
  assert.equal(m.startedAt, null);
  assert.equal((await rows('voice_session_start')).length, 0);
});

test('clock skew cannot produce a negative duration', async () => {
  await join('2026-08-02T19:00:05.000Z');
  await leave('2026-08-02T19:00:00.000Z'); // end stamped before the start
  assert.equal(meta((await rows('voice_session_end'))[0]).durationSeconds, 0);
});

// --- channel moves ---------------------------------------------------------

test('moving A to B ends A and starts B, each credited to its own channel', async () => {
  await join('2026-08-02T19:00:00.000Z', 'chan-a');
  // What the adapter does on a move: leave old, join new, same instant.
  await leave('2026-08-02T19:20:00.000Z', 'chan-a');
  await join('2026-08-02T19:20:00.000Z', 'chan-b');
  await leave('2026-08-02T19:50:00.000Z', 'chan-b');

  assert.deepEqual(
    (await rows('voice_session_start')).map((r) => r.source),
    ['channel:chan-a', 'channel:chan-b'],
  );
  assert.deepEqual(
    (await rows('voice_session_end')).map((r) => [r.source, meta(r).durationSeconds]),
    [
      ['channel:chan-a', 20 * 60],
      ['channel:chan-b', 30 * 60],
    ],
  );
});

test('the end is credited to the channel the session opened in', async () => {
  await join('2026-08-02T19:00:00.000Z', 'chan-a');
  // A caller that names the wrong channel on the way out does not get to
  // reattribute the session.
  await leave('2026-08-02T19:10:00.000Z', 'chan-wrong');
  assert.equal((await rows('voice_session_end'))[0].source, 'channel:chan-a');
});

// --- the things that must not have changed --------------------------------

test('bots produce no session rows at all', async () => {
  await handlers.onVoiceJoin({ guildId: G, memberId: M, isBot: true, channelId: CH });
  await handlers.onVoiceLeave({ guildId: G, memberId: M, isBot: true, channelId: CH });
  assert.equal(await store.countByType('voice_session_start'), 0);
  assert.equal(await store.countByType('voice_session_end'), 0);
});

test('both halves advance last_active_at, which AM30 reads', async () => {
  await join('2026-08-02T19:00:00.000Z');
  const afterJoin = await harness.db
    .prepare(`SELECT last_active_at AS t FROM members WHERE guild_id = ? AND member_id = ?`)
    .get<{ t: string }>(G, M);
  assert.equal(afterJoin?.t, '2026-08-02T19:00:00.000Z');

  await leave('2026-08-02T20:30:00.000Z');
  const afterLeave = await harness.db
    .prepare(`SELECT last_active_at AS t FROM members WHERE guild_id = ? AND member_id = ?`)
    .get<{ t: string }>(G, M);
  assert.equal(afterLeave?.t, '2026-08-02T20:30:00.000Z', 'a leave proves presence up to then');
});

test('an out-of-order leave never drags last_active_at backwards', async () => {
  await join('2026-08-02T19:00:00.000Z');
  await leave('2026-08-02T20:30:00.000Z');
  await leave('2026-08-02T19:30:00.000Z'); // a replayed/late gateway event
  const row = await harness.db
    .prepare(`SELECT last_active_at AS t FROM members WHERE guild_id = ? AND member_id = ?`)
    .get<{ t: string }>(G, M);
  assert.equal(row?.t, '2026-08-02T20:30:00.000Z');
});

test('a replayed gateway event does not double-count a session', async () => {
  const at = '2026-08-02T19:00:00.000Z';
  await join(at);
  await join(at); // same instant, same member - the gateway repeated itself
  assert.equal(await store.countByType('voice_session_start'), 1);
});

// --- the tracker on its own ------------------------------------------------

test('the tracker holds one session per member and forgets it on end', () => {
  const t = new VoiceSessionTracker();
  assert.equal(t.openCount, 0);
  t.start(G, M, 'chan-a', '2026-08-02T19:00:00.000Z');
  assert.equal(t.isOpen(G, M), true);
  // A second start replaces rather than accumulates: Discord allows exactly
  // one voice channel at a time.
  t.start(G, M, 'chan-b', '2026-08-02T19:20:00.000Z');
  assert.equal(t.openCount, 1);
  assert.equal(t.end(G, M)?.channelId, 'chan-b');
  assert.equal(t.end(G, M), null, 'ending twice is not an error, it is unknown');
  assert.equal(t.openCount, 0);
});

test('clear() drops open sessions, which is what a reconnect does', () => {
  const t = new VoiceSessionTracker();
  t.start(G, '1', 'chan-a', '2026-08-02T19:00:00.000Z');
  t.start(G, '2', 'chan-a', '2026-08-02T19:00:00.000Z');
  assert.equal(t.openCount, 2);
  t.clear();
  assert.equal(t.openCount, 0);
});
