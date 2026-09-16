import { PermissionFlagsBits } from 'discord.js';

/**
 * Permissions a member-facing role may carry. Everything else is rejected,
 * including permission bits added by Discord after this code ships. Expanding
 * this list is an explicit security decision.
 */
export const SELF_ROLE_ALLOWED_PERMISSIONS = [
  ['AddReactions', PermissionFlagsBits.AddReactions],
  ['Stream', PermissionFlagsBits.Stream],
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
  ['AttachFiles', PermissionFlagsBits.AttachFiles],
  ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
  ['UseExternalEmojis', PermissionFlagsBits.UseExternalEmojis],
  ['Connect', PermissionFlagsBits.Connect],
  ['Speak', PermissionFlagsBits.Speak],
  ['ChangeNickname', PermissionFlagsBits.ChangeNickname],
  ['UseApplicationCommands', PermissionFlagsBits.UseApplicationCommands],
] as const;

export type SelfRolePermissionSource = string | bigint | { bitfield: bigint };

export interface SelfRoleChannelOverwrite {
  id: string;
  type: number;
  allow: SelfRolePermissionSource;
  deny: SelfRolePermissionSource;
}

export interface SelfRoleChannelPermissions {
  id: string;
  name?: string;
  permissionOverwrites?: readonly SelfRoleChannelOverwrite[];
}

export interface SelfRoleChannelSafetyInput {
  guildId: string;
  roleId: string;
  everyonePermissions: SelfRolePermissionSource;
  rolePermissions: SelfRolePermissionSource;
  channels: readonly SelfRoleChannelPermissions[];
}

const SELF_ROLE_ALLOWED_PERMISSION_MASK = SELF_ROLE_ALLOWED_PERMISSIONS.reduce(
  (mask, [, bit]) => mask | bit,
  0n,
);

const KNOWN_PERMISSION_BITS = Object.entries(PermissionFlagsBits)
  .map(([name, bit]) => [name, bit] as const)
  .sort(([, left], [, right]) => left < right ? -1 : left > right ? 1 : 0);

export function permissionBitfield(permissions: SelfRolePermissionSource): bigint {
  return typeof permissions === 'object'
    ? permissions.bitfield
    : typeof permissions === 'bigint'
      ? permissions
      : BigInt(permissions);
}

export function findSelfRoleDisallowedPermission(
  permissions: SelfRolePermissionSource,
): string | null {
  const bitfield = permissionBitfield(permissions);
  const disallowed = bitfield & ~SELF_ROLE_ALLOWED_PERMISSION_MASK;
  if (disallowed === 0n) return null;

  for (const [name, bit] of KNOWN_PERMISSION_BITS) {
    if ((disallowed & bit) === bit) return name;
  }
  return `unknown permission bits ${disallowed}`;
}

/**
 * Self-service roles may not unlock a channel hidden from @everyone. Discord
 * computes role overwrites as a union (deny, then allow), so compare the member
 * holding only @everyone with the same member after this one role is added.
 */
export function findSelfRoleUnsafeChannelGrant(
  input: SelfRoleChannelSafetyInput,
): { channelId: string; channelName?: string; permission: string; kind: 'unsafe_permission' | 'new_channel_access' } | null {
  for (const channel of input.channels) {
    const roleOverwrite = channel.permissionOverwrites?.find(
      (candidate) => candidate.type === 0 && candidate.id === input.roleId,
    );
    if (roleOverwrite) {
      const disallowed = findSelfRoleDisallowedPermission(permissionBitfield(roleOverwrite.allow));
      if (disallowed) return unsafe(channel, disallowed, 'unsafe_permission');
    }

    const before = effectiveRolePermissions(
      input.guildId,
      permissionBitfield(input.everyonePermissions),
      channel.permissionOverwrites ?? [],
      [],
    );
    const after = effectiveRolePermissions(
      input.guildId,
      permissionBitfield(input.everyonePermissions) | permissionBitfield(input.rolePermissions),
      channel.permissionOverwrites ?? [],
      [input.roleId],
    );
    if ((before & PermissionFlagsBits.ViewChannel) === 0n && (after & PermissionFlagsBits.ViewChannel) !== 0n) {
      return unsafe(channel, 'ViewChannel', 'new_channel_access');
    }
  }
  return null;
}

function effectiveRolePermissions(
  guildId: string,
  base: bigint,
  overwrites: readonly SelfRoleChannelOverwrite[],
  heldRoleIds: readonly string[],
): bigint {
  if ((base & PermissionFlagsBits.Administrator) !== 0n) return ~0n;
  const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId);
  if (everyone) base = (base & ~permissionBitfield(everyone.deny)) | permissionBitfield(everyone.allow);

  const held = new Set(heldRoleIds);
  let deny = 0n;
  let allow = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || overwrite.id === guildId || !held.has(overwrite.id)) continue;
    deny |= permissionBitfield(overwrite.deny);
    allow |= permissionBitfield(overwrite.allow);
  }
  return (base & ~deny) | allow;
}

function unsafe(
  channel: SelfRoleChannelPermissions,
  permission: string,
  kind: 'unsafe_permission' | 'new_channel_access',
) {
  return {
    channelId: channel.id,
    ...(channel.name ? { channelName: channel.name } : {}),
    permission,
    kind,
  };
}
