import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from '../src/analytics/communityClassifier.ts';
import { CommunityFactStore } from '../src/analytics/communityFacts.ts';
import { buildCommunityScorecard } from '../src/analytics/communityScorecard.ts';
import { OnboardingRota, type OnboardingRotaConfig, type RotaActor } from '../src/analytics/onboardingRota.ts';

const GUILD = 'notice-guild';
const KEY = 'fixture-only-dedicated-notice-state-key';
const FIRST = '2026-09-01T23:05:00.000Z';
const DUE = '2026-09-01T23:35:00.000Z';
const subject: RotaActor = { guildId: GUILD, actorId: 'new-human', pending: false };
const primary: RotaActor = { guildId: GUILD, actorId: 'accepted-primary', pending: false, isStaff: true };
let fixture: TestDb;
let classifier: CommunityClassifier;
let rota: OnboardingRota;

function makeRota(overrides: Partial<OnboardingRotaConfig> = {}) {
  return new OnboardingRota(fixture.db, classifier, {
    enabled: true, noticeEnabled: true, pseudonymKey: KEY, primaryActorId: primary.actorId, ...overrides,
  });
}

before(async () => {
  fixture = await openTestDb(import.meta.filename);
  classifier = new CommunityClassifier(loadCommunityClassifierConfig({
    TWO_COMMUNITY_RAID_ACTOR_IDS: 'raider', TWO_COMMUNITY_TEST_ACTOR_IDS: 'fixture-user',
    TWO_COMMUNITY_AUTOMATION_ACTOR_IDS: 'automation', TWO_COMMUNITY_STAGING_GUILD_IDS: 'staging-guild',
  }));
  rota = makeRota();
});
after(async () => fixture?.cleanup());
beforeEach(async () => fixture.reset());

async function act(actor = subject, occurredAt = FIRST, target = rota, actionId = 'first-message') {
  await target.rulesAccepted({ ...actor, occurredAt: '2026-09-01T23:00:00.000Z', sourceCohort: 'invite:campaign' });
  await target.promptShown({ ...actor, occurredAt: '2026-09-01T23:01:00.000Z',
    promptVariant: 'session', messageId: 'welcome', channelId: 'general' });
  await target.message({ ...actor, occurredAt, messageId: actionId, channelId: 'general', eligibleChannel: true });
}

function ack(overrides: Partial<Parameters<OnboardingRota['acknowledgePrimary']>[0]> = {}, target = rota) {
  return target.acknowledgePrimary({ ...primary, subject, occurredAt: DUE,
    actionId: 'first-message', channelId: 'general', ...overrides });
}

async function rows() {
  return fixture.db.prepare('SELECT * FROM community_facts ORDER BY id')
    .all<{ event_type: string; actor_id: string; metadata: string; occurred_at: string }>();
}

test('the persisted first action reaches its deadline at exactly 30 minutes, across restart', async () => {
  await act();
  assert.deepEqual(await rota.dueNotices(GUILD, '2026-09-01T23:34:59.999Z'), []);
  const snapshot = await rows();
  const expected = [{ memberId: rota.memberId(GUILD, subject.actorId), actionId: 'first-message',
    channelId: 'general', sourceCohort: 'invite:campaign', actionAt: FIRST, dueAt: DUE,
    elapsedSeconds: 1800, coverageBlock: 'America/Chicago 18:00–22:00 daily' }];
  assert.deepEqual(await makeRota().dueNotices(GUILD, DUE), expected);
  assert.deepEqual(await makeRota().dueNotices(GUILD, DUE), expected);
  assert.deepEqual(await rows(), snapshot, 'listing never claims or changes state');
  await act(subject, DUE, makeRota(), 'later-message');
  assert.deepEqual(await makeRota().dueNotices(GUILD, DUE), expected, 'redelivery cannot restart the clock');
  assert.equal((await rota.dueNotices(GUILD, '2026-09-02T13:00:00.000Z'))[0].dueAt, DUE,
    'elapsed deadline is not reset outside published coverage');
});

