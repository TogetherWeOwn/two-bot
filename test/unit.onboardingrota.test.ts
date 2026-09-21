import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from '../src/analytics/communityClassifier.ts';
import { CommunityFactStore } from '../src/analytics/communityFacts.ts';
import { buildCommunityScorecard } from '../src/analytics/communityScorecard.ts';
import { ONBOARDING_FACT_TYPES } from '../src/analytics/onboardingEvents.ts';
import { OnboardingRota, type RotaActor, type RotaMessage } from '../src/analytics/onboardingRota.ts';

const GUILD = 'rota-guild';
const KEY = 'test-only-dedicated-key-not-a-real-secret';
const GATE = '2026-09-01T12:00:00.000Z';
const FIRST = '2026-09-01T12:05:00.000Z';
const REPLY = '2026-09-01T12:10:00.000Z';
const subject: RotaActor = { guildId: GUILD, actorId: 'new-human', pending: false };
let fixture: TestDb;
let classifier: CommunityClassifier;
let rota: OnboardingRota;

before(async () => {
  fixture = await openTestDb(import.meta.filename);
  classifier = new CommunityClassifier(loadCommunityClassifierConfig({
    TWO_COMMUNITY_CLASSIFIER_VERSION: 'rota-test-v1',
    TWO_COMMUNITY_AUTOMATION_ACTOR_IDS: 'automation',
    TWO_COMMUNITY_RAID_ACTOR_IDS: 'raider',
    TWO_COMMUNITY_STAGING_GUILD_IDS: 'staging-guild',
    TWO_COMMUNITY_TEST_ACTOR_IDS: 'fixture-user',
  }));
  rota = new OnboardingRota(fixture.db, classifier, { enabled: true, pseudonymKey: KEY });
});
after(async () => fixture?.cleanup());
beforeEach(async () => fixture.reset());

function message(overrides: Partial<RotaMessage> = {}): RotaMessage {
  return { ...subject, messageId: 'first-message', channelId: 'general', eligibleChannel: true, occurredAt: FIRST, ...overrides };
}

async function enroll(actor = subject, target = rota) {
  await target.rulesAccepted({ ...actor, occurredAt: GATE, sourceCohort: 'invite:fixture-campaign' });
  await target.promptShown({ ...actor, occurredAt: GATE, promptVariant: 'accepted-flow', messageId: 'welcome', channelId: 'general' });
}

async function rows() {
  return fixture.db.prepare('SELECT * FROM community_facts ORDER BY id')
    .all<{ event_type: string; actor_id: string; metadata: string; idempotency_key: string; source_event_id: string; occurred_at: string }>();
}

function reply(overrides: Partial<Parameters<OnboardingRota['reply']>[0]> = {}) {
  return rota.reply({ ...message(), actorId: 'human-primary', isStaff: true, messageId: 'reply',
    occurredAt: REPLY, subject, replyToMessageId: 'first-message', ...overrides });
}

test('seven durable milestones carry cohort, pseudonyms, raw clocks and no raw member ids', async () => {
  await enroll();
  await rota.message(message());
  await reply();
  await rota.message(message({ messageId: 'return', occurredAt: '2026-09-08T12:00:00.000Z' }));
  const actual = await rows();
  assert.equal(actual.length, 7);
  assert.deepEqual(actual.map(r => r.event_type).sort(), [...ONBOARDING_FACT_TYPES].sort());
  for (const row of actual) {
    assert.equal(row.actor_id, rota.memberId(GUILD, subject.actorId));
    assert.equal(JSON.parse(row.metadata).sourceCohort, 'invite:fixture-campaign');
    assert.equal(JSON.parse(row.metadata).rulesAcceptedAt, GATE);
    assert.ok(row.idempotency_key.includes(row.actor_id));
  }
  const latency = JSON.parse(actual.find(r => r.event_type === 'onboarding_reply_latency')!.metadata);
  assert.equal(latency.latencySeconds, 300);
  assert.equal(latency.qualifyingActionAt, FIRST);
  assert.equal(latency.replyAt, REPLY);
  assert.equal(latency.responderId, rota.memberId(GUILD, 'human-primary'));
  assert.doesNotMatch(JSON.stringify(actual), /new-human|human-primary/);
  assert.notEqual(rota.memberId(GUILD, subject.actorId), rota.memberId('other-guild', subject.actorId));
});

test('concurrent redelivery and restart retain one row per milestone and original cohort', async () => {
  await Promise.all(Array.from({ length: 5 }, () => enroll()));
  await Promise.all(Array.from({ length: 5 }, () => rota.message(message())));
  await Promise.all(Array.from({ length: 5 }, () => reply()));
  const restarted = new OnboardingRota(fixture.db, classifier, { enabled: true, pseudonymKey: KEY });
  await enroll(subject, restarted);
  await restarted.rulesAccepted({ ...subject, occurredAt: REPLY, sourceCohort: 'different-source' });
  await restarted.message(message());
  assert.equal((await rows()).length, 6);
  assert.ok((await rows()).every(r => JSON.parse(r.metadata).sourceCohort === 'invite:fixture-campaign'));
});

