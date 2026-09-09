import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSelfRolePanels,
  SelfRoleConfigError,
  validateSelfRolePanelRoles,
} from '../src/selfRoles/config.ts';
import {
  emojiIdentity,
  parseSelfRoleCustomId,
  planSelfRoleChange,
  reactionEndpointEmoji,
  reactionOptionKey,
  selfRoleCustomId,
} from '../src/selfRoles/plan.ts';
import { Events, PermissionFlagsBits } from 'discord.js';
import {
  findSelfRoleDisallowedPermission,
  SELF_ROLE_ALLOWED_PERMISSIONS,
} from '../src/selfRoles/permissions.ts';
import type { SelfRolePanel } from '../src/selfRoles/types.ts';
import { applyRoleDelta, registerSelfRoles, validateSelfRoleDispatch } from '../src/discord/selfRoles.ts';
import { SelfRoleStore } from '../src/store/selfRoleStore.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const A = '111111111111111111';
const B = '222222222222222222';
const C = '333333333333333333';
const panel: SelfRolePanel = {
  id: 'colors',
  channelId: A,
  messageId: B,
  mode: 'button',
  exclusive: true,
  color: true,
  options: [
    { key: 'red', label: 'Red', roleId: A, permissions: '0', emoji: '🔴' },
    { key: 'blue', label: 'Blue', roleId: B, permissions: '0', emoji: '🔵' },
  ],
};

let harness: TestDb;
before(async () => { harness = await openTestDb(import.meta.filename); });
after(async () => { await harness.cleanup(); });
beforeEach(async () => { await harness.reset(); });

test('multiple panels and all three picker modes parse from deployment config', () => {
  const parsed = loadSelfRolePanels(JSON.stringify([
    panel,
    { ...panel, id: 'games', messageId: C, mode: 'select', exclusive: false, color: false },
    { ...panel, id: 'alerts', messageId: '444444444444444444', mode: 'reaction', exclusive: false, color: false },
  ]));
  assert.deepEqual(parsed.map((p) => p.mode), ['button', 'select', 'reaction']);
});

test('configuration rejects duplicate panels, messages, roles, and unsafe color semantics', () => {
  const duplicateMessage = JSON.stringify([panel, { ...panel, id: 'other' }]);
  assert.throws(() => loadSelfRolePanels(duplicateMessage), SelfRoleConfigError);
  assert.throws(
    () => loadSelfRolePanels(JSON.stringify([{ ...panel, exclusive: false }])),
    /color requires exclusive=true/,
  );
  assert.throws(
    () => loadSelfRolePanels(JSON.stringify([{ ...panel, options: [...panel.options, { key: 'green', label: 'Green', roleId: A, permissions: '0' }] }])),
    /offers role .* more than once/,
  );
});

const allowedPermissionNames = new Set<string>(SELF_ROLE_ALLOWED_PERMISSIONS.map(([name]) => name));
const knownPermissionBits = new Map<bigint, string>();
for (const [name, bit] of Object.entries(PermissionFlagsBits)) {
  if (!knownPermissionBits.has(bit)) knownPermissionBits.set(bit, name);
}

for (const [bit, permission] of knownPermissionBits) {
  if (allowedPermissionNames.has(permission)) continue;

  test(`configuration rejects non-allowlisted ${permission} permission`, () => {
    assert.throws(
      () => loadSelfRolePanels(JSON.stringify([{
        ...panel,
        options: [{ ...panel.options[0], permissions: String(bit) }],
      }])),
      new RegExp(`roleId ${A} has disallowed permission ${permission}.*permissions`),
    );
  });

  test(`startup resolution rejects live non-allowlisted ${permission} permission`, () => {
    assert.throws(
      () => validateSelfRolePanelRoles([panel], [
        { id: A, name: 'Staff', permissions: String(bit) },
        { id: B, name: 'Blue', permissions: '0' },
      ]),
      new RegExp(`role ${A} \\(\"Staff\"\\) has disallowed permission ${permission}`),
    );
  });

  test(`dispatch re-check rejects live non-allowlisted ${permission} permission`, () => {
    const roles = new Map([
      [A, { id: A, managed: false, editable: true, permissions: { bitfield: bit } }],
    ]);
    const member = {
      guild: {
        members: { me: { permissions: { has: () => true } } },
        roles: { cache: { get: (id: string) => roles.get(id) } },
      },
    };
    assert.deepEqual(validateSelfRoleDispatch(panel, member as never, [A]), {
      code: 'disallowed_role_permission',
      reason: `role ${A} has disallowed permission ${permission}`,
      publicMessage: 'That role is not safe for self-service. Staff have been notified in the logs.',
    });
  });
}

