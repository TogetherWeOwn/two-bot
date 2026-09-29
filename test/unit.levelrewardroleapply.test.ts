/**
 * TOG-4444: the staging reward-role apply operation, by execution against a
 * fake port. The port records every call with the guild it was scoped to, so
 * "zero live-guild writes" is asserted on the call log, not on the source.
 *
 * The CLI, the audit row and the database guard are in
 * test/e2e.levelrewardroleapply.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MANAGE_ROLES_BIT,
  RewardRoleApplyError,
  applyRewardRole,
  assertStagingGuild,
  effectivePermissions,
  precheckGrantEligibility,
  selectMappedReward,
  type RewardRolePort,
} from '../src/leveling/rewardRoleApply.ts';
import type { PartialRole } from '../src/staging/provision.ts';
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const BOT_ID = '900000000000000001';
const MEMBER = '900000000000000500';
const OTHER_ROLE = '900000000000000030';
const ROLES = (
  JSON.parse(readFileSync(new URL('./fixtures/mee6-guild-roles.json', import.meta.url), 'utf8')) as {
    roles: PartialRole[];
  }
).roles;

/** The probe report shape, as `levels:roles:probe --report` writes it. */
function report(overrides: Record<string, unknown> = {}) {
  return {
    reportVersion: 1,
    guildId: TWO_STAGING_GUILD_ID,
    mode: 'dry-run',
    mapped: [
      { level: 10, roleId: '900000000000000021', roleName: 'Level Ten', renamedFrom: 'Level 10', position: 20 },
      { level: 5, roleId: '900000000000000020', roleName: 'Level 5', position: 10 },
    ],
    ...overrides,
  };
}

interface Call {
  op: 'read' | 'grant' | 'revoke';
  guildId: string;
  memberId: string;
  roleId?: string;
}

/** A fake Discord member store scoped to one guild, logging every call. */
function fakePort(
  guildId: string,
  initial: string[] | null,
  faults: { grantDoesNotLand?: boolean; revokeDoesNotLand?: boolean } = {},
) {
  let roles = initial === null ? null : [...initial];
  const calls: Call[] = [];
  const port: RewardRolePort = {
    guildId,
    async memberRoles(memberId) {
      calls.push({ op: 'read', guildId, memberId });
      return roles === null ? null : [...roles];
    },
    async grantRole(memberId, roleId) {
      calls.push({ op: 'grant', guildId, memberId, roleId });
      if (!faults.grantDoesNotLand && roles && !roles.includes(roleId)) roles.push(roleId);
    },
    async revokeRole(memberId, roleId) {
      calls.push({ op: 'revoke', guildId, memberId, roleId });
      if (!faults.revokeDoesNotLand && roles) roles = roles.filter((id) => id !== roleId);
    },
  };
  return { port, calls, current: () => roles };
}

function run(port: RewardRolePort, events: string[] = []) {
  return applyRewardRole(port, {
    memberId: MEMBER,
    target: selectMappedReward(report()),
    roles: ROLES,
    botId: BOT_ID,
    ownerId: null,
    logger: (event) => events.push(event),
  });
}

test('the staging guild passes; the live guild and anything else are refused with exit 2', () => {
  assertStagingGuild(TWO_STAGING_GUILD_ID);
  assert.throws(
    () => assertStagingGuild(LIVE_GUILD_ID),
    (err: unknown) =>
      err instanceof RewardRoleApplyError && err.exitCode === 2 && /Refusing live guild/.test(err.message),
  );
  assert.throws(() => assertStagingGuild(''), /Unknown guild \(empty\)/);
  assert.throws(() => assertStagingGuild('123'), /Unknown guild 123/);
});

test('the reward comes from the probe artifact: lowest mapped level by default, or the named level', () => {
  assert.equal(selectMappedReward(report()).roleId, '900000000000000020');
  assert.equal(selectMappedReward(report(), 10).roleId, '900000000000000021');
  assert.throws(() => selectMappedReward(report(), 15), /Level 15 has no mapped reward.*mapped: 5, 10/);
});

