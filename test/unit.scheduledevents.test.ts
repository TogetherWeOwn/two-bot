import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../src/store/db.ts';
import { openEphemeralTestDb as openDb } from './helpers/testDb.ts';
import {
  runScheduledEventsCycle,
  SCHEDULED_EVENTS_INTERVAL_MS,
} from '../src/jobs/scheduledEvents.ts';
import { DiscordRest } from '../src/discord/rest.ts';
import { stubRest } from './helpers/stubRest.ts';

const GUILD = '326474832151838730';
const OBSERVED_AT = '2026-09-04T18:00:00.000Z';

/** A DiscordRest wired to a fixed response sequence, recording every path. */
function sequenceRest(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  let index = 0;
  const paths: string[] = [];
  const rest = new DiscordRest({
    token: 'test-token',
    base: 'https://discord.test/api/v10',
    minIntervalMs: 0,
    fetchImpl: (async (url: string) => {
      const path = String(url).replace('https://discord.test/api/v10', '');
      paths.push(path);
      const current = responses[Math.min(index++, responses.length - 1)]!;
      return new Response(current.body === undefined ? '' : JSON.stringify(current.body), {
        status: current.status,
        headers: { 'content-type': 'application/json', ...current.headers },
      });
    }) as unknown as typeof fetch,
  });
  return { rest, paths };
}

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

  test('overlapping events at the same start time are all stored', async () => {
    const { rest } = stubRest(() => [
      {
        id: 'event-a',
        name: 'Morning Raid',
        scheduled_start_time: '2026-09-06T18:00:00.000Z',
        status: 1,
      },
      {
        id: 'event-b',
        name: 'Evening Raid',
        scheduled_start_time: '2026-09-06T18:00:00.000Z',
        status: 1,
      },
    ]);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, true);
    assert.equal(result.eventCount, 2);
    assert.deepEqual(
      (await db.prepare(`SELECT event_id FROM scheduled_events ORDER BY event_id`).all<{ event_id: string }>()).map(
        (r) => r.event_id,
      ),
      ['event-a', 'event-b'],
    );
  });

  test('a changed set replaces the snapshot without duplicating surviving events', async () => {
    const seed = db.prepare(
      `INSERT INTO scheduled_events
         (guild_id, event_id, name, starts_at, channel_id, description, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await seed.run(GUILD, 'keep', 'Old name', '2026-09-06T18:00:00.000Z', null, null, 'scheduled', OBSERVED_AT);
    await seed.run(GUILD, 'gone', 'Gone event', '2026-09-07T18:00:00.000Z', null, null, 'scheduled', OBSERVED_AT);
    const { rest } = stubRest(() => [
      {
        id: 'keep',
        name: 'New name',
        scheduled_start_time: '2026-09-06T19:00:00.000Z',
        status: 2,
      },
      {
        id: 'fresh',
        name: 'Fresh event',
        scheduled_start_time: '2026-09-08T18:00:00.000Z',
        status: 1,
      },
    ]);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, true);
    assert.equal(result.eventCount, 2);
    assert.deepEqual(
      (await db.prepare(`SELECT event_id, name, status FROM scheduled_events ORDER BY event_id`).all()),
      [
        { event_id: 'fresh', name: 'Fresh event', status: 'scheduled' },
        { event_id: 'keep', name: 'New name', status: 'active' },
      ],
    );
  });

  test('a transient 500 is retried and the snapshot still lands', async () => {
    const { rest, paths } = sequenceRest([
      { status: 500, body: { message: 'internal error' } },
      {
        status: 200,
        body: [
          {
            id: 'event-1',
            name: 'Sunday Squad',
            scheduled_start_time: '2026-09-06T18:00:00.000Z',
            status: 1,
          },
        ],
      },
    ]);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, true);
    assert.equal(result.eventCount, 1);
    assert.equal(paths.length, 2, 'one failed attempt plus its retry');
    assert.equal((await db.prepare(`SELECT event_id FROM scheduled_events`).all()).length, 1);
  });

  test('a 200 object envelope is a failed read, not an empty snapshot', async () => {
    await db.prepare(
      `INSERT INTO scheduled_events
         (guild_id, event_id, name, starts_at, channel_id, description, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(GUILD, 'old', 'Old event', '2026-09-06T18:00:00.000Z', null, null, 'scheduled', OBSERVED_AT);
    const { rest } = stubRest(() => ({ message: 'Something went wrong', code: 0 }));

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, 'discord_read_failed');
    assert.deepEqual(
      (await db.prepare(`SELECT event_id FROM scheduled_events`).all<{ event_id: string }>()).map((r) => r.event_id),
      ['old'],
    );
  });

  test('an unknown Discord status rejects the whole snapshot', async () => {
    await db.prepare(
      `INSERT INTO scheduled_events
         (guild_id, event_id, name, starts_at, channel_id, description, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(GUILD, 'old', 'Old event', '2026-09-06T18:00:00.000Z', null, null, 'scheduled', OBSERVED_AT);
    const { rest } = stubRest(() => [
      {
        id: 'event-1',
        name: 'Future status',
        scheduled_start_time: '2026-09-06T18:00:00.000Z',
        status: 9,
      },
    ]);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, 'invalid_response');
    assert.deepEqual(
      (await db.prepare(`SELECT event_id FROM scheduled_events`).all<{ event_id: string }>()).map((r) => r.event_id),
      ['old'],
    );
  });

  test('all four Discord statuses are stored verbatim', async () => {
    const { rest } = stubRest(() => [
      { id: 'e1', name: 'Planned', scheduled_start_time: '2026-09-06T18:00:00.000Z', status: 1 },
      { id: 'e2', name: 'Live', scheduled_start_time: '2026-09-06T18:00:00.000Z', status: 2 },
      { id: 'e3', name: 'Done', scheduled_start_time: '2026-09-06T18:00:00.000Z', status: 3 },
      { id: 'e4', name: 'Scrapped', scheduled_start_time: '2026-09-06T18:00:00.000Z', status: 4 },
    ]);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, true);
    assert.equal(result.eventCount, 4);
    assert.deepEqual(
      (await db.prepare(`SELECT event_id, status FROM scheduled_events ORDER BY event_id`).all()),
      [
        { event_id: 'e1', status: 'scheduled' },
        { event_id: 'e2', status: 'active' },
        { event_id: 'e3', status: 'completed' },
        { event_id: 'e4', status: 'cancelled' },
      ],
    );
  });

  test('DST fall-back: the same wall time with different offsets stores two distinct instants', async () => {
    // Europe/London ends DST on 2026-10-25: 01:30 happens twice, once at
    // +01:00 (BST) and once at +00:00 (GMT). Both must survive as distinct rows.
    const { rest } = stubRest(() => [
      {
        id: 'dst-fall-bst',
        name: 'Before the clocks change',
        scheduled_start_time: '2026-10-25T01:30:00+01:00',
        status: 1,
      },
      {
        id: 'dst-fall-gmt',
        name: 'After the clocks change',
        scheduled_start_time: '2026-10-25T01:30:00+00:00',
        status: 1,
      },
    ]);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, true);
    assert.equal(result.eventCount, 2);
    assert.deepEqual(
      (await db.prepare(`SELECT event_id, starts_at FROM scheduled_events ORDER BY starts_at`).all()),
      [
        { event_id: 'dst-fall-bst', starts_at: '2026-10-25T00:30:00.000Z' },
        { event_id: 'dst-fall-gmt', starts_at: '2026-10-25T01:30:00.000Z' },
      ],
    );
    // Next-run computation: the BST instance is the earlier UTC instant.
    const next = await db
      .prepare(`SELECT event_id FROM scheduled_events ORDER BY starts_at LIMIT 1`)
      .get<{ event_id: string }>();
    assert.equal(next?.event_id, 'dst-fall-bst');
  });

  test('DST spring-forward: events across the gap keep distinct UTC instants', async () => {
    // Europe/London starts DST on 2026-03-29: 01:30 GMT (+00:00) and 03:30 BST
    // (+01:00) are different instants on either side of the skipped hour.
    const { rest } = stubRest(() => [
      {
        id: 'dst-spring-gmt',
        name: 'Before the gap',
        scheduled_start_time: '2026-03-29T01:30:00+00:00',
        status: 1,
      },
      {
        id: 'dst-spring-bst',
        name: 'After the gap',
        scheduled_start_time: '2026-03-29T03:30:00+01:00',
        status: 1,
      },
    ]);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });
    assert.equal(result.recorded, true);
    assert.equal(result.eventCount, 2);
    assert.deepEqual(
      (await db.prepare(`SELECT event_id, starts_at FROM scheduled_events ORDER BY starts_at`).all()),
      [
        { event_id: 'dst-spring-gmt', starts_at: '2026-03-29T01:30:00.000Z' },
        { event_id: 'dst-spring-bst', starts_at: '2026-03-29T02:30:00.000Z' },
      ],
    );
  });

  test('re-polling the same payload replaces without duplicating rows', async () => {
    const payload = () => [
      {
        id: 'event-a',
        name: 'Morning Raid',
        scheduled_start_time: '2026-09-06T18:00:00.000Z',
        status: 1,
      },
      {
        id: 'event-b',
        name: 'Evening Raid',
        scheduled_start_time: '2026-09-06T19:00:00.000Z',
        status: 1,
      },
    ];
    const first = stubRest(payload);
    await runScheduledEventsCycle({ db, rest: first.rest, guildId: GUILD, now: () => OBSERVED_AT });

    const LATER = '2026-09-04T19:00:00.000Z';
    const second = stubRest(payload);
    const result = await runScheduledEventsCycle({ db, rest: second.rest, guildId: GUILD, now: () => LATER });

    assert.equal(result.recorded, true);
    assert.equal(result.eventCount, 2);
    assert.deepEqual(
      (await db.prepare(`SELECT event_id, updated_at FROM scheduled_events ORDER BY event_id`).all()),
      [
        { event_id: 'event-a', updated_at: LATER },
        { event_id: 'event-b', updated_at: LATER },
      ],
    );
  });
});