test('allowed permissions pass alone and in combination', () => {
  let combined = 0n;
  for (const [permission, bit] of SELF_ROLE_ALLOWED_PERMISSIONS) {
    combined |= bit;
    assert.equal(findSelfRoleDisallowedPermission(bit), null, permission);
  }
  assert.equal(findSelfRoleDisallowedPermission(combined), null);
});

test('unknown future permission bits fail closed through every gate', () => {
  const knownMask = [...knownPermissionBits.keys()].reduce((mask, bit) => mask | bit, 0n);
  let unknownBit = 1n;
  while ((knownMask & unknownBit) !== 0n) unknownBit <<= 1n;
  const unknown = `unknown permission bits ${unknownBit}`;

  assert.throws(
    () => loadSelfRolePanels(JSON.stringify([{
      ...panel,
      options: [{ ...panel.options[0], permissions: String(unknownBit) }],
    }])),
    new RegExp(unknown),
  );
  assert.throws(
    () => validateSelfRolePanelRoles([panel], [
      { id: A, name: 'Future', permissions: unknownBit },
      { id: B, name: 'Blue', permissions: 0n },
    ]),
    new RegExp(unknown),
  );

  const roles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: unknownBit } }],
  ]);
  const member = {
    guild: {
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: { get: (id: string) => roles.get(id) } },
    },
  };
  assert.deepEqual(validateSelfRoleDispatch(panel, member as never, [A]), {
    code: 'disallowed_role_permission',
    reason: `role ${A} has disallowed permission ${unknown}`,
    publicMessage: 'That role is not safe for self-service. Staff have been notified in the logs.',
  });
});

test('dispatch re-check rejects any live permission-mask drift', () => {
  const roles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: 1n << 10n } }], // ViewChannel
  ]);
  const member = {
    guild: {
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: { get: (id: string) => roles.get(id) } },
    },
  };
  assert.deepEqual(validateSelfRoleDispatch(panel, member as never, [A]), {
    code: 'role_permissions_changed',
    reason: `role ${A} permission mask changed from 0 to 1024`,
    publicMessage: 'That role changed after this panel was configured. Staff have been notified in the logs.',
  });
});

test('dispatch fetches the authoritative role and rejects a stale safe cache before mutation', async () => {
  let fetches = 0;
  const added: string[] = [];
  const cachedRole = { id: A, managed: false, editable: true, permissions: { bitfield: 0n } };
  const fetchedRole = {
    id: A,
    managed: false,
    editable: true,
    permissions: { bitfield: PermissionFlagsBits.Administrator },
  };
  const audits: Array<{ outcome: string; code: string | null }> = [];
  const member = {
    id: B,
    guild: {
      id: C,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => member,
      },
      roles: {
        cache: new Map([[A, cachedRole]]),
        fetch: async () => {
          fetches++;
          return new Map([[A, fetchedRole]]);
        },
      },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map(),
      add: async (roleId: string) => { added.push(roleId); },
      remove: async () => {},
    },
  };
  const store = {
    claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }),
    finishAudit: async (row: { outcome: string; code: string | null }) => { audits.push(row); },
  };

  await applyRoleDelta({
    panel,
    member: member as never,
    source: 'button',
    sourceId: panel.messageId,
    eventId: 'event-stale-cache',
    optionKey: 'red',
    roleId: A,
    operation: 'add',
    addRoleIds: [A],
    removeRoleIds: [],
    deps: { panels: [panel], store: store as never },
  });

  assert.equal(fetches, 1);
  assert.deepEqual(added, []);
  assert.deepEqual(audits.map(({ outcome, code }) => ({ outcome, code })), [
    { outcome: 'rejected', code: 'disallowed_role_permission' },
  ]);
});

