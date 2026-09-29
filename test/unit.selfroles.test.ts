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
    {
      ...panel,
      id: 'games',
      messageId: C,
      mode: 'select',
      exclusive: false,
      color: false,
      options: [{ ...panel.options[0], roleId: '444444444444444444' }],
    },
    {
      ...panel,
      id: 'alerts',
      messageId: '555555555555555555',
      mode: 'reaction',
      exclusive: false,
      color: false,
      options: [{ ...panel.options[0], roleId: '666666666666666666' }],
    },
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

test('configuration rejects reaction panels over Discord\'s 20-reaction cap', () => {
  const reactionOption = (n: number) => ({
    key: `opt-${n}`,
    label: `Option ${n}`,
    roleId: `7${String(n).padStart(16, '0')}`,
    permissions: '0',
    emoji: `${n}️⃣`,
  });
  const reactionPanel = (count: number) => JSON.stringify([{
    ...panel,
    id: 'reactions',
    mode: 'reaction',
    exclusive: false,
    color: false,
    options: Array.from({ length: count }, (_, i) => reactionOption(i)),
  }]);
  assert.throws(() => loadSelfRolePanels(reactionPanel(21)), /20-reaction limit/);
  assert.equal(loadSelfRolePanels(reactionPanel(20)).length, 1);
});

test('configuration rejects button panels whose custom ids exceed Discord\'s 100-char limit', () => {
  const buttonPanel = (panelId: string, optionKey: string) => JSON.stringify([{
    ...panel,
    id: panelId,
    mode: 'button',
    exclusive: false,
    color: false,
    options: [{ ...panel.options[0], key: optionKey }],
  }]);
  // 14-char prefix + 60-char panel id + colon + 25-char option key = exactly 100.
  assert.equal(loadSelfRolePanels(buttonPanel('p'.repeat(60), 'k'.repeat(25))).length, 1);
  assert.throws(
    () => loadSelfRolePanels(buttonPanel('p'.repeat(60), 'k'.repeat(26))),
    /over Discord's 100-char custom_id limit/,
  );
  // Select panels render no button custom ids, so long keys still load there.
  const selectPanel = JSON.stringify([{
    ...panel,
    id: 'p'.repeat(60),
    mode: 'select',
    exclusive: false,
    color: false,
    options: [{ ...panel.options[0], key: 'k'.repeat(26) }],
  }]);
  assert.equal(loadSelfRolePanels(selectPanel).length, 1);
});

test('configuration rejects button labels over Discord\'s 80-char limit', () => {
  const buttonPanel = (label: string) => JSON.stringify([{
    ...panel,
    id: 'labels',
    mode: 'button',
    exclusive: false,
    color: false,
    options: [{ ...panel.options[0], label }],
  }]);
  assert.throws(() => loadSelfRolePanels(buttonPanel('x'.repeat(90))), /no longer than 80 characters/);
  assert.equal(loadSelfRolePanels(buttonPanel('x'.repeat(80))).length, 1);
  const selectPanel = JSON.stringify([{
    ...panel,
    id: 'labels',
    mode: 'select',
    exclusive: false,
    color: false,
    options: [{ ...panel.options[0], label: 'x'.repeat(90) }],
  }]);
  assert.equal(loadSelfRolePanels(selectPanel).length, 1);
});

test('configuration rejects role ids reused across panels', () => {
  assert.throws(
    () => loadSelfRolePanels(JSON.stringify([
      panel,
      {
        ...panel,
        id: 'other',
        messageId: C,
        color: false,
        options: [{ ...panel.options[0], key: 'shared' }],
      },
    ])),
    new RegExp(`role ${A} is assigned to both panel "colors" and panel "other"`),
  );
});

test('color panels require every resolved live role to have a visible color', () => {
  assert.throws(
    () => validateSelfRolePanelRoles([panel], [
      { id: A, name: 'Red', permissions: '0', color: 0xff0000 },
      { id: B, name: 'Uncolored', permissions: '0', color: 0 },
    ]),
    new RegExp(`role ${B} \\("Uncolored"\\) does not have a visible Discord color`),
  );
  assert.doesNotThrow(() => validateSelfRolePanelRoles([panel], [
    { id: A, name: 'Red', permissions: '0', color: 0xff0000 },
    { id: B, name: 'Blue', permissions: '0', color: 0x0000ff },
  ]));
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
      [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: bit } }],
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
    [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: unknownBit } }],
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
    [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: 1n << 10n } }], // ViewChannel
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

