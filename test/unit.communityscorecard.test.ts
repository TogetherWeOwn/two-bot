import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import {
  CommunityClassifier,
  loadCommunityClassifierConfig,
  type CommunityClassification,
} from '../src/analytics/communityClassifier.ts';
import { CommunityFactStore, type CommunityFactType } from '../src/analytics/communityFacts.ts';
import {
  buildCommunityScorecard,
  previousClosedCommunityWeek,
} from '../src/analytics/communityScorecard.ts';
import { isCommunityScorecardRunTime } from '../src/jobs/communityScorecard.ts';

const GUILD = 'guild-a';
const OTHER_GUILD = 'guild-b';
const VERSION = 'community-test-v1';
const WEEK_START = '2026-08-31T00:00:00.000Z';
const WEEK_END = '2026-09-07T00:00:00.000Z';
const GENERATED_AT = '2026-09-07T06:15:00.000Z';

let t: TestDb;
let classifier: CommunityClassifier;
let facts: CommunityFactStore;

before(async () => {
  t = await openTestDb(import.meta.filename);
  classifier = new CommunityClassifier(loadCommunityClassifierConfig({
    TWO_COMMUNITY_CLASSIFIER_VERSION: VERSION,
    TWO_COMMUNITY_AUTOMATION_ACTOR_IDS: 'staff-bot',
    TWO_COMMUNITY_RAID_ACTOR_IDS: 'raid-user',
    TWO_COMMUNITY_STAGING_GUILD_IDS: 'staging-guild',
    TWO_COMMUNITY_STAGING_ACTOR_IDS: 'staging-user',
    TWO_COMMUNITY_TEST_ACTOR_IDS: 'test-user',
  }));
  facts = new CommunityFactStore(t.db, classifier);
});
after(async () => t.cleanup());
beforeEach(async () => t.reset());

async function cover(guildId = GUILD) {
  for (const stream of [
    'message_created',
    'voice_session_started',
    'voice_session_ended',
    'member_joined',
    'event_attended',
    'rules_accepted',
  ] as CommunityFactType[]) {
    await facts.markStreamHeartbeat(guildId, stream, WEEK_END);
  }
}

async function watermark(guildId = GUILD): Promise<number> {
  const row = await t.db
    .prepare(`SELECT MAX(id) AS watermark FROM community_facts WHERE guild_id = ?`)
    .get<{ watermark: number | null }>(guildId);
  return Number(row?.watermark ?? 0);
}

async function score(guildId = GUILD, overrides: Partial<Parameters<typeof buildCommunityScorecard>[1]> = {}) {
  return buildCommunityScorecard(t.db, {
    guildId,
    classifierVersion: VERSION,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    watermark: await watermark(guildId),
    generatedAt: GENERATED_AT,
    recommendationsEnabled: true,
    correctionCycles: 0,
    ...overrides,
  });
}

async function message(
  id: string,
  actorId: string,
  occurredAt: string,
  opts: { guildId?: string; classification?: CommunityClassification; channelClass?: 'human' | 'welcome' | 'other' } = {},
) {
  const classification = opts.classification ?? 'eligible_human';
  await facts.record({
    guildId: opts.guildId ?? GUILD,
    eventType: 'message_created',
    sourceEventId: id,
    actorId,
    occurredAt,
    source: 'channel:general',
    idempotencyKey: `discord-message:${id}`,
    classification: {
      classification,
      classifierVersion: VERSION,
      matchedRule: classification === 'eligible_human' ? 'no_exclusion_matched' : `fixture_${classification}`,
    },
    metadata: { channelId: 'general', channelClass: opts.channelClass ?? 'human' },
  });
}

async function join(id: string, actorId: string, at: string, classification: CommunityClassification = 'eligible_human') {
  await facts.record({
    guildId: GUILD,
    eventType: 'member_joined',
    sourceEventId: id,
    actorId,
    occurredAt: at,
    source: 'unknown',
    idempotencyKey: `join:${id}`,
    classification: { classification, classifierVersion: VERSION, matchedRule: `fixture_${classification}` },
  });
}

async function voice(id: string, actorId: string, start: string, end: string, classification: CommunityClassification = 'eligible_human') {
  await facts.record({
    guildId: GUILD,
    eventType: 'voice_session_ended',
    sourceEventId: id,
    actorId,
    occurredAt: end,
    source: 'channel:voice',
    idempotencyKey: `voice-end:${id}`,
    classification: { classification, classifierVersion: VERSION, matchedRule: `fixture_${classification}` },
    metadata: {
      sessionKey: id,
      channelId: 'voice',
      startedAt: start,
      durationSeconds: (Date.parse(end) - Date.parse(start)) / 1000,
      startKnown: true,
    },
  });
}