test('dispatch mutates only explicit role ids and never submits a cached full-role set', async () => {
  const unrelated = '444444444444444444';
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const authoritativeRoles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, permissions: { bitfield: 0n } }],
  ]);
  const member = {
    id: C,
    guild: {
      id: A,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => member,
      },
      roles: { fetch: async () => authoritativeRoles },
      channels: { fetch: async () => new Map() },
    },
    // The unrelated cached role represents the stale snapshot that array-based
    // discord.js role mutations would otherwise send back as a full replacement.
    roles: {
      cache: new Map([[A, { id: A }], [unrelated, { id: unrelated }]]),
      add: async (roleId: unknown) => { added.push(roleId); },
      remove: async (roleId: unknown) => { removed.push(roleId); },
    },
  };
  const store = { claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }), finishAudit: async () => {} };

  await applyRoleDelta({
    panel,
    member: member as never,
    source: 'button',
    sourceId: panel.messageId,
    eventId: 'event-singular-role-delta',
    optionKey: 'blue',
    roleId: B,
    operation: 'replace',
    addRoleIds: [B],
    removeRoleIds: [A],
    deps: { panels: [panel], store: store as never },
  });

  assert.deepEqual(removed, [A]);
  assert.deepEqual(added, [B]);
  assert.equal(removed.includes(unrelated), false);
  assert.equal(added.includes(unrelated), false);
});

test('a later add failure reconciles authoritative role state to the pre-mutation snapshot', async () => {
  const D = '444444444444444444';
  const multiPanel: SelfRolePanel = {
    ...panel,
    exclusive: false,
    color: false,
    options: [
      ...panel.options,
      { key: 'green', label: 'Green', roleId: D, permissions: '0', emoji: '🟢' },
    ],
  };
  const roleState = new Set([A]);
  const added: string[] = [];
  const removed: string[] = [];
  const authoritativeRoles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [D, { id: D, managed: false, editable: true, permissions: { bitfield: 0n } }],
  ]);
  const audits: Array<{ outcome: string; code: string | null }> = [];
  const member = {
    id: C,
    guild: {
      id: A,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => ({
          ...member,
          roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) },
        }),
      },
      roles: { fetch: async () => authoritativeRoles },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map([[A, { id: A }]]),
      add: async (roleId: string) => {
        added.push(roleId);
        if (roleId === D) throw new Error('later add failed');
        roleState.add(roleId);
      },
      remove: async (roleId: string) => {
        removed.push(roleId);
        roleState.delete(roleId);
      },
    },
  };
  const store = {
    claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }),
    finishAudit: async (row: { outcome: string; code: string | null }) => { audits.push(row); },
  };

  await applyRoleDelta({
    panel: multiPanel,
    member: member as never,
    source: 'select',
    sourceId: multiPanel.messageId,
    eventId: 'event-later-add-failure',
    optionKey: null,
    roleId: null,
    operation: 'replace',
    addRoleIds: [B, D],
    removeRoleIds: [A],
    deps: { panels: [multiPanel], store: store as never },
  });

  assert.deepEqual(added, [B, D, A]);
  assert.deepEqual(removed, [A, B]);
  assert.deepEqual([...roleState], [A]);
  assert.deepEqual(audits.map(({ outcome, code }) => ({ outcome, code })), [
    { outcome: 'rejected', code: 'discord_rejected' },
  ]);
});

test('rollback does not grant a stale-cache role whose remove was an authoritative no-op', async () => {
  const D = '444444444444444444';
  const multiPanel: SelfRolePanel = {
    ...panel,
    exclusive: false,
    color: false,
    options: [
      ...panel.options,
      { key: 'green', label: 'Green', roleId: D, permissions: '0', emoji: '🟢' },
    ],
  };
  const roleState = new Set<string>();
  const added: string[] = [];
  const removed: string[] = [];
  const authoritativeRoles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [D, { id: D, managed: false, editable: true, permissions: { bitfield: 0n } }],
  ]);
  const audits: Array<{ outcome: string; code: string | null }> = [];
  const member = {
    id: C,
    guild: {
      id: A,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => ({
          ...member,
          roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) },
        }),
      },
      roles: { fetch: async () => authoritativeRoles },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map([[A, { id: A }]]),
      add: async (roleId: string) => {
        added.push(roleId);
        if (roleId === D) throw new Error('later add failed');
        roleState.add(roleId);
      },
      remove: async (roleId: string) => {
        removed.push(roleId);
        roleState.delete(roleId);
      },
    },
  };
  const store = {
    claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }),
    finishAudit: async (row: { outcome: string; code: string | null }) => { audits.push(row); },
  };

  await applyRoleDelta({
    panel: multiPanel,
    member: member as never,
    source: 'select',
    sourceId: multiPanel.messageId,
    eventId: 'event-stale-held-rollback',
    optionKey: null,
    roleId: null,
    operation: 'replace',
    addRoleIds: [B, D],
    removeRoleIds: [A],
    deps: { panels: [multiPanel], store: store as never },
  });

  assert.deepEqual(removed, [B]);
  assert.deepEqual(added, [B, D]);
  assert.deepEqual([...roleState], []);
  assert.deepEqual(audits.map(({ outcome, code }) => ({ outcome, code })), [
    { outcome: 'rejected', code: 'discord_rejected' },
  ]);
});