test('a report for another guild, a non-report, or malformed rows are refused', () => {
  assert.throws(() => selectMappedReward(report({ guildId: LIVE_GUILD_ID })), /not the TWO Staging guild/);
  assert.throws(() => selectMappedReward({ nope: true }), /not a probe mapping artifact/);
  assert.throws(() => selectMappedReward(null), /not a probe mapping artifact/);
  assert.throws(
    () => selectMappedReward(report({ mapped: [{ level: 5, roleId: 7 }] })),
    /malformed mapped rows/,
  );
  assert.throws(() => selectMappedReward(report({ mapped: [] })), /maps zero rewards/);
});

test('hierarchy is re-checked by id at exercise time and fails closed', () => {
  assert.equal(
    precheckGrantEligibility({ roles: ROLES, botId: BOT_ID, ownerId: null, targetRoleId: '900000000000000020' })
      .botPosition,
    50,
  );
  // Staff sits at 80, above the bot at 50.
  assert.throws(
    () => precheckGrantEligibility({ roles: ROLES, botId: BOT_ID, ownerId: null, targetRoleId: '900000000000000023' }),
    /at or above the bot's own role/,
  );
  assert.throws(
    () => precheckGrantEligibility({ roles: ROLES, botId: BOT_ID, ownerId: null, targetRoleId: '900000000000000022' }),
    /managed by an integration/,
  );
  assert.throws(
    () => precheckGrantEligibility({ roles: ROLES, botId: BOT_ID, ownerId: null, targetRoleId: '900000000000000099' }),
    /no longer exists/,
  );
  assert.throws(
    () => precheckGrantEligibility({ roles: ROLES, botId: '900000000000000777', ownerId: null, targetRoleId: '900000000000000020' }),
    /has no managed role/,
  );
  // The guild owner bypasses hierarchy, as Discord does.
  assert.equal(
    precheckGrantEligibility({ roles: ROLES, botId: BOT_ID, ownerId: BOT_ID, targetRoleId: '900000000000000023' })
      .ownerBypass,
    true,
  );
});

test('Manage Roles is read from the roles the bot holds, and a bad bitfield grants nothing', () => {
  const roles: PartialRole[] = [
    { id: 'e', name: '@everyone', position: 0, managed: false, permissions: '0' },
    { id: 'b', name: 'bot', position: 5, managed: true, permissions: String(MANAGE_ROLES_BIT) },
    { id: 'x', name: 'junk', position: 6, managed: false, permissions: 'not-a-number' },
  ] as PartialRole[];
  assert.equal(effectivePermissions(roles, ['b'], 'e') & MANAGE_ROLES_BIT, MANAGE_ROLES_BIT);
  assert.equal(effectivePermissions(roles, [], 'e') & MANAGE_ROLES_BIT, 0n);
  assert.equal(effectivePermissions(roles, ['x'], 'e'), 0n);
});

test('grant, positive readback, revoke, negative readback - and the member is left as found', async () => {
  const fake = fakePort(TWO_STAGING_GUILD_ID, [OTHER_ROLE]);
  const events: string[] = [];
  const summary = await run(fake.port, events);

  assert.deepEqual(summary, {
    guildId: TWO_STAGING_GUILD_ID,
    memberId: MEMBER,
    level: 5,
    roleId: '900000000000000020',
    roleName: 'Level 5',
    alreadyHeld: false,
    positiveReadback: true,
    negativeReadback: true,
    residueRestored: true,
  });
  assert.deepEqual(fake.current(), [OTHER_ROLE]);
  assert.deepEqual(
    fake.calls.map((c) => c.op),
    ['read', 'grant', 'read', 'revoke', 'read'],
  );
  assert.deepEqual(events, [
    'level_reward_role_precheck',
    'level_reward_role_grant',
    'level_reward_role_positive_readback',
    'level_reward_role_revoke',
    'level_reward_role_negative_readback',
    'level_reward_role_complete',
  ]);
  // Exactly one member, one role, one guild - and it is not the live one.
  assert.ok(fake.calls.every((c) => c.guildId === TWO_STAGING_GUILD_ID && c.memberId === MEMBER));
  assert.ok(fake.calls.every((c) => c.guildId !== LIVE_GUILD_ID));
  assert.equal(fake.calls.filter((c) => c.op === 'grant').length, 1);
});