test('Monday closed-week boundary and schedule are exact', () => {
  assert.deepEqual(previousClosedCommunityWeek(new Date(GENERATED_AT)), {
    start: WEEK_START,
    end: WEEK_END,
  });
  assert.equal(isCommunityScorecardRunTime(new Date('2026-09-07T06:14:59.000Z')), false);
  assert.equal(isCommunityScorecardRunTime(new Date(GENERATED_AT)), true);
  assert.equal(isCommunityScorecardRunTime(new Date('2026-09-08T06:15:00.000Z')), false);
});

test('classifier precedence assigns each excluded fact to one bucket', () => {
  assert.equal(classifier.classify({ guildId: GUILD, actorId: 'x', isBot: true, webhookId: 'w' }).classification, 'bot');
  assert.equal(classifier.classify({ guildId: GUILD, actorId: 'x', webhookId: 'w' }).classification, 'webhook');
  assert.equal(classifier.classify({ guildId: GUILD, actorId: 'staff-bot' }).classification, 'staff_automation');
  assert.equal(classifier.classify({ guildId: GUILD, actorId: 'raid-user' }).classification, 'raid');
  assert.equal(classifier.classify({ guildId: 'staging-guild', actorId: 'x' }).classification, 'staging');
  assert.equal(classifier.classify({ guildId: GUILD, actorId: 'test-user' }).classification, 'test');
});

test('mixed raw fixture reconciles exactly by event type and total', async () => {
  await cover();
  await message('m-human', 'human', '2026-09-01T10:00:00.000Z');
  for (const [classification, id] of [
    ['bot', 'm-bot'],
    ['webhook', 'm-webhook'],
    ['staff_automation', 'm-staff'],
    ['raid', 'm-raid'],
    ['staging', 'm-staging'],
    ['test', 'm-test'],
  ] as Array<[CommunityClassification, string]>) {
    await message(id, id, '2026-09-01T11:00:00.000Z', { classification });
  }
  await join('j-human', 'join-human', '2026-09-02T10:00:00.000Z');
  await join('j-raid', 'join-raid', '2026-09-02T11:00:00.000Z', 'raid');
  await voice('v-human', 'voice-human', '2026-09-03T10:00:00.000Z', '2026-09-03T10:10:00.000Z');

  const { scorecard } = await score();
  assert.equal(scorecard.coverageState, 'complete');
  assert.equal(scorecard.reconciliation.message_created.raw, 7);
  assert.equal(scorecard.reconciliation.message_created.reconciles, true);
  assert.equal(scorecard.reconciliation.member_joined.raw, 2);
  assert.equal(scorecard.reconciliation.total.raw, 10);
  assert.equal(scorecard.reconciliation.total.reconciles, true);
});

test('excluded-only fixture contributes zero to every human numerator', async () => {
  await cover();
  for (const classification of ['bot', 'webhook', 'staff_automation', 'raid', 'staging', 'test'] as CommunityClassification[]) {
    await message(`m-${classification}`, classification, '2026-09-01T10:00:00.000Z', { classification });
    await join(`j-${classification}`, `j-${classification}`, '2026-09-02T10:00:00.000Z', classification);
    await voice(`v-${classification}`, `v-${classification}`, '2026-09-03T10:00:00.000Z', '2026-09-03T10:20:00.000Z', classification);
    await facts.record({
      guildId: GUILD,
      eventType: 'event_attended',
      sourceEventId: `e-${classification}`,
      actorId: `e-${classification}`,
      occurredAt: '2026-09-04T10:00:00.000Z',
      source: 'event:one',
      idempotencyKey: `event:${classification}`,
      classification: { classification, classifierVersion: VERSION, matchedRule: `fixture_${classification}` },
      metadata: { eventOccurrenceId: 'one', proof: 'host_checkin' },
    });
  }
  const { scorecard } = await score();
  assert.equal(scorecard.weeklyActiveHumans, 0);
  assert.equal(scorecard.humanMessages, 0);
  assert.equal(scorecard.eligibleJoins, 0);
  assert.deepEqual(scorecard.eventAttendance, { participations: 0, distinctHumans: 0 });
  assert.equal(scorecard.firstHumanReply?.resolvedCount, 0);
});

test('weekly active uses one message or 600 deduplicated voice seconds', async () => {
  await cover();
  await message('active-message', 'both', '2026-09-01T10:00:00.000Z');
  await voice('v-both', 'both', '2026-09-01T11:00:00.000Z', '2026-09-01T11:10:00.000Z');
  await voice('v-600-a', 'voice-600', '2026-09-02T10:00:00.000Z', '2026-09-02T10:06:00.000Z');
  await voice('v-600-b', 'voice-600', '2026-09-02T10:05:00.000Z', '2026-09-02T10:10:00.000Z');
  await voice('v-599', 'voice-599', '2026-09-03T10:00:00.000Z', '2026-09-03T10:09:59.000Z');
  const { scorecard } = await score();
  assert.equal(scorecard.weeklyActiveHumans, 2, 'both + unioned 600-second actor; 599 is inactive');
});