test('rollback does not remove a role already held outside the stale cache', async () => {
  const D = '444444444444444444';
  const multiPanel: SelfRolePanel = {
    ...panel,
    exclusive: false,
    color: false,
    options: [
      ...panel.options,
      { key: 'green', label: 'Green', roleId: D, permissions: '0', emoji: '🟢' },
    ],
  };
  const roleState = new Set([B]);
  const added: string[] = [];
  const removed: string[] = [];
  const authoritativeRoles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [D, { id: D, managed: false, editable: true, permissions: { bitfield: 0n } }],
  ]);
  const audits: Array<{ outcome: string; code: string | null }> = [];
  const member = {
    id: C,
    guild: {
      id: A,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => ({
          ...member,
          roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) },
        }),
      },
      roles: { fetch: async () => authoritativeRoles },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map(),
      add: async (roleId: string) => {
        added.push(roleId);
        if (roleId === D) throw new Error('later add failed');
        roleState.add(roleId);
      },
      remove: async (roleId: string) => {
        removed.push(roleId);
        roleState.delete(roleId);
      },
    },
  };
  const store = {
    claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }),
    finishAudit: async (row: { outcome: string; code: string | null }) => { audits.push(row); },
  };

  await applyRoleDelta({
    panel: multiPanel,
    member: member as never,
    source: 'select',
    sourceId: multiPanel.messageId,
    eventId: 'event-stale-absent-rollback',
    optionKey: null,
    roleId: null,
    operation: 'add',
    addRoleIds: [B, D],
    removeRoleIds: [],
    deps: { panels: [multiPanel], store: store as never },
  });

  assert.deepEqual(added, [D]);
  assert.deepEqual(removed, []);
  assert.deepEqual([...roleState], [B]);
  assert.deepEqual(audits.map(({ outcome, code }) => ({ outcome, code })), [
    { outcome: 'rejected', code: 'discord_rejected' },
  ]);
});

test('member fetch failure rejects before validating roles or mutating', async () => {
  let roleFetches = 0;
  const added: string[] = [];
  const audits: Array<{ outcome: string; code: string | null }> = [];
  const member = {
    id: C,
    guild: {
      id: A,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => { throw new Error('member unavailable'); },
      },
      roles: { fetch: async () => { roleFetches++; return new Map(); } },
    },
    roles: {
      cache: new Map(),
      add: async (roleId: string) => { added.push(roleId); },
      remove: async () => {},
    },
  };
  const store = {
    claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }),
    finishAudit: async (row: { outcome: string; code: string | null }) => { audits.push(row); },
  };

  await applyRoleDelta({
    panel,
    member: member as never,
    source: 'button',
    sourceId: panel.messageId,
    eventId: 'event-member-fetch-failed',
    optionKey: 'red',
    roleId: A,
    operation: 'add',
    addRoleIds: [A],
    removeRoleIds: [],
    deps: { panels: [panel], store: store as never },
  });

  assert.equal(roleFetches, 0);
  assert.deepEqual(added, []);
  assert.deepEqual(audits.map(({ outcome, code }) => ({ outcome, code })), [
    { outcome: 'rejected', code: 'member_fetch_failed' },
  ]);
});

test('exclusive color selection removes old colors and adds exactly one new color', () => {
  assert.deepEqual(
    planSelfRoleChange({ panel, optionKey: 'blue', memberRoleIds: [A], source: 'button', remove: false }),
    {
      ok: true,
      option: panel.options[1],
      operation: 'replace',
      addRoleIds: [B],
      removeRoleIds: [A],
      outcome: 'switched',
    },
  );
});

