/**
 * The staging provisioning decisions, checked without Discord or a token.
 *
 * These are the decisions that are expensive to get wrong. A bot may only
 * create guilds while it is in fewer than ten, and it can never hand ownership
 * of one to a person - so "create a second TWO Staging by accident" is a
 * mistake with no clean undo. Everything that could cause it is a pure
 * function here, and this file is how we know it behaves before the token
 * exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_TYPE_TEXT,
  CHANNEL_TYPE_VOICE,
  GUILD_CREATE_HEADROOM,
  chooseGuild,
  evaluateHierarchy,
  guildCreatePayload,
  planChannels,
  planRoles,
  type PartialRole,
} from '../src/staging/provision.ts';
import {
  LIVE_GUILD_ID,
  STAGING_ROLES,
  STAGING_SERVER_NAME,
  STAGING_TEXT_CHANNELS,
  STAGING_VOICE_CHANNELS,
} from '../src/staging/spec.ts';

const BOT = '111111111111111111';
const STAGING = '222222222222222222';

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `9${i}`.padEnd(18, '0'), name: `other ${i}` }));

// --- chooseGuild ------------------------------------------------------------

test('creates a guild only when the bot is in none like it', () => {
  const c = chooseGuild({ guilds: [] });
  assert.equal(c.action, 'create');
});

test('adopts the existing TWO Staging instead of creating a second one', () => {
  const c = chooseGuild({ guilds: [{ id: STAGING, name: STAGING_SERVER_NAME }, ...filler(2)] });
  assert.equal(c.action, 'reconcile');
  assert.equal(c.action === 'reconcile' && c.guildId, STAGING);
});

test('stops rather than guessing when there are two TWO Staging guilds', () => {
  const c = chooseGuild({
    guilds: [
      { id: STAGING, name: STAGING_SERVER_NAME },
      { id: '333333333333333333', name: STAGING_SERVER_NAME },
    ],
  });
  assert.equal(c.action, 'abort');
  assert.match(c.reason, /previous run went wrong/);
  // Both ids are named so a human can go delete the right one.
  assert.match(c.reason, new RegExp(STAGING));
  assert.match(c.reason, /333333333333333333/);
});

test('refuses to create once the bot is near the ten-guild cliff', () => {
  const c = chooseGuild({ guilds: filler(GUILD_CREATE_HEADROOM) });
  assert.equal(c.action, 'abort');
  assert.match(c.reason, /unrecoverable/);
});

test('an explicit guild id means adopt, never create - the founder-built path', () => {
  const c = chooseGuild({
    guilds: [{ id: STAGING, name: 'Owen test server' }],
    explicitGuildId: STAGING,
  });
  assert.equal(c.action, 'reconcile');
  assert.equal(c.action === 'reconcile' && c.guildId, STAGING);
});

test('an explicit guild id the bot is not in aborts instead of creating', () => {
  const c = chooseGuild({ guilds: [], explicitGuildId: STAGING });
  assert.equal(c.action, 'abort');
  assert.match(c.reason, /invite the bot/);
});

test('the live TWO guild is refused outright', () => {
  const c = chooseGuild({
    guilds: [{ id: LIVE_GUILD_ID, name: 'TWO' }],
    explicitGuildId: LIVE_GUILD_ID,
  });
  assert.equal(c.action, 'abort');
  assert.match(c.reason, /LIVE/);
});

// --- the create payload -----------------------------------------------------

test('the create payload asks for exactly the spec channels and no roles', () => {
  const p = guildCreatePayload();
  assert.equal(p.name, STAGING_SERVER_NAME);
  assert.equal(p.channels.length, STAGING_TEXT_CHANNELS.length + STAGING_VOICE_CHANNELS.length);
  for (const n of STAGING_TEXT_CHANNELS) {
    assert.ok(p.channels.some((c) => c.name === n && c.type === CHANNEL_TYPE_TEXT), `missing #${n}`);
  }
  for (const n of STAGING_VOICE_CHANNELS) {
    assert.ok(p.channels.some((c) => c.name === n && c.type === CHANNEL_TYPE_VOICE), `missing voice ${n}`);
  }
  assert.equal((p as Record<string, unknown>).roles, undefined);
});

// --- planChannels / planRoles ----------------------------------------------

test('an empty guild plans every spec channel and role', () => {
  const cp = planChannels([]);
  assert.equal(cp.create.length, STAGING_TEXT_CHANNELS.length + STAGING_VOICE_CHANNELS.length);
  assert.deepEqual(planRoles([]).create, [...STAGING_ROLES]);
});

test('a fully built guild plans nothing - the script is re-runnable', () => {
  const channels = [
    ...STAGING_TEXT_CHANNELS.map((name, i) => ({ id: `c${i}`, name, type: CHANNEL_TYPE_TEXT })),
    ...STAGING_VOICE_CHANNELS.map((name, i) => ({ id: `v${i}`, name, type: CHANNEL_TYPE_VOICE })),
  ];
  const roles = STAGING_ROLES.map((name, i) => ({ id: `r${i}`, name, position: i + 1 }));
  assert.deepEqual(planChannels(channels).create, []);
  assert.deepEqual(planRoles(roles).create, []);
});

test('a text channel named like the voice one does not satisfy the voice requirement', () => {
  // `Voice 1` as a text channel would pass a name-only check and then fail the
  // first_voice_session assertion for a reason nobody would look for.
  const cp = planChannels([{ id: 'x', name: 'Voice 1', type: CHANNEL_TYPE_TEXT }]);
  assert.ok(cp.create.some((c) => c.name === 'Voice 1' && c.type === CHANNEL_TYPE_VOICE));
});

test('channels outside the spec are reported but never planned for deletion', () => {
  const cp = planChannels([{ id: 'x', name: 'scratch', type: CHANNEL_TYPE_TEXT }]);
  assert.deepEqual(cp.extra, ['scratch']);
  assert.ok(!JSON.stringify(cp).includes('delete'));
});

// --- evaluateHierarchy ------------------------------------------------------

const specRoles = (positions: number[]): PartialRole[] =>
  STAGING_ROLES.map((name, i) => ({ id: `r${i}`, name, position: positions[i] }));

test('owning the guild bypasses the hierarchy check entirely', () => {
  // This is the whole point of the bot creating its own server: the classic
  // silent role-assign 403 cannot happen to an owner, so reporting it would be
  // three confident failures on a server that works.
  const h = evaluateHierarchy({
    roles: specRoles([5, 6, 7]), // all ABOVE where a bot role would be
    botId: BOT,
    ownerId: BOT,
  });
  assert.equal(h.ownerBypass, true);
  assert.deepEqual(h.blocked, []);
  assert.deepEqual(h.assignable, [...STAGING_ROLES]);
  assert.equal(h.humanFix, null);
});

test('a role above a non-owner bot is reported as blocked', () => {
  const roles: PartialRole[] = [
    ...specRoles([1, 2, 9]),
    { id: 'bot', name: 'Owen Staging', position: 5, managed: true, tags: { bot_id: BOT } },
  ];
  const h = evaluateHierarchy({ roles, botId: BOT, ownerId: '999' });
  assert.equal(h.ownerBypass, false);
  assert.deepEqual(h.blocked.map((b) => b.name), ['Game: Test']);
  assert.deepEqual(h.assignable, ['Moderator', 'Member']);
});

test('blocked roles are moved down, never the bot role up', () => {
  const roles: PartialRole[] = [
    ...specRoles([1, 2, 9]),
    { id: 'bot', name: 'Owen Staging', position: 5, tags: { bot_id: BOT } },
  ];
  const h = evaluateHierarchy({ roles, botId: BOT, ownerId: '999' });
  assert.equal(h.repositions.length, 1);
  // Discord rejects any attempt to place a role at or above the bot's own.
  for (const r of h.repositions) assert.ok(r.position < 5, `${r.name} must land below the bot`);
  assert.equal(h.humanFix, null);
});

test('when there is no room beneath the bot, it asks a human instead of failing on Discord', () => {
  const roles: PartialRole[] = [
    ...specRoles([2, 3, 4]),
    { id: 'bot', name: 'Owen Staging', position: 1, tags: { bot_id: BOT } },
  ];
  const h = evaluateHierarchy({ roles, botId: BOT, ownerId: '999' });
  assert.equal(h.repositions.length, 0);
  assert.match(h.humanFix ?? '', /Drag "Owen Staging" above/);
});

test('a non-owner bot with no managed role can grant nothing', () => {
  const h = evaluateHierarchy({ roles: specRoles([1, 2, 3]), botId: BOT, ownerId: '999' });
  assert.deepEqual(h.assignable, []);
  assert.equal(h.blocked.length, STAGING_ROLES.length);
  assert.match(h.humanFix ?? '', /Re-invite the bot/);
});

test('missing spec roles are reported whoever owns the guild', () => {
  for (const ownerId of [BOT, '999']) {
    const h = evaluateHierarchy({ roles: [], botId: BOT, ownerId });
    assert.deepEqual(h.missing, [...STAGING_ROLES]);
  }
});
