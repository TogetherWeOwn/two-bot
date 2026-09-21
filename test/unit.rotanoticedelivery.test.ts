import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from '../src/analytics/communityClassifier.ts';
import { OnboardingRota } from '../src/analytics/onboardingRota.ts';
import { OperationalAuditStore } from '../src/audit/store.ts';
import { RotaNoticeDelivery, type RotaNoticeDeliveryDeps } from '../src/discord/rotaNoticeDelivery.ts';
import { rotaNoticeEntryId } from '../src/discord/rotaNoticePayload.ts';

// All ids below are synthetic fixtures, not real Discord snowflakes.
const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const DESTINATION = '777777777777777777';
const ACTION = '333333333333333333';
const BOT = '444444444444444444';
const PRIMARY = '555555555555555555';
const SUBJECT = '666666666666666666';
const KEY = 'fixture-only-delivery-test-key-123456789012';
const FIRST = '2026-09-01T23:05:00.000Z';
const DUE = '2026-09-01T23:35:00.000Z';

let fixture: TestDb;
let classifier: CommunityClassifier;
let rota: OnboardingRota;
let store: OperationalAuditStore;

function enroll() {
  const subject = { guildId: GUILD, actorId: SUBJECT, pending: false };
  return (async () => {
    await rota.rulesAccepted({ ...subject, occurredAt: '2026-09-01T23:00:00.000Z', sourceCohort: 'invite:campaign' });
    await rota.promptShown({ ...subject, occurredAt: '2026-09-01T23:01:00.000Z',
      promptVariant: 'session', messageId: 'welcome', channelId: CHANNEL });
    await rota.message({ ...subject, occurredAt: FIRST, messageId: ACTION, channelId: CHANNEL, eligibleChannel: true });
  })();
}

interface FakeChannelOpts {
  send?: (payload: { content: string }) => Promise<{ id: string }> | { id: string };
  history?: Array<{ id: string; authorId: string; content: string }>;
  failHistoryWith?: { status: number };
}

function fakeChannel(opts: FakeChannelOpts = {}) {
  const sent: Array<{ content: string; nonce: unknown; allowedMentions: unknown }> = [];
  const history = opts.history ?? [];
  let seq = 900;
  const messages = {
    fetch: async (args: Record<string, unknown>) => {
      if (opts.failHistoryWith) {
        const err = Object.assign(new Error('fetch failed'), { status: opts.failHistoryWith.status });
        throw err;
      }
      if (args.limit === 1 && !args.before) {
        const last = history[history.length - 1];
        const one = last ? [{ ...last }] : [];
        return collection(one);
      }
      let pool = [...history];
      if (typeof args.before === 'string') pool = pool.filter((m) => BigInt(m.id) < BigInt(args.before as string));
      const page = pool.slice(-100);
      return collection(page);
    },
  };
  const channel: any = {
    id: CHANNEL,
    client: { user: { id: BOT } },
    messages,
    send: async (payload: { content: string; nonce: unknown; allowedMentions: unknown }) => {
      sent.push(payload);
      if (opts.send) return opts.send(payload);
      const id = String(seq++);
      history.push({ id, authorId: BOT, content: payload.content });
      return { id };
    },
  };
  return { channel, sent, history };
}

function collection(rows: Array<{ id: string; authorId: string; content: string }>) {
  const map = new Map(rows.map((m) => [m.id, { id: m.id, author: { id: m.authorId }, content: m.content }]));
  const col: any = new Collection(map);
  return col;
}

function deps(overrides: Partial<RotaNoticeDeliveryDeps> = {}): RotaNoticeDeliveryDeps {
  return {
    rota: rota as unknown as RotaNoticeDeliveryDeps['rota'],
    store: store as unknown as RotaNoticeDeliveryDeps['store'],
    verifyAccess: async () => fakeChannel().channel,
    ...overrides,
  };
}

function delivery(channel: any, overrideDeps: Partial<RotaNoticeDeliveryDeps> = {}, destination = CHANNEL) {
  const client: any = { user: { id: BOT, bot: true } };
  return new RotaNoticeDelivery(client,
    { guildId: GUILD, noticeChannelId: destination, readerIds: [PRIMARY] },
    deps({ verifyAccess: async () => channel, ...overrideDeps }));
}

before(async () => {
  fixture = await openTestDb(import.meta.filename);
  classifier = new CommunityClassifier(loadCommunityClassifierConfig({
    TWO_COMMUNITY_RAID_ACTOR_IDS: 'raider', TWO_COMMUNITY_TEST_ACTOR_IDS: 'fixture-user',
    TWO_COMMUNITY_AUTOMATION_ACTOR_IDS: 'automation', TWO_COMMUNITY_STAGING_GUILD_IDS: 'staging-guild',
  }));
});
after(async () => fixture?.cleanup());
beforeEach(async () => {
  await fixture.reset();
  rota = new OnboardingRota(fixture.db, classifier, {
    enabled: true, noticeEnabled: true, pseudonymKey: KEY, primaryActorId: PRIMARY,
  });
  store = new OperationalAuditStore(fixture.db);
});