test('bots, webhooks, staff subjects, raids, fixtures and uncleared screening cannot enroll or act', async () => {
  const exclusions: Partial<RotaActor>[] = [
    { isBot: true }, { webhookId: 'hook' }, { isStaff: true }, { isStaffAutomation: true },
    { actorId: 'automation' }, { actorId: 'raider' }, { actorId: 'fixture-user' },
    { guildId: 'staging-guild' }, { isStaging: true }, { isTest: true }, { pending: true }, { pending: null },
  ];
  for (const exclusion of exclusions) {
    const actor = { ...subject, ...exclusion };
    await enroll(actor);
    await rota.message(message(actor));
  }
  assert.equal((await rows()).length, 0);
  await enroll();
  for (const exclusion of exclusions) await rota.message(message(exclusion));
  assert.equal((await rows()).length, 2);
});

test('only a later explicit reply by another eligible human in the action channel stops the clock', async () => {
  await enroll();
  await rota.message(message());
  const exclusions: Partial<Parameters<OnboardingRota['reply']>[0]>[] = [
    { actorId: subject.actorId }, { isBot: true }, { webhookId: 'hook' }, { actorId: 'automation' },
    { actorId: 'raider' }, { actorId: 'fixture-user' }, { pending: true }, { pending: null },
    { subject: { ...subject, pending: true } }, { subject: { ...subject, isStaff: true } },
    { guildId: 'other-guild' }, { channelId: 'elsewhere' }, { replyToMessageId: 'unrelated' },
    { eligibleChannel: false }, { rejected: true }, { occurredAt: FIRST }, { occurredAt: GATE },
  ];
  for (const exclusion of exclusions) await reply(exclusion);
  assert.equal((await rows()).length, 4);
  await reply();
  assert.equal((await rows()).length, 6);
});

test('no gate or visible prompt is inferred; rejected and pre-gate messages do not advance', async () => {
  await rota.message(message());
  await rota.promptShown({ ...subject, occurredAt: GATE, promptVariant: 'not-delivered', messageId: 'x', channelId: 'general' });
  assert.equal((await rows()).length, 0);
  await enroll();
  await rota.message(message({ occurredAt: '2026-09-01T11:59:59.999Z' }));
  await rota.message(message({ rejected: true }));
  await rota.message(message({ eligibleChannel: false }));
  assert.equal((await rows()).length, 2);
  await rota.message(message({ channelId: 'other-human-room' }));
  assert.equal((await rows()).length, 3);
  await reply({ channelId: 'other-human-room' });
  assert.equal((await rows()).length, 3);
});

test('seven-day return window is [gate + 7 days, gate + 8 days) in UTC', async () => {
  await enroll();
  await rota.message(message({ occurredAt: '2026-09-08T11:59:59.999Z' }));
  await rota.message(message({ occurredAt: '2026-09-09T12:00:00.000Z' }));
  assert.ok((await rows()).every(r => r.event_type !== 'onboarding_seven_day_return'));
  await rota.message(message({ occurredAt: '2026-09-08T12:00:00.000Z' }));
  assert.equal((await rows()).filter(r => r.event_type === 'onboarding_seven_day_return').length, 1);
});

test('disabled measurement writes nothing and an enabled instance refuses a weak pseudonym key', async () => {
  assert.throws(() => new OnboardingRota(fixture.db, classifier, { enabled: true, pseudonymKey: '' }), /dedicated pseudonym key/);
  const disabled = new OnboardingRota(fixture.db, classifier, { enabled: false, pseudonymKey: '' });
  await enroll(subject, disabled);
  await disabled.message(message());
  await disabled.reply({ ...message(), actorId: 'responder', subject, replyToMessageId: 'first-message' });
  assert.equal((await rows()).length, 0);
});

test('derived milestones do not become raw scorecard activity or missing stream coverage', async () => {
  await enroll();
  await rota.message(message());
  await reply();
  const store = new CommunityFactStore(fixture.db, classifier);
  for (const stream of ['message_created', 'voice_session_started', 'voice_session_ended',
    'member_joined', 'event_attended', 'rules_accepted'] as const) {
    await store.markStreamCoverage(GUILD, stream, '2026-08-31T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
  }
  const result = await buildCommunityScorecard(fixture.db, {
    guildId: GUILD, classifierVersion: classifier.version,
    weekStart: '2026-08-31T00:00:00.000Z', weekEnd: '2026-09-07T00:00:00.000Z',
    watermark: 1000, generatedAt: '2026-09-07T06:15:00.000Z',
    recommendationsEnabled: false, correctionCycles: 0,
  });
  assert.equal(result.scorecard.coverageState, 'complete');
  assert.equal(result.scorecard.rawFactCount, 0);
  assert.equal(result.scorecard.weeklyActiveHumans, 0);
  assert.equal(result.scorecard.humanMessages, 0);
});
