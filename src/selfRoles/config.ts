import { emojiIdentity, selfRoleCustomId } from './plan.ts';
import {
  findSelfRoleDisallowedPermission,
  findSelfRoleUnsafeChannelGrant,
  type SelfRoleChannelPermissions,
} from './permissions.ts';
import type { SelfRolePanel } from './types.ts';

const SNOWFLAKE = /^\d{17,20}$/;

export class SelfRoleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfRoleConfigError';
  }
}

/**
 * Load the panel catalogue from an environment variable or systemd credential.
 *
 * Role and message ids are deployment data, not source guesses that belong in the
 * repository. An empty value disables the feature. A malformed non-empty value
 * is a startup error: silently running with no pickers would leave old panels
 * clickable while the bot ignores them.
 */
export function loadSelfRolePanels(raw = process.env.TWO_SELF_ROLE_PANELS ?? ''): SelfRolePanel[] {
  if (!raw.trim()) return [];

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SelfRoleConfigError('TWO_SELF_ROLE_PANELS must be valid JSON.');
  }
  if (!Array.isArray(value)) {
    throw new SelfRoleConfigError('TWO_SELF_ROLE_PANELS must be a JSON array.');
  }

  const panels = value.map((panel, index) => parsePanel(panel, index));
  const panelIds = new Set<string>();
  const messageIds = new Set<string>();
  const rolePanels = new Map<string, string>();
  for (const panel of panels) {
    if (panelIds.has(panel.id)) throw new SelfRoleConfigError(`duplicate panel id "${panel.id}"`);
    if (messageIds.has(panel.messageId)) {
      throw new SelfRoleConfigError(`message ${panel.messageId} is assigned to more than one panel`);
    }
    for (const option of panel.options) {
      const priorPanelId = rolePanels.get(option.roleId);
      if (priorPanelId) {
        throw new SelfRoleConfigError(
          `role ${option.roleId} is assigned to both panel "${priorPanelId}" and panel "${panel.id}"`,
        );
      }
      rolePanels.set(option.roleId, panel.id);
    }
    panelIds.add(panel.id);
    messageIds.add(panel.messageId);
  }
  return panels;
}

export interface SelfRoleResolvedRole {
  id: string;
  name?: string;
  permissions: string | bigint | { bitfield: bigint };
  /** Discord integer color; zero means the role has no visible color. */
  color?: number;
}

/**
 * Resolve the deployment catalogue against Discord before any controls are
 * registered or published. The JSON alone cannot prove a snowflake is safe;
 * the live role permission mask is the authorization boundary.
 */
export function validateSelfRolePanelRoles(
  panels: readonly SelfRolePanel[],
  roles: readonly SelfRoleResolvedRole[],
  channels: readonly SelfRoleChannelPermissions[] = [],
  guildId?: string,
): void {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const everyone = guildId ? byId.get(guildId) : undefined;
  if (panels.length && channels.length && (!guildId || !everyone)) {
    throw new SelfRoleConfigError('the guild id and @everyone role are required to validate channel access');
  }
  for (const panel of panels) {
    for (const option of panel.options) {
      const role = byId.get(option.roleId);
      if (!role) {
        throw new SelfRoleConfigError(
          `panel "${panel.id}" option "${option.key}" role ${option.roleId} does not exist`,
        );
      }
      let livePermissions: bigint;
      try {
        livePermissions = typeof role.permissions === 'object'
          ? role.permissions.bitfield
          : BigInt(role.permissions);
      } catch {
        throw new SelfRoleConfigError(
          `panel "${panel.id}" option "${option.key}" role ${option.roleId} has an invalid permission mask`,
        );
      }
      const disallowed = findSelfRoleDisallowedPermission(livePermissions);
      if (disallowed) {
        throw new SelfRoleConfigError(
          `panel "${panel.id}" option "${option.key}" role ${option.roleId}` +
            `${role.name ? ` ("${role.name}")` : ''} has disallowed permission ${disallowed}`,
        );
      }
      if (livePermissions !== BigInt(option.permissions)) {
        throw new SelfRoleConfigError(
          `panel "${panel.id}" option "${option.key}" role ${option.roleId}` +
            `${role.name ? ` ("${role.name}")` : ''} permission mask changed from ` +
            `${option.permissions} to ${livePermissions}`,
        );
      }
      const liveColor = role.color;
      if (panel.color && (!Number.isInteger(liveColor) || (liveColor ?? 0) <= 0)) {
        throw new SelfRoleConfigError(
          `panel "${panel.id}" option "${option.key}" role ${option.roleId}` +
            `${role.name ? ` ("${role.name}")` : ''} does not have a visible Discord color`,
        );
      }
      const unsafeGrant = everyone && guildId
        ? findSelfRoleUnsafeChannelGrant({
            guildId,
            roleId: option.roleId,
            everyonePermissions: everyone.permissions,
            rolePermissions: livePermissions,
            channels,
          })
        : null;
      if (unsafeGrant) {
        throw new SelfRoleConfigError(
          `panel "${panel.id}" option "${option.key}" role ${option.roleId}` +
            `${role.name ? ` ("${role.name}")` : ''} has disallowed effective channel permission ` +
            `${unsafeGrant.permission} in channel ${unsafeGrant.channelId}` +
            `${unsafeGrant.channelName ? ` ("${unsafeGrant.channelName}")` : ''}`,
        );
      }
    }
  }
}