test('a re-run on a member already holding the role skips the grant and still ends clean', async () => {
  const fake = fakePort(TWO_STAGING_GUILD_ID, [OTHER_ROLE, '900000000000000020']);
  const events: string[] = [];
  const summary = await run(fake.port, events);
  assert.equal(summary.alreadyHeld, true);
  assert.equal(summary.negativeReadback, true);
  assert.ok(events.includes('level_reward_role_already_held'));
  assert.equal(fake.calls.filter((c) => c.op === 'grant').length, 0);
  assert.deepEqual(fake.current(), [OTHER_ROLE]);

  // And again: the invariant holds, so the second run is an ordinary run.
  const again = await run(fake.port);
  assert.equal(again.alreadyHeld, false);
  assert.deepEqual(fake.current(), [OTHER_ROLE]);
});

test('a port scoped to the live guild is refused before any call is made', async () => {
  const fake = fakePort(LIVE_GUILD_ID, [OTHER_ROLE]);
  await assert.rejects(() => run(fake.port), /Refusing live guild/);
  assert.equal(fake.calls.length, 0);
});

test('a hierarchy gap is refused before any call is made', async () => {
  const fake = fakePort(TWO_STAGING_GUILD_ID, [OTHER_ROLE]);
  await assert.rejects(
    () =>
      applyRewardRole(fake.port, {
        memberId: MEMBER,
        target: { level: 25, roleId: '900000000000000023', roleName: 'Staff', position: 80 },
        roles: ROLES,
        botId: BOT_ID,
        ownerId: null,
      }),
    /at or above the bot's own role/,
  );
  assert.equal(fake.calls.length, 0);
});

test('a missing member is an error, never an invitation', async () => {
  const fake = fakePort(TWO_STAGING_GUILD_ID, null);
  await assert.rejects(() => run(fake.port), /is not in the staging guild/);
  assert.deepEqual(
    fake.calls.map((c) => c.op),
    ['read'],
  );
});

test('a member id that is not a snowflake is refused before any call', async () => {
  const fake = fakePort(TWO_STAGING_GUILD_ID, []);
  await assert.rejects(
    () =>
      applyRewardRole(fake.port, {
        memberId: 'someone',
        target: selectMappedReward(report()),
        roles: ROLES,
        botId: BOT_ID,
        ownerId: null,
      }),
    /is not a Discord user id/,
  );
  assert.equal(fake.calls.length, 0);
});

test('a grant that does not read back stops before the revoke', async () => {
  const fake = fakePort(TWO_STAGING_GUILD_ID, [OTHER_ROLE], { grantDoesNotLand: true });
  await assert.rejects(() => run(fake.port), /did not read back.*Stopping before the revoke/);
  assert.equal(fake.calls.filter((c) => c.op === 'revoke').length, 0);
  assert.deepEqual(fake.current(), [OTHER_ROLE]);
});

test('a revoke that does not read back fails loudly and says the role may remain', async () => {
  const fake = fakePort(TWO_STAGING_GUILD_ID, [], { revokeDoesNotLand: true });
  await assert.rejects(() => run(fake.port), /may still be on the member/);
});

test('a report with no guild at all is refused, naming (missing)', () => {
  const { guildId, ...rest } = report();
  void guildId;
  assert.throws(
    () => selectMappedReward(rest),
    (err: unknown) =>
      err instanceof RewardRoleApplyError &&
      err.exitCode === 2 &&
      /\(missing\)/.test(err.message) &&
      /not the TWO Staging guild/.test(err.message),
  );
});