test('due candidate is claimed, rechecked, and sent with suppressed mentions', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const [outcome] = await delivery(channel).runDue(DUE);
  assert.equal(outcome.status, 'sent');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.match(sent[0].content, /rota fallback notice.*\(bot\)/);
  assert.ok(typeof sent[0].nonce === 'string' && sent[0].nonce.length > 0);
  const memberId = rota.memberId(GUILD, SUBJECT);
  const entryId = rotaNoticeEntryId(GUILD, memberId, ACTION);
  assert.equal((outcome as { entryId: string }).entryId, entryId);
  const row = await store.get(entryId);
  assert.equal(row?.deliveryState, 'delivered');
  assert.equal(row?.mirrorMessageId, (outcome as { messageId: string }).messageId);
  assert.equal(row?.mirrorChannelId, CHANNEL);
});

test('distinct source and staff destination still reaches the send path', async () => {
  // Regression for the review finding on 274485e: candidate.channelId is the
  // newcomer's source/action channel, noticeChannelId the staff destination.
  // They differ in any real deployment; delivery must not suppress on that.
  await enroll();
  const { channel, sent } = fakeChannel();
  const [outcome] = await delivery(channel, {}, DESTINATION).runDue(DUE);
  assert.equal(outcome.status, 'sent');
  assert.equal(sent.length, 1);
  const memberId = rota.memberId(GUILD, SUBJECT);
  const entryId = rotaNoticeEntryId(GUILD, memberId, ACTION);
  const row = await store.get(entryId);
  assert.equal(row?.deliveryState, 'delivered');
  assert.equal(row?.mirrorChannelId, DESTINATION);
  assert.equal(row?.event.destinationChannelId, DESTINATION);
  assert.match(sent[0].content, new RegExp(`https://discord\\.com/channels/${GUILD}/${CHANNEL}/${ACTION}`));
});

test('second sweep after delivery reconciles without resending', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const svc = delivery(channel);
  const [first] = await svc.runDue(DUE);
  assert.equal(first.status, 'sent');
  const messageId = (first as { messageId: string }).messageId;
  // The notice does not stop the clock: the candidate stays due, but the
  // durable delivered row reconciles instead of resending.
  const [second] = await svc.runDue('2026-09-01T23:50:00.000Z');
  assert.equal(second.status, 'recovered');
  assert.equal((second as { messageId: string }).messageId, messageId);
  assert.equal(sent.length, 1);
});

test('concurrent claimants deliver at most once', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const svc = delivery(channel);
  const results = await Promise.all([svc.runDue(DUE), svc.runDue(DUE), svc.runDue(DUE)]);
  assert.equal(results.flat().filter((r) => r.status === 'sent').length, 1);
  assert.equal(sent.length, 1);
});

test('reply before the sweep suppresses the send at the snapshot', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  await rota.reply({ guildId: GUILD, actorId: PRIMARY, pending: false, isBot: false,
    subject: { guildId: GUILD, actorId: SUBJECT, pending: false },
    occurredAt: '2026-09-01T23:10:00.000Z', messageId: 'reply',
    channelId: CHANNEL, eligibleChannel: true, replyToMessageId: ACTION });
  const outcomes = await delivery(channel).runDue(DUE);
  assert.deepEqual(outcomes, []);
  assert.equal(sent.length, 0);
});

test('reply landing after the snapshot is caught by the lock-scoped recheck', async () => {
  await enroll();
  const memberId = rota.memberId(GUILD, SUBJECT);
  const hold = await rota.dueNotices(GUILD, DUE);
  assert.equal(hold.length, 1);
  await rota.reply({ guildId: GUILD, actorId: PRIMARY, pending: false, isBot: false,
    subject: { guildId: GUILD, actorId: SUBJECT, pending: false },
    occurredAt: '2026-09-01T23:10:00.000Z', messageId: 'reply',
    channelId: CHANNEL, eligibleChannel: true, replyToMessageId: ACTION });
  assert.equal(await rota.confirmNoticeEligible(GUILD, memberId, ACTION, CHANNEL, DUE), null);
});

test('acknowledgement before the sweep suppresses the send at the snapshot', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const primary = { guildId: GUILD, actorId: PRIMARY, pending: false as const };
  const subject = { guildId: GUILD, actorId: SUBJECT, pending: false as const };
  assert.equal(await rota.acknowledgePrimary({ ...primary, subject, occurredAt: DUE,
    actionId: ACTION, channelId: CHANNEL }), true);
  const outcomes = await delivery(channel).runDue(DUE);
  assert.deepEqual(outcomes, []);
  assert.equal(sent.length, 0);
});

