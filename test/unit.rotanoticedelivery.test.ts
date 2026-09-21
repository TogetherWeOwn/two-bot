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
  let seq = 900000000000000000n;
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
    guild: { id: GUILD },
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
  const sorted = [...rows].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
  const map = new Map(sorted.map((m) => [m.id, { id: m.id, author: { id: m.authorId, bot: m.authorId === BOT },
    guildId: GUILD, channelId: CHANNEL, partial: false, webhookId: null, system: false, content: m.content }]));
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
  channel.id = DESTINATION;
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
  // Delivery retires queue work, not the human-reply measurement clock.
  assert.deepEqual(await svc.runDue('2026-09-01T23:50:00.000Z'), []);
  assert.equal((await store.get(first.entryId))?.mirrorMessageId, messageId);
  const replyFacts = await fixture.db.prepare(
    "SELECT count(*)::int AS n FROM community_facts WHERE event_type IN ('welcome_rota_replied', 'onboarding_first_human_reply')",
  ).get<{ n: number }>();
  assert.equal(replyFacts?.n, 0);
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

test('no-prompt reply after a stale snapshot suppresses delivery across restart', async () => {
  const subject = { guildId: GUILD, actorId: SUBJECT, pending: false };
  await rota.rulesAccepted({ ...subject, occurredAt: FIRST, sourceCohort: 'unknown' });
  await rota.message({ ...subject, occurredAt: FIRST, messageId: ACTION, channelId: CHANNEL, eligibleChannel: true });
  const snapshot = await rota.dueNotices(GUILD, DUE);
  assert.equal(snapshot.length, 1);
  await rota.reply({ guildId: GUILD, actorId: PRIMARY, pending: false, subject,
    occurredAt: '2026-09-01T23:10:00.000Z', messageId: 'reply',
    channelId: CHANNEL, eligibleChannel: true, replyToMessageId: ACTION });
  const restarted = new OnboardingRota(fixture.db, classifier, {
    enabled: true, noticeEnabled: true, pseudonymKey: KEY, primaryActorId: PRIMARY,
  });
  const { channel, sent } = fakeChannel();
  const [outcome] = await delivery(channel, { rota: {
    dueNotices: async () => snapshot,
    confirmNoticeEligible: restarted.confirmNoticeEligible.bind(restarted),
    withNoticeEligibility: restarted.withNoticeEligibility.bind(restarted),
  } }).runDue(DUE);
  assert.equal(outcome.status, 'suppressed');
  assert.equal(sent.length, 0);
  assert.equal(await store.get(rotaNoticeEntryId(GUILD, restarted.memberId(GUILD, SUBJECT), ACTION)), null);
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
      history.push({ id: '900000000000000001', authorId: BOT, content: payload.content });
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
  assert.equal((second as { messageId: string }).messageId, '900000000000000001');
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

async function expireClaim(entryId: string) {
  await fixture.db.prepare(
    `UPDATE operational_audit_log SET delivery_lease_until = '2000-01-01T00:00:00.000Z' WHERE entry_id = ?`,
  ).run(entryId);
}

async function stoppedByHuman(kind: 'reply' | 'ack') {
  const subject = { guildId: GUILD, actorId: SUBJECT, pending: false };
  const primary = { guildId: GUILD, actorId: PRIMARY, pending: false };
  if (kind === 'ack') {
    assert.equal(await rota.acknowledgePrimary({ ...primary, subject, occurredAt: DUE,
      actionId: ACTION, channelId: CHANNEL }), true);
  } else {
    await rota.reply({ ...primary, subject, occurredAt: DUE, messageId: 'reply',
      channelId: CHANNEL, eligibleChannel: true, replyToMessageId: ACTION });
  }
}

for (const kind of ['reply', 'ack'] as const) {
  test(`${kind} during access verification prevents POST at the final send check`, async () => {
    await enroll();
    const { channel, sent } = fakeChannel();
    let checks = 0;
    const svc = delivery(channel, { verifyAccess: async () => {
      if (++checks === 1) await stoppedByHuman(kind);
      return channel;
    } });
    assert.equal((await svc.runDue(DUE))[0].status, 'suppressed');
    assert.equal(sent.length, 0);
  });
}

for (const failAt of [1, 2]) {
  test(`kill-switch read failure at check ${failAt} holds without POST`, async () => {
    await enroll();
    const { channel, sent } = fakeChannel();
    const faulty = Object.create(store) as OperationalAuditStore;
    let reads = 0;
    faulty.isDeliveryHalted = async () => { if (++reads === failAt) throw new Error('unavailable'); return false; };
    assert.equal((await delivery(channel, { store: faulty }).runDue(DUE))[0].status, 'held');
    assert.equal(sent.length, 0);
    const row = await store.get(rotaNoticeEntryId(GUILD, rota.memberId(GUILD, SUBJECT), ACTION));
    assert.equal(row?.deliverySearchBefore, null, 'no POST was attempted in this claim');
  });
}

test('access revoked during history work is refused before POST', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  let checks = 0;
  const [outcome] = await delivery(channel, { verifyAccess: async () => ++checks === 1 ? channel : null }).runDue(DUE);
  assert.equal(outcome.status, 'failed');
  assert.equal(checks, 2);
  assert.equal(sent.length, 0);
});

test('halt while recovering never clears an ambiguous previous POST boundary', async () => {
  await enroll();
  const { channel, sent, history } = fakeChannel({ send: () => { throw new Error('unknown outcome'); } });
  const [first] = await delivery(channel).runDue(DUE);
  const entryId = first.entryId;
  const boundary = (await store.get(entryId))!.deliverySearchBefore;
  assert.ok(boundary);
  await expireClaim(entryId);
  await store.engageDeliveryHalt('fixture');
  assert.equal((await delivery(channel).runDue(DUE))[0].status, 'held');
  assert.equal((await store.get(entryId))!.deliverySearchBefore, boundary);
  await store.disengageDeliveryHalt();
  history.length = 0;
  assert.equal((await delivery(channel).runDue(DUE))[0].status, 'failed');
  assert.equal(sent.length, 1, 'missing ambiguous marker must not cause a second POST');
  assert.equal((await store.get(entryId))!.deliveryState, 'quarantined');
});

test('changed configured destination cannot redirect an existing durable notice', async () => {
  await enroll();
  const { channel, sent } = fakeChannel({ send: () => { throw new Error('unknown outcome'); } });
  const [first] = await delivery(channel).runDue(DUE);
  await expireClaim(first.entryId);
  const other = fakeChannel(); other.channel.id = DESTINATION;
  assert.equal((await delivery(other.channel, {}, DESTINATION).runDue(DUE))[0].status, 'failed');
  assert.equal(other.sent.length, 0);
  assert.equal(sent.length, 1);
  assert.equal((await store.get(first.entryId))!.deliveryState, 'quarantined');
});

test('lost recovery lease stops history work instead of swallowing the refusal', async () => {
  await enroll();
  const { channel, sent } = fakeChannel({ send: () => { throw new Error('unknown outcome'); } });
  const [first] = await delivery(channel).runDue(DUE);
  await expireClaim(first.entryId);
  let fetches = 0;
  channel.messages.fetch = async () => { fetches++; return new Collection(); };
  const stale = Object.create(store) as OperationalAuditStore;
  stale.extendDeliveryLease = async () => { throw new Error('claim lost'); };
  assert.equal((await delivery(channel, { store: stale }).runDue(DUE))[0].status, 'failed');
  assert.equal(fetches, 0);
  assert.equal(sent.length, 1);
  assert.ok((await store.get(first.entryId))!.deliverySearchBefore);
});

test('recovery history budget is bounded and an incomplete scan is quarantined', async () => {
  await enroll();
  const { channel, sent } = fakeChannel({ send: () => { throw new Error('unknown outcome'); } });
  const [first] = await delivery(channel).runDue(DUE);
  await expireClaim(first.entryId);
  let pages = 0;
  channel.messages.fetch = async () => {
    if (++pages > 6) throw new Error('test backstop for unbounded scan');
    return collection(Array.from({ length: 100 }, (_,i) => ({
      id: String(900000000000010000n - BigInt(pages * 100 + i)), authorId: PRIMARY, content: 'unrelated',
    })));
  };
  assert.equal((await delivery(channel).runDue(DUE))[0].status, 'failed');
  assert.equal(pages, 5);
  assert.equal(sent.length, 1);
  assert.equal((await store.get(first.entryId))!.deliveryState, 'quarantined');
});

test('delivered subjects cannot starve the next bounded batch', async () => {
  await enroll();
  const later = { guildId: GUILD, actorId: '888888888888888888', pending: false };
  await rota.rulesAccepted({ ...later, occurredAt: FIRST, sourceCohort: 'unknown' });
  await rota.message({ ...later, occurredAt: '2026-09-01T23:06:00.000Z',
    messageId: '999999999999999999', channelId: CHANNEL, eligibleChannel: true });
  const { channel, sent } = fakeChannel();
  const svc = delivery(channel);
  const now = '2026-09-01T23:40:00.000Z';
  assert.equal((await svc.runDue(now, 1))[0].status, 'sent');
  assert.equal((await svc.runDue(now, 1))[0].status, 'sent');
  assert.equal(sent.length, 2);
  assert.deepEqual(await svc.runDue(now, 1), []);
});

test('pending retry failures yield to never-attempted subjects', async () => {
  await enroll();
  const later = { guildId: GUILD, actorId: '888888888888888888', pending: false };
  await rota.rulesAccepted({ ...later, occurredAt: FIRST, sourceCohort: 'unknown' });
  await rota.message({ ...later, occurredAt: '2026-09-01T23:06:00.000Z',
    messageId: '999999999999999999', channelId: CHANNEL, eligibleChannel: true });
  const { channel } = fakeChannel();
  const svc = delivery(channel, { verifyAccess: async () => null });
  const now = '2026-09-01T23:40:00.000Z';
  const [first] = await svc.runDue(now, 1);
  const [second] = await svc.runDue(now, 1);
  assert.notEqual(first.entryId, second.entryId);
  assert.equal((await rota.dueNotices(GUILD, now)).length, 2, 'transient failures remain retryable');
});

test('stop during access work holds the active claim and refuses later sweeps', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const svc = delivery(channel, { verifyAccess: async () => { svc.stop(); return channel; } });
  assert.equal((await svc.runDue(DUE))[0].status, 'held');
  assert.equal(sent.length, 0);
  assert.deepEqual(await svc.runDue(DUE), []);
});

