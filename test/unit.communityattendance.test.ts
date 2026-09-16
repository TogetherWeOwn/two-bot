import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CommunityClassifier,
  loadCommunityClassifierConfig,
} from '../src/analytics/communityClassifier.ts';
import { CommunityFactStore } from '../src/analytics/communityFacts.ts';
import { recordCommunityAttendance } from '../src/analytics/communityAttendance.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const GUILD = 'guild-a';
const VERSION = 'community-test-v1';
let t: TestDb;
let facts: CommunityFactStore;

before(async () => {
  t = await openTestDb(import.meta.filename);
  facts = new CommunityFactStore(t.db, new CommunityClassifier(loadCommunityClassifierConfig({
    TWO_COMMUNITY_CLASSIFIER_VERSION: VERSION,
  })));
});
after(async () => t.cleanup());
beforeEach(async () => t.reset());

function interaction(eventOccurrenceId: string, actorId: string, bot = false) {
  const replies: unknown[] = [];
  return {
    replies,
    value: {
      guildId: GUILD,
      options: {
        getString: () => eventOccurrenceId,
        getUser: () => ({ id: actorId, bot }),
      },
      reply: async (value: unknown) => { replies.push(value); },
    },
  };
}

test('host check-in command records one durable attendance fact and deduplicates retries', async () => {
  const first = interaction('event-1', 'human-1');
  assert.equal(await recordCommunityAttendance(first.value as never, {
    facts,
    guildId: GUILD,
    now: () => '2026-09-02T10:00:00.000Z',
  }), true);
  assert.equal(first.replies.length, 1);

  const duplicate = interaction('event-1', 'human-1');
  assert.equal(await recordCommunityAttendance(duplicate.value as never, {
    facts,
    guildId: GUILD,
    now: () => '2026-09-02T10:01:00.000Z',
  }), false);

  const rows = await t.db.prepare(
    `SELECT event_type, source_event_id, actor_id, classification, metadata FROM community_facts`,
  ).all<{ event_type: string; source_event_id: string; actor_id: string; classification: string; metadata: string }>();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    event_type: 'event_attended',
    source_event_id: 'event-1:human-1',
    actor_id: 'human-1',
    classification: 'eligible_human',
    metadata: JSON.stringify({ eventOccurrenceId: 'event-1', proof: 'host_checkin' }),
  });
});

test('host check-in retains bot classification so it never enters human attendance', async () => {
  const bot = interaction('event-1', 'bot-1', true);
  assert.equal(await recordCommunityAttendance(bot.value as never, {
    facts,
    guildId: GUILD,
    now: () => '2026-09-02T10:00:00.000Z',
  }), true);
  const row = await t.db.prepare(
    `SELECT classification FROM community_facts WHERE actor_id = ?`,
  ).get<{ classification: string }>('bot-1');
  assert.equal(row?.classification, 'bot');
});