test('acknowledgement landing after the snapshot is caught by the lock-scoped recheck', async () => {
  await enroll();
  const memberId = rota.memberId(GUILD, SUBJECT);
  assert.equal((await rota.dueNotices(GUILD, DUE)).length, 1);
  const primary = { guildId: GUILD, actorId: PRIMARY, pending: false as const };
  const subject = { guildId: GUILD, actorId: SUBJECT, pending: false as const };
  assert.equal(await rota.acknowledgePrimary({ ...primary, subject, occurredAt: DUE,
    actionId: ACTION, channelId: CHANNEL }), true);
  assert.equal(await rota.confirmNoticeEligible(GUILD, memberId, ACTION, CHANNEL, DUE), null);
});

test('access refusal fails closed with no send and no fallback', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const svc = delivery(channel, { verifyAccess: async () => null });
  const [outcome] = await svc.runDue(DUE);
  assert.equal(outcome.status, 'failed');
  assert.equal((outcome as { classification: string }).classification, 'access_refused');
  assert.equal(sent.length, 0);
  const row = await store.get(rotaNoticeEntryId(GUILD, rota.memberId(GUILD, SUBJECT), ACTION));
  assert.equal(row?.deliveryState, 'pending');
});

test('kill switch holds the claim without sending', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  assert.equal(await store.engageDeliveryHalt('fixture-operator'), true);
  const [outcome] = await delivery(channel).runDue(DUE);
  assert.equal(outcome.status, 'held');
  assert.equal(sent.length, 0);
  assert.equal(await store.disengageDeliveryHalt(), true);
  const [retry] = await delivery(channel).runDue(DUE);
  assert.equal(retry.status, 'sent');
});

test('ambiguous POST keeps the lease; retry after expiry recovers the sent marker', async () => {
  await enroll();
  const history: Array<{ id: string; authorId: string; content: string }> = [];
  const { channel, sent } = fakeChannel({
    history,
    // Discord accepted the POST but the response was lost: the marker lands
    // in history even though this call throws.
    send: (payload) => {
      history.push({ id: '901', authorId: BOT, content: payload.content });
      throw Object.assign(new Error('socket reset'), { status: null });
    },
  });
  const svc = delivery(channel);
  const [first] = await svc.runDue(DUE);
  assert.equal(first.status, 'failed');
  assert.equal((first as { classification: string }).classification, 'discord_post_ambiguous');
  const entryId = rotaNoticeEntryId(GUILD, rota.memberId(GUILD, SUBJECT), ACTION);
  const held = await store.get(entryId);
  assert.equal(held?.deliveryState, 'delivering');
  // The lease outlives the test clock: expire it the way a later sweep would see it.
  await fixture.db.prepare(
    `UPDATE operational_audit_log SET delivery_lease_until = '2000-01-01T00:00:00.000Z' WHERE entry_id = ?`,
  ).run(entryId);
  const [second] = await delivery(channel).runDue(DUE);
  assert.equal(second.status, 'recovered');
  assert.equal((second as { messageId: string }).messageId, '901');
  assert.equal(sent.length, 1, 'the retry reconciled the marker instead of resending');
});

test('missing marker after the recovery boundary quarantines without resending', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const svc = delivery(channel);
  const [first] = await svc.runDue(DUE);
  assert.equal(first.status, 'sent');
  const entryId = (first as { entryId: string }).entryId;
  // Simulate crash-after-POST-before-ack with the marker lost: row back to
  // delivering with the recovery boundary persisted, lease expired, and no
  // matching message in history.
  await fixture.db.prepare(
    `UPDATE operational_audit_log SET delivery_state = 'delivering', delivery_claim_token = NULL,
       delivery_lease_until = '2000-01-01T00:00:00.000Z', mirror_message_id = NULL WHERE entry_id = ?`,
  ).run(entryId);
  const boundary = (await store.get(entryId))?.deliverySearchBefore;
  assert.ok(boundary, 'the recovery boundary survived the crash');
  const { channel: empty } = fakeChannel({ history: [] });
  const [second] = await delivery(empty).runDue(DUE);
  assert.equal(second.status, 'failed');
  assert.equal((second as { classification: string }).classification, 'discord_marker_missing');
  assert.equal(sent.length, 1, 'no resend happened anywhere');
  assert.equal((await store.get(entryId))?.deliveryState, 'quarantined');
});

test('definite send rejection fails the delivery and clears the boundary', async () => {
  await enroll();
  const { channel } = fakeChannel({
    send: () => { throw Object.assign(new Error('forbidden'), { status: 403 }); },
  });
  const [outcome] = await delivery(channel).runDue(DUE);
  assert.equal(outcome.status, 'failed');
  assert.equal((outcome as { classification: string }).classification, 'discord_send_rejected');
  const row = await store.get(rotaNoticeEntryId(GUILD, rota.memberId(GUILD, SUBJECT), ACTION));
  assert.equal(row?.deliveryState, 'pending');
  assert.equal(row?.deliverySearchBefore, null);
});
