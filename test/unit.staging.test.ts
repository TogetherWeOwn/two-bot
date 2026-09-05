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
  FORMER_STAGING_BOT_APPLICATION_ID,
  LIVE_BOT_APPLICATION_ID,
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_INVITE_PERMISSIONS,
  STAGING_PERMISSIONS,
  applicationIdFromToken,
  checkStagingToken,
  describePermissions,
  stagingInviteUrl,
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

test('the superseded test-two token is refused, not waved through as unknown', () => {
  // `test-two` held the staging role until 2026-09-05. It is a real bot with a
  // real token, so a stale shell keeps working against the WRONG guild - the
  // one failure mode the generic "unrecognised app" branch would hide.
  const r = checkStagingToken(tokenFor(FORMER_STAGING_BOT_APPLICATION_ID));
  assert.equal(r.ok, false);
  assert.match(r.message, /test-two/);
  assert.match(r.message, new RegExp(STAGING_BOT_APPLICATION_ID));
});

test('an unrecognised or unparseable token is allowed through to Discord, not hard-failed', () => {
  // A token reset changes the secret but never the application id, so a reset
  // staging token still passes above. This covers a THIRD app someone makes
  // later: we warn, we do not block a setup that may be correct.
  assert.equal(checkStagingToken(tokenFor('123456789012345678')).ok, true);
  assert.equal(checkStagingToken('garbage').ok, true);
});

/**
 * The invite permission integer, pinned bit by bit.
 *
 * TOG-463 ran the three internal actions against a real guild on 2026-09-05.
 * `announcement.post` passed; `role.assign` and `event.upsert` came back
 * `422 discord_rejected` wrapping Discord's own 403. The endpoint was right -
 * it asked, Discord said no - but the run cost a day and ended in a request
 * for a human to click through Discord settings.
 *
 * An invited bot holds exactly what its invite carried and cannot grant itself
 * more, so an invite that is short by one bit is not a small problem: it is
 * another round-trip to a person. These tests exist so that gap is a red test
 * on a laptop instead of a 403 an hour into a staging run.
 */

test('the invite carries every permission the internal actions need', () => {
  // Straight from docs/INTERNAL_ACTIONS.md section 8, "the permission bill".
  const REQUIRED: ReadonlyArray<{ action: string; name: string; bit: bigint }> = [
    { action: 'role.assign', name: 'Manage Roles', bit: 1n << 28n },
    { action: 'announcement.post', name: 'View Channel', bit: 1n << 10n },
    { action: 'announcement.post', name: 'Send Messages', bit: 1n << 11n },
    { action: 'event.upsert', name: 'Manage Events', bit: 1n << 33n },
  ];
  const missing = REQUIRED.filter((p) => !(STAGING_INVITE_PERMISSIONS & p.bit)).map(
    (p) => `${p.action} needs ${p.name}`,
  );
  assert.deepEqual(
    missing,
    [],
    'the staging invite would 403 on these actions; an invited bot cannot grant itself the difference',
  );
});

test('the events bits survive the 32-bit shift trap', () => {
  // `1 << 33` is 2 in JavaScript - the shift operand wraps mod 32 - so the
  // high bits MUST be BigInt. The failure is silent: you get a plausible
  // permission integer that grants Kick Members instead of Manage Events.
  assert.equal(1 << 33, 2, 'if this ever changes, the guard below can be simplified');
  assert.equal(STAGING_INVITE_PERMISSIONS & (1n << 33n), 1n << 33n, 'Manage Events');
  assert.equal(STAGING_INVITE_PERMISSIONS & (1n << 44n), 1n << 44n, 'Create Events');
  // What the buggy number-arithmetic version would produce: the shifts wrap to
  // bits 1 and 12, so you get Kick Members and Send TTS Messages instead.
  const WRAPPED = BigInt(STAGING_PERMISSIONS | (1 << 33) | (1 << 44));
  assert.notEqual(STAGING_INVITE_PERMISSIONS, WRAPPED);
  assert.ok(
    STAGING_INVITE_PERMISSIONS >= 1n << 44n,
    'Create Events is bit 44; a value below 2^44 cannot contain it',
  );
});

test('the invite never asks for Administrator', () => {
  // Staging is where we prove the LIVE bot needs no more than a scoped set.
  // An Administrator invite would make every staging run pass and prove
  // nothing about production.
  assert.equal(STAGING_INVITE_PERMISSIONS & (1n << 3n), 0n, 'Administrator');
  // Nor the destructive bits - a staging server is disposable, our habits are not.
  assert.equal(STAGING_INVITE_PERMISSIONS & (1n << 2n), 0n, 'Ban Members');
  assert.equal(STAGING_INVITE_PERMISSIONS & (1n << 1n), 0n, 'Kick Members');
  assert.equal(STAGING_INVITE_PERMISSIONS & (1n << 5n), 0n, 'Manage Server');
});

test('the invite is the onboarding set plus exactly the two events bits', () => {
  // Pins the relationship rather than the number, so widening the invite is a
  // deliberate edit here and not a silently larger grant.
  assert.equal(
    STAGING_INVITE_PERMISSIONS,
    BigInt(STAGING_PERMISSIONS) | (1n << 33n) | (1n << 44n),
  );
  assert.equal(STAGING_PERMISSIONS, 268520512, 'the onboarding set is unchanged');
  assert.equal(STAGING_INVITE_PERMISSIONS, 17601044499520n);
});

test('the invite url carries the wider set, not the onboarding one', () => {
  // The regression that shipped: spec.ts interpolated STAGING_PERMISSIONS
  // here, so the link a human opened was short by both events bits.
  const url = stagingInviteUrl();
  assert.match(url, new RegExp(`permissions=${STAGING_INVITE_PERMISSIONS}(&|$)`));
  assert.ok(
    !url.includes(`permissions=${STAGING_PERMISSIONS}&`),
    'the invite url must not use the narrow onboarding set',
  );
  assert.match(url, new RegExp(`client_id=${STAGING_BOT_APPLICATION_ID}`));
  assert.ok(!url.includes(LIVE_BOT_APPLICATION_ID), 'never invite the live bot to staging');
});

test('describePermissions reports the events bits as missing when they are', () => {
  // staging-verify.ts fails the run on `missing`. Before this change the
  // events bits were absent from PERMISSION_BITS entirely, so a guild that
  // could not run event.upsert verified GREEN - a verifier certifying a
  // configuration we had already measured as broken.
  const onboardingOnly = BigInt(STAGING_PERMISSIONS);
  const { missing } = describePermissions(onboardingOnly);
  assert.deepEqual(missing, ['Manage Events', 'Create Events']);

  const everything = describePermissions(STAGING_INVITE_PERMISSIONS);
  assert.deepEqual(everything.missing, []);
  assert.ok(everything.held.includes('Manage Events'));
});

test('the real 2026-09-05 failing mask is diagnosed, not waved through', () => {
  // The effective mask measured on the live guild that day. Reproduced here
  // so the verifier is known to reject the exact configuration that failed.
  const MEASURED = 2112134023859777n;
  const { held, missing } = describePermissions(MEASURED);
  assert.ok(held.includes('View Channels'), 'announcement.post passed that day');
  assert.ok(held.includes('Send Messages'), 'announcement.post passed that day');
  assert.ok(missing.includes('Manage Roles'), 'role.assign returned 403 that day');
  assert.ok(missing.includes('Manage Events'), 'event.upsert returned 403 that day');
});