test('one durable primary acknowledgement suppresses notice eligibility but not human-reply measurement', async () => {
  await act();
  const results = await Promise.all(Array.from({ length: 8 }, () => ack()));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await ack({}, makeRota()), false);
  assert.deepEqual(await makeRota().dueNotices(GUILD, DUE), []);
  const facts = await rows();
  assert.equal(facts.length, 5);
  const accepted = facts.find(row => row.event_type === 'welcome_rota_acknowledged')!;
  assert.equal(accepted.actor_id, rota.memberId(GUILD, subject.actorId));
  assert.deepEqual(JSON.parse(accepted.metadata), {
    actionId: 'first-message', channelId: 'general', qualifyingActionAt: FIRST,
    responderId: rota.memberId(GUILD, primary.actorId), role: 'primary',
    coverageBlock: 'America/Chicago 18:00–22:00 daily', sourceCohort: 'invite:campaign',
    rulesAcceptedAt: '2026-09-01T23:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(facts), /new-human|accepted-primary/);
  assert.equal(facts.filter(r => /human_reply|reply_latency/.test(r.event_type)).length, 0);
  await rota.reply({ ...primary, subject, occurredAt: '2026-09-01T23:40:00.000Z', messageId: 'reply',
    channelId: 'general', eligibleChannel: true, replyToMessageId: 'first-message' });
  const latency = (await rows()).find(r => r.event_type === 'onboarding_reply_latency')!;
  assert.equal(JSON.parse(latency.metadata).latencySeconds, 2100, 'ack does not stop the human clock');
});

test('acknowledgement requires bound primary, eligible actors, exact action and current screening evidence', async () => {
  await act();
  const exclusions: Partial<Parameters<OnboardingRota['acknowledgePrimary']>[0]>[] = [
    { actorId: 'other-staff' }, { actorId: subject.actorId }, { guildId: 'other-guild' },
    { isBot: true }, { webhookId: 'webhook' }, { isStaffAutomation: true }, { isTest: true },
    { isStaging: true }, { pending: true }, { pending: null },
    { subject: { ...subject, pending: true } }, { subject: { ...subject, pending: null } },
    { subject: { ...subject, isStaff: true } }, { subject: { ...subject, isBot: true } },
    { subject: { ...subject, guildId: 'elsewhere' } }, { subject: { ...subject, actorId: 'raider' } },
    { actionId: 'later-message' }, { channelId: 'wrong-channel' }, { occurredAt: '2026-09-01T23:04:59.999Z' },
  ];
  for (const exclusion of exclusions) assert.equal(await ack(exclusion), false);
  for (const actorId of ['raider', 'fixture-user', 'automation']) {
    assert.equal(await ack({ actorId }, makeRota({ primaryActorId: actorId })), false);
  }
  assert.equal(await ack({}, makeRota({ primaryActorId: undefined })), false);
  assert.equal((await rows()).length, 4);
  assert.equal((await rota.dueNotices(GUILD, DUE)).length, 1);
});

test('missing enrollment or first action cannot be acknowledged; no shown prompt is invented', async () => {
  assert.equal(await ack(), false);
  await rota.rulesAccepted({ ...subject, occurredAt: FIRST, sourceCohort: 'unknown' });
  assert.equal(await ack(), false);
  await rota.message({ ...subject, occurredAt: FIRST, messageId: 'first-message',
    channelId: 'general', eligibleChannel: true });
  assert.equal((await rota.dueNotices(GUILD, DUE)).length, 1, 'first message, not prompt_acted, starts fallback');
  assert.equal(await ack({ occurredAt: FIRST }), true);
  assert.equal((await rows()).length, 3);
});

test('persisted eligible human reply suppresses the notice; ack after reply is still operations evidence', async () => {
  await act();
  await rota.reply({ ...primary, subject, occurredAt: '2026-09-01T23:10:00.000Z', messageId: 'reply',
    channelId: 'general', eligibleChannel: true, replyToMessageId: 'first-message' });
  assert.deepEqual(await makeRota().dueNotices(GUILD, DUE), []);
  assert.equal(await ack(), true);
  assert.deepEqual(await makeRota().dueNotices(GUILD, DUE), []);
});

test('human reply without prompt exposure durably stops the first-message notice only', async () => {
  const actionId = '111111111111111111';
  const channelId = '222222222222222222';
  await rota.rulesAccepted({ ...subject, occurredAt: FIRST, sourceCohort: 'invite:campaign' });
  await rota.message({ ...subject, occurredAt: FIRST, messageId: actionId, channelId, eligibleChannel: true });
  const memberId = rota.memberId(GUILD, subject.actorId);
  assert.equal((await rota.dueNotices(GUILD, DUE)).length, 1);
  assert.deepEqual(await rota.confirmNoticeEligible(GUILD, memberId, actionId, channelId, DUE), { dueAt: DUE });
  const reply = { ...primary, subject, occurredAt: '2026-09-01T23:10:00.000Z', messageId: 'reply',
    channelId, eligibleChannel: true, replyToMessageId: actionId };
  await Promise.all(Array.from({ length: 8 }, () => makeRota().reply(reply)));
  const restarted = makeRota();
  assert.deepEqual(await restarted.dueNotices(GUILD, DUE), []);
  assert.equal(await restarted.confirmNoticeEligible(GUILD, memberId, actionId, channelId, DUE), null);
  const facts = await rows();
  assert.deepEqual(facts.map(row => row.event_type), [
    'onboarding_rules_accepted', 'onboarding_first_eligible_message', 'welcome_rota_replied',
  ], 'no prompt exposure, activation or prompt-reply latency is invented');
  assert.equal(facts[2].actor_id, memberId);
  assert.deepEqual(JSON.parse(facts[2].metadata), {
    actionId, channelId, replyMessageId: 'reply', responderId: rota.memberId(GUILD, primary.actorId),
    qualifyingActionAt: FIRST, replyAt: reply.occurredAt,
    sourceCohort: 'invite:campaign', rulesAcceptedAt: FIRST,
  });
  assert.doesNotMatch(JSON.stringify(facts), /new-human|accepted-primary/);
});

test('without prompt exposure invalid replies cannot suppress the notice', async () => {
  const actionId = '111111111111111111';
  const channelId = '222222222222222222';
  await rota.rulesAccepted({ ...subject, occurredAt: FIRST, sourceCohort: 'unknown' });
  await rota.message({ ...subject, occurredAt: FIRST, messageId: actionId, channelId, eligibleChannel: true });
  const reply = { ...primary, subject, occurredAt: '2026-09-01T23:10:00.000Z', messageId: 'reply',
    channelId, eligibleChannel: true, replyToMessageId: actionId };
  const exclusions: Partial<Parameters<OnboardingRota['reply']>[0]>[] = [
    { actorId: subject.actorId }, { isBot: true }, { webhookId: 'webhook' }, { isStaffAutomation: true },
    { actorId: 'raider' }, { actorId: 'fixture-user' }, { actorId: 'automation' },
    { pending: true }, { pending: null }, { guildId: 'elsewhere' },
    { subject: { ...subject, isStaff: true } }, { subject: { ...subject, pending: true } },
    { eligibleChannel: false }, { rejected: true }, { channelId: 'other' },
    { replyToMessageId: 'other' }, { occurredAt: FIRST }, { occurredAt: '2026-09-01T23:04:00.000Z' },
  ];
  for (const exclusion of exclusions) await rota.reply({ ...reply, ...exclusion });
  assert.equal((await rows()).length, 2);
  assert.equal((await makeRota().dueNotices(GUILD, DUE)).length, 1);
  assert.deepEqual(await makeRota().confirmNoticeEligible(
    GUILD, rota.memberId(GUILD, subject.actorId), actionId, channelId, DUE,
  ), { dueAt: DUE });
});

test('first-message reply stop remains independent of a later prompt action and its latency', async () => {
  await rota.rulesAccepted({ ...subject, occurredAt: FIRST, sourceCohort: 'unknown' });
  await rota.message({ ...subject, occurredAt: FIRST, messageId: 'first', channelId: 'general', eligibleChannel: true });
  await rota.promptShown({ ...subject, occurredAt: '2026-09-01T23:06:00.000Z',
    promptVariant: 'session', messageId: 'welcome', channelId: 'general' });
  await rota.message({ ...subject, occurredAt: '2026-09-01T23:07:00.000Z', messageId: 'acted',
    channelId: 'general', eligibleChannel: true });
  const reply = { ...primary, subject, occurredAt: '2026-09-01T23:10:00.000Z', messageId: 'reply',
    channelId: 'general', eligibleChannel: true, replyToMessageId: 'first' };
  await rota.reply(reply);
  assert.deepEqual(await makeRota().dueNotices(GUILD, DUE), []);
  assert.equal((await rows()).filter(r => /human_reply|reply_latency/.test(r.event_type)).length, 0);
  await rota.reply({ ...reply, replyToMessageId: 'acted', messageId: 'prompt-reply' });
  const facts = await rows();
  assert.equal(facts.filter(r => r.event_type === 'welcome_rota_replied').length, 1);
  assert.equal(JSON.parse(facts.find(r => r.event_type === 'onboarding_reply_latency')!.metadata).latencySeconds, 180);
});

test('disabled notice, unbound primary and master rollback return no candidates without deleting facts', async () => {
  await act();
  const snapshot = await rows();
  for (const config of [{ noticeEnabled: false }, { noticeEnabled: undefined },
    { primaryActorId: undefined }, { enabled: false }]) {
    assert.deepEqual(await makeRota(config).dueNotices(GUILD, DUE), []);
  }
  assert.equal(await ack({}, makeRota({ enabled: false })), false);
  assert.deepEqual(await rows(), snapshot);
  assert.equal(await ack({}, makeRota({ noticeEnabled: false })), true,
    'notice-only rollback preserves primary acknowledgement');
  assert.deepEqual(await rota.dueNotices(GUILD, DUE), []);
});

test('bot, staff, raid, staging, test and screening exclusions never create due candidates', async () => {
  const exclusions: Partial<RotaActor>[] = [
    { isBot: true }, { webhookId: 'webhook' }, { isStaff: true }, { actorId: 'raider' },
    { actorId: 'fixture-user' }, { actorId: 'automation' }, { guildId: 'staging-guild' },
    { isTest: true }, { isStaging: true }, { pending: true }, { pending: null },
  ];
  for (const exclusion of exclusions) await act({ ...subject, ...exclusion });
  assert.deepEqual(await rota.dueNotices(GUILD, DUE), []);
  assert.deepEqual(await rota.dueNotices('staging-guild', DUE), []);
  assert.deepEqual(await rows(), []);
});

test('guild isolation, bounded ordered results and invalid clocks fail safely', async () => {
  await act({ ...subject, actorId: 'second' }, '2026-09-01T23:06:00.000Z');
  await act();
  await act({ ...subject, guildId: 'other-guild' });
  assert.deepEqual(await rota.dueNotices('absent-guild', DUE), []);
  const found = await rota.dueNotices(GUILD, '2026-09-01T23:40:00.000Z', 1);
  assert.equal(found.length, 1);
  assert.equal(found[0].memberId, rota.memberId(GUILD, subject.actorId));
  assert.equal((await rota.dueNotices(GUILD, '2026-09-01T23:40:00.000Z')).length, 2);
  for (const limit of [0, -1, 101, 1.5, NaN]) await assert.rejects(rota.dueNotices(GUILD, DUE, limit));
  await assert.rejects(rota.dueNotices(GUILD, 'not-a-clock'));
  await assert.rejects(ack({ occurredAt: 'not-a-clock' }));
});

test('operational acknowledgement and reply stops create no scorecard activity or stream requirements', async () => {
  await act();
  await ack();
  await rota.reply({ ...primary, subject, occurredAt: DUE, messageId: 'reply',
    channelId: 'general', eligibleChannel: true, replyToMessageId: 'first-message' });
  assert.equal((await rows()).filter(r => r.event_type === 'welcome_rota_replied').length, 1);
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
