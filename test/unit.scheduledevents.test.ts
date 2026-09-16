import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../src/store/db.ts';
import { openEphemeralTestDb as openDb } from './helpers/testDb.ts';
import {
  runScheduledEventsCycle,
  SCHEDULED_EVENTS_INTERVAL_MS,
} from '../src/jobs/scheduledEvents.ts';
import { stubRest } from './helpers/stubRest.ts';

const GUILD = '326474832151838730';
const OBSERVED_AT = '2026-09-04T18:00:00.000Z';

describe('scheduled events poller', () => {
  let db: Db;

  before(async () => {
    db = await openDb();
  });
  after(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('DELETE FROM scheduled_events');
  });

  test('polls the Discord scheduled-events endpoint every ten minutes', async () => {
    assert.equal(SCHEDULED_EVENTS_INTERVAL_MS, 10 * 60 * 1000);
    const { rest, paths } = stubRest(() => []);
    await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.deepEqual(paths, [`/guilds/${GUILD}/scheduled-events`]);
  });

  test('stores the fields used by the web contract', async () => {
    const { rest } = stubRest(() => [
      {
        id: 'event-1',
        name: 'Sunday Squad',
        scheduled_start_time: '2026-09-06T18:30:00+01:00',
        channel_id: 'voice-1',
        description: 'Join the weekly games night.',
        status: 1,
      },
    ]);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.deepEqual(result, { recorded: true, observedAt: OBSERVED_AT, eventCount: 1 });
    assert.deepEqual(
      (await db.prepare(`SELECT * FROM scheduled_events`).all()).map((row) => ({ ...row })),
      [
        {
          guild_id: GUILD,
          event_id: 'event-1',
          name: 'Sunday Squad',
          starts_at: '2026-09-06T17:30:00.000Z',
          channel_id: 'voice-1',
          description: 'Join the weekly games night.',
          status: 'scheduled',
          updated_at: OBSERVED_AT,
        },
      ],
    );
  });

  test('a successful empty response deletes the last event', async () => {
    await db.prepare(
      `INSERT INTO scheduled_events
         (guild_id, event_id, name, starts_at, channel_id, description, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(GUILD, 'old', 'Old event', '2026-09-06T18:00:00.000Z', null, null, 'scheduled', OBSERVED_AT);
    const { rest } = stubRest(() => []);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, true);
    assert.equal(result.eventCount, 0);
    assert.deepEqual(await db.prepare(`SELECT * FROM scheduled_events`).all(), []);
  });

  test('a failed read preserves the last good snapshot', async () => {
    await db.prepare(
      `INSERT INTO scheduled_events
         (guild_id, event_id, name, starts_at, channel_id, description, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(GUILD, 'old', 'Old event', '2026-09-06T18:00:00.000Z', null, null, 'scheduled', OBSERVED_AT);
    const { rest } = stubRest(() => undefined);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, 'discord_read_failed');
    assert.equal((await db.prepare(`SELECT * FROM scheduled_events`).all()).length, 1);
  });

  test('one malformed event rejects the whole snapshot', async () => {
    await db.prepare(
      `INSERT INTO scheduled_events
         (guild_id, event_id, name, starts_at, channel_id, description, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(GUILD, 'old', 'Old event', '2026-09-06T18:00:00.000Z', null, null, 'scheduled', OBSERVED_AT);
    const { rest } = stubRest(() => [
      {
        id: 'event-1',
        name: 'Good event',
        scheduled_start_time: '2026-09-06T18:00:00.000Z',
        status: 1,
      },
      { id: 'event-2', name: 'No start time', status: 1 },
    ]);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, 'invalid_response');
    assert.deepEqual(
      (await db.prepare(`SELECT event_id FROM scheduled_events`).all<{ event_id: string }>()).map((r) => r.event_id),
      ['old'],
    );
  });
});
