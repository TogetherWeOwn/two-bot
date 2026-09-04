import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordRest } from '../src/discord/rest.ts';
import { runScheduledEventsCycle } from '../src/jobs/scheduledEvents.ts';
import { applyWebContract } from '../src/store/webContract.ts';
import { startMockDiscord, type MockDiscord } from '../tools/mock-discord/server.ts';
import { openTestDb, type TestDb, usingPostgres } from './helpers/testDb.ts';

const suite = usingPostgres ? describe : describe.skip;

suite('scheduled events mock lifecycle', () => {
  let fixture: TestDb;
  let mock: MockDiscord;

  before(async () => {
    fixture = await openTestDb(import.meta.filename);
    mock = await startMockDiscord();
    await applyWebContract(fixture.db);
  });
  after(async () => {
    await mock.close();
    await fixture.cleanup();
  });
  beforeEach(async () => {
    mock.scheduledEvents.splice(0);
    await fixture.reset();
  });

  test('created event appears after one poll and deletion returns the view to zero rows', async () => {
    const rest = new DiscordRest({ token: 'test', base: `${mock.apiBase}/v10`, minIntervalMs: 0 });
    const query = `SELECT event_id, name, starts_at, channel_id, description FROM ${fixture.webSchema}.upcoming_events`;

    await runScheduledEventsCycle({ db: fixture.db, rest, guildId: mock.guildId });
    assert.deepEqual(await fixture.db.prepare(query).all(), [], 'zero Discord events must publish zero rows');

    mock.scheduledEvents.push({
      id: 'event-1',
      name: 'Sunday Squad',
      scheduled_start_time: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      channel_id: mock.voiceChannelId,
      description: 'Weekly community games night.',
      status: 1,
    });
    await runScheduledEventsCycle({ db: fixture.db, rest, guildId: mock.guildId });

    assert.deepEqual(await fixture.db.prepare(query).all(), [
      {
        event_id: 'event-1',
        name: 'Sunday Squad',
        starts_at: mock.scheduledEvents[0].scheduled_start_time,
        channel_id: mock.voiceChannelId,
        description: 'Weekly community games night.',
      },
    ]);

    mock.scheduledEvents.splice(0);
    await runScheduledEventsCycle({ db: fixture.db, rest, guildId: mock.guildId });
    assert.deepEqual(await fixture.db.prepare(query).all(), []);
    assert.deepEqual(
      await fixture.db.prepare(`SELECT * FROM ${fixture.webSchema}.next_event`).all(),
      [],
      'next_event must not synthesize a placeholder',
    );
  });
});
