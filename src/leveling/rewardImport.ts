/**
 * The reward-role half of the MEE6 import (TOG-1641, TOG-3481).
 *
 * `importManifest.ts` moves XP and nothing else - `parseMee6Export` reads
 * `players` and drops the rest of the file on the floor. A MEE6 export also
 * carries `role_rewards`, the level -> role ladder, and that half has never had
 * an importer or a dry run. An operator migrating off MEE6 therefore finds out
 * which of their reward roles Owen cannot actually hand out at the moment a
 * member levels up, in production, where the failure is a swallowed
 * `level_role_reward_failed` log line (src/leveling/discord.ts:60).
 *
 * This module is the pre-flight for that. It classifies every reward in the
 * export against the guild's real roles and says which ones would land. It is
 * pure: data in, report out, no database and no network, mirroring
 * `evaluateTempVoiceStructure` in ../staging/tempVoiceCheck.ts. Writing is not
 * "disabled" here, it is absent - there is nothing in this file that can write.
 *
 * Four things stop a reward from landing, and the two that cost the most are
 * the two nobody expects, both from the schema at
 * migrations/0010_leveling.sql:43-49:
 *
 *   PRIMARY KEY (guild_id, level)   two roles at the same level is not an
 *                                   error - `replaceRoleRewards` collapses
 *                                   them through a Map keyed by level
 *                                   (service.ts:308-311) and the loser
 *                                   disappears with no diagnostic at all.
 *   UNIQUE (guild_id, role_id)      one role at two levels is the opposite
 *                                   failure: the INSERT violates the
 *                                   constraint and takes the whole
 *                                   transaction down, so a 40-reward import
 *                                   lands nothing.
 *
 * The other two are Discord's, and both make `member.roles.add` throw at
 * level-up rather than at import: a role that no longer exists, and a role the
 * bot is not high enough to grant. The hierarchy rule is the same one
 * `evaluateHierarchy` applies by name in ../staging/provision.ts:504 - a bot
 * grants strictly below its own top role, and the guild owner bypasses the
 * check entirely - applied here by id, because an export carries ids.
 */
import type { PartialRole } from '../staging/provision.ts';
import type { LevelRoleReward } from './service.ts';

export const REWARD_REPORT_VERSION = 1;

/** A level -> role pair as it appeared in the export, before any judgement. */
export interface Mee6RoleReward {
  level: number;
  roleId: string;
  /** The name MEE6 recorded. Advisory only: ids are the identity. */
  roleName?: string;
}

export type RewardSkipReason =
  | 'role_absent'
  | 'role_managed'
  | 'above_bot_role'
  | 'duplicate_level'
  | 'duplicate_role';

export const REWARD_SKIP_REASONS: readonly RewardSkipReason[] = [
  'role_absent',
  'role_managed',
  'above_bot_role',
  'duplicate_level',
  'duplicate_role',
];

export interface MappedReward {
  level: number;
  roleId: string;
  /** The live guild's name for the role, which may differ from the export's. */
  roleName: string;
  /** Set when the export's remembered name no longer matches the guild's. */
  renamedFrom?: string;
  position: number;
}

export interface UnmappedReward {
  level: number;
  roleId: string;
  roleName?: string;
  reason: RewardSkipReason;
  /** Always names the concrete thing that lost, never just the rule. */
  detail: string;
}

export interface RewardCounts {
  rewardsIn: number;
  mapped: number;
  unmapped: number;
  byReason: Record<RewardSkipReason, number>;
  /**
   * rewardsIn === mapped + unmapped, or the report is not a faithful account
   * of the file and the caller must fail on it.
   */
  balances: boolean;
}

/** What `replaceRoleRewards` currently holds, so the report can show a delta. */
export interface RewardDelta {
  /** In the export and mappable, not currently stored. */
  added: LevelRoleReward[];
  /** Stored at this level, but the export points the level at another role. */
  changed: Array<{ level: number; from: string; to: string }>;
  /** Stored now and absent from the mappable set. An apply would drop these. */
  removed: LevelRoleReward[];
  unchanged: LevelRoleReward[];
}

export interface RewardImportReport {
  reportVersion: number;
  guildId: string;
  /** Always 'dry-run'. This module has no apply path. */
  mode: 'dry-run';
  counts: RewardCounts;
  mapped: MappedReward[];
  unmapped: UnmappedReward[];
  /** Exactly what an apply would hand `replaceRoleRewards`, in level order. */
  apply: LevelRoleReward[];
  botRoleId: string | null;
  botPosition: number | null;
  ownerBypass: boolean;
  /** Null when the caller did not supply the stored rewards. */
  delta: RewardDelta | null;
}

/** Every malformed reward at once, for the reason `Mee6ExportError` gives. */
export class Mee6RewardExportError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`MEE6 role_rewards are not importable:\n  ${problems.join('\n  ')}`);
    this.name = 'Mee6RewardExportError';
    this.problems = problems;
  }
}