test('dispatch re-check rejects a color-panel role without visible color', () => {
  const roles = new Map([
    [A, { id: A, managed: false, editable: true, color: 0, permissions: { bitfield: 0n } }],
  ]);
  const member = {
    guild: {
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: { get: (id: string) => roles.get(id) } },
    },
  };
  assert.deepEqual(validateSelfRoleDispatch(panel, member as never, [A]), {
    code: 'missing_role_color',
    reason: `color-panel role ${A} does not have a visible Discord color`,
    publicMessage: 'That color role has no visible color. Staff have been notified in the logs.',
  });
});

test('dispatch fails closed when a color-panel role omits live color data', () => {
  const roles = new Map([
    [A, { id: A, managed: false, editable: true, permissions: { bitfield: 0n } }],
  ]);
  const member = {
    guild: {
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: { get: (id: string) => roles.get(id) } },
    },
  };
  assert.equal(validateSelfRoleDispatch(panel, member as never, [A])?.code, 'missing_role_color');
});

test('dispatch fetches the authoritative role and rejects a stale safe cache before mutation', async () => {
  let fetches = 0;
  const added: string[] = [];
  const cachedRole = { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } };
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
    [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
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
    [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
    [D, { id: D, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
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
    [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
    [D, { id: D, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
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
    [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
    [D, { id: D, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
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

test('stale button and select component types are rejected before applying changes', async () => {
  for (const componentType of ['button', 'select'] as const) {
    const configuredPanel = { ...panel, mode: componentType === 'button' ? 'select' as const : 'button' as const };
    const listeners = new Map<string, (...args: never[]) => Promise<void>>();
    const audits: Array<{ code: string | null; source: string }> = [];
    let memberFetches = 0;
    let mutations = 0;
    let reply = '';
    registerSelfRoles({
      on: (event: string, listener: (...args: never[]) => Promise<void>) => listeners.set(event, listener),
    } as never, {
      panels: [configuredPanel],
      store: {
        claimAudit: async () => ({ token: 'test', generation: 1, recovered: false, desiredRoleIds: [], preMutationRoleIds: [] }),
        finishAudit: async (row: { code: string | null; source: string }) => { audits.push(row); },
      } as never,
    });
    const member = {
      id: C,
      guild: {
        id: A,
        members: {
          me: { permissions: { has: () => true } },
          fetch: async () => { memberFetches++; return member; },
        },
      },
      roles: {
        cache: new Map(),
        add: async () => { mutations++; },
        remove: async () => { mutations++; },
      },
    };
    const interaction = {
      id: `stale-${componentType}`,
      customId: componentType === 'button'
        ? selfRoleCustomId(configuredPanel.id, configuredPanel.options[0].key)
        : selfRoleCustomId(configuredPanel.id),
      user: { id: C },
      member,
      guild: member.guild,
      guildId: A,
      channelId: configuredPanel.channelId,
      message: { id: configuredPanel.messageId },
      values: componentType === 'select' ? [configuredPanel.options[0].key] : undefined,
      deferred: false,
      replied: false,
      isButton: () => componentType === 'button',
      isStringSelectMenu: () => componentType === 'select',
      deferReply: async () => {},
      editReply: async ({ content }: { content: string }) => { reply = content; },
    };

    await listeners.get(Events.InteractionCreate)!(interaction as never);

    assert.equal(memberFetches, 0, componentType);
    assert.equal(mutations, 0, componentType);
    assert.equal(audits.length, 1, componentType);
    assert.equal(audits[0]?.code, 'wrong_component_type', componentType);
    assert.equal(audits[0]?.source, componentType, componentType);
    assert.match(reply, /does not match the configured/, componentType);
  }
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
      { id: A, name: 'Red', permissions: '0', color: 0xff0000 },
      { id: B, name: 'Blue', permissions: '0', color: 0x0000ff },
      { id: C, name: '@everyone', permissions: '0', color: 0 },
    ], channels, C),
    /disallowed effective channel permission ManageMessages.*channel 333333333333333333/,
  );

  const roles = new Map([
    [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
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
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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

test('registered button replay preserves committed roles and audit after acknowledgement failure', async (t) => {
  const store = new SelfRoleStore(harness.db);
  const claimAudit = store.claimAudit.bind(store);
  const claims = t.mock.method(store, 'claimAudit', claimAudit);
  const finishAuditAndSetPanelOption = store.finishAuditAndSetPanelOption.bind(store);
  const commits = t.mock.method(store, 'finishAuditAndSetPanelOption', finishAuditAndSetPanelOption);
  const finishAudit = store.finishAudit.bind(store);
  const otherFinishes = t.mock.method(store, 'finishAudit', finishAudit);
  const listeners = new Map<string, (...args: never[]) => Promise<void>>();
  registerSelfRoles({
    on: (event: string, listener: (...args: never[]) => Promise<void>) => listeners.set(event, listener),
  } as never, { panels: [panel], store });

  const roleState = new Set<string>();
  const mutations: Array<{ operation: string; roleId: string; reason: string }> = [];
  const fetchArgs: unknown[] = [];
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
  ]));
  const member = {
    id: C,
    guild: {
      id: A,
      members: {
        me: { permissions: { has: () => true } },
        fetch: async (args: unknown) => {
          fetchArgs.push(args);
          return { ...member, roles: { ...member.roles, cache: new Map([...roleState].map((id) => [id, { id }])) } };
        },
      },
      roles: { fetch: async () => roles },
      channels: { fetch: async () => new Map() },
    },
    roles: {
      cache: new Map(),
      add: async (roleId: string, reason: string) => {
        mutations.push({ operation: 'add', roleId, reason });
        roleState.add(roleId);
      },
      remove: async (roleId: string, reason: string) => {
        mutations.push({ operation: 'remove', roleId, reason });
        roleState.delete(roleId);
      },
    },
  };
  const eventId = '444444444444444444';
  const committedState = async () => ({
    roleIds: [...roleState],
    audits: await harness.db.prepare('SELECT * FROM self_role_audit WHERE event_id = ?')
      .all<Record<string, unknown>>(eventId),
    panel: await harness.db.prepare(
      `SELECT latest_event_id, latest_event_order, latest_option_key, target_committed
         FROM self_role_panel_claims WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
    ).get<Record<string, unknown>>(A, C, panel.id),
  });
  const replies: Array<{ content: string; state: Awaited<ReturnType<typeof committedState>> }> = [];
  let deferrals = 0;
  let freshReplies = 0;
  // Discord redelivers the same event as a fresh object: same id, unacknowledged.
  // Each delivery acknowledges once; a second acknowledgement on the same object
  // rejects (InteractionAlreadyReplied) before any store work, as in Discord.js.
  const makeInteraction = () => {
    const delivery = {
      id: eventId,
      customId: selfRoleCustomId(panel.id, 'red'),
      user: { id: C },
      member,
      guild: member.guild,
      guildId: A,
      channelId: panel.channelId,
      message: { id: panel.messageId },
      deferred: false,
      replied: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      deferReply: async () => {
        if (delivery.deferred || delivery.replied) throw new Error('InteractionAlreadyReplied');
        deferrals++;
        delivery.deferred = true;
      },
      editReply: async ({ content }: { content: string }) => {
        // Observe the real transaction before failing both the acknowledgement and fallback.
        replies.push({ content, state: await committedState() });
        throw new Error('fixture acknowledgement unavailable');
      },
      reply: async () => { freshReplies++; throw new Error('fixture acknowledgement unavailable'); },
    };
    return delivery;
  };
  const dispatch = listeners.get(Events.InteractionCreate)!;

  const firstDelivery = makeInteraction();
  await assert.doesNotReject(() => dispatch(firstDelivery as never));
  const committed = await committedState();
  assert.equal(committed.audits.length, 1);
  const audit = committed.audits[0]!;
  assert.equal(audit.outcome, 'assigned');
  assert.equal(audit.code, null);
  assert.equal(audit.reason, null);
  assert.equal(audit.desired_role_ids, JSON.stringify([A]));
  assert.equal(audit.pre_mutation_role_ids, '[]');
  assert.equal(audit.added_role_ids, JSON.stringify([A]));
  assert.equal(audit.attempted_added_role_ids, JSON.stringify([A]));
  for (const field of [
    'removed_role_ids', 'attempted_removed_role_ids',
    'compensated_added_role_ids', 'compensated_removed_role_ids',
    'unresolved_added_role_ids', 'unresolved_removed_role_ids',
  ]) assert.equal(audit[field], '[]', field);
  assert.equal(audit.processing_expires_at, null);
  assert.deepEqual(committed.roleIds, [A]);
  assert.equal(committed.panel?.latest_event_id, eventId);
  assert.equal(committed.panel?.latest_option_key, 'red');
  assert.equal(committed.panel?.target_committed, true);

  // Forced fetch now sees the added role: replay would toggle it off without final-audit dedupe.
  // Redelivered as a fresh object carrying the same event ID, as Discord redelivers
  // the same event; the first object stays acknowledged and is never reused.
  await assert.doesNotReject(() => dispatch(makeInteraction() as never));

  assert.deepEqual(await committedState(), committed);
  assert.deepEqual(mutations, [{ operation: 'add', roleId: A, reason: `TWO self-role panel ${panel.id}` }]);
  assert.equal(commits.mock.callCount(), 1);
  assert.equal(otherFinishes.mock.callCount(), 0);
  assert.equal(claims.mock.callCount(), 2);
  assert.equal(await claims.mock.calls[1]!.result, null);
  assert.equal(deferrals, 2);
  assert.equal(freshReplies, 0);
  assert.equal(fetchArgs.length, 2);
  assert.ok(fetchArgs.every((args) => JSON.stringify(args) === JSON.stringify({ user: C, force: true })));
  assert.deepEqual(replies.map(({ content }) => content), [
    'Role added.', 'The role action failed. Please try again.',
    'This role request was already handled.', 'The role action failed. Please try again.',
  ]);
  for (const reply of replies) assert.deepEqual(reply.state, committed, reply.content);
});

test('recovered button converges to persisted desired roles after the first add succeeded', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const roleState = new Set([A]);
  const removed: string[] = [];
  const roles = new Map([
    [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
    [B, { id: B, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
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
    [A, { id: A, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } }],
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
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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

test('an older event cannot replace a migrated legacy panel claim with a null event order', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const newerEventId = '222222222222222222';
  await harness.db.prepare(
    `INSERT INTO self_role_panel_claims
       (guild_id, member_id, panel_id, claim_token, claim_generation, processing_expires_at,
        latest_event_id, latest_option_key, latest_event_order)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
  ).run(A, C, panel.id, 'legacy', now.toISOString(), newerEventId, 'blue');

  now = new Date('2026-09-09T00:00:01.001Z');
  const olderEventId = '111111111111111111';
  const olderOrder = `${((BigInt(olderEventId) >> 22n) + 1_420_070_400_000n).toString().padStart(13, '0')}:${olderEventId.padStart(20, '0')}`;
  const claim = await store.claimPanel(A, C, panel.id, olderEventId, olderOrder);

  assert.ok(claim?.superseded);
  assert.equal(claim.latestEventId, newerEventId);
  assert.equal(claim.latestOptionKey, 'blue');
  const stored = await harness.db.prepare(
    `SELECT latest_event_id, latest_option_key, latest_event_order
       FROM self_role_panel_claims WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
  ).get<Record<string, unknown>>(A, C, panel.id);
  assert.deepEqual({ ...stored }, {
    latest_event_id: newerEventId,
    latest_option_key: 'blue',
    latest_event_order: `${((BigInt(newerEventId) >> 22n) + 1_420_070_400_000n).toString().padStart(13, '0')}:${newerEventId.padStart(20, '0')}`,
  });
});

test('panel chronology advances without publishing an uncommitted option', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const first = await store.claimPanel(A, C, panel.id, 'first-red', '0000000000001:000001');
  assert.ok(first && !first.superseded);
  assert.equal(first.latestOptionKey, null);
  assert.equal(await store.setPanelClaimOption(first, 'red'), true);
  await store.releasePanelClaim(first);

  now = new Date('2026-09-09T00:00:00.001Z');
  const second = await store.claimPanel(A, C, panel.id, 'second-blue', '0000000000002:000001');
  assert.ok(second && !second.superseded);
  assert.equal(second.latestEventId, 'second-blue');
  assert.equal(second.latestOptionKey, 'red');
  const storedBeforeCommit = await harness.db.prepare(
    `SELECT latest_event_id, latest_option_key FROM self_role_panel_claims
      WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
  ).get<Record<string, unknown>>(A, C, panel.id);
  assert.deepEqual({ ...storedBeforeCommit }, { latest_event_id: 'second-blue', latest_option_key: 'red' });

  assert.equal(await store.setPanelClaimOption(first, 'blue'), false);
  assert.equal(await store.setPanelClaimOption(second, 'blue'), true);
  const storedAfterCommit = await harness.db.prepare(
    `SELECT latest_event_id, latest_option_key FROM self_role_panel_claims
      WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
  ).get<Record<string, unknown>>(A, C, panel.id);
  assert.deepEqual({ ...storedAfterCommit }, { latest_event_id: 'second-blue', latest_option_key: 'blue' });
});

test('first exclusive dispatch seeds the committed target from authoritative roles', async () => {
  const store = new SelfRoleStore(harness.db);
  const roleState = new Set([A]);
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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
      remove: async (roleId: string) => { roleState.delete(roleId); },
      add: async (roleId: string) => { roleState.add(roleId); },
    },
  };

  await applyRoleDelta({
    panel, member: member as never, source: 'select', sourceId: panel.messageId,
    eventId: 'initial-clear', optionKey: null, roleId: null, operation: 'replace',
    addRoleIds: [], removeRoleIds: [], desiredRoleIds: [], deps: { panels: [panel], store },
  });

  assert.deepEqual([...roleState], []);
  const stored = await harness.db.prepare(
    `SELECT latest_option_key, target_committed FROM self_role_panel_claims
      WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
  ).get<Record<string, unknown>>(A, C, panel.id);
  assert.equal(stored?.latest_option_key, null);
  assert.equal(Boolean(stored?.target_committed), true);
});

test('an older delayed exclusive selection cannot overwrite a newer completed selection', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const roleState = new Set<string>();
  let releaseOlder!: () => void;
  const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve; });
  let olderStarted!: () => void;
  const started = new Promise<void>((resolve) => { olderStarted = resolve; });
  let blockOlder = true;
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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
          if (roleId === A && blockOlder) {
            olderStarted();
            await olderBlocked;
          }
          roleState.add(roleId);
        },
      },
    };
    return member;
  };

  const older = applyRoleDelta({
    panel, member: makeMember() as never, source: 'button', sourceId: panel.messageId,
    eventId: 'older-red', eventOrder: '0000000000001:000001', optionKey: 'red', roleId: A,
    operation: 'replace', addRoleIds: [], removeRoleIds: [], requestedOptionKey: 'red',
    deps: { panels: [panel], store },
  });
  await started;
  now = new Date('2026-09-09T00:00:01.001Z');
  blockOlder = false;
  await applyRoleDelta({
    panel, member: makeMember() as never, source: 'button', sourceId: panel.messageId,
    eventId: 'newer-blue', eventOrder: '0000000000002:000001', optionKey: 'blue', roleId: B,
    operation: 'replace', addRoleIds: [], removeRoleIds: [], requestedOptionKey: 'blue',
    deps: { panels: [panel], store },
  });
  releaseOlder();
  await older;

  assert.deepEqual([...roleState], [B]);
  const olderAudit = await harness.db.prepare(
    `SELECT outcome, code FROM self_role_audit WHERE event_id = ?`,
  ).get<{ outcome: string; code: string | null }>('older-red');
  assert.deepEqual({ ...olderAudit }, { outcome: 'rejected', code: 'superseded_by_later_event' });
});

test('a stale delayed clear restores a newer accepted exclusive selection', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const roleState = new Set([A]);
  let releaseOlder!: () => void;
  const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve; });
  let olderStarted!: () => void;
  const started = new Promise<void>((resolve) => { olderStarted = resolve; });
  let blockOlder = true;
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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
        remove: async (roleId: string) => {
          if (roleId === A && blockOlder) {
            olderStarted();
            await olderBlocked;
          }
          roleState.delete(roleId);
        },
        add: async (roleId: string) => { roleState.add(roleId); },
      },
    };
    return member;
  };

  const older = applyRoleDelta({
    panel, member: makeMember() as never, source: 'select', sourceId: panel.messageId,
    eventId: 'older-clear', eventOrder: '0000000000001:000001', optionKey: null, roleId: null,
    operation: 'replace', addRoleIds: [], removeRoleIds: [], desiredRoleIds: [],
    deps: { panels: [panel], store },
  });
  await started;
  now = new Date('2026-09-09T00:00:33.001Z');
  blockOlder = false;
  await applyRoleDelta({
    panel, member: makeMember() as never, source: 'select', sourceId: panel.messageId,
    eventId: 'newer-red', eventOrder: '0000000000002:000001', optionKey: 'red', roleId: A,
    operation: 'replace', addRoleIds: [], removeRoleIds: [], desiredRoleIds: [A],
    deps: { panels: [panel], store },
  });
  releaseOlder();
  await older;

  assert.deepEqual([...roleState], [A]);
  const olderAudit = await harness.db.prepare(
    `SELECT outcome, code FROM self_role_audit WHERE event_id = ?`,
  ).get<{ outcome: string; code: string | null }>('older-clear');
  assert.deepEqual({ ...olderAudit }, { outcome: 'rejected', code: 'superseded_by_later_event' });
});