for (const config of [{ enabled: false, noticeEnabled: true }, { enabled: true, noticeEnabled: false }]) {
  test(`final eligibility honors master=${config.enabled}, notice=${config.noticeEnabled}`, async () => {
    await enroll();
    const snapshot = await rota.dueNotices(GUILD, DUE);
    const rolledBack = new OnboardingRota(fixture.db, classifier, { ...config, pseudonymKey: KEY, primaryActorId: PRIMARY });
    const { channel, sent } = fakeChannel();
    const [outcome] = await delivery(channel, { rota: {
      dueNotices: async () => snapshot,
      confirmNoticeEligible: rota.confirmNoticeEligible.bind(rota),
      withNoticeEligibility: rolledBack.withNoticeEligibility.bind(rolledBack),
    } }).runDue(DUE);
    assert.equal(outcome.status, 'suppressed');
    assert.equal(sent.length, 0);
  });
}

test('lost claim after preparing POST cannot send or mutate the replacement owner', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const stale = Object.create(store) as OperationalAuditStore;
  let replacementToken: string | null = null;
  stale.prepareDeliverySend = async (entryId, token, cursor) => {
    await store.prepareDeliverySend(entryId, token, cursor);
    await expireClaim(entryId);
    replacementToken = (await store.claim(entryId))!.deliveryClaimToken;
  };
  const [outcome] = await delivery(channel, { store: stale }).runDue(DUE);
  assert.equal(outcome.status, 'failed');
  assert.equal(sent.length, 0);
  const row = (await store.get(outcome.entryId))!;
  assert.equal(row.deliveryClaimToken, replacementToken);
  assert.equal(row.deliveryState, 'delivering');
  assert.ok(row.deliverySearchBefore);
});

