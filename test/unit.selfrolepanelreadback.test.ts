/**
 * TOG-9984: self-role panel live read-back drift test (round 5 gap A1).
 *
 * Leveling has read-back tests (`test/unit.levelrewardroleapply.test.ts` over
 * `applyRewardRole` in `src/leveling/rewardRoleApply.ts`): grant, re-read the
 * member, prove the role is there, revoke, re-read, prove it is gone - and a
 * grant/revoke that does not land fails loudly instead of auditing clean.
 * Self-role had no equivalent: `applyRoleDelta` (`src/discord/selfRoles.ts`)
 * audits its *intended* delta without re-reading the member afterwards, so a
 * panel edit that silently does not land - or a live guild edit that moves the
 * ground under the config - would only surface at the next dispatch.
 *
 * This pins the read-back half with the same shape: drive the real write path
 * (`applyRoleDelta`) against a fake guild, then force-fetch the member exactly
 * the way the dispatch does (`members.fetch({ user, force: true })`) and prove
 * the configured panel matches live guild state - or that the drift is named.
 * The comparator reads the *audited* desired set out of the claim the write
 * path stored, so if the write path and the read-back shape ever diverge (the
 * audit claims roles the live fetch cannot see, or vice versa) this suite reds.
 *
 * Fully offline: in-memory role set, stub audit store, no token, no database,
 * no network, no live Discord, no live guild writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { applyRoleDelta } from '../src/discord/selfRoles.ts';
import type { SelfRolePanel } from '../src/selfRoles/types.ts';

const GUILD = '111111111111111111';
const MEMBER = '222222222222222222';
const RED = '333333333333333333';
const BLUE = '444444444444444444';
const UNRELATED = '555555555555555555';

const panel: SelfRolePanel = {
  id: 'readback',
  channelId: GUILD,
  messageId: '666666666666666666',
  mode: 'button',
  exclusive: false,
  color: false,
  options: [
    { key: 'red', label: 'Red', roleId: RED, permissions: '0', emoji: '🔴' },
    { key: 'blue', label: 'Blue', roleId: BLUE, permissions: '0', emoji: '🔵' },
  ],
};

interface FakeGuild {
  member: Record<string, any>;
  roleState: Set<string>;
  memberFetches: unknown[];
}

function liveRole(id: string, permissions: { bitfield: bigint } = { bitfield: 0n }) {
  return { id, managed: false, editable: true, color: 1, permissions };
}

/**
 * A fake guild whose member fetch is the authoritative read-back: it rebuilds
 * the roles cache from the live role set on every call, the way a
 * `force: true` Discord fetch would. Mutations go through `member.roles`
 * add/remove so a fault (a grant that never lands) is a one-line override.
 */
function fakeGuild(opts: {
  initial: string[];
  roles: Map<string, ReturnType<typeof liveRole>>;
  faults?: { addNoop?: boolean };
}): FakeGuild {
  const roleState = new Set(opts.initial);
  const memberFetches: unknown[] = [];
  const member: Record<string, any> = {
    id: MEMBER,
    guild: {
      id: GUILD,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async (args: unknown) => {
          memberFetches.push(args);
          return {
            ...member,
            roles: {
              ...member.roles,
              cache: new Map([...roleState].map((id) => [id, { id }])),
            },
          };
        },
      },
      roles: { fetch: async () => opts.roles },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map([...roleState].map((id) => [id, { id }])),
      add: async (roleId: string) => {
        if (!opts.faults?.addNoop) roleState.add(roleId);
      },
      remove: async (roleId: string) => {
        roleState.delete(roleId);
      },
    },
  };
  return { member, roleState, memberFetches };
}

function stubStore(claims: Array<Record<string, any>>, audits: Array<Record<string, any>>) {
  return {
    claimAudit: async (row: Record<string, any>) => {
      claims.push(row);
      return {
        token: 'test',
        generation: 1,
        recovered: false,
        desiredRoleIds: row.desiredRoleIds ?? [],
        preMutationRoleIds: row.preMutationRoleIds ?? [],
      };
    },
    finishAudit: async (row: Record<string, any>) => {
      audits.push(row);
    },
  };
}

/**
 * The read-back comparator: the panel-role set the write path desired (as
 * stored on its own audit claim) against the panel-role set the live fetch
 * sees. Empty means the configured panel matches live guild state; anything
 * else names the drifted roles. Mirrors the leveling positive/negative
 * read-back, where a grant that does not read back stops the run.
 */