test('failed stale reconciliation leaves exact unresolved audit evidence', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const roleState = new Set([A]);
  let releaseOlder!: () => void;
  const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve; });
  let olderStarted!: () => void;
  const started = new Promise<void>((resolve) => { olderStarted = resolve; });
  let blockOlder = true;
  let failRepairAdd = false;
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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
        remove: async (roleId: string) => {
          if (roleId === A && blockOlder) {
            olderStarted();
            await olderBlocked;
          }
          roleState.delete(roleId);
        },
        add: async (roleId: string, reason: string) => {
          if (failRepairAdd && roleId === A && reason.includes('stale reconcile')) throw new Error('repair add failed');
          roleState.add(roleId);
        },
      },
    };
    return member;
  };

  const older = applyRoleDelta({
    panel, member: makeMember() as never, source: 'select', sourceId: panel.messageId,
    eventId: 'failed-repair-clear', eventOrder: '0000000000001:000001', optionKey: null, roleId: null,
    operation: 'replace', addRoleIds: [], removeRoleIds: [], desiredRoleIds: [],
    deps: { panels: [panel], store },
  });
  await started;
  now = new Date('2026-09-09T00:00:33.001Z');
  blockOlder = false;
  await applyRoleDelta({
    panel, member: makeMember() as never, source: 'select', sourceId: panel.messageId,
    eventId: 'failed-repair-red', eventOrder: '0000000000002:000001', optionKey: 'red', roleId: A,
    operation: 'replace', addRoleIds: [], removeRoleIds: [], desiredRoleIds: [A],
    deps: { panels: [panel], store },
  });
  failRepairAdd = true;
  releaseOlder();
  await older;

  assert.deepEqual([...roleState], []);
  const repairAudit = await harness.db.prepare(
    `SELECT outcome, code, unresolved_added_role_ids, unresolved_removed_role_ids
       FROM self_role_audit WHERE event_id LIKE ?`,
  ).get<Record<string, unknown>>('stale-reconcile:failed-repair-clear:%');
  assert.deepEqual({ ...repairAudit }, {
    outcome: 'rejected',
    code: 'stale_reconcile_failed',
    unresolved_added_role_ids: '[]',
    unresolved_removed_role_ids: JSON.stringify([A]),
  });
});

