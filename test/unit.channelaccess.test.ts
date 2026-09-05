import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveChannelAccess,
  VIEW_CHANNEL,
  SEND_MESSAGES,
  ADMINISTRATOR,
  type ChannelAccessInput,
} from '../src/discord/channelAccess.ts';

const GUILD = '326474832151838730';
const BOT = '1539711683898118154';

const base = (over: Partial<ChannelAccessInput> = {}): ChannelAccessInput => ({
  guildId: GUILD,
  botId: BOT,
  botRoleIds: [],
  guildRoles: [{ id: GUILD, permissions: String(VIEW_CHANNEL | SEND_MESSAGES) }],
  overwrites: [],
  ...over,
});

test('plain @everyone view+send is postable', () => {
  const r = resolveChannelAccess(base());
  assert.deepEqual(r, { view: true, send: true, admin: false });
});

test('Administrator short-circuits and is reported as such', () => {
  const r = resolveChannelAccess(
    base({
      botRoleIds: ['role-admin'],
      guildRoles: [
        { id: GUILD, permissions: '0' },
        { id: 'role-admin', permissions: String(ADMINISTRATOR) },
      ],
      // Denied outright, and it still resolves - that is the point.
      overwrites: [{ id: GUILD, type: 0, allow: '0', deny: String(VIEW_CHANNEL) }],
    }),
  );
  assert.equal(r.view, true);
  assert.equal(r.send, true);
  assert.equal(r.admin, true, 'a pass that depends on Administrator must be flagged');
});

/**
 * The live TWO server as of 2026-09-05: #🔧〢updates-and-changes denies View to
 * @everyone and allows it back to Staff. The bot holds Prospect and Owen, not
 * Staff. Today Administrator hides this; the moment TOG-64 trims it, raid alerts
 * stop being delivered.
 */
test('live staff-alert shape: without Administrator the bot cannot post', () => {
  // Real values read from the live guild on 2026-09-05. Owen carries
  // Administrator (8866461766385663); once TOG-64 trims that bit the union of
  // @everyone + Prospect + Owen still grants Send but no longer beats the
  // channel's View deny - a shape that fools any check reading Send alone.
  const OWEN_WITHOUT_ADMIN = String(8866461766385663n & ~ADMINISTRATOR);
  const input = base({
    botRoleIds: ['1144789677057003636', '1539718644953514087'], // Prospect, Owen
    guildRoles: [
      { id: GUILD, permissions: '2111339353935424' },
      { id: '1144789677057003636', permissions: '0' }, // Prospect
      { id: '1539718644953514087', permissions: OWEN_WITHOUT_ADMIN }, // Owen, post-TOG-64
      { id: '1087192823767515219', permissions: '32957699452871' }, // Staff
    ],
    overwrites: [
      { id: GUILD, type: 0, allow: '0', deny: String(VIEW_CHANNEL) },
      { id: '1087192823767515219', type: 0, allow: String(VIEW_CHANNEL), deny: '0' },
    ],
  });

  const r = resolveChannelAccess(input);
  assert.equal(r.admin, false);
  assert.equal(r.view, false, 'the @everyone deny applies - the bot is not Staff');
  assert.equal(r.send, false, 'Send is meaningless without View');

  // The trap this whole check exists for: the raw Send bit still reads true, so
  // anything testing Send alone would report the alert channel as healthy.
  assert.equal(
    (BigInt(OWEN_WITHOUT_ADMIN) & SEND_MESSAGES) !== 0n,
    true,
    'Send survives the trim - only the View deny reveals the break',
  );

  // Giving the bot's own role the same allow Staff has is the documented fix.
  const fixed = resolveChannelAccess({
    ...input,
    overwrites: [
      ...input.overwrites,
      { id: '1539718644953514087', type: 0, allow: String(VIEW_CHANNEL), deny: '0' },
    ],
  });
  assert.equal(fixed.view, true);
  assert.equal(fixed.send, true);
});

test('a role allow beats another role deny; a member overwrite beats both', () => {
  const roles = base({
    botRoleIds: ['a', 'b'],
    guildRoles: [
      { id: GUILD, permissions: String(VIEW_CHANNEL | SEND_MESSAGES) },
      { id: 'a', permissions: '0' },
      { id: 'b', permissions: '0' },
    ],
    overwrites: [
      { id: 'a', type: 0, allow: '0', deny: String(SEND_MESSAGES) },
      { id: 'b', type: 0, allow: String(SEND_MESSAGES), deny: '0' },
    ],
  });
  assert.equal(resolveChannelAccess(roles).send, true, 'role allows are unioned over role denies');

  const memberDenied = resolveChannelAccess({
    ...roles,
    overwrites: [...roles.overwrites, { id: BOT, type: 1, allow: '0', deny: String(SEND_MESSAGES) }],
  });
  assert.equal(memberDenied.send, false, 'a member-specific deny is applied last and wins');
});

test('Send without View is not postable', () => {
  const r = resolveChannelAccess(
    base({
      guildRoles: [{ id: GUILD, permissions: String(SEND_MESSAGES) }],
    }),
  );
  assert.equal(r.view, false);
  assert.equal(r.send, false);
});