test('halt engaged while preparing POST is caught by the final switch read', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const wrapped = Object.create(store) as OperationalAuditStore;
  wrapped.prepareDeliverySend = async (entryId, token, cursor) => {
    await store.prepareDeliverySend(entryId, token, cursor);
    await store.engageDeliveryHalt('fixture');
  };
  const [outcome] = await delivery(channel, { store: wrapped }).runDue(DUE);
  assert.equal(outcome.status, 'held');
  assert.equal(sent.length, 0);
  assert.equal((await store.get(outcome.entryId))!.deliverySearchBefore, null);
});

test('POST authorization holds the subject lock against a concurrent acknowledgement', { timeout: 5000 }, async () => {
  await enroll();
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { channel, sent } = fakeChannel({ send: async () => {
    started(); await gate; return { id: '900000000000000000' };
  } });
  const posting = delivery(channel).runDue(DUE);
  let acknowledged = false;
  let ack: Promise<void> | undefined;
  try {
    await entered;
    ack = stoppedByHuman('ack').then(() => { acknowledged = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(acknowledged, false);
  } finally {
    release();
    await ack;
  }
  assert.equal((await posting)[0].status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(acknowledged, true);
});

test('crash after POST before database acknowledgement recovers one marker', async () => {
  await enroll();
  const { channel, sent } = fakeChannel();
  const faulty = Object.create(store) as OperationalAuditStore;
  faulty.markDelivered = async () => { throw new Error('database acknowledgement lost'); };
  const [first] = await delivery(channel, { store: faulty }).runDue(DUE);
  assert.equal(first.status, 'failed');
  await expireClaim(first.entryId);
  assert.equal((await delivery(channel).runDue(DUE))[0].status, 'recovered');
  assert.equal(sent.length, 1);
});

for (const mode of ['partial', 'foreign-channel', 'foreign-guild', 'duplicate-marker', 'repeated-page', 'invalid-id']) {
  test(`uncertain ${mode} recovery history quarantines without resend`, async () => {
    await enroll();
    const { channel, sent } = fakeChannel({ send: () => { throw new Error('unknown outcome'); } });
    const [first] = await delivery(channel).runDue(DUE);
    await expireClaim(first.entryId);
    const marker = `rota-notice:${first.entryId};`;
    let fetches = 0;
    channel.messages.fetch = async () => {
      fetches++;
      if (mode === 'repeated-page') {
        return collection(Array.from({ length: 100 }, (_,i) => ({
          id: String(900000000000010000n - BigInt(i)), authorId: PRIMARY, content: '',
        })));
      }
      const rows = collection([{ id: '900000000000000001', authorId: BOT, content: marker }]);
      if (mode === 'partial') rows.first().partial = true;
      if (mode === 'foreign-channel') rows.first().channelId = DESTINATION;
      if (mode === 'foreign-guild') rows.first().guildId = PRIMARY;
      if (mode === 'invalid-id') rows.first().id = 'not-a-snowflake';
      if (mode === 'duplicate-marker') rows.set('900000000000000000', { ...rows.first(), id: '900000000000000000' });
      return rows;
    };
    assert.equal((await delivery(channel).runDue(DUE))[0].status, 'failed');
    assert.equal((await store.get(first.entryId))!.deliveryState, 'quarantined');
    assert.equal(sent.length, 1);
    assert.ok(fetches <= 2);
  });
}

test('a webhook or another author cannot impersonate a recovered bot marker', async () => {
  await enroll();
  const { channel, sent } = fakeChannel({ send: () => { throw new Error('unknown outcome'); } });
  const [first] = await delivery(channel).runDue(DUE);
  await expireClaim(first.entryId);
  channel.messages.fetch = async () => {
    const rows = collection([
      { id: '900000000000000001', authorId: BOT, content: `rota-notice:${first.entryId};` },
      { id: '900000000000000000', authorId: PRIMARY, content: `rota-notice:${first.entryId};` },
    ]);
    rows.first().webhookId = PRIMARY;
    return rows;
  };
  assert.equal((await delivery(channel).runDue(DUE))[0].status, 'failed');
  assert.equal(sent.length, 1);
  assert.equal((await store.get(first.entryId))!.deliveryState, 'quarantined');
});