test('bot-noise alert is false below 20%, true at 20%, and bot traffic never engages', async () => {
  await cover();
  for (let i = 0; i < 81; i++) await message(`human-${i}`, `human-${i}`, '2026-09-01T10:00:00.000Z');
  for (let i = 0; i < 19; i++) await message(`bot-${i}`, `bot-${i}`, '2026-09-01T11:00:00.000Z', { classification: 'bot' });
  let result = await score();
  assert.equal(result.scorecard.botNoise?.ratio, 0.19);
  assert.equal(result.scorecard.botNoise?.alert, false);
  assert.equal(result.scorecard.humanMessages, 81);
  assert.equal(result.scorecard.weeklyActiveHumans, 81);

  for (let i = 81; i < 100; i++) await message(`human-${i}`, `human-${i}`, '2026-09-01T10:00:00.000Z');
  for (let i = 19; i < 25; i++) await message(`bot-${i}`, `bot-${i}`, '2026-09-01T11:00:00.000Z', { classification: 'bot' });
  result = await score(GUILD, { watermark: await watermark(), generatedAt: '2026-09-07T06:16:00.000Z' });
  assert.equal(result.scorecard.botNoise?.ratio, 0.2);
  assert.equal(result.scorecard.botNoise?.alert, true);
  assert.equal(result.scorecard.intervention.code, 'BOT_NOISE_HIGH');
});

test('self replies and excluded replies do not stop first-human-reply clock', async () => {
  await cover();
  await join('join-new', 'new', '2026-09-01T09:00:00.000Z');
  await message('new-first', 'new', '2026-09-01T09:05:00.000Z', { channelClass: 'welcome' });
  await message('new-self', 'new', '2026-09-01T09:06:00.000Z', { channelClass: 'welcome' });
  await message('bot-reply', 'bot', '2026-09-01T09:07:00.000Z', { classification: 'bot', channelClass: 'welcome' });
  await message('human-reply', 'helper', '2026-09-01T09:10:00.000Z', { channelClass: 'welcome' });
  const { scorecard } = await score();
  assert.equal(scorecard.firstHumanReply?.resolvedCount, 1);
  assert.equal(scorecard.firstHumanReply?.medianSeconds, 600);
});

test('attendance deduplicates proof methods and rejects RSVP-only', async () => {
  await cover();
  assert.equal(await facts.recordAttendance({
    guildId: GUILD, actorId: 'rsvp', eventOccurrenceId: 'event-1', occurredAt: '2026-09-02T10:00:00.000Z', proof: 'rsvp',
  }), false);
  await facts.recordAttendance({
    guildId: GUILD, actorId: 'human', eventOccurrenceId: 'event-1', occurredAt: '2026-09-02T10:00:00.000Z', proof: 'host_checkin',
  });
  await facts.recordAttendance({
    guildId: GUILD, actorId: 'human', eventOccurrenceId: 'event-1', occurredAt: '2026-09-02T10:01:00.000Z', proof: 'voice_600s',
  });
  const { scorecard } = await score();
  assert.deepEqual(scorecard.eventAttendance, { participations: 1, distinctHumans: 1 });
});

test('duplicate rerun reuses result; later watermark creates auditable revision without duplicate alert', async () => {
  await cover();
  for (let i = 0; i < 4; i++) await message(`human-${i}`, `human-${i}`, '2026-09-01T10:00:00.000Z');
  await message('bot', 'bot', '2026-09-01T11:00:00.000Z', { classification: 'bot' });
  const first = await score();
  assert.equal(first.reused, false);
  assert.equal(first.alertEmitted, true);
  const duplicate = await score();
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.alertEmitted, false);

  await message('late', 'late-human', '2026-09-02T10:00:00.000Z');
  const revision = await score(GUILD, { watermark: await watermark(), generatedAt: '2026-09-07T07:00:00.000Z' });
  assert.equal(revision.scorecard.revision, 2);
  assert.equal(revision.alertEmitted, false, 'threshold alert dedupes within the ISO week');
});

test('incomplete ingestion fails closed, and kill switch disables recommendations after two corrections', async () => {
  await message('human', 'human', '2026-09-01T10:00:00.000Z');
  const { scorecard } = await score(GUILD, { correctionCycles: 2 });
  assert.equal(scorecard.coverageState, 'incomplete');
  assert.equal(scorecard.weeklyActiveHumans, null);
  assert.equal(scorecard.intervention.code, 'INGESTION_INCOMPLETE');
  assert.equal(scorecard.killSwitchActive, true);
  assert.equal(scorecard.recommendationsEnabled, false);
});

test('scorecard is guild isolated', async () => {
  await cover();
  await cover(OTHER_GUILD);
  await message('g-a', 'a', '2026-09-01T10:00:00.000Z');
  await message('g-b', 'b', '2026-09-01T10:00:00.000Z', { guildId: OTHER_GUILD });
  const a = await score(GUILD);
  const b = await score(OTHER_GUILD);
  assert.equal(a.scorecard.humanMessages, 1);
  assert.equal(b.scorecard.humanMessages, 1);
  assert.equal(a.scorecard.guildId, GUILD);
  assert.equal(b.scorecard.guildId, OTHER_GUILD);
});