interface RawReward {
  rank?: unknown;
  level?: unknown;
  role?: unknown;
  role_id?: unknown;
  roleId?: unknown;
}

function readRoleId(raw: RawReward): { id?: unknown; name?: string } {
  // MEE6 nests the role; hand-written and re-exported files tend to flatten it.
  // Accept both shapes on the way in and be strict about the value, so a file
  // is rejected for being wrong rather than for being shaped unusually.
  if (raw.role && typeof raw.role === 'object') {
    const role = raw.role as { id?: unknown; name?: unknown };
    return { id: role.id, name: typeof role.name === 'string' ? role.name : undefined };
  }
  if (typeof raw.role === 'string') return { id: raw.role };
  return { id: raw.role_id ?? raw.roleId };
}

/**
 * Parse and fully validate the `role_rewards` section of a MEE6 export.
 *
 * An export with no `role_rewards` key is legitimate - plenty of servers level
 * without reward roles - and parses to an empty list. A `role_rewards` key that
 * is present but not an array is a malformed file and throws.
 */
export function parseMee6RoleRewards(text: string): Mee6RoleReward[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Mee6RewardExportError([`file is not valid JSON: ${(error as Error).message}`]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Mee6RewardExportError(['export must be an object carrying a role_rewards array']);
  }
  const section = (parsed as { role_rewards?: unknown }).role_rewards;
  if (section === undefined || section === null) return [];
  if (!Array.isArray(section)) {
    throw new Mee6RewardExportError(['role_rewards must be an array']);
  }

  const problems: string[] = [];
  const rewards: Mee6RoleReward[] = [];
  section.forEach((raw, index) => {
    const at = `role_rewards[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const entry = raw as RawReward;
    const levelRaw = entry.rank ?? entry.level;
    if (levelRaw === undefined) {
      problems.push(`${at} has no rank or level`);
      return;
    }
    if (!Number.isInteger(levelRaw) || Number(levelRaw) <= 0) {
      // `level > 0` is the table's CHECK (migrations/0010_leveling.sql:45), so
      // level 0 is rejected here rather than at the INSERT.
      problems.push(`${at} has an invalid level: ${JSON.stringify(levelRaw)}`);
      return;
    }
    const { id, name } = readRoleId(entry);
    if (typeof id !== 'string') {
      problems.push(`${at} has no role id`);
      return;
    }
    if (!/^\d{17,20}$/.test(id)) {
      problems.push(`${at} has an invalid Discord role id: ${id}`);
      return;
    }
    rewards.push({ level: Number(levelRaw), roleId: id, roleName: name });
  });

  if (problems.length > 0) throw new Mee6RewardExportError(problems);
  return rewards;
}

function tally(unmapped: readonly UnmappedReward[]): Record<RewardSkipReason, number> {
  const counts = Object.fromEntries(REWARD_SKIP_REASONS.map((r) => [r, 0])) as Record<
    RewardSkipReason,
    number
  >;
  for (const row of unmapped) counts[row.reason]++;
  return counts;
}

export interface PlanRewardOptions {
  roles: readonly PartialRole[];
  /** The bot's own user id, used to find its managed role among `roles`. */
  botId: string;
  /** Owner of the guild. When it equals `botId`, hierarchy stops applying. */
  ownerId?: string | null;
  /** Current contents of level_role_rewards, when the caller read them. */
  storedRewards?: readonly LevelRoleReward[] | null;
}

/**
 * Classify every reward in the export against the live guild. Writes nothing.
 *
 * The ordering is the one decision here worth defending: a reward is checked
 * for grantability FIRST, and only a reward that would otherwise have been
 * written can be called a duplicate. So `duplicate_level` and `duplicate_role`
 * always mean "this one was fine and lost to another one that was also fine",
 * never "this one was broken in two ways". If level 5 names a deleted role and
 * then a good one, the operator is told the role was deleted - which is a fact
 * about their server they can act on - rather than being told about a collapse
 * that cost them nothing.
 *
 * A level or a role is likewise only "taken" by a reward that actually mapped,
 * so duplicates are judged against what would be WRITTEN rather than against
 * what the file happens to list twice.
 *
 * Rewards are sorted by level, then by role id to break a tie, so the winner of
 * a genuine duplicate does not depend on the order the export happened to use.
 * The same export in any permutation produces a byte-identical report, which is
 * what makes two runs diffable.
 */
export function planRewardRoleImport(
  guildId: string,
  rewards: readonly Mee6RoleReward[],
  options: PlanRewardOptions,
): RewardImportReport {
  const { roles, botId, ownerId = null, storedRewards = null } = options;

  const byId = new Map<string, PartialRole>();
  for (const role of roles) if (!byId.has(role.id)) byId.set(role.id, role);

  const botRole = roles.find((role) => role.tags?.bot_id === botId) ?? null;
  const ownerBypass = Boolean(ownerId) && ownerId === botId;

  const mapped: MappedReward[] = [];
  const unmapped: UnmappedReward[] = [];

  // Sorting by level first makes "the lower level wins" a property of the loop
  // rather than of the file's ordering, so the report is deterministic for any
  // permutation of the same export - which is what makes it diffable.
  const ordered = [...rewards].sort((a, b) => a.level - b.level || a.roleId.localeCompare(b.roleId));
  const levelClaimedBy = new Map<number, string>();
  const roleClaimedAt = new Map<string, number>();

  for (const reward of ordered) {
    const { level, roleId, roleName } = reward;

    const live = byId.get(roleId);
    if (!live) {
      unmapped.push({
        level,
        roleId,
        roleName,
        reason: 'role_absent',
        detail:
          `no role ${roleId}${roleName ? ` ("${roleName}")` : ''} exists in guild ${guildId}; ` +
          'it was deleted after the export, or the export came from another guild',
      });
      continue;
    }
    if (live.managed) {
      // A managed role belongs to an integration and no bot can assign it, so
      // this would import cleanly and then fail forever at level-up.
      unmapped.push({
        level,
        roleId,
        roleName: live.name,
        reason: 'role_managed',
        detail:
          `role "${live.name}" (${roleId}) is managed by an integration; Discord does not let ` +
          'any bot grant it, so the reward would be stored and never land',
      });
      continue;
    }
    if (!ownerBypass && (!botRole || live.position >= botRole.position)) {
      unmapped.push({
        level,
        roleId,
        roleName: live.name,
        reason: 'above_bot_role',
        detail: botRole
          ? `role "${live.name}" is at position ${live.position}, at or above the bot's own role ` +
            `"${botRole.name}" at ${botRole.position}; a bot grants only strictly below itself. ` +
            `Drag the bot's role above "${live.name}" in Server Settings > Roles.`
          : `the bot has no managed role in guild ${guildId} and does not own it, so it can grant ` +
            `nothing - re-invite the bot with the scoped permission link`,
      });
      continue;
    }

    // Duplicates last, and only among rewards that were otherwise importable.
    // A reward is called a duplicate only when it lost to another reward that
    // was itself fine - so the label always means "this one was good and got
    // collapsed", never "this one was broken in two ways at once".
    const levelHolder = levelClaimedBy.get(level);
    if (levelHolder !== undefined) {
      unmapped.push({
        level,
        roleId,
        roleName: live.name,
        reason: 'duplicate_level',
        detail:
          `level ${level} is already the reward for role ${levelHolder}; the table's ` +
          `PRIMARY KEY (guild_id, level) keeps one row per level, so importing this would ` +
          `silently drop role "${live.name}" (${roleId})`,
      });
      continue;
    }
    const roleHolder = roleClaimedAt.get(roleId);
    if (roleHolder !== undefined) {
      unmapped.push({
        level,
        roleId,
        roleName: live.name,
        reason: 'duplicate_role',
        detail:
          `role "${live.name}" (${roleId}) is already the reward for level ${roleHolder}; the ` +
          `table's UNIQUE (guild_id, role_id) would reject this row and abort the whole import`,
      });
      continue;
    }

    levelClaimedBy.set(level, roleId);
    roleClaimedAt.set(roleId, level);
    mapped.push({
      level,
      roleId,
      roleName: live.name,
      ...(roleName && roleName !== live.name ? { renamedFrom: roleName } : {}),
      position: live.position,
    });
  }

  const apply: LevelRoleReward[] = mapped.map((row) => ({ level: row.level, roleId: row.roleId }));

  let delta: RewardDelta | null = null;
  if (storedRewards) {
    const stored = new Map(storedRewards.map((row) => [row.level, row.roleId]));
    const planned = new Map(apply.map((row) => [row.level, row.roleId]));
    const added: LevelRoleReward[] = [];
    const changed: Array<{ level: number; from: string; to: string }> = [];
    const unchanged: LevelRoleReward[] = [];
    for (const [level, roleId] of planned) {
      const before = stored.get(level);
      if (before === undefined) added.push({ level, roleId });
      else if (before === roleId) unchanged.push({ level, roleId });
      else changed.push({ level, from: before, to: roleId });
    }
    // `replaceRoleRewards` deletes the guild's rows before inserting
    // (service.ts:316), so anything stored and not planned is a deletion an
    // operator should see BEFORE they reach for --apply, not after.
    const removed = [...stored]
      .filter(([level]) => !planned.has(level))
      .map(([level, roleId]) => ({ level, roleId }));
    delta = { added, changed, removed, unchanged };
  }

  const counts: RewardCounts = {
    rewardsIn: rewards.length,
    mapped: mapped.length,
    unmapped: unmapped.length,
    byReason: tally(unmapped),
    balances: rewards.length === mapped.length + unmapped.length,
  };

  return {
    reportVersion: REWARD_REPORT_VERSION,
    guildId,
    mode: 'dry-run',
    counts,
    mapped,
    unmapped,
    apply,
    botRoleId: botRole?.id ?? null,
    botPosition: botRole?.position ?? null,
    ownerBypass,
    delta,
  };
}
