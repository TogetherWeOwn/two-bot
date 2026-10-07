/**
 * The weekly re-engagement list (TWO-8).
 *
 * The two assertions that matter most are the ones that decide whether a human
 * working this list top-down spends the week on people or on bots:
 *
 *   - raid accounts never appear on it, and are counted on their own line
 *   - a member who has only ever been in voice counts as engaged
 *
 * Everything else is bucket arithmetic.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import {
  buildList,
  classify,
  engagedVia,
  markListed,
  rank,
  THRESHOLDS,
  type ListEntry,
} from '../src/jobs/reengagement.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = '1';
const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

let harness: TestDb;

before(async () => {
  harness = await openTestDb(import.meta.filename);
});
after(async () => {
  await harness.cleanup();
});
beforeEach(async () => {
  await harness.reset();
});

// --- classification (pure, no database) -----------------------------------

test('a member who joined days ago and said nothing is not written off yet', () => {
  assert.equal(classify({ joinedAt: daysAgo(1), firstMessageAt: null, firstVoiceAt: null, lastActiveAt: null }, NOW), null);
  assert.equal(
    classify({ joinedAt: daysAgo(30), firstMessageAt: null, firstVoiceAt: null, lastActiveAt: null }, NOW),
    'never_engaged',
  );
});

test('quiet time decides the bucket', () => {
  const at = (d: number) => ({ joinedAt: daysAgo(400), firstMessageAt: daysAgo(d), firstVoiceAt: null, lastActiveAt: daysAgo(d) });
  assert.equal(classify(at(5), NOW), null, 'active last week is not a problem');
  assert.equal(classify(at(THRESHOLDS.quietDays + 1), NOW), 'slipping');
  assert.equal(classify(at(THRESHOLDS.dormantDays + 1), NOW), 'dormant');
  assert.equal(classify(at(THRESHOLDS.lapsedDays + 1), NOW), 'lapsed');
});

test('boundaries fall on the safer side', () => {
  const at = (d: number) => ({ joinedAt: daysAgo(400), firstMessageAt: daysAgo(d), firstVoiceAt: null, lastActiveAt: daysAgo(d) });
  // Exactly at the threshold counts as quiet - a day short of it does not.
  assert.equal(classify(at(THRESHOLDS.quietDays), NOW), 'slipping');
  assert.equal(classify(at(THRESHOLDS.quietDays - 1), NOW), null);
});

test('voice counts as engagement', () => {
  // TWO is voice-first: 15 human text messages in 90 days against 495 voice
  // events. Ranking a voice regular as "never engaged" would put most of the
  // active community on the list.
  const voiceOnly = { joinedAt: daysAgo(100), firstMessageAt: null, firstVoiceAt: daysAgo(4), lastActiveAt: daysAgo(4) };
  assert.equal(classify(voiceOnly, NOW), null);
  assert.equal(engagedVia(voiceOnly), 'voice');
  assert.equal(engagedVia({ joinedAt: null, firstMessageAt: daysAgo(1), firstVoiceAt: daysAgo(1), lastActiveAt: daysAgo(1) }), 'both');
});

test('the most recoverable names sort to the top', () => {
  const e = (segment: ListEntry['segment'], daysQuiet: number | null, daysSinceJoin = 100): ListEntry => ({
    memberId: `${segment}:${daysQuiet}`,
    segment,
    joinedAt: daysAgo(daysSinceJoin),
    joinSource: null,
    lastActiveAt: daysQuiet === null ? null : daysAgo(daysQuiet),
    daysQuiet,
    daysSinceJoin,
    engagedVia: 'both',
    previouslyListedAt: null,
  });
  const sorted = [e('lapsed', 300), e('dormant', 90), e('slipping', 40), e('slipping', 25), e('never_engaged', null, 10)]
    .sort(rank)
    .map((x) => x.memberId);
  assert.deepEqual(sorted, ['never_engaged:null', 'slipping:25', 'slipping:40', 'dormant:90', 'lapsed:300']);
});

// --- the list itself ------------------------------------------------------

async function seed(store: EventStore, id: string, joinedAt: string, activeAt?: string): Promise<void> {
  await store.record({ guildId: G, memberId: id, eventType: 'member_join', occurredAt: joinedAt, source: 'invite:x' });
  if (activeAt) {
    await store.record({ guildId: G, memberId: id, eventType: 'first_voice_session', occurredAt: activeAt, source: 'channel:c1' });
  }
}

test('raid accounts are kept off the list and counted separately', async () => {
  const store = new EventStore(harness.db);
  // Three accounts from the confirmed 2025-07-06 mass-join, plus one real
  // person who joined the same week and also never engaged.
  for (const id of ['r1', 'r2', 'r3']) await seed(store, id, '2025-07-06T20:40:00.000Z');
  await seed(store, 'human', '2025-07-09T18:00:00.000Z');

  const list = await buildList(harness.db, G, { now: NOW });

  assert.deepEqual(list.entries.map((e) => e.memberId), ['human']);
  assert.equal(list.setAside.raidAccounts, 3);
  assert.equal(list.totals.presentHumans, 4, 'they are still in the server, so still in the total');
});

test('engaged raid-window joiners stay in the population and classify by recency', async () => {
  const store = new EventStore(harness.db);
  const joinedAt = '2025-07-06T20:40:00.000Z';
  await seed(store, 'silent', joinedAt);
  await seed(store, 'active', joinedAt, daysAgo(2));
  await seed(store, 'slipping', joinedAt, daysAgo(30));
  await seed(store, 'dormant', joinedAt);
  await store.record({ guildId: G, memberId: 'dormant', eventType: 'first_message', occurredAt: daysAgo(90), source: 'channel:c1' });
  await seed(store, 'lapsed', joinedAt, daysAgo(300));
  await store.record({ guildId: G, memberId: 'lapsed', eventType: 'first_message', occurredAt: daysAgo(300), source: 'channel:c1' });

  // Engagement must not bypass the present-human and guild filters.
  await seed(store, 'gone', joinedAt, daysAgo(30));
  await store.record({ guildId: G, memberId: 'gone', eventType: 'member_leave', occurredAt: daysAgo(1), source: 'gateway' });
  await seed(store, 'bot', joinedAt, daysAgo(30));
  await harness.db.prepare('UPDATE members SET is_bot = TRUE WHERE guild_id = ? AND member_id = ?').run(G, 'bot');
  await store.record({ guildId: 'other', memberId: 'outsider', eventType: 'member_join', occurredAt: joinedAt, source: 'invite:x' });
  await store.record({ guildId: 'other', memberId: 'outsider', eventType: 'first_voice_session', occurredAt: daysAgo(30), source: 'channel:c1' });

  const before = await harness.db.prepare('SELECT COUNT(*) AS n FROM events').get<{ n: number }>();
  const list = await buildList(harness.db, G, { now: NOW });

  assert.deepEqual(list.entries.map((e) => [e.memberId, e.segment, e.engagedVia, e.daysQuiet]), [
    ['slipping', 'slipping', 'voice', 30],
    ['dormant', 'dormant', 'text', 90],
    ['lapsed', 'lapsed', 'both', 300],
  ]);
  assert.deepEqual(list.counts, { never_engaged: 0, slipping: 1, dormant: 1, lapsed: 1 });
  assert.equal(list.setAside.raidAccounts, 1, 'only the silent window joiner is set aside');
  assert.equal(list.totals.stillActive, 1, 'recently engaged window joiners still count');
  assert.equal(list.totals.presentHumans, 5);
  assert.equal(
    list.totals.presentHumans,
    list.entries.length + list.totals.stillActive + list.setAside.inGracePeriod + list.setAside.raidAccounts,
    'included and set-aside members account for every present human',
  );
  assert.deepEqual(await harness.db.prepare('SELECT COUNT(*) AS n FROM events').get(), before, 'building the list is read-only');
});

test('a member who left is not somebody we are losing', async () => {
  const store = new EventStore(harness.db);
  await seed(store, 'gone', daysAgo(200));
  await store.record({ guildId: G, memberId: 'gone', eventType: 'member_leave', occurredAt: daysAgo(10), source: 'gateway' });

  const list = await buildList(harness.db, G, { now: NOW });
  assert.equal(list.entries.length, 0);
});

test('the list separates the three reasons a member is not on it', async () => {
  const store = new EventStore(harness.db);
  await seed(store, 'active', daysAgo(300), daysAgo(2)); // still around
  await seed(store, 'fresh', daysAgo(1)); // too early to say
  await seed(store, 'quiet', daysAgo(300), daysAgo(30)); // slipping

  const list = await buildList(harness.db, G, { now: NOW });
  assert.deepEqual(list.entries.map((e) => e.memberId), ['quiet']);
  assert.equal(list.totals.stillActive, 1);
  assert.equal(list.setAside.inGracePeriod, 1);
  assert.equal(list.counts.slipping, 1);
});

test('marking a handover makes next week distinguish new names from old', async () => {
  const store = new EventStore(harness.db);
  await seed(store, 'quiet', daysAgo(300), daysAgo(30));

  const first = await buildList(harness.db, G, { now: NOW });
  assert.equal(first.entries[0].previouslyListedAt, null, 'new this week');

  assert.equal(await markListed(store, G, first.entries), 1);

  const second = await buildList(harness.db, G, { now: NOW });
  assert.ok(second.entries[0].previouslyListedAt, 'carried over, not new');
});

test('nothing on this path sends a member anything', async () => {
  // markListed writes one event type and no others. If an outbound feature is
  // ever added, this test should be the thing that fails first.
  const store = new EventStore(harness.db);
  await seed(store, 'quiet', daysAgo(300), daysAgo(30));
  const list = await buildList(harness.db, G, { now: NOW });
  await markListed(store, G, list.entries);

  const types = (await harness.db
    .prepare(`SELECT DISTINCT event_type AS t FROM events WHERE member_id = 'quiet'`)
    .all<{ t: string }>()).map((r) => r.t).sort();
  assert.deepEqual(types, ['first_voice_session', 'member_inactive', 'member_join']);
});