test('button toggles and reaction removal are idempotent', () => {
  const held = planSelfRoleChange({ panel, optionKey: 'red', memberRoleIds: [A], source: 'button', remove: false });
  assert.ok(held.ok);
  assert.equal(held.outcome, 'already_held');
  const reactionPanel = { ...panel, mode: 'reaction' as const, exclusive: false, color: false };
  const absent = planSelfRoleChange({ panel: reactionPanel, optionKey: 'red', memberRoleIds: [], source: 'reaction', remove: true });
  assert.ok(absent.ok);
  assert.equal(absent.outcome, 'already_absent');
});

test('a control cannot cross panel mode and unknown options are rejected', () => {
  assert.deepEqual(
    planSelfRoleChange({ panel, optionKey: 'red', memberRoleIds: [], source: 'select', remove: false }),
    { ok: false, code: 'wrong_source', reason: 'panel colors expects button, received select' },
  );
  assert.equal(planSelfRoleChange({ panel, optionKey: 'green', memberRoleIds: [], source: 'button', remove: false }).ok, false);
});

test('custom ids and reaction emoji resolve only configured panel options', () => {
  assert.equal(selfRoleCustomId('colors', 'red'), 'two:self-role:colors:red');
  assert.deepEqual(parseSelfRoleCustomId('two:self-role:colors:red'), { panelId: 'colors', optionKey: 'red' });
  assert.equal(parseSelfRoleCustomId('two:self-role:Colors:red'), null);
  assert.equal(reactionOptionKey({ ...panel, mode: 'reaction' }, { id: null, name: '🔵' }), 'blue');
  assert.equal(reactionOptionKey({ ...panel, mode: 'reaction' }, { id: null, name: '🟢' }), null);

  const custom = '<:red:555555555555555555>';
  const customPanel = {
    ...panel,
    mode: 'reaction' as const,
    options: [{ ...panel.options[0], emoji: custom }],
  };
  assert.equal(emojiIdentity(custom), '555555555555555555');
  assert.equal(reactionEndpointEmoji(custom), 'red:555555555555555555');
  assert.equal(reactionOptionKey(customPanel, { id: '555555555555555555', name: 'red' }), 'red');
});

test('unsafe channel overwrite grants fail closed at startup and dispatch', () => {
  const channels = [{
    id: C,
    name: 'staff',
    permissionOverwrites: [{
      id: A,
      type: 0,
      allow: String(PermissionFlagsBits.ManageMessages),
      deny: '0',
    }],
  }];
  assert.throws(
    () => validateSelfRolePanelRoles([panel], [
      { id: A, name: 'Red', permissions: '0' },
      { id: B, name: 'Blue', permissions: '0' },
      { id: C, name: '@everyone', permissions: '0' },
    ], channels, C),
    /disallowed effective channel permission ManageMessages.*channel 333333333333333333/,
  );

  const roles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [C, { id: C, managed: false, editable: false, permissions: { bitfield: 0n } }],
  ]);
  const member = {
    guild: {
      id: C,
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: roles },
    },
  };
  assert.deepEqual(validateSelfRoleDispatch(panel, member as never, [A], roles as never, channels), {
    code: 'disallowed_channel_permission',
    reason: `role ${A} has disallowed effective channel permission ManageMessages in channel ${C}`,
    publicMessage: 'That role is not safe for self-service. Staff have been notified in the logs.',
  });
});

test('an ambiguous mutation is authoritatively reconciled and audited by actual effects', async () => {
  const roleState = new Set<string>();
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, permissions: { bitfield: 0n } },
  ]));
  const audits: Array<Record<string, unknown>> = [];
  const member = {
    id: C,
    guild: {
      id: A,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => ({
          ...member,
          roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) },
        }),
      },
      roles: { fetch: async () => roles },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map(),
      add: async (roleId: string) => {
        roleState.add(roleId);
        throw new Error('timeout after Discord applied the role');
      },
      remove: async (roleId: string) => { roleState.delete(roleId); },
    },
  };
  const store = {
    claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }),
    finishAudit: async (row: Record<string, unknown>) => { audits.push(row); },
  };

  await applyRoleDelta({
    panel, member: member as never, source: 'button', sourceId: panel.messageId,
    eventId: 'ambiguous-add', optionKey: 'red', roleId: A, operation: 'add',
    addRoleIds: [A], removeRoleIds: [], deps: { panels: [panel], store: store as never },
  });

  assert.deepEqual([...roleState], []);
  assert.partialDeepStrictEqual(audits[0], {
    outcome: 'rejected',
    code: 'discord_rejected',
    addedRoleIds: [],
    removedRoleIds: [],
    attemptedAddedRoleIds: [A],
    attemptedRemovedRoleIds: [],
    compensatedAddedRoleIds: [],
    compensatedRemovedRoleIds: [A],
    unresolvedAddedRoleIds: [],
    unresolvedRemovedRoleIds: [],
  });
});

