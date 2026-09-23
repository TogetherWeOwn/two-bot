import { PermissionFlagsBits } from 'discord.js';
import { ActionError } from '../internal/errors.ts';
import type { ModerationActionName, ModerationPolicy, ModerationRequest, ModerationTarget } from './types.ts';

export type ModerationPolicyRefusalReason =
  | 'actor_missing_permission'
  | 'target_self'
  | 'target_guild_owner'
  | 'target_owen'
  | 'target_bot'
  | 'target_staff_role'
  | 'actor_hierarchy'
  | 'bot_hierarchy';

const MODERATION_POLICY_REFUSAL_REASONS = new Set<ModerationPolicyRefusalReason>([
  'actor_missing_permission',
  'target_self',
  'target_guild_owner',
  'target_owen',
  'target_bot',
  'target_staff_role',
  'actor_hierarchy',
  'bot_hierarchy',
]);

const PERMISSION_FOR: Record<ModerationActionName, bigint> = {
  'moderation.ban': PermissionFlagsBits.BanMembers,
  'moderation.tempban': PermissionFlagsBits.BanMembers,
  'moderation.kick': PermissionFlagsBits.KickMembers,
  'moderation.timeout': PermissionFlagsBits.ModerateMembers,
  'moderation.warn': PermissionFlagsBits.ModerateMembers,
  'moderation.purge': PermissionFlagsBits.ManageMessages,
  'moderation.slowmode': PermissionFlagsBits.ManageChannels,
  'moderation.lockdown': PermissionFlagsBits.ManageChannels,
  'moderation.unlock': PermissionFlagsBits.ManageChannels,
};

const TARGET_ACTIONS = new Set<ModerationActionName>([
  'moderation.ban',
  'moderation.tempban',
  'moderation.kick',
  'moderation.timeout',
  'moderation.warn',
]);

/**
 * The refusals that are facts about *who the target is*, not about what the
 * actor may do or where either sits in the role hierarchy.
 */
export type ModerationTargetProtectionReason = Extract<
  ModerationPolicyRefusalReason,
  'target_guild_owner' | 'target_owen' | 'target_bot' | 'target_staff_role'
>;

const PROTECTION_MESSAGE: Record<ModerationTargetProtectionReason, string> = {
  target_guild_owner: 'The guild owner is protected',
  target_owen: 'Owen is protected',
  target_bot: 'Bots are protected',
  target_staff_role: 'Staff roles are protected',
};

/**
 * Whether this target is protected from being moderated at all, independent of
 * the verb.
 *
 * Split out of `assertModerationAllowed` for TOG-3092: automod has to decide
 * whether it may delete a message, and a message deletion is not a
 * `ModerationActionName` - it needs neither the actor permission nor the
 * hierarchy comparison that the member verbs do, so it cannot go through
 * `assertModerationAllowed`. Deliberately excludes `actor_hierarchy` and
 * `bot_hierarchy`: those describe a *capability* limit on timeout/kick/ban,
 * while Manage Messages lets Owen delete a message from anyone above them.
 * Folding them in here would silently stop deleting spam from anyone ranked
 * above the bot.
 *
 * `assertModerationAllowed` calls this rather than repeating the checks, so a
 * protection added in one place can never go missing from the other.
 */
export function moderationTargetProtection(
  target: ModerationTarget,
  policy: ModerationPolicy,
): ModerationTargetProtectionReason | undefined {
  if (target.isGuildOwner) return 'target_guild_owner';
  if (target.userId === policy.owenUserId || target.userId === policy.botUserId) return 'target_owen';
  if (target.isBot) return 'target_bot';
  if (target.roleIds.some((roleId) => policy.protectedRoleIds.has(roleId))) return 'target_staff_role';
  return undefined;
}

export function assertModerationAllowed(request: ModerationRequest, policy: ModerationPolicy): void {
  const permission = PERMISSION_FOR[request.action];
  if ((request.actor.permissions & permission) !== permission) {
    refuse(`Missing required permission for ${request.action}`, 'actor_missing_permission');
  }

  if (!TARGET_ACTIONS.has(request.action)) return;
  const target = request.target;
  if (!target) {
    throw new ActionError('malformed', 'This moderation action requires a target', {
      logReason: 'missing_target',
    });
  }
  if (target.userId === request.actor.userId) refuse('You cannot moderate yourself', 'target_self');
  const protection = moderationTargetProtection(target, policy);
  if (protection) refuse(PROTECTION_MESSAGE[protection], protection);
  if (request.botHighestRolePosition !== undefined && request.botHighestRolePosition <= target.highestRolePosition) {
    refuse('The target is equal to or above Owen\'s highest role', 'bot_hierarchy');
  }
  if (request.actor.highestRolePosition <= target.highestRolePosition) {
    refuse('The target is equal to or above your highest role', 'actor_hierarchy');
  }
}

export function isModerationPolicyRefusal(err: unknown): err is ActionError & { logReason: ModerationPolicyRefusalReason } {
  return err instanceof ActionError
    && err.code === 'action_not_allowed'
    && MODERATION_POLICY_REFUSAL_REASONS.has(err.logReason as ModerationPolicyRefusalReason);
}

function refuse(message: string, logReason: ModerationPolicyRefusalReason): never {
  throw new ActionError('action_not_allowed', message, { logReason });
}