test('a rejected successor never becomes the stale-repair target', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const roleState = new Set([A]);
  let releaseOlder!: () => void;
  const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve; });
  let olderStarted!: () => void;
  const started = new Promise<void>((resolve) => { olderStarted = resolve; });
  let blockOlder = true;
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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
        remove: async (roleId: string) => {
          if (roleId === A && blockOlder) {
            olderStarted();
            await olderBlocked;
          }
          roleState.delete(roleId);
        },
        add: async (roleId: string) => { roleState.add(roleId); },
      },
    };
    return member;
  };

  const seed = await store.claimPanel(A, C, panel.id, 'seed-red', '0000000000000:000001');
  assert.ok(seed && !seed.superseded);
  assert.equal(await store.setPanelClaimOption(seed, 'red'), true);
  await store.releasePanelClaim(seed);

  now = new Date('2026-09-09T00:00:00.001Z');
  const older = applyRoleDelta({
    panel, member: makeMember() as never, source: 'select', sourceId: panel.messageId,
    eventId: 'rejected-target-clear', eventOrder: '0000000000001:000001', optionKey: null, roleId: null,
    operation: 'replace', addRoleIds: [], removeRoleIds: [], desiredRoleIds: [],
    deps: { panels: [panel], store },
  });
  await started;
  now = new Date('2026-09-09T00:00:33.001Z');
  blockOlder = false;
  roles.set(B, { id: B, managed: false, editable: true, color: 1, permissions: { bitfield: 8n } });
  await applyRoleDelta({
    panel, member: makeMember() as never, source: 'select', sourceId: panel.messageId,
    eventId: 'rejected-target-blue', eventOrder: '0000000000002:000001', optionKey: 'blue', roleId: B,
    operation: 'replace', addRoleIds: [], removeRoleIds: [], desiredRoleIds: [B],
    deps: { panels: [panel], store },
  });
  roles.set(B, { id: B, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } });
  releaseOlder();
  await older;

  assert.deepEqual([...roleState], [A]);
  const blueAudit = await harness.db.prepare(
    `SELECT outcome, code FROM self_role_audit WHERE event_id = ?`,
  ).get<Record<string, unknown>>('rejected-target-blue');
  assert.deepEqual({ ...blueAudit }, { outcome: 'rejected', code: 'disallowed_role_permission' });
  const stored = await harness.db.prepare(
    `SELECT latest_event_id, latest_option_key FROM self_role_panel_claims
      WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
  ).get<Record<string, unknown>>(A, C, panel.id);
  assert.deepEqual({ ...stored }, { latest_event_id: 'rejected-target-blue', latest_option_key: 'red' });
});

test('stale repair removes an unsafe divergent role while restoring only a safe target', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const store = new SelfRoleStore(harness.db, { now: () => now, leaseMs: 1_000 });
  const roleState = new Set([A]);
  let releaseOlder!: () => void;
  const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve; });
  let olderStarted!: () => void;
  const started = new Promise<void>((resolve) => { olderStarted = resolve; });
  let blockOlder = true;
  const roles = new Map(panel.options.map((option) => [
    option.roleId,
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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
        remove: async (roleId: string) => {
          if (roleId === A && blockOlder) {
            olderStarted();
            await olderBlocked;
          }
          roleState.delete(roleId);
        },
        add: async (roleId: string) => { roleState.add(roleId); },
      },
    };
    return member;
  };

  const seed = await store.claimPanel(A, C, panel.id, 'unsafe-seed', '0000000000000:000001');
  assert.ok(seed && !seed.superseded);
  assert.equal(await store.setPanelClaimOption(seed, 'red'), true);
  await store.releasePanelClaim(seed);
  const older = applyRoleDelta({
    panel, member: makeMember() as never, source: 'select', sourceId: panel.messageId,
    eventId: 'unsafe-clear', eventOrder: '0000000000001:000001', optionKey: null, roleId: null,
    operation: 'replace', addRoleIds: [], removeRoleIds: [], desiredRoleIds: [], deps: { panels: [panel], store },
  });
  await started;
  now = new Date('2026-09-09T00:00:33.001Z');
  blockOlder = false;
  roles.set(B, { id: B, managed: false, editable: true, color: 1, permissions: { bitfield: 8n } });
  roleState.add(B);
  releaseOlder();
  await older;

  assert.deepEqual([...roleState], [A]);
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
    { id: option.roleId, managed: false, editable: true, color: 1, permissions: { bitfield: 0n } },
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
