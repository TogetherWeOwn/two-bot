/**
 * The Wave 2 decisions, checked without Discord or a token.
 *
 * Wave 2 is the first wave of the TOG-34 redesign that writes to the live TWO
 * server, so the decisions worth testing are the ones whose failure is quiet:
 * creating a second `#looking-to-play` on a re-run, creating `⚙️ SYSTEM`
 * without its View deny, or matching a category against a same-named channel.
 * None of those throw. All of them are wrong in a way somebody finds later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_TYPE_CATEGORY,
  CHANNEL_TYPE_TEXT,
  CHANNEL_TYPE_VOICE,
  LIVE_GUILD_ID,
  LOOKING_TO_PLAY,
  VERIFIED_ROLE,
  VIEW_CHANNEL,
  WAVE2_CATEGORIES,
  categoryOverwrites,
  catalogRolesDestroyedByWave6,
  planIsComplete,
  planWave2,
  type PartialChannel,
  type PartialRole,
} from '../src/redesign/wave2.ts';

/** A server with none of the Wave 2 objects on it. */
const emptyish = {
  channels: [
    { id: '1', name: '💬〢general', type: CHANNEL_TYPE_TEXT },
    { id: '2', name: '🎮 GAMES', type: CHANNEL_TYPE_CATEGORY },
  ] as PartialChannel[],
  roles: [
    { id: '10', name: '@everyone' },
    { id: '11', name: 'SySOp' },
  ] as PartialRole[],
};

test('a fresh server plans every Wave 2 object exactly once', () => {
  const plan = planWave2(emptyish);
  assert.equal(plan.createCategories.length, 4);
  assert.deepEqual(
    plan.createCategories.map((c) => c.name),
    WAVE2_CATEGORIES.map((c) => c.name),
    'categories are planned in the order rev 6 §4.1 draws them',
  );
  assert.equal(plan.createChannels.length, 1);
  assert.equal(plan.createChannels[0]?.name, 'looking-to-play');
  assert.equal(plan.createRoles.length, 1);
  assert.equal(plan.createRoles[0]?.name, 'Verified');
  assert.equal(plan.duplicates.length, 0);
  assert.equal(planIsComplete(plan), false);
});

test('exactly one category is created hidden, and it is ⚙️ SYSTEM', () => {
  const hidden = WAVE2_CATEGORIES.filter((c) => c.hidden);
  assert.deepEqual(
    hidden.map((c) => c.name),
    ['⚙️ SYSTEM'],
    'rev 6 §4.3: only SYSTEM denies @everyone View',
  );
});

test('the SYSTEM overwrite denies View to @everyone and allows nothing', () => {
  const system = WAVE2_CATEGORIES.find((c) => c.name === '⚙️ SYSTEM')!;
  const ow = categoryOverwrites(system, LIVE_GUILD_ID);
  assert.equal(ow.length, 1);
  // @everyone's role id IS the guild id. Getting this wrong denies View to a
  // role that does not exist, and the category is created world-readable.
  assert.equal(ow[0]?.id, LIVE_GUILD_ID);
  assert.equal(ow[0]?.type, 0, 'a role overwrite, not a member overwrite');
  assert.equal(ow[0]?.deny, VIEW_CHANNEL.toString());
  assert.equal(ow[0]?.allow, '0');
});

test('visible categories are created with no overwrites at all', () => {
  for (const cat of WAVE2_CATEGORIES.filter((c) => !c.hidden)) {
    assert.deepEqual(categoryOverwrites(cat, LIVE_GUILD_ID), [], `${cat.name} inherits @everyone`);
  }
});

test('re-running against a finished server creates nothing', () => {
  const done = {
    channels: [
      ...WAVE2_CATEGORIES.map((c, i) => ({
        id: `c${i}`,
        name: c.name,
        type: CHANNEL_TYPE_CATEGORY,
      })),
      { id: 'ch', name: 'looking-to-play', type: CHANNEL_TYPE_TEXT },
    ] as PartialChannel[],
    roles: [{ id: '10', name: '@everyone' }, { id: '12', name: 'Verified' }] as PartialRole[],
  };
  const plan = planWave2(done);
  assert.equal(planIsComplete(plan), true, 'Wave 2 is idempotent');
  assert.equal(plan.present.length, 6, '4 categories + the channel + the role');
  assert.equal(plan.duplicates.length, 0);
});

