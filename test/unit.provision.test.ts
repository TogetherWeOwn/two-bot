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
  GUILD_CREATE_LIMIT,
  chooseGuild,
  evaluateHierarchy,
  guildCreatePayload,
  planChannels,
  planRoles,
  type PartialRole,
} from '../src/staging/provision.ts';
import {
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
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

// This used to assert `create`. It cannot any more: on 2026-09-05 POST /guilds
// was run for real, at zero guilds, and Discord returned HTTP 400 code 20001
// "Bots cannot use this endpoint" - on a bare payload and on v9 too. The test
// now pins the opposite, and pins that the refusal carries the human's next
// step, because an abort that does not say "make it yourself, here is the
// link" only moves the dead end one layer up.
test('never returns create - a bot cannot make a guild (code 20001)', () => {
  const c = chooseGuild({ guilds: [] });
  assert.equal(c.action, 'abort');
  assert.match(c.reason, /20001/);
  assert.match(c.reason, /Bots cannot use this endpoint/);
  assert.match(c.reason, /discord\.com\/api\/oauth2\/authorize/, 'must hand over the invite link');
  assert.match(c.reason, /DISCORD_STAGING_GUILD_ID/, 'must say where to put the id');
});

// The case that actually happened on TWO-25: the token we were given was a
// bot already sitting in the live TWO server, and every other check passed.
// Membership in production outranks every other decision this function makes.
test('refuses to create when the bot is in the live TWO server', () => {
  const c = chooseGuild({ guilds: [{ id: LIVE_GUILD_ID, name: 'TogetherWeOwn' }] });
  assert.equal(c.action, 'abort');
  assert.match(c.reason, /LIVE TWO server/);
});

test('refuses to reconcile a real staging guild while also in the live server', () => {
  const c = chooseGuild({
    guilds: [
      { id: STAGING, name: STAGING_SERVER_NAME },
      { id: LIVE_GUILD_ID, name: 'TogetherWeOwn' },
    ],
  });
  assert.equal(c.action, 'abort');
});

test('live-server membership beats an explicit staging guild id', () => {
  const c = chooseGuild({
    guilds: [
      { id: STAGING, name: STAGING_SERVER_NAME },
      { id: LIVE_GUILD_ID, name: 'TogetherWeOwn' },
    ],
    explicitGuildId: STAGING,
  });
  assert.equal(c.action, 'abort');
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
  // The count and the limit are both named, so the abort explains itself.
  assert.match(c.reason, new RegExp(`in ${GUILD_CREATE_HEADROOM} guilds`));
  assert.match(c.reason, new RegExp(String(GUILD_CREATE_LIMIT)));
  assert.match(c.reason, /Public Bot/);
});

test('at the hard ten-guild limit it aborts and blames the Public Bot setting', () => {
  const c = chooseGuild({ guilds: filler(GUILD_CREATE_LIMIT) });
  assert.equal(c.action, 'abort');
  assert.match(c.reason, new RegExp(`in ${GUILD_CREATE_LIMIT} guilds`));
  assert.match(c.reason, new RegExp(`${GUILD_CREATE_LIMIT}-guild limit`));
  assert.match(c.reason, /Public Bot/);
  assert.match(c.reason, new RegExp(STAGING_BOT_APPLICATION_ID));
  // Every guild is named, because the fix is "go remove the bot from these".
  for (const g of filler(GUILD_CREATE_LIMIT)) assert.match(c.reason, new RegExp(g.id));
});

test('past the limit too - a bot in eleven guilds is not a silent no-op', () => {
  const c = chooseGuild({ guilds: filler(GUILD_CREATE_LIMIT + 1) });
  assert.equal(c.action, 'abort');
  assert.match(c.reason, /at or past/);
});

// --- the guild-list warnings ------------------------------------------------

test('zero guilds warns about nothing - that is the normal first run', () => {
  const c = chooseGuild({ guilds: [] });
  assert.deepEqual(c.warnings, []);
});

test('guilds we did not add the bot to are warned about by name', () => {
  const c = chooseGuild({ guilds: filler(2) });
  // The action is `abort` now for a reason that has nothing to do with these
  // strays (no bot can create a guild at all). What matters here, and still
  // holds, is that both strays are named in the warnings rather than swallowed.
  assert.match(c.reason, /20001/, 'two strays must not change WHY we stop');
  assert.equal(c.warnings.length, 2);
  assert.match(c.warnings[0], /is in 2 guild\(s\)/);
  assert.match(c.warnings[0], /"other 0"/);
  assert.match(c.warnings[1], /2 of those are not ours: all of them/);
  assert.match(c.warnings[1], /Public Bot/);
  assert.match(c.warnings[1], new RegExp(STAGING_BOT_APPLICATION_ID));
});

test('our own staging server is not reported as a stray', () => {
  const c = chooseGuild({ guilds: [{ id: STAGING, name: STAGING_SERVER_NAME }] });
  assert.equal(c.action, 'reconcile');
  assert.equal(c.warnings.length, 1, 'the count line only');
  assert.ok(!c.warnings.some((w) => /not ours/.test(w)));
});

test('an explicitly named guild is not a stray either, but its neighbours are', () => {
  const c = chooseGuild({
    guilds: [{ id: STAGING, name: 'Owen test server' }, ...filler(1)],
    explicitGuildId: STAGING,
  });
  assert.equal(c.action, 'reconcile');
  const strays = c.warnings.filter((w) => /not ours/.test(w));
  assert.equal(strays.length, 1);
  assert.match(strays[0], /1 of those is not ours/);
  assert.match(strays[0], /"other 0"/);
  assert.ok(!strays[0].includes('Owen test server'));
});

test('running low on guild slots is called out even when the run can proceed', () => {
  const c = chooseGuild({
    guilds: [{ id: STAGING, name: STAGING_SERVER_NAME }, ...filler(GUILD_CREATE_HEADROOM - 1)],
  });
  assert.equal(c.action, 'reconcile', 'reconcile never calls POST /guilds, so it is allowed');
  assert.ok(c.warnings.some((w) => /guild-creation slots are used/.test(w)));
});

test('the warnings survive an abort - the operator sees why before the refusal', () => {
  const c = chooseGuild({ guilds: filler(GUILD_CREATE_LIMIT) });
  assert.equal(c.action, 'abort');
  assert.ok(c.warnings.length >= 2);
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
