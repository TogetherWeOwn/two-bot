/**
 * The staging fixtures, checked without Postgres, Discord, or a token.
 *
 * These run against in-memory SQLite because the fixtures go through
 * EventStore, which is driver-agnostic. That is deliberate: QA needs to trust
 * the fixture SHAPE, and the shape is a property of the seed data, not of the
 * engine underneath it. The Postgres path is exercised by staging-reset.ts
 * itself, which re-checks every count after seeding and exits non-zero on a
 * mismatch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { flagInactive, joinedNeverPosted } from '../src/jobs/inactivity.ts';
import {
  EXPECTED_DISTINCT,
  EXPECTED_FAST_SECONDS,
  EXPECTED_FUNNEL,
  EXPECTED_JOINED_NEVER_POSTED,
  EXPECTED_NEWLY_INACTIVE,
  FIXTURE_MEMBER_IDS,
  TEST_NOW,
  fixtureEvents,
  resetStagingData,
  seedFixtures,
} from '../src/staging/fixtures.ts';
import {
  LIVE_BOT_APPLICATION_ID,
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  applicationIdFromToken,
  checkStagingToken,
} from '../src/staging/spec.ts';
import type { EventType } from '../src/core/events.ts';

const G = '999000111222333444'; // a stand-in staging guild id

async function seeded(now = TEST_NOW) {
  const db = await openDb(':memory:');
  const r = await seedFixtures(db, { guildId: G, now });
  return { db, store: new EventStore(db), r };
}

test('the seeded funnel matches the documented expectations', async () => {
  const { store } = await seeded();
  for (const [type, expected] of Object.entries(EXPECTED_FUNNEL)) {
    assert.equal(
      await store.countByType(type as EventType),
      expected,
      `${type} count disagrees with EXPECTED_FUNNEL - update both or neither`,
    );
  }
  for (const [type, expected] of Object.entries(EXPECTED_DISTINCT)) {
    assert.equal(
      await store.countMembersWith(type as EventType),
      expected,
      `${type} distinct-member count disagrees with EXPECTED_DISTINCT`,
    );
  }
});

test('seeding twice changes nothing - QA can re-run without drift', async () => {
  const { db, store, r } = await seeded();
  assert.equal(r.inserted, r.events, 'first seed should insert every event');

  const again = await seedFixtures(db, { guildId: G, now: TEST_NOW });
  assert.equal(again.inserted, 0, 'a second seed must insert nothing');
  assert.equal(again.members, r.members);
  for (const [type, expected] of Object.entries(EXPECTED_FUNNEL)) {
    assert.equal(await store.countByType(type as EventType), expected);
  }
});

/**
 * Regression. The first Postgres run of staging-reset.ts double-counted every
 * repeatable event, because it called the clock once for the reset and again
 * for the idempotency re-seed - and those events key on their timestamp. The
 * anchor a seed used now comes back in the result so a caller can reuse it.
 */
test('reseeding with the anchor a previous seed reported inserts nothing', async () => {
  const db = await openDb(':memory:');
  const first = await seedFixtures(db, { guildId: G }); // real clock, unpinned
  assert.ok(first.now, 'seedFixtures must report the anchor it used');

  const again = await seedFixtures(db, { guildId: G, now: first.now });
  assert.equal(again.inserted, 0);

  const store = new EventStore(db);
  for (const [type, expected] of Object.entries(EXPECTED_FUNNEL)) {
    assert.equal(
      await store.countByType(type as EventType),
      expected,
      `${type} doubled - the second seed used a different clock reading`,
    );
  }
});

test('two resets at different moments both land on the known state', async () => {
  const db = await openDb(':memory:');
  await resetStagingData(db, { guildId: G, now: '2026-08-19T12:00:00.000Z' });
  await resetStagingData(db, { guildId: G, now: '2026-08-19T12:00:05.000Z' });
  const store = new EventStore(db);
  for (const [type, expected] of Object.entries(EXPECTED_FUNNEL)) {
    assert.equal(await store.countByType(type as EventType), expected);
  }
});

test('reset clears foreign rows and restores exactly the known state', async () => {
  const { db, store } = await seeded();

  // Something a previous test run left behind.
  await store.record({
    guildId: G,
    memberId: '123456789012345678',
    eventType: 'member_join',
    occurredAt: '2026-08-18T00:00:00.000Z',
    source: 'invite:leftover',
  });
  assert.equal(await store.countByType('member_join'), EXPECTED_FUNNEL.member_join + 1);

  await resetStagingData(db, { guildId: G, now: TEST_NOW });
  assert.equal(await store.countByType('member_join'), EXPECTED_FUNNEL.member_join);
  const stray = await db
    .prepare(`SELECT COUNT(*) AS n FROM members WHERE member_id = ?`)
    .get<{ n: number }>('123456789012345678');
  assert.equal(Number(stray?.n), 0, 'reset must remove members it did not seed');
});

test('joined-never-posted is exactly the lurker and the stalled member', async () => {
  const { db } = await seeded();
  const list = await joinedNeverPosted(db, G);
  assert.equal(list.length, EXPECTED_JOINED_NEVER_POSTED);
  assert.deepEqual(
    [...list].sort(),
    [FIXTURE_MEMBER_IDS.lurker, FIXTURE_MEMBER_IDS.stalled].sort(),
  );
});

