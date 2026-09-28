/**
 * The staging-only reward-role apply operation (TOG-1641, TOG-4444).
 *
 * The dry-run probe (`rewardImport.ts`) answers "which rewards would land".
 * This module is the other half: grant one mapped reward role to one
 * disposable staging member, prove it landed, take it back off, and prove it
 * is gone - leaving no residue either way.
 *
 * It is pure the way `rewardImport.ts` is pure: data in, decisions out, no
 * database and no network. The Discord calls arrive through `RewardRolePort`,
 * which is already scoped to a single guild, and the guild is asserted to be
 * the staging guild before anything else happens - so a live-guild write is
 * not a thing this module can express, not a thing it promises not to do.
 *
 * Fail-closed throughout: hierarchy and permission gaps throw before any
 * write; a grant the readback cannot see throws; a revoke the readback still
 * sees throws louder, because that one may have left a role on a member.
 */
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../staging/spec.ts';
import type { PartialRole } from '../staging/provision.ts';

/** Thrown for every refusal and every unverified step. Never a partial run. */
export class RewardRoleApplyError extends Error {
  /** 2 for usage/refusal (before any write), 1 for an operational failure. */
  readonly exitCode: 2 | 1;

  constructor(message: string, exitCode: 2 | 1 = 1) {
    super(message);
    this.name = 'RewardRoleApplyError';
    this.exitCode = exitCode;
  }
}

/**
 * The one guild this operation may touch. Anything else - the live guild, a
 * typo, an empty string - throws before a file, a database or the network is
 * opened. The caller runs this first for the same reason the probe does: a
 * mistyped guild must fail on the guild rather than on a connection string.
 */
export function assertStagingGuild(guildId: string): void {
  if (guildId === TWO_STAGING_GUILD_ID) return;
  if (guildId === LIVE_GUILD_ID) {
    throw new RewardRoleApplyError(
      `Refusing live guild ${LIVE_GUILD_ID}. This operation is staging-only ` +
        `(guild ${TWO_STAGING_GUILD_ID}); there is no live override.`,
      2,
    );
  }
  throw new RewardRoleApplyError(
    `Unknown guild ${guildId || '(empty)'}. This operation runs only against ` +
      `the TWO Staging guild (${TWO_STAGING_GUILD_ID}).`,
    2,
  );
}

export interface RewardRoleTarget {
  level: number;
  roleId: string;
  roleName: string;
  position: number;
}

interface ProbeReportShape {
  reportVersion?: unknown;
  guildId?: unknown;
  mode?: unknown;
  mapped?: unknown;
}

/**
 * Read the probe's mapping output artifact and pick the one reward to
 * exercise. The role id comes from this artifact, never from a flag or a
 * literal - which is what makes "not hardcoded" a property of the call
 * rather than a promise in a comment.
 *
 * With no `level` the lowest mapped level wins: the cheapest reward is the
 * one to prove the path with. A level with no mapped reward throws rather
 * than falling back to another, because silently exercising a different
 * reward than the operator named is how evidence stops meaning anything.
 */
export function selectMappedReward(report: unknown, level?: number): RewardRoleTarget {
  const shape = report as ProbeReportShape | null;
  if (!shape || typeof shape !== 'object' || !Array.isArray(shape.mapped)) {
    throw new RewardRoleApplyError(
      'The --report file is not a probe mapping artifact: it needs a "mapped" array. ' +
        'Generate it with `npm run levels:roles:probe -- --report <path>`.',
      2,
    );
  }
  if (shape.guildId !== TWO_STAGING_GUILD_ID) {
    throw new RewardRoleApplyError(
      `The report is for guild ${String(shape.guildId ?? '(missing)')}, not the TWO Staging ` +
        `guild (${TWO_STAGING_GUILD_ID}). Regenerate it against staging.`,
      2,
    );
  }
  const mapped = (shape.mapped as Array<Partial<RewardRoleTarget>>).filter(
    (row): row is RewardRoleTarget =>
      !!row &&
      Number.isInteger(row.level) &&
      typeof row.roleId === 'string' &&
      typeof row.roleName === 'string' &&
      Number.isInteger(row.position),
  );
  if (mapped.length !== (shape.mapped as unknown[]).length) {
    throw new RewardRoleApplyError('The report has malformed mapped rows; regenerate it with the probe.', 2);
  }
  if (mapped.length === 0) {
    throw new RewardRoleApplyError('The report maps zero rewards: there is nothing to exercise.', 1);
  }
  const ordered = [...mapped].sort((a, b) => a.level - b.level || a.roleId.localeCompare(b.roleId));
  if (level === undefined) return ordered[0];
  const picked = ordered.find((row) => row.level === level);
  if (!picked) {
    throw new RewardRoleApplyError(
      `Level ${level} has no mapped reward in this report (mapped: ` +
        `${ordered.map((row) => row.level).join(', ')}). Grantability is decided by the probe, ` +
        'not by this operation.',
      2,
    );
  }
  return picked;
}