test('expired processing claims recover while completed claims remain final', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const row = {
    eventId: 'event-recovery', guildId: A, panelId: panel.id, memberId: B, sourceId: panel.messageId,
    optionKey: 'red', roleId: A, source: 'button' as const, operation: 'add' as const,
    outcome: 'assigned' as const, code: null, reason: null, addedRoleIds: [A], removedRoleIds: [],
    attemptedAddedRoleIds: [A], attemptedRemovedRoleIds: [],
    compensatedAddedRoleIds: [], compensatedRemovedRoleIds: [],
    unresolvedAddedRoleIds: [], unresolvedRemovedRoleIds: [],
  };
  const first = await store.claimAudit(row);
  assert.ok(first);
  assert.equal(first.recovered, false);
  now = new Date('2026-09-09T00:00:00.500Z');
  assert.equal(await store.claimAudit(row), null);
  now = new Date('2026-09-09T00:00:01.001Z');
  const recovered = await store.claimAudit(row);
  assert.ok(recovered);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.generation, 2);
  await store.finishAudit(row, recovered);
  now = new Date('2026-09-10T00:00:00.000Z');
  assert.equal(await store.claimAudit(row), null);
});

test('uncached partial reactions fetch and reach the role handler without escaping failures', async () => {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const client = { on: (event: string, listener: (...args: never[]) => unknown) => listeners.set(event, listener) };
  let reactionFetched = 0;
  let memberFetch: unknown;
  let claimed = 0;
  registerSelfRoles(client as never, {
    panels: [{ ...panel, mode: 'reaction', exclusive: false, color: false }],
    store: {
      claimAudit: async () => { claimed++; throw new Error('db unavailable'); },
      finishAudit: async () => {},
    } as never,
  });
  const member = {
    id: C,
    guild: {
      id: A,
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: new Map(), fetch: async () => new Map() },
      channels: { fetch: async () => new Map() },
    },
    roles: { cache: new Map() },
  };
  const reaction = {
    partial: true,
    fetch: async () => { reactionFetched++; },
    message: {
      id: panel.messageId,
      channelId: panel.channelId,
      guild: {
        members: {
          fetch: async (opts: unknown) => { memberFetch = opts; return member; },
        },
      },
    },
    emoji: { id: null, name: '🔴' },
  };
  listeners.get(Events.MessageReactionAdd)!(reaction as never, { id: C, bot: false } as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reactionFetched, 1);
  assert.deepEqual(memberFetch, { user: C, force: true });
  assert.equal(claimed, 1);
});

test('concurrent exclusive selections serialize and recompute from forced member state', async () => {
  const roleState = new Set<string>();
  const fetchArgs: unknown[] = [];
  let releaseFirst!: () => void;
  const firstAddBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstAddStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstAddStarted = resolve; });
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, permissions: { bitfield: 0n } },
  ]));
  const member = {
    id: C,
    guild: {
      id: A,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async (opts: unknown) => {
          fetchArgs.push(opts);
          return { ...member, roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) } };
        },
      },
      roles: { fetch: async () => roles },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map(),
      remove: async (roleId: string) => { roleState.delete(roleId); },
      add: async (roleId: string) => {
        if (roleId === A) {
          firstAddStarted();
          await firstAddBlocked;
        }
        roleState.add(roleId);
      },
    },
  };
  const store = { claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }), finishAudit: async () => {} };
  const red = applyRoleDelta({
    panel, member: member as never, source: 'button', sourceId: panel.messageId, eventId: 'exclusive-red',
    optionKey: 'red', roleId: A, operation: 'replace', addRoleIds: [], removeRoleIds: [],
    requestedOptionKey: 'red', requestedRemove: false, deps: { panels: [panel], store: store as never },
  });
  await firstStarted;
  const blue = applyRoleDelta({
    panel, member: member as never, source: 'button', sourceId: panel.messageId, eventId: 'exclusive-blue',
    optionKey: 'blue', roleId: B, operation: 'replace', addRoleIds: [], removeRoleIds: [],
    requestedOptionKey: 'blue', requestedRemove: false, deps: { panels: [panel], store: store as never },
  });
  releaseFirst();
  await Promise.all([red, blue]);
  assert.deepEqual([...roleState], [B]);
  assert.ok(fetchArgs.length >= 2);
  assert.ok(fetchArgs.every((args) => JSON.stringify(args) === JSON.stringify({ user: C, force: true })));
});

