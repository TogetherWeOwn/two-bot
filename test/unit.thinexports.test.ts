/**
 * Thin-export gap coverage (TOG-7205, follow-up to 0e866351).
 *
 * The functions pinned here are pure (or pure against a stubbed store) and had
 * zero direct unit coverage: `isLogChannel` and `writeEarlyMessages` in
 * src/backfill/messages.ts, the embed-id helpers in src/backfill/parse.ts,
 * `inviteUrl` in src/redirect/campaigns.ts, and the permission-bit helpers in
 * src/selfRoles/permissions.ts. Everything else in those four modules is
 * already reached by an existing unit suite.
 *
 * No database, no network: the one writer (`writeEarlyMessages`) runs against
 * a stub EventStore so the ladder-ordering contract is pinned without
 * TWO_TEST_DATABASE_URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { MESSAGE_RUNGS, type FunnelEvent } from '../src/core/events.ts';
import type { RawEmbed } from '../src/discord/rest.ts';
import {
  isLogChannel,
  writeEarlyMessages,
  type MemberMessages,
} from '../src/backfill/messages.ts';
import {
  channelIdFromEmbed,
  memberIdFromEmbed,
  SNOWFLAKE,
} from '../src/backfill/parse.ts';
import { inviteUrl } from '../src/redirect/campaigns.ts';
import {
  findSelfRoleUnsafeChannelGrant,
  permissionBitfield,
} from '../src/selfRoles/permissions.ts';
import type { EventStore } from '../src/store/eventStore.ts';

// --- isLogChannel ------------------------------------------------------------

test('isLogChannel skips bot-output channels by name or category', () => {
  assert.equal(isLogChannel('member-log', ''), true);
  assert.equal(isLogChannel('wick-checks', ''), true);
  assert.equal(isLogChannel('mod-audit', ''), true);
  assert.equal(isLogChannel('modmail-123', ''), true);
  assert.equal(isLogChannel('network-status', ''), true);
  assert.equal(isLogChannel('general', 'Server Logs'), true);
  assert.equal(isLogChannel('general', 'audit-trail'), true);
});

test('isLogChannel skips numeric-prefixed mirror channels but keeps conversation', () => {
  assert.equal(isLogChannel('12-introductions', ''), true);
  assert.equal(isLogChannel('general', 'Community'), false);
  assert.equal(isLogChannel('rules', ''), false);
  assert.equal(isLogChannel('general', ''), false);
});

// --- memberIdFromEmbed / channelIdFromEmbed -----------------------------------

const embed = (over: Partial<RawEmbed> = {}): RawEmbed => ({ ...over });

test('member id comes from the footer first, then the description mention', () => {
  assert.equal(
    memberIdFromEmbed(embed({ footer: { text: 'ID: 1015384495525986346' } })),
    '1015384495525986346',
  );
  // The nickname mention form still resolves when no footer is present.
  assert.equal(
    memberIdFromEmbed(embed({ description: 'Welcome <@!1015384495525986346>!' })),
    '1015384495525986346',
  );
  assert.equal(
    memberIdFromEmbed(embed({ description: 'Welcome <@1015384495525986346>!' })),
    '1015384495525986346',
  );
});

test('member id prefers the footer when both footer and mention exist', () => {
  assert.equal(
    memberIdFromEmbed(
      embed({
        footer: { text: 'ID: 111111111111111111' },
        description: 'Welcome <@222222222222222222>!',
      }),
    ),
    '111111111111111111',
  );
});

test('member id is null when no snowflake is present', () => {
  assert.equal(memberIdFromEmbed(embed({})), null);
  assert.equal(memberIdFromEmbed(embed({ description: 'no ids here' })), null);
  // A short number is not a snowflake.
  assert.equal(memberIdFromEmbed(embed({ footer: { text: 'ID: 123' } })), null);
});

test('channel id comes from the <#id> mention, or null', () => {
  assert.equal(
    channelIdFromEmbed(embed({ description: '**<@123456789012345678> joined voice channel <#987654321098765432>**' })),
    '987654321098765432',
  );
  assert.equal(channelIdFromEmbed(embed({ description: 'no channel here' })), null);
  assert.equal(channelIdFromEmbed(embed({})), null);
});

test('SNOWFLAKE finds an id inside text but not a short number', () => {
  assert.ok(SNOWFLAKE.test('member 1015384495525986346 joined'));
  assert.equal(SNOWFLAKE.test('just 123'), false);
});

// --- inviteUrl ----------------------------------------------------------------

test('inviteUrl builds the fixed discord.gg target', () => {
  assert.equal(inviteUrl('AbC-123'), 'https://discord.gg/AbC-123');
  // The redirect must never point anywhere else: the host is fixed, only the
  // validated code varies.
  assert.equal(new URL(inviteUrl('anything')).hostname, 'discord.gg');
});

// --- permissionBitfield -------------------------------------------------------

test('permissionBitfield accepts all three permission shapes', () => {
  assert.equal(permissionBitfield(456n), 456n);
  assert.equal(permissionBitfield('123'), 123n);
  assert.equal(permissionBitfield({ bitfield: 789n }), 789n);
  assert.equal(permissionBitfield('0'), 0n);
});

// --- findSelfRoleUnsafeChannelGrant --------------------------------------------

const G = '999999999999999999';
const ROLE = '111111111111111111';

test('a role that adds no new channel access is safe', () => {
  const view = String(PermissionFlagsBits.ViewChannel);
  const send = String(PermissionFlagsBits.SendMessages);
  assert.equal(
    findSelfRoleUnsafeChannelGrant({
      guildId: G,
      roleId: ROLE,
      everyonePermissions: String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages),
      rolePermissions: send,
      channels: [{ id: 'c1', permissionOverwrites: [] }],
    }),
    null,
  );
  // An overwrite granting only an allowlisted permission is likewise safe.
  assert.equal(
    findSelfRoleUnsafeChannelGrant({
      guildId: G,
      roleId: ROLE,
      everyonePermissions: view,
      rolePermissions: send,
      channels: [{
        id: 'c1',
        permissionOverwrites: [{ id: ROLE, type: 0, allow: send, deny: '0' }],
      }],
    }),
    null,
  );
});

test('an overwrite granting a disallowed permission is flagged as unsafe', () => {
  const found = findSelfRoleUnsafeChannelGrant({
    guildId: G,
    roleId: ROLE,
    everyonePermissions: '0',
    rolePermissions: '0',
    channels: [{
      id: 'c1',
      name: 'staff',
      permissionOverwrites: [{
        id: ROLE,
        type: 0,
        allow: String(PermissionFlagsBits.ManageMessages),
        deny: '0',
      }],
    }],
  });
  assert.deepEqual(found, {
    channelId: 'c1',
    channelName: 'staff',
    permission: 'ManageMessages',
    kind: 'unsafe_permission',
  });
});

test('a role that unlocks a hidden channel is flagged as new access', () => {
  const found = findSelfRoleUnsafeChannelGrant({
    guildId: G,
    roleId: ROLE,
    everyonePermissions: '0',
    rolePermissions: String(PermissionFlagsBits.ViewChannel),
    channels: [{ id: 'c1', permissionOverwrites: [] }],
  });
  assert.deepEqual(found, {
    channelId: 'c1',
    permission: 'ViewChannel',
    kind: 'new_channel_access',
  });
});

// --- writeEarlyMessages ---------------------------------------------------------

interface StubStore {
  events: FunnelEvent[];
  touched: Array<{ memberId: string; at: string }>;
  store: EventStore;
}

/** A stub EventStore: configurable per-key insert results, records everything. */
function stubStore(inserted: (key: string) => boolean = () => true): StubStore {
  const events: FunnelEvent[] = [];
  const touched: Array<{ memberId: string; at: string }> = [];
  const store = {
    async recordEarliest(e: FunnelEvent) {
      events.push(e);
      const key = `${e.memberId}:${e.eventType}:${e.occurredAt}`;
      return { inserted: inserted(key), eventId: events.length };
    },
    async touchActivity(_guildId: string, memberId: string, at: string) {
      touched.push({ memberId, at });
    },
  } as unknown as EventStore;
  return { events, touched, store };
}

