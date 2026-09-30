/**
 * EventStore.recordEarliest - the guard that lets a once-per-member milestone
 * be corrected downwards by a backfill.
 *
 * This existed with no test. It is the reason the manual attendance log
 * (TWO-66) can be replayed safely and the reason the answer to the ordering
 * question on TOG-99 is "call recordEarliest", so it is worth pinning down.
 *
 * The failure it prevents: a member first speaks at an event while the bot is
 * down; the listener later sees them on some Tuesday and writes
 * first_voice_session at Tuesday's timestamp; the backfill then arrives with
 * the true, earlier time. Plain record() would drop that silently - ON CONFLICT
 * DO NOTHING - and their time-to-voice would be overstated by the whole gap, in
 * the direction that flatters us.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import type { FunnelEvent } from '../src/core/events.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = '1';
const M = 'm1';
const TUESDAY = '2026-09-08T18:00:00.000Z'; // what the listener saw
const TRUE_FIRST = '2026-08-23T00:14:00.000Z'; // what the manual log says

let harness: TestDb;
let store: EventStore;

before(async () => {
  harness = await openTestDb(import.meta.filename);
});
after(async () => {
  await harness.cleanup();
});
beforeEach(async () => {
  await harness.reset();
  store = new EventStore(harness.db);
});

const voice = (occurredAt: string, source: string, metadata?: Record<string, unknown>): FunnelEvent => ({
  guildId: G,
  memberId: M,
  eventType: 'first_voice_session',
  occurredAt,
  source,
  metadata,
});

const row = async () =>
  harness.db
    .prepare(
      `SELECT occurred_at, source, metadata FROM events
        WHERE event_type = 'first_voice_session' AND member_id = ?`,
    )
    .get<{ occurred_at: string; source: string; metadata: string | null }>(M);

const memberFirstVoice = async () =>
  (
    await harness.db
      .prepare(`SELECT first_voice_at AS t FROM members WHERE guild_id = ? AND member_id = ?`)
      .get<{ t: string | null }>(G, M)
  )?.t ?? null;

test('plain record() silently drops the earlier truth - the bug being guarded', async () => {
  await store.record(voice(TUESDAY, 'channel:v1'));
  const second = await store.record(voice(TRUE_FIRST, 'manual:anchor-event'));

  assert.equal(second.inserted, false, 'no error, just discarded');
  assert.equal((await row())?.occurred_at, TUESDAY, 'the wrong, later time survives');
});

test('recordEarliest lets the earlier timestamp win, whichever order they arrive', async () => {
  await store.record(voice(TUESDAY, 'channel:v1'));
  await store.recordEarliest(voice(TRUE_FIRST, 'manual:anchor-event', { backfilled: true }));

  const r = await row();
  assert.equal(r?.occurred_at, TRUE_FIRST);
  assert.equal(r?.source, 'manual:anchor-event', 'the winning row keeps its own attribution');
  assert.deepEqual(JSON.parse(r?.metadata ?? '{}'), { backfilled: true });
  assert.equal(await memberFirstVoice(), TRUE_FIRST, 'the members projection moved too');
});

test('backfill first, listener second: the later event cannot overwrite it', async () => {
  await store.recordEarliest(voice(TRUE_FIRST, 'manual:anchor-event'));
  await store.record(voice(TUESDAY, 'channel:v1'));

  assert.equal((await row())?.occurred_at, TRUE_FIRST);
  assert.equal(await memberFirstVoice(), TRUE_FIRST);
});

test('recordEarliest never moves a timestamp forwards', async () => {
  await store.recordEarliest(voice(TRUE_FIRST, 'manual:anchor-event'));
  const r = await store.recordEarliest(voice(TUESDAY, 'channel:v1'));

  assert.equal(r.inserted, false);
  assert.equal((await row())?.occurred_at, TRUE_FIRST);
  assert.equal((await row())?.source, 'manual:anchor-event', 'and does not reattribute it either');
});

test('re-running the same backfill twice changes nothing', async () => {
  await store.recordEarliest(voice(TRUE_FIRST, 'manual:anchor-event'));
  await store.recordEarliest(voice(TRUE_FIRST, 'manual:anchor-event'));

  assert.equal(await store.countByType('first_voice_session'), 1);
  assert.equal((await row())?.occurred_at, TRUE_FIRST);
});

test('recordEarliest on a fresh member inserts normally', async () => {
  const r = await store.recordEarliest(voice(TRUE_FIRST, 'manual:anchor-event'));
  assert.equal(r.inserted, true);
  assert.equal(await memberFirstVoice(), TRUE_FIRST);
});

for (const eventType of ['first_message', 'first_voice_session'] as const) {
  const milestoneColumn = eventType === 'first_message' ? 'first_message_at' : 'first_voice_at';
  for (const method of ['record', 'recordEarliest'] as const) {
    for (const activityFirst of [true, false]) {
      test(`${method}: ${eventType} preserves recency with ${activityFirst ? 'activity' : 'milestone'} first and duplicate delivery`, async () => {
        const milestone: FunnelEvent = {
          guildId: G,
          memberId: M,
          eventType,
          occurredAt: TRUE_FIRST,
          source: 'manual:anchor-event',
        };
        const projection = () =>
          harness.db
            .prepare(
              `SELECT ${milestoneColumn} AS milestone_at, last_active_at FROM members
                WHERE guild_id = ? AND member_id = ?`,
            )
            .get<{ milestone_at: string | null; last_active_at: string | null }>(G, M);

        if (activityFirst) {
          await store.touchActivity(G, M, TUESDAY);
          assert.deepEqual(await projection(), { milestone_at: null, last_active_at: TUESDAY });
        }
        const first = await store[method](milestone);
        assert.equal(first.inserted, true);
        assert.deepEqual(await projection(), {
          milestone_at: TRUE_FIRST,
          last_active_at: activityFirst ? TUESDAY : TRUE_FIRST,
        });
        if (!activityFirst) await store.touchActivity(G, M, TUESDAY);

        const duplicate = await store[method](milestone);
        assert.equal(duplicate.inserted, false);
        assert.equal(duplicate.eventId, first.eventId);
        assert.equal(await store.countByType(eventType, G), 1);
        const event = await harness.db
          .prepare(`SELECT occurred_at FROM events WHERE id = ?`)
          .get<{ occurred_at: string }>(first.eventId);
        assert.equal(event?.occurred_at, TRUE_FIRST);
        assert.deepEqual(await projection(), { milestone_at: TRUE_FIRST, last_active_at: TUESDAY });
      });
    }
  }
}

test('an equal timestamp is a no-op, not a rewrite', async () => {
  await store.record(voice(TRUE_FIRST, 'channel:v1'));
  await store.recordEarliest(voice(TRUE_FIRST, 'manual:anchor-event'));
  assert.equal((await row())?.source, 'channel:v1', 'no change means no reattribution');
});

test('first_message gets the same protection', async () => {
  const msg = (occurredAt: string, source: string): FunnelEvent => ({
    guildId: G,
    memberId: M,
    eventType: 'first_message',
    occurredAt,
    source,
  });
  await store.record(msg(TUESDAY, 'channel:general'));
  await store.recordEarliest(msg(TRUE_FIRST, 'manual:anchor-event'));

  const r = await harness.db
    .prepare(`SELECT occurred_at AS t FROM events WHERE event_type = 'first_message' AND member_id = ?`)
    .get<{ t: string }>(M);
  assert.equal(r?.t, TRUE_FIRST);
  const m = await harness.db
    .prepare(`SELECT first_message_at AS t FROM members WHERE guild_id = ? AND member_id = ?`)
    .get<{ t: string }>(G, M);
  assert.equal(m?.t, TRUE_FIRST);
});