export interface GrantEligibility {
  botRoleId: string;
  botPosition: number;
  ownerBypass: boolean;
}

/**
 * The hierarchy precheck, by id rather than by name: the same rule
 * `planRewardRoleImport` applies to the export (a bot grants strictly below
 * its own top role; the guild owner bypasses it), re-applied at exercise
 * time against the live roles snapshot - because positions move.
 */
export function precheckGrantEligibility(opts: {
  roles: readonly PartialRole[];
  botId: string;
  ownerId: string | null;
  targetRoleId: string;
}): GrantEligibility {
  const { roles, botId, ownerId, targetRoleId } = opts;
  const target = roles.find((role) => role.id === targetRoleId);
  if (!target) {
    throw new RewardRoleApplyError(
      `Role ${targetRoleId} no longer exists in the guild; the report is stale. Regenerate it.`,
    );
  }
  if (target.managed) {
    throw new RewardRoleApplyError(
      `Role "${target.name}" (${targetRoleId}) is managed by an integration; Discord lets no bot grant it.`,
    );
  }
  if (ownerId && ownerId === botId) return { botRoleId: '', botPosition: -1, ownerBypass: true };
  const botRole = roles.find((role) => role.tags?.bot_id === botId) ?? null;
  if (!botRole) {
    throw new RewardRoleApplyError(
      'The bot has no managed role in this guild and does not own it, so it can grant ' +
        'nothing - re-invite the bot with the scoped permission link.',
    );
  }
  if (target.position >= botRole.position) {
    throw new RewardRoleApplyError(
      `Role "${target.name}" is at position ${target.position}, at or above the bot's own role ` +
        `"${botRole.name}" at ${botRole.position}; a bot grants only strictly below itself. ` +
        `Drag the bot's role above "${target.name}" in Server Settings > Roles.`,
    );
  }
  return { botRoleId: botRole.id, botPosition: botRole.position, ownerBypass: false };
}

/** Manage Roles, the permission bit the exercise needs on the bot member. */
export const MANAGE_ROLES_BIT = 1n << 28n;

/**
 * The bot member's effective permission mask from the roles snapshot: the OR
 * of every permission bitfield on the roles the member holds. @everyone is
 * position 0 and always applies.
 */
export function effectivePermissions(
  roles: readonly PartialRole[],
  memberRoleIds: readonly string[],
  everyoneRoleId: string | null,
): bigint {
  const held = new Set(memberRoleIds);
  if (everyoneRoleId) held.add(everyoneRoleId);
  let mask = 0n;
  for (const role of roles) {
    if (!held.has(role.id)) continue;
    try {
      mask |= BigInt(role.permissions ?? '0');
    } catch {
      // A malformed bitfield grants nothing rather than everything.
    }
  }
  return mask;
}

/** Discord calls, already scoped to one guild by the caller. */
export interface RewardRolePort {
  guildId: string;
  /** Current role ids, or null when the member is not in the guild. */
  memberRoles(memberId: string): Promise<string[] | null>;
  grantRole(memberId: string, roleId: string, reason: string): Promise<void>;
  revokeRole(memberId: string, roleId: string, reason: string): Promise<void>;
}

export type ApplyLogger = (event: string, fields: Record<string, unknown>) => void;

