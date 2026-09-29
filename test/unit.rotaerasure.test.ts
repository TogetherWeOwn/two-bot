/**
 * Rota authorized-erasure helper (TOG-9028).
 *
 * `OnboardingRota.eraseSubject()` derives the guild-separated pseudonym
 * through `memberId()` and deletes, in one transaction with bound
 * parameters only: (a) derived `community_facts` rows keyed by the subject
 * pseudonym, (b) reply/ack/latency rows where the subject acted as
 * responder (`metadata.responderId`), scoped to the responderId-bearing
 * event types, (c) `rota_notice` audit rows addressed to the subject.
 *
 * Fixture DB only. Raw member ids below are synthetic fixtures, never real
 * Discord identities.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from '../src/analytics/communityClassifier.ts';
import { CommunityFactStore } from '../src/analytics/communityFacts.ts';
import { OnboardingRota, type RotaActor, type RotaMessage } from '../src/analytics/onboardingRota.ts';
import { OperationalAuditStore } from '../src/audit/store.ts';

const GUILD = 'rota-erasure-guild';
const OTHER_GUILD = 'rota-erasure-other-guild';
const KEY = 'test-only-erasure-key-not-a-real-secret-12';
const GATE = '2026-09-01T12:00:00.000Z';
const FIRST = '2026-09-01T12:05:00.000Z';
const REPLY = '2026-09-01T12:10:00.000Z';
const PRIMARY = 'erasure-primary';
const SUBJECT = 'erasure-subject';
const SECOND = 'erasure-second';
const RESPONDER = 'erasure-responder';

let fixture: TestDb;
let classifier: CommunityClassifier;
let rota: OnboardingRota;
let primaried: OnboardingRota;

before(async () => {
  fixture = await openTestDb(import.meta.filename);
  classifier = new CommunityClassifier(loadCommunityClassifierConfig({
    TWO_COMMUNITY_CLASSIFIER_VERSION: 'rota-erasure-test-v1',
    TWO_COMMUNITY_AUTOMATION_ACTOR_IDS: 'automation',
    TWO_COMMUNITY_RAID_ACTOR_IDS: 'raider',
    TWO_COMMUNITY_STAGING_GUILD_IDS: 'staging-guild',
    TWO_COMMUNITY_TEST_ACTOR_IDS: 'fixture-user',
  }));
  rota = new OnboardingRota(fixture.db, classifier, { enabled: true, pseudonymKey: KEY });
  primaried = new OnboardingRota(fixture.db, classifier,
    { enabled: true, pseudonymKey: KEY, primaryActorId: PRIMARY });
});
after(async () => fixture?.cleanup());
beforeEach(async () => fixture.reset());

function actor(actorId: string, guildId = GUILD): RotaActor {
  return { guildId, actorId, pending: false };
}

function message(actorId: string): RotaMessage {
  return { ...actor(actorId), messageId: 'first-message', channelId: 'general', eligibleChannel: true, occurredAt: FIRST };
}

async function enrollSubject() {
  await rota.rulesAccepted({ ...actor(SUBJECT), occurredAt: GATE, sourceCohort: 'invite:fixture-campaign' });
  await rota.promptShown({ ...actor(SUBJECT), occurredAt: GATE,
    promptVariant: 'accepted-flow', messageId: 'welcome', channelId: 'general' });
  await rota.message(message(SUBJECT));
}

async function enrollSecond() {
  await rota.rulesAccepted({ ...actor(SECOND), occurredAt: GATE, sourceCohort: 'invite:fixture-campaign' });
  await rota.promptShown({ ...actor(SECOND), occurredAt: GATE,
    promptVariant: 'accepted-flow', messageId: 'welcome-2', channelId: 'general' });
  await rota.message({ ...message(SECOND), messageId: 'second-first-message' });
}

async function factCount(where: string, ...params: unknown[]): Promise<number> {
  const row = await fixture.db.prepare(`SELECT COUNT(*) AS n FROM community_facts WHERE ${where}`)
    .get<{ n: string }>(...params);
  return Number(row?.n ?? 0);
}

test('eraseSubject removes the subject pseudonym rows, responder rows and notices, nothing else', async () => {
  const subjectPseudo = rota.memberId(GUILD, SUBJECT);
  const secondPseudo = rota.memberId(GUILD, SECOND);

  // Subject funnel: enrollment + prompt + first message (4 rows), a staff
  // responder reply (3 rows), and a primary acknowledgement (1 row).
  await enrollSubject();
  await rota.reply({ ...message(RESPONDER), actorId: RESPONDER, isStaff: true, messageId: 'staff-reply',
    occurredAt: REPLY, subject: actor(SUBJECT), replyToMessageId: 'first-message' });
  assert.equal(await primaried.acknowledgePrimary({
    ...actor(PRIMARY), occurredAt: REPLY, subject: actor(SUBJECT),
    actionId: 'first-message', channelId: 'general',
  }), true);
  assert.equal(await factCount('guild_id = ? AND actor_id = ?', GUILD, subjectPseudo), 8);

  // Second member funnel (7 rows), with the SUBJECT as the human responder
  // (3 responderId rows owned by the second member, not the subject). The
  // reply must reference the second member's own first message, not the
  // default 'first-message' from message().
  await enrollSecond();
  await rota.reply({ ...message(SUBJECT), messageId: 'subject-reply', occurredAt: REPLY,
    subject: actor(SECOND), replyToMessageId: 'second-first-message', channelId: 'general' });
  assert.equal(await factCount('guild_id = ? AND actor_id = ?', GUILD, secondPseudo), 7);

  // Non-rota fact for the second member and a raw scorecard row.
  const facts = new CommunityFactStore(fixture.db, classifier);
  assert.equal(await facts.record({
    guildId: GUILD, eventType: 'message_created', actorId: 'raw-non-rota-member',
    sourceEventId: 'raw-message-1', occurredAt: FIRST, source: 'channel:general',
    idempotencyKey: 'raw-message-1',
    classification: classifier.classify({ guildId: GUILD, actorId: 'raw-non-rota-member' }),
    metadata: {},
  }), true);

  // A responderId that must NOT match: same key, non-listed event type.
  await fixture.db.prepare(
    `INSERT INTO community_facts
       (guild_id, event_type, source_event_id, actor_id, occurred_at, source,
        classifier_version, classification, matched_rule, metadata, idempotency_key)
     VALUES (?, 'onboarding_prompt_acted', 'decoy', ?, ?, 'invite:fixture-campaign',
        'rota-erasure-test-v1', 'eligible_human', 'none', ?, 'decoy-key')`,
  ).run(GUILD, secondPseudo, FIRST,
    JSON.stringify({ responderId: subjectPseudo, sourceCohort: 'invite:fixture-campaign', rulesAcceptedAt: GATE }));

  // Same subject enrolled in another guild: guild separation must hold.
  await rota.rulesAccepted({ ...actor(SUBJECT, OTHER_GUILD), occurredAt: GATE, sourceCohort: 'invite:other' });

  // Audit rows: one notice per member plus an unrelated row.
  const audits = new OperationalAuditStore(fixture.db);
  await audits.record({ entryId: `rota-notice:${GUILD}:${subjectPseudo}:first-message`, kind: 'rota_notice',
    channel: 'audit', guildId: GUILD, occurredAt: FIRST, actorId: null, targetId: subjectPseudo,
    messageId: 'first-message', action: 'rota_fallback_notice' });
  await audits.record({ entryId: `rota-notice:${GUILD}:${secondPseudo}:second-first-message`, kind: 'rota_notice',
    channel: 'audit', guildId: GUILD, occurredAt: FIRST, actorId: null, targetId: secondPseudo,
    messageId: 'second-first-message', action: 'rota_fallback_notice' });
  await audits.record({ entryId: 'unrelated-audit', kind: 'member_update', channel: 'audit',
    guildId: GUILD, occurredAt: FIRST, targetId: 'raw-non-rota-member' });

  const counts = await rota.eraseSubject(GUILD, SUBJECT);
  assert.deepEqual(counts, { factsByActor: 8, factsByResponder: 3, auditNotices: 1 });

  // Subject rows gone by both identity paths.
  assert.equal(await factCount('guild_id = ? AND actor_id = ?', GUILD, subjectPseudo), 0);
  assert.equal(await factCount(
    `guild_id = ? AND event_type IN (
       'welcome_rota_acknowledged', 'welcome_rota_replied',
       'onboarding_first_human_reply', 'onboarding_reply_latency'
     ) AND metadata::json->>'responderId' = ?`, GUILD, subjectPseudo), 0);

  // Second member keeps their own 4 enrollment/action rows plus the decoy;
  // the 3 reply rows where the subject was responder are gone by design.
  assert.equal(await factCount('guild_id = ? AND actor_id = ?', GUILD, secondPseudo), 5);
  assert.equal(await factCount(`actor_id = 'raw-non-rota-member'`), 1);
  assert.equal(await factCount(`idempotency_key = 'decoy-key'`), 1);
  assert.equal(await factCount('guild_id = ? AND actor_id = ?', OTHER_GUILD, rota.memberId(OTHER_GUILD, SUBJECT)), 1);
  assert.equal(await audits.get(`rota-notice:${GUILD}:${secondPseudo}:second-first-message`) !== null, true);
  assert.equal(await audits.get('unrelated-audit') !== null, true);
  assert.equal(await audits.get(`rota-notice:${GUILD}:${subjectPseudo}:first-message`), null);

  // No raw fixture id survives in the remaining derived rows.
  assert.doesNotMatch(
    JSON.stringify(await fixture.db.prepare('SELECT actor_id, metadata FROM community_facts').all()),
    /erasure-subject|erasure-second|erasure-responder|erasure-primary/,
  );

  // Erasure is idempotent: a second pass deletes nothing.
  assert.deepEqual(await rota.eraseSubject(GUILD, SUBJECT), { factsByActor: 0, factsByResponder: 0, auditNotices: 0 });
});

test('eraseSubject on an unknown member deletes nothing', async () => {
  await enrollSubject();
  await enrollSecond();
  assert.deepEqual(await rota.eraseSubject(GUILD, 'never-enrolled'), { factsByActor: 0, factsByResponder: 0, auditNotices: 0 });
  // 4 enrollment/action rows per member; no replies were recorded here.
  assert.equal(await factCount('guild_id = ?', GUILD), 8);
});