function panelReadbackProblems(
  target: SelfRolePanel,
  desiredRoleIds: readonly string[],
  observedRoleIds: readonly string[],
): string[] {
  const offered = new Set(target.options.map((option) => option.roleId));
  const desired = new Set(desiredRoleIds.filter((id) => offered.has(id)));
  const observed = new Set(observedRoleIds.filter((id) => offered.has(id)));
  return [
    ...[...desired]
      .filter((id) => !observed.has(id))
      .map((id) => `panel "${target.id}" role ${id} is missing from live guild state`),
    ...[...observed]
      .filter((id) => !desired.has(id))
      .map((id) => `panel "${target.id}" role ${id} is present in live guild state but not desired`),
  ];
}

async function livePanelRoleIds(fake: FakeGuild): Promise<string[]> {
  const authoritative = await fake.member.guild.members.fetch({ user: MEMBER, force: true });
  return [...authoritative.roles.cache.keys()] as string[];
}

function healthyRoles(): Map<string, ReturnType<typeof liveRole>> {
  return new Map([
    [RED, liveRole(RED)],
    [BLUE, liveRole(BLUE)],
  ]);
}

test('grant reads back: live guild state matches the configured panel after the edit', async () => {
  const fake = fakeGuild({ initial: [], roles: healthyRoles() });
  const claims: Array<Record<string, any>> = [];
  const audits: Array<Record<string, any>> = [];

  await applyRoleDelta({
    panel,
    member: fake.member as never,
    source: 'button',
    sourceId: panel.messageId,
    eventId: 'readback-grant-red',
    optionKey: 'red',
    roleId: RED,
    operation: 'add',
    addRoleIds: [RED],
    removeRoleIds: [],
    deps: { panels: [panel], store: stubStore(claims, audits) as never },
  });

  assert.equal(audits.length, 1);
  assert.deepEqual(
    { outcome: audits[0].outcome, addedRoleIds: audits[0].addedRoleIds, removedRoleIds: audits[0].removedRoleIds },
    { outcome: 'assigned', addedRoleIds: [RED], removedRoleIds: [] },
  );
  // The read-back goes through the same forced member fetch the dispatch
  // uses - a cached snapshot must never satisfy this assertion.
  const observed = await livePanelRoleIds(fake);
  assert.ok(
    fake.memberFetches.every((args) => JSON.stringify(args) === JSON.stringify({ user: MEMBER, force: true })),
  );
  assert.deepEqual(panelReadbackProblems(panel, claims[0].desiredRoleIds, observed), []);
  assert.deepEqual(observed, [RED]);
});

test('revoke reads back: the role is gone and unrelated roles are untouched', async () => {
  const fake = fakeGuild({ initial: [RED, UNRELATED], roles: healthyRoles() });
  const claims: Array<Record<string, any>> = [];
  const audits: Array<Record<string, any>> = [];

  await applyRoleDelta({
    panel,
    member: fake.member as never,
    source: 'button',
    sourceId: panel.messageId,
    eventId: 'readback-revoke-red',
    optionKey: 'red',
    roleId: RED,
    operation: 'remove',
    addRoleIds: [],
    removeRoleIds: [RED],
    deps: { panels: [panel], store: stubStore(claims, audits) as never },
  });

  assert.equal(audits[0].outcome, 'removed');
  const observed = await livePanelRoleIds(fake);
  assert.deepEqual(panelReadbackProblems(panel, claims[0].desiredRoleIds, observed), []);
  assert.deepEqual(observed, [UNRELATED]);
  assert.deepEqual([...fake.roleState].sort(), [UNRELATED]);
});

test('exclusive switch reads back exactly the new role', async () => {
  const exclusive = { ...panel, id: 'readback-exclusive', exclusive: true };
  const fake = fakeGuild({ initial: [RED], roles: healthyRoles() });
  const claims: Array<Record<string, any>> = [];
  const audits: Array<Record<string, any>> = [];

  await applyRoleDelta({
    panel: exclusive,
    member: fake.member as never,
    source: 'button',
    sourceId: exclusive.messageId,
    eventId: 'readback-switch-blue',
    optionKey: 'blue',
    roleId: BLUE,
    operation: 'replace',
    addRoleIds: [],
    removeRoleIds: [],
    requestedOptionKey: 'blue',
    requestedRemove: false,
    deps: { panels: [exclusive], store: stubStore(claims, audits) as never },
  });

  assert.equal(audits[0].outcome, 'switched');
  const observed = await livePanelRoleIds(fake);
  assert.deepEqual(panelReadbackProblems(exclusive, claims[0].desiredRoleIds, observed), []);
  assert.deepEqual(observed, [BLUE]);
});