export interface RewardRoleApplySummary {
  guildId: string;
  memberId: string;
  level: number;
  roleId: string;
  roleName: string;
  /** The member already held the role: grant skipped, readback still proven. */
  alreadyHeld: boolean;
  positiveReadback: boolean;
  negativeReadback: boolean;
  /** The member's other roles are exactly what they were before the run. */
  residueRestored: boolean;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * Grant, prove, revoke, prove - in one idempotent, logged operation.
 *
 * Re-run safety comes from the pre-check: when the member already holds the
 * role the grant is skipped (logged, not silently), the positive readback is
 * still asserted, and the revoke still runs - so every run ends with the
 * role absent and the member otherwise untouched. Cleanup is not a second
 * command; it is the second half of the only command.
 */
export async function applyRewardRole(
  port: RewardRolePort,
  opts: {
    memberId: string;
    target: RewardRoleTarget;
    roles: readonly PartialRole[];
    botId: string;
    ownerId: string | null;
    logger?: ApplyLogger;
  },
): Promise<RewardRoleApplySummary> {
  const { memberId, target, roles, botId, ownerId, logger = () => undefined } = opts;
  assertStagingGuild(port.guildId);
  if (!/^\d{17,20}$/.test(memberId)) {
    throw new RewardRoleApplyError(`--member ${memberId} is not a Discord user id.`, 2);
  }
  const eligibility = precheckGrantEligibility({
    roles,
    botId,
    ownerId,
    targetRoleId: target.roleId,
  });
  logger('level_reward_role_precheck', {
    guildId: port.guildId,
    memberId,
    level: target.level,
    roleId: target.roleId,
    ...eligibility,
  });

  const before = await port.memberRoles(memberId);
  if (before === null) {
    throw new RewardRoleApplyError(
      `Member ${memberId} is not in the staging guild. Add the disposable test account first; ` +
        'this operation never creates members.',
    );
  }
  const alreadyHeld = before.includes(target.roleId);
  const reason = `TOG-4444 staging reward-role exercise (level ${target.level})`;

  if (alreadyHeld) {
    // A previous run's revoke must have failed after its positive readback -
    // or someone granted the role by hand. Either way the safe move is the
    // same: say so, keep going, and let the revoke half restore the invariant.
    logger('level_reward_role_already_held', { guildId: port.guildId, memberId, roleId: target.roleId });
  } else {
    await port.grantRole(memberId, target.roleId, reason);
    logger('level_reward_role_grant', { guildId: port.guildId, memberId, roleId: target.roleId });
  }

  const positive = await port.memberRoles(memberId);
  const positiveReadback = positive !== null && positive.includes(target.roleId);
  logger('level_reward_role_positive_readback', {
    guildId: port.guildId,
    memberId,
    roleId: target.roleId,
    present: positiveReadback,
  });
  if (!positiveReadback) {
    throw new RewardRoleApplyError(
      `Grant of role "${target.roleName}" (${target.roleId}) to ${memberId} did not read back. ` +
        'Stopping before the revoke: retry the run once Discord has settled.',
    );
  }

  await port.revokeRole(memberId, target.roleId, reason);
  logger('level_reward_role_revoke', { guildId: port.guildId, memberId, roleId: target.roleId });

  const negative = await port.memberRoles(memberId);
  const negativeReadback = negative !== null && !negative.includes(target.roleId);
  logger('level_reward_role_negative_readback', {
    guildId: port.guildId,
    memberId,
    roleId: target.roleId,
    absent: negativeReadback,
  });
  if (!negativeReadback) {
    throw new RewardRoleApplyError(
      `Revoke of role "${target.roleName}" (${target.roleId}) from ${memberId} did not read back: ` +
        'the role may still be on the member. Remove it by hand in Server Settings > Members, then re-run.',
    );
  }

  const residueRestored = sameMembers(
    negative!.filter((id) => id !== target.roleId),
    before.filter((id) => id !== target.roleId),
  );
  logger('level_reward_role_complete', {
    guildId: port.guildId,
    memberId,
    roleId: target.roleId,
    alreadyHeld,
    residueRestored,
  });
  return {
    guildId: port.guildId,
    memberId,
    level: target.level,
    roleId: target.roleId,
    roleName: target.roleName,
    alreadyHeld,
    positiveReadback,
    negativeReadback,
    residueRestored,
  };
}
