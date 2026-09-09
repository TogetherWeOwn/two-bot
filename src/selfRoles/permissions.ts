import { PermissionFlagsBits } from 'discord.js';

/**
 * Permissions that can turn a member-facing role picker into a moderation or
 * administration path. Keep this explicit: adding a new staff-capability bit is
 * a security decision, not an incidental Discord API change.
 */
export const SELF_ROLE_PRIVILEGED_PERMISSIONS = [
  ['Administrator', PermissionFlagsBits.Administrator],
  ['ManageGuild', PermissionFlagsBits.ManageGuild],
  ['ManageRoles', PermissionFlagsBits.ManageRoles],
  ['ManageChannels', PermissionFlagsBits.ManageChannels],
  ['ManageMessages', PermissionFlagsBits.ManageMessages],
  ['ManageWebhooks', PermissionFlagsBits.ManageWebhooks],
  ['KickMembers', PermissionFlagsBits.KickMembers],
  ['BanMembers', PermissionFlagsBits.BanMembers],
  ['MuteMembers', PermissionFlagsBits.MuteMembers],
  ['DeafenMembers', PermissionFlagsBits.DeafenMembers],
  ['MoveMembers', PermissionFlagsBits.MoveMembers],
  ['ModerateMembers', PermissionFlagsBits.ModerateMembers],
  ['MentionEveryone', PermissionFlagsBits.MentionEveryone],
  ['ManageNicknames', PermissionFlagsBits.ManageNicknames],
  ['ManageEvents', PermissionFlagsBits.ManageEvents],
  ['ManageThreads', PermissionFlagsBits.ManageThreads],
  ['ViewAuditLog', PermissionFlagsBits.ViewAuditLog],
] as const;

export type SelfRolePrivilegedPermission = (typeof SELF_ROLE_PRIVILEGED_PERMISSIONS)[number][0];

export type SelfRolePermissionSource = string | bigint | { bitfield: bigint };

export function findSelfRolePrivilegedPermission(
  permissions: SelfRolePermissionSource,
): SelfRolePrivilegedPermission | null {
  const bitfield = typeof permissions === 'object'
    ? permissions.bitfield
    : typeof permissions === 'bigint'
      ? permissions
      : BigInt(permissions);
  for (const [name, bit] of SELF_ROLE_PRIVILEGED_PERMISSIONS) {
    if ((bitfield & bit) === bit) return name;
  }
  return null;
}