test('same-level mapped rewards break ties by role id, deterministically', () => {
  const tied = report({
    mapped: [
      { level: 5, roleId: '900000000000000024', roleName: 'Level 5 Alt', position: 12 },
      { level: 5, roleId: '900000000000000020', roleName: 'Level 5', position: 10 },
    ],
  });
  assert.equal(selectMappedReward(tied).roleId, '900000000000000020');
  assert.equal(selectMappedReward(tied, 5).roleId, '900000000000000020');
});

test('a role with no permission bitfield contributes nothing to the effective mask', () => {
  const roles: PartialRole[] = [
    { id: 'e', name: '@everyone', position: 0, managed: false, permissions: '0' },
    { id: 'b', name: 'bot', position: 5, managed: true },
  ] as PartialRole[];
  assert.equal(effectivePermissions(roles, ['b'], 'e'), 0n);
});

test('the logger is optional: a run without one still grants, verifies and cleans up', async () => {
  const fake = fakePort(TWO_STAGING_GUILD_ID, [OTHER_ROLE]);
  const summary = await applyRewardRole(fake.port, {
    memberId: MEMBER,
    target: selectMappedReward(report()),
    roles: ROLES,
    botId: BOT_ID,
    ownerId: null,
  });
  assert.equal(summary.alreadyHeld, false);
  assert.equal(summary.residueRestored, true);
  assert.deepEqual(fake.current(), [OTHER_ROLE]);
});

test('residue drift is reported, not hidden: a role lost mid-run reads back as not restored', async () => {
  // A concurrent change drops the member's other role between grant and final
  // readback: the revoke still verifies, but the summary says residue is unrestored.
  let roles = [OTHER_ROLE];
  const calls: Call[] = [];
  const port: RewardRolePort = {
    guildId: TWO_STAGING_GUILD_ID,
    async memberRoles(memberId) {
      calls.push({ op: 'read', guildId: TWO_STAGING_GUILD_ID, memberId });
      return [...roles];
    },
    async grantRole(memberId, roleId) {
      calls.push({ op: 'grant', guildId: TWO_STAGING_GUILD_ID, memberId, roleId });
      if (!roles.includes(roleId)) roles.push(roleId);
    },
    async revokeRole(memberId, roleId) {
      calls.push({ op: 'revoke', guildId: TWO_STAGING_GUILD_ID, memberId, roleId });
      // The revoke lands, but the member's unrelated role vanished meanwhile.
      roles = roles.filter((id) => id !== roleId && id !== OTHER_ROLE);
    },
  };
  const summary = await applyRewardRole(port, {
    memberId: MEMBER,
    target: selectMappedReward(report()),
    roles: ROLES,
    botId: BOT_ID,
    ownerId: null,
  });
  assert.equal(summary.positiveReadback, true);
  assert.equal(summary.negativeReadback, true);
  assert.equal(summary.residueRestored, false);
  assert.ok(calls.every((c) => c.guildId === TWO_STAGING_GUILD_ID));
  assert.ok(!calls.some((c) => c.guildId === LIVE_GUILD_ID));
});

test('a dry run resolves the target, pre-checks and reads once - zero grants, zero revokes', async () => {
  const fake = fakePort(TWO_STAGING_GUILD_ID, [OTHER_ROLE]);
  // The script's dry-run ordering, without the script's Discord or database:
  // pick the reward from the probe artifact, re-check hierarchy, read the member.
  const target = selectMappedReward(report());
  const eligibility = precheckGrantEligibility({
    roles: ROLES,
    botId: BOT_ID,
    ownerId: null,
    targetRoleId: target.roleId,
  });
  assert.equal(eligibility.ownerBypass, false);
  assert.deepEqual(await fake.port.memberRoles(MEMBER), [OTHER_ROLE]);
  assert.deepEqual(fake.current(), [OTHER_ROLE]);
  assert.deepEqual(fake.calls.map((c) => c.op), ['read']);
  assert.ok(fake.calls.every((c) => c.guildId === TWO_STAGING_GUILD_ID));
  assert.ok(!fake.calls.some((c) => c.guildId === LIVE_GUILD_ID));
});