function parsePanel(value: unknown, index: number): SelfRolePanel {
  const at = `panel[${index}]`;
  const panel = record(value, at);
  const id = shortKey(panel.id, `${at}.id`);
  const channelId = snowflake(panel.channelId, `${at}.channelId`);
  const messageId = snowflake(panel.messageId, `${at}.messageId`);
  const mode = panel.mode;
  if (mode !== 'button' && mode !== 'select' && mode !== 'reaction') {
    throw new SelfRoleConfigError(`${at}.mode must be "button", "select", or "reaction"`);
  }
  const exclusive = optionalBoolean(panel.exclusive, `${at}.exclusive`) ?? false;
  const color = optionalBoolean(panel.color, `${at}.color`) ?? false;
  if (color && !exclusive) throw new SelfRoleConfigError(`${at}.color requires exclusive=true`);

  if (!Array.isArray(panel.options) || panel.options.length === 0) {
    throw new SelfRoleConfigError(`${at}.options must be a non-empty array`);
  }
  if (mode === 'button' && panel.options.length > 25) {
    throw new SelfRoleConfigError(`${at} has more than Discord's 25-button limit`);
  }
  if (mode === 'select' && panel.options.length > 25) {
    throw new SelfRoleConfigError(`${at} has more than Discord's 25-option select limit`);
  }
  if (mode === 'reaction' && panel.options.length > 20) {
    throw new SelfRoleConfigError(`${at} has more than Discord's 20-reaction limit`);
  }

  const optionKeys = new Set<string>();
  const roleIds = new Set<string>();
  const emojis = new Set<string>();
  const options = panel.options.map((option, optionIndex) => {
    const oat = `${at}.options[${optionIndex}]`;
    const o = record(option, oat);
    const key = shortKey(o.key, `${oat}.key`);
    const label = text(o.label, `${oat}.label`, 100);
    const roleId = snowflake(o.roleId, `${oat}.roleId`);
    const permissions = permissionMask(o.permissions, `${oat}.permissions`);
    const disallowed = findSelfRoleDisallowedPermission(permissions);
    if (disallowed) {
      throw new SelfRoleConfigError(
        `${oat}.roleId ${roleId} has disallowed permission ${disallowed} in ${oat}.permissions`,
      );
    }
    const emoji = optionalText(o.emoji, `${oat}.emoji`, 100);
    const description = optionalText(o.description, `${oat}.description`, 100);
    const emojiKey = emoji ? emojiIdentity(emoji) : undefined;

    if (optionKeys.has(key)) throw new SelfRoleConfigError(`${at} has duplicate option key "${key}"`);
    if (roleIds.has(roleId)) throw new SelfRoleConfigError(`${at} offers role ${roleId} more than once`);
    if (mode === 'reaction' && !emoji) throw new SelfRoleConfigError(`${oat}.emoji is required`);
    if (mode === 'reaction' && emojiKey && emojis.has(emojiKey)) {
      throw new SelfRoleConfigError(`${at} has duplicate reaction emoji "${emoji}"`);
    }
    optionKeys.add(key);
    roleIds.add(roleId);
    if (emojiKey) emojis.add(emojiKey);
    return { key, label, roleId, permissions, ...(emoji ? { emoji } : {}), ...(description ? { description } : {}) };
  });

  if (mode === 'button') {
    for (const [optionIndex, option] of options.entries()) {
      const customId = selfRoleCustomId(id, option.key);
      if (customId.length > 100) {
        throw new SelfRoleConfigError(
          `panel[${index}].options[${optionIndex}].key "${option.key}" builds button custom_id ` +
            `"${customId}" (${customId.length} chars), over Discord's 100-char custom_id limit`,
        );
      }
    }
  }

  return { id, channelId, messageId, mode, exclusive, color, options };
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SelfRoleConfigError(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, at: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new SelfRoleConfigError(`${at} must be a non-empty string no longer than ${max} characters`);
  }
  return value;
}

function optionalText(value: unknown, at: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return text(value, at, max);
}

function shortKey(value: unknown, at: string): string {
  const key = text(value, at, 60);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
    throw new SelfRoleConfigError(`${at} must contain only lowercase letters, digits, _ or -`);
  }
  return key;
}

function snowflake(value: unknown, at: string): string {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) {
    throw new SelfRoleConfigError(`${at} must be a Discord snowflake string`);
  }
  return value;
}

function permissionMask(value: unknown, at: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new SelfRoleConfigError(`${at} must be a Discord permission bitfield string`);
  }
  try {
    return BigInt(value).toString();
  } catch {
    throw new SelfRoleConfigError(`${at} must be a Discord permission bitfield string`);
  }
}

function optionalBoolean(value: unknown, at: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new SelfRoleConfigError(`${at} must be boolean`);
  return value;
}