const T1 = '2026-03-01T00:00:00.000Z';
const T2 = '2026-03-02T00:00:00.000Z';
const T3 = '2026-03-03T00:00:00.000Z';

function ladder(memberId: string): Map<string, MemberMessages> {
  return new Map([
    [memberId, {
      memberId,
      rungs: [
        { id: 'a', at: T1, channelId: 'c1' },
        { id: 'b', at: T2, channelId: 'c2' },
        { id: 'c', at: T3, channelId: 'c1' },
      ],
    }],
  ]);
}

test('a full ladder writes all three rungs in order with the scan source', async () => {
  const { events, touched, store } = stubStore();
  const result = await writeEarlyMessages(store, 'g', ladder('m1'), new Map([['m1', T3]]));
  assert.deepEqual(result, { written: 3, laddersCompleted: 1 });
  assert.deepEqual(
    events.map((e) => e.eventType),
    [...MESSAGE_RUNGS],
    'the Nth-earliest message becomes the Nth rung',
  );
  assert.deepEqual(
    events.map((e) => e.source),
    ['channel:c1', 'channel:c2', 'channel:c1'],
  );
  for (const e of events) {
    assert.equal(e.memberId, 'm1');
    assert.deepEqual(e.metadata, { backfill: 'message_scan' });
  }
  assert.deepEqual(touched, [{ memberId: 'm1', at: T3 }]);
});

test('a partial ladder writes only its rungs and completes no ladder', async () => {
  const { store } = stubStore();
  const early = new Map([
    ['m1', {
      memberId: 'm1',
      rungs: [
        { id: 'a', at: T1, channelId: 'c1' },
        { id: 'b', at: T2, channelId: 'c1' },
      ],
    }],
  ]);
  const result = await writeEarlyMessages(store, 'g', early, new Map());
  assert.deepEqual(result, { written: 2, laddersCompleted: 0 });
});

test('a re-run that inserts nothing still reports the completed ladder', async () => {
  // recordEarliest keeps the earliest timestamp, so a re-run writes nothing
  // new - but the member still clears the AM7 text bar.
  const { store } = stubStore(() => false);
  const result = await writeEarlyMessages(store, 'g', ladder('m1'), new Map([['m1', T3]]));
  assert.deepEqual(result, { written: 0, laddersCompleted: 1 });
});

test('an empty scan writes nothing', async () => {
  const { events, touched, store } = stubStore();
  assert.deepEqual(await writeEarlyMessages(store, 'g', new Map(), new Map()), {
    written: 0,
    laddersCompleted: 0,
  });
  assert.equal(events.length, 0);
  assert.equal(touched.length, 0);
});
