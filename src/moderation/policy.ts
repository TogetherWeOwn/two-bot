import { PermissionFlagsBits } from 'discord.js';
import { ActionError } from '../internal/errors.ts';
import type { ModerationActionName, ModerationPolicy, ModerationRequest } from './types.ts';

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
  if (target.isGuildOwner) refuse('The guild owner is protected', 'target_guild_owner');
  if (target.userId === policy.owenUserId || target.userId === policy.botUserId) {
    refuse('Owen is protected', 'target_owen');
  }
  if (target.isBot) refuse('Bots are protected', 'target_bot');
  if (target.roleIds.some((roleId) => policy.protectedRoleIds.has(roleId))) {
    refuse('Staff roles are protected', 'target_staff_role');
  }
  if (request.actor.highestRolePosition <= target.highestRolePosition) {
    refuse('The target is equal to or above your highest role', 'actor_hierarchy');
  }
}

function refuse(message: string, logReason: string): never {
  throw new ActionError('action_not_allowed', message, { logReason });
}