test('a fresh inactivity sweep flags exactly one member, and not the already-flagged one', async () => {
  const { db, store } = await seeded(new Date().toISOString());
  const flagged = await flagInactive(db, store, 14);
  assert.equal(flagged.length, EXPECTED_NEWLY_INACTIVE);
  assert.deepEqual(flagged, [FIXTURE_MEMBER_IDS.quiet]);
  assert.ok(
    !flagged.includes(FIXTURE_MEMBER_IDS.inactive),
    'the already-flagged member must not be flagged again - that is a repeat nudge',
  );
  assert.ok(!flagged.includes(FIXTURE_MEMBER_IDS.leaver), 'members who left must not be flagged');
  assert.ok(!flagged.includes(FIXTURE_MEMBER_IDS.bot), 'bots must never be flagged');
});

test('the fast fixture crosses join -> first message inside 60 seconds', async () => {
  const { store } = await seeded();
  const secs = await store.secondsBetween(
    G,
    FIXTURE_MEMBER_IDS.fast,
    'member_join',
    'first_message',
  );
  assert.equal(secs, EXPECTED_FAST_SECONDS);
  assert.ok(secs !== null && secs < 60);
});

test('a rejoining member ends up active again, not marked as left', async () => {
  const { db } = await seeded();
  const m = await db
    .prepare(`SELECT * FROM members WHERE guild_id = ? AND member_id = ?`)
    .get<Record<string, unknown>>(G, FIXTURE_MEMBER_IDS.rejoiner);
  assert.equal(m?.left_at, null, 'the second join must clear left_at');
  assert.ok(m?.first_message_at, 'their message survives the rejoin');
});

test('the bot fixture is present but excluded from the funnel', async () => {
  const { db, store } = await seeded();
  const m = await db
    .prepare(`SELECT is_bot, joined_at FROM members WHERE guild_id = ? AND member_id = ?`)
    .get<{ is_bot: number; joined_at: string | null }>(G, FIXTURE_MEMBER_IDS.bot);
  assert.equal(Number(m?.is_bot), 1);
  assert.equal(m?.joined_at, null, 'the bot has no join event, only a members row');
  assert.equal(
    await store.hasEvent(G, FIXTURE_MEMBER_IDS.bot, 'member_join'),
    false,
    'the bot must contribute no funnel events',
  );
});

test('invite baselines are seeded so attribution has something to diff against', async () => {
  const { db } = await seeded();
  const rows = await db
    .prepare(`SELECT code, uses FROM invite_snapshots WHERE guild_id = ? ORDER BY code`)
    .all<{ code: string; uses: number }>(G);
  assert.deepEqual(
    rows.map((r) => r.code),
    ['qa-alpha', 'qa-beta'],
  );
  assert.ok(rows.every((r) => Number(r.uses) > 0));
});

test('every fixture id is unmistakably synthetic', () => {
  for (const [key, id] of Object.entries(FIXTURE_MEMBER_IDS)) {
    assert.ok(id.startsWith('90000000000000'), `${key} is not in the reserved fixture block`);
  }
});

test('fixtures never carry the live guild id', () => {
  const events = fixtureEvents({ guildId: G, now: TEST_NOW });
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.guildId !== LIVE_GUILD_ID));
});

/*
 * The wrong-token guard.
 *
 * On 2026-08-19 the secrets store had bound this agent the LIVE bot's token
 * while DISCORD_STAGING_BOT_TOKEN was absent entirely. Nothing ran, because
 * the variable was missing - but the same mix-up with the variable PRESENT
 * would have pointed a guild-creating script at the production bot. These
 * tests are the check that catches that, and they need no token to run: a
 * synthetic token is just base64(application id) plus two junk segments.
 */
const tokenFor = (appId: string) => `${Buffer.from(appId).toString('base64')}.Gxxxxx.yyyyyyyyyy`;

test('an application id can be read back out of a token shape', () => {
  assert.equal(applicationIdFromToken(tokenFor(STAGING_BOT_APPLICATION_ID)), STAGING_BOT_APPLICATION_ID);
  assert.equal(applicationIdFromToken(tokenFor(LIVE_BOT_APPLICATION_ID)), LIVE_BOT_APPLICATION_ID);
  assert.equal(applicationIdFromToken(''), null);
  assert.equal(applicationIdFromToken('not-a-token'), null);
});

test('the live bot token is refused, and the message says which bot it is', () => {
  const r = checkStagingToken(tokenFor(LIVE_BOT_APPLICATION_ID));
  assert.equal(r.ok, false);
  assert.match(r.message, /LIVE bot/);
  assert.match(r.message, new RegExp(LIVE_BOT_APPLICATION_ID));
});

test('the staging bot token is accepted', () => {
  const r = checkStagingToken(tokenFor(STAGING_BOT_APPLICATION_ID));
  assert.equal(r.ok, true);
});

test('an unrecognised or unparseable token is allowed through to Discord, not hard-failed', () => {
  // A token reset changes the secret but never the application id, so a reset
  // staging token still passes above. This covers a THIRD app someone makes
  // later: we warn, we do not block a setup that may be correct.
  assert.equal(checkStagingToken(tokenFor('123456789012345678')).ok, true);
  assert.equal(checkStagingToken('garbage').ok, true);
});