test('a same-named channel does not satisfy a category, and vice versa', () => {
  // A text channel literally called "💬 CHAT" is not the CHAT category. If the
  // planner matched on name alone it would skip the create and Wave 3 would
  // later try to move keeper channels into a category that does not exist.
  const plan = planWave2({
    channels: [{ id: '1', name: '💬 CHAT', type: CHANNEL_TYPE_TEXT }],
    roles: [],
  });
  assert.ok(
    plan.createCategories.some((c) => c.name === '💬 CHAT'),
    'the CHAT category is still planned',
  );
});

test('a voice channel named looking-to-play does not satisfy the text channel', () => {
  const plan = planWave2({
    channels: [{ id: '1', name: 'looking-to-play', type: CHANNEL_TYPE_VOICE }],
    roles: [],
  });
  assert.equal(plan.createChannels.length, 1, 'still creates the text channel');
});

test('duplicates are reported, never repaired', () => {
  const plan = planWave2({
    channels: [
      { id: '1', name: 'looking-to-play', type: CHANNEL_TYPE_TEXT },
      { id: '2', name: 'looking-to-play', type: CHANNEL_TYPE_TEXT },
    ],
    roles: [{ id: '3', name: 'Verified' }, { id: '4', name: 'Verified' }],
  });
  assert.deepEqual(plan.duplicates.sort(), ['#looking-to-play', 'Verified']);
  // Reporting, not deleting: this wave has no destructive verb.
  assert.equal(plan.createChannels.length, 0);
  assert.equal(plan.createRoles.length, 0);
});

test('a managed role called Verified does not count as ours', () => {
  const plan = planWave2({
    channels: [],
    roles: [{ id: '9', name: 'Verified', managed: true }],
  });
  assert.equal(plan.createRoles.length, 1, 'an integration role cannot be made to behave like ours');
});

test('Verified is created with no permissions, which is the point of D3', () => {
  // Rev 6 §4.4: "Verified unlocks nothing at launch - and that is deliberate."
  // A non-zero mask here would quietly make it a second gate.
  assert.equal(VERIFIED_ROLE.permissions, '0');
  assert.equal(VERIFIED_ROLE.hoist, true, 'hoisted is the entire visible effect');
  assert.equal(VERIFIED_ROLE.mentionable, false);
});

test('#looking-to-play lands in CHAT and carries its rev 6 topic', () => {
  assert.equal(LOOKING_TO_PLAY.parentCategory, '💬 CHAT');
  assert.equal(LOOKING_TO_PLAY.type, CHANNEL_TYPE_TEXT);
  assert.match(LOOKING_TO_PLAY.topic, /Anyone up for anything/);
});

test('Wave 2 never plans to touch any of the nine keeper channels', () => {
  // execution-gate §3 pins these nine ids: Wave 3 renames them, Wave 2 must not
  // create anything that shadows one. #general is the load-bearing case - a new
  // empty channel called general is how the history gets lost.
  const keeperNames = ['general', 'announcements', 'start-here', 'Lobby', 'Squad'];
  const created = [LOOKING_TO_PLAY.name, ...WAVE2_CATEGORIES.map((c) => c.name)];
  for (const k of keeperNames) {
    assert.ok(!created.includes(k), `Wave 2 does not create "${k}"`);
  }
});

test('catalog roles that Wave 6 deletes are found; managed and absent ones are not', () => {
  const doomed = catalogRolesDestroyedByWave6({
    catalogRoleIds: ['1', '2', '3', '3'],
    roles: [
      { id: '1', name: 'Shooter Games' },
      { id: '2', name: 'Statbot', managed: true },
      // id 3 is absent from the guild entirely.
    ],
  });
  assert.deepEqual(doomed, [{ id: '1', name: 'Shooter Games' }]);
});

test('the real onboarding catalog is fully destroyed by Wave 6', async () => {
  // The finding this function exists for, asserted against the actual catalog
  // rather than a fixture: every role our bot grants is a game/platform role,
  // and rev 6 §4.4 deletes every game and platform role.
  const { ALL_PICKS } = await import('../src/onboarding/catalog.ts');
  const ids = [...new Set(ALL_PICKS.map((p) => p.roleId))];
  assert.ok(ids.length > 0);
  const doomed = catalogRolesDestroyedByWave6({
    catalogRoleIds: ids,
    roles: ids.map((id) => ({ id, name: `role-${id}` })),
  });
  assert.equal(doomed.length, ids.length, 'no catalog role survives Wave 6');
});