test('a live permission-mask edit flags drift and mutates nothing', async () => {
  // An admin raised the role after the panel was configured: ViewChannel is
  // allowlisted but the config pins "0", so the dispatch must refuse with the
  // drift named instead of granting a role the config no longer describes.
  const drifted = new Map([
    [RED, liveRole(RED, { bitfield: PermissionFlagsBits.ViewChannel })],
    [BLUE, liveRole(BLUE)],
  ]);
  const fake = fakeGuild({ initial: [], roles: drifted });
  const claims: Array<Record<string, any>> = [];
  const audits: Array<Record<string, any>> = [];

  await applyRoleDelta({
    panel,
    member: fake.member as never,
    source: 'button',
    sourceId: panel.messageId,
    eventId: 'readback-perm-drift',
    optionKey: 'red',
    roleId: RED,
    operation: 'add',
    addRoleIds: [RED],
    removeRoleIds: [],
    deps: { panels: [panel], store: stubStore(claims, audits) as never },
  });

  assert.deepEqual(
    { outcome: audits[0].outcome, code: audits[0].code },
    { outcome: 'rejected', code: 'role_permissions_changed' },
  );
  assert.match(String(audits[0].reason), new RegExp(`permission mask changed from 0 to ${PermissionFlagsBits.ViewChannel}`));
  assert.deepEqual([...fake.roleState], []);
});

test('a live role deletion flags drift and mutates nothing', async () => {
  const withoutRed = new Map([[BLUE, liveRole(BLUE)]]);
  const fake = fakeGuild({ initial: [], roles: withoutRed });
  const claims: Array<Record<string, any>> = [];
  const audits: Array<Record<string, any>> = [];

  await applyRoleDelta({
    panel,
    member: fake.member as never,
    source: 'button',
    sourceId: panel.messageId,
    eventId: 'readback-missing-role',
    optionKey: 'red',
    roleId: RED,
    operation: 'add',
    addRoleIds: [RED],
    removeRoleIds: [],
    deps: { panels: [panel], store: stubStore(claims, audits) as never },
  });

  assert.deepEqual(
    { outcome: audits[0].outcome, code: audits[0].code },
    { outcome: 'rejected', code: 'missing_role' },
  );
  assert.deepEqual([...fake.roleState], []);
});

test('a grant that never lands is flagged by the read-back, not hidden by the audit', async () => {
  // The write path audits its intended delta without re-reading the member
  // (the gap this card pins): the audit says assigned while the role is
  // absent. The read-back must name the missing role rather than agree.
  const fake = fakeGuild({ initial: [], roles: healthyRoles(), faults: { addNoop: true } });
  const claims: Array<Record<string, any>> = [];
  const audits: Array<Record<string, any>> = [];

  await applyRoleDelta({
    panel,
    member: fake.member as never,
    source: 'button',
    sourceId: panel.messageId,
    eventId: 'readback-lost-grant',
    optionKey: 'red',
    roleId: RED,
    operation: 'add',
    addRoleIds: [RED],
    removeRoleIds: [],
    deps: { panels: [panel], store: stubStore(claims, audits) as never },
  });

  assert.equal(audits[0].outcome, 'assigned');
  const observed = await livePanelRoleIds(fake);
  assert.deepEqual(panelReadbackProblems(panel, claims[0].desiredRoleIds, observed), [
    `panel "${panel.id}" role ${RED} is missing from live guild state`,
  ]);
});

test('an external membership edit between grant and read-back is flagged', async () => {
  const fake = fakeGuild({ initial: [], roles: healthyRoles() });
  const claims: Array<Record<string, any>> = [];
  const audits: Array<Record<string, any>> = [];

  await applyRoleDelta({
    panel,
    member: fake.member as never,
    source: 'button',
    sourceId: panel.messageId,
    eventId: 'readback-external-edit',
    optionKey: 'red',
    roleId: RED,
    operation: 'add',
    addRoleIds: [RED],
    removeRoleIds: [],
    deps: { panels: [panel], store: stubStore(claims, audits) as never },
  });

  // Someone (another bot, an admin) granted the sibling panel role outside
  // this dispatch before the re-read.
  fake.roleState.add(BLUE);
  const observed = await livePanelRoleIds(fake);
  assert.deepEqual(panelReadbackProblems(panel, claims[0].desiredRoleIds, observed), [
    `panel "${panel.id}" role ${BLUE} is present in live guild state but not desired`,
  ]);
});