test('recovered button converges to persisted desired roles after the first add succeeded', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const roleState = new Set([A]);
  const removed: string[] = [];
  const roles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, permissions: { bitfield: 0n } }],
  ]);
  const row = {
    eventId: 'recovered-button', guildId: C, panelId: panel.id, memberId: B, sourceId: panel.messageId,
    optionKey: 'red', roleId: A, source: 'button' as const, operation: 'replace' as const,
    desiredRoleIds: [A], preMutationRoleIds: [], outcome: 'processing' as const, code: null, reason: null,
    addedRoleIds: [], removedRoleIds: [], attemptedAddedRoleIds: [], attemptedRemovedRoleIds: [],
    compensatedAddedRoleIds: [], compensatedRemovedRoleIds: [], unresolvedAddedRoleIds: [], unresolvedRemovedRoleIds: [],
  };
  assert.ok(await store.claimAudit(row));
  now = new Date('2026-09-09T00:00:01.001Z');
  const member = {
    id: B,
    guild: {
      id: C,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => ({ ...member, roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) } }),
      },
      roles: { fetch: async () => roles },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map([...roleState].map((id) => [id, { id }])),
      add: async (roleId: string) => { roleState.add(roleId); },
      remove: async (roleId: string) => { removed.push(roleId); roleState.delete(roleId); },
    },
  };

  await applyRoleDelta({
    panel, member: member as never, source: 'button', sourceId: panel.messageId,
    eventId: row.eventId, optionKey: 'red', roleId: A, operation: 'replace',
    addRoleIds: [], removeRoleIds: [], requestedOptionKey: 'red', requestedToggle: true,
    deps: { panels: [panel], store },
  });

  assert.deepEqual(removed, []);
  assert.deepEqual([...roleState], [A]);
  const stored = await harness.db.prepare(
    `SELECT outcome, desired_role_ids, pre_mutation_role_ids, added_role_ids, removed_role_ids
       FROM self_role_audit WHERE event_id = ?`,
  ).get<Record<string, unknown>>(row.eventId);
  assert.deepEqual({ ...stored }, {
    outcome: 'assigned',
    desired_role_ids: '["111111111111111111"]',
    pre_mutation_role_ids: '[]',
    added_role_ids: '["111111111111111111"]',
    removed_role_ids: '[]',
  });
});

test('dispatch keeps fetched @everyone for effective channel permission validation', async () => {
  const roleState = new Set<string>();
  const added: string[] = [];
  const safePanel = { ...panel, options: [{ ...panel.options[0] }] };
  const roles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: 0n } }],
    [C, { id: C, managed: false, editable: false, permissions: { bitfield: 0n } }],
  ]);
  const channel = { id: B, name: 'general', permissionOverwrites: { cache: new Map() } };
  const member = {
    id: B,
    guild: {
      id: C,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => ({ ...member, roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) } }),
      },
      roles: { fetch: async () => roles },
      channels: { fetch: async () => new Map([[B, channel]]) },
    },
    roles: {
      cache: new Map(),
      add: async (roleId: string) => { added.push(roleId); roleState.add(roleId); },
      remove: async (roleId: string) => { roleState.delete(roleId); },
    },
  };
  const store = { claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }), finishAudit: async () => {} };

  await applyRoleDelta({
    panel: safePanel, member: member as never, source: 'button', sourceId: safePanel.messageId,
    eventId: 'everyone-dispatch', optionKey: 'red', roleId: A, operation: 'add',
    addRoleIds: [A], removeRoleIds: [], deps: { panels: [safePanel], store: store as never },
  });

  assert.deepEqual(added, [A]);
});

test('independent stores serialize exclusive changes through the shared database', async () => {
  const firstStore = new SelfRoleStore(harness.db, { leaseMs: 2_000 });
  const secondStore = new SelfRoleStore(harness.db, { leaseMs: 2_000 });
  const roleState = new Set<string>();
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  let releaseFirst!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, permissions: { bitfield: 0n } },
  ]));
  const makeMember = () => {
    const member = {
      id: C,
      guild: {
        id: A,
        members: {
          me: { permissions: { has: () => true } },
          fetch: async () => ({ ...member, roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) } }),
        },
        roles: { fetch: async () => roles },
        channels: { fetch: async () => new Map() },
      },
      roles: {
        cache: new Map(),
        remove: async (roleId: string) => { roleState.delete(roleId); },
        add: async (roleId: string) => {
          if (roleId === A) { firstStarted(); await blocked; }
          roleState.add(roleId);
        },
      },
    };
    return member;
  };
  const red = applyRoleDelta({
    panel, member: makeMember() as never, source: 'button', sourceId: panel.messageId,
    eventId: 'shared-red', optionKey: 'red', roleId: A, operation: 'replace', addRoleIds: [], removeRoleIds: [],
    requestedOptionKey: 'red', deps: { panels: [panel], store: firstStore },
  });
  await started;
  const blue = applyRoleDelta({
    panel, member: makeMember() as never, source: 'button', sourceId: panel.messageId,
    eventId: 'shared-blue', optionKey: 'blue', roleId: B, operation: 'replace', addRoleIds: [], removeRoleIds: [],
    requestedOptionKey: 'blue', deps: { panels: [panel], store: secondStore },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual([...roleState], []);
  releaseFirst();
  await Promise.all([red, blue]);
  assert.deepEqual([...roleState], [B]);
});

test('stale in-flight claimant stops before audit or compensation after REST returns', async () => {
  let owns = true;
  let releaseAdd!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseAdd = resolve; });
  let addStarted!: () => void;
  const started = new Promise<void>((resolve) => { addStarted = resolve; });
  let finishes = 0;
  let compensations = 0;
  const roleState = new Set<string>();
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, permissions: { bitfield: 0n } },
  ]));
  const member = {
    id: C,
    guild: {
      id: A,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => ({ ...member, roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) } }),
      },
      roles: { fetch: async () => roles },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map(),
      add: async (roleId: string, reason: string) => {
        if (reason.endsWith('reconcile')) compensations++;
        addStarted();
        await blocked;
        roleState.add(roleId);
      },
      remove: async (_roleId: string, reason: string) => { if (reason.endsWith('reconcile')) compensations++; },
    },
  };
  const store = {
    claimAudit: async (row: { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }) => ({ token: 'old', generation: 1, recovered: false, desiredRoleIds: row.desiredRoleIds ?? [], preMutationRoleIds: row.preMutationRoleIds ?? [] }),
    finishAudit: async () => { finishes++; },
    ownsClaim: async () => owns,
  };
  const running = applyRoleDelta({
    panel: { ...panel, exclusive: false }, member: member as never, source: 'button', sourceId: panel.messageId,
    eventId: 'stale-in-flight', optionKey: 'red', roleId: A, operation: 'add', addRoleIds: [A], removeRoleIds: [],
    deps: { panels: [panel], store: store as never },
  });
  await started;
  owns = false;
  releaseAdd();
  await running;
  assert.equal(finishes, 0);
  assert.equal(compensations, 0);
  assert.deepEqual([...roleState], [A]);
});

test('audit claims dedupe gateway deliveries before the final outcome is stored', async () => {
  const store = new SelfRoleStore(harness.db);
  const row = {
    eventId: 'event-1', guildId: A, panelId: panel.id, memberId: B, sourceId: panel.messageId,
    optionKey: 'red', roleId: A, source: 'button' as const, operation: 'add' as const,
    outcome: 'assigned' as const, code: null, reason: null, addedRoleIds: [A], removedRoleIds: [],
    attemptedAddedRoleIds: [A], attemptedRemovedRoleIds: [],
    compensatedAddedRoleIds: [], compensatedRemovedRoleIds: [],
    unresolvedAddedRoleIds: [], unresolvedRemovedRoleIds: [],
  };
  const claim = await store.claimAudit(row);
  assert.ok(claim);
  assert.equal(await store.claimAudit(row), null);
  await store.finishAudit(row, claim);
  const stored = await harness.db
    .prepare(`SELECT COUNT(*) AS n, MAX(outcome) AS outcome FROM self_role_audit WHERE panel_id = ?`)
    .get<{ n: number; outcome: string }>(panel.id);
  assert.equal(Number(stored?.n), 1);
  assert.equal(stored?.outcome, 'assigned');
});
