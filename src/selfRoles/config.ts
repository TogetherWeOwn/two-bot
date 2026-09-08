import { emojiIdentity } from './plan.ts';
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
  for (const panel of panels) {
    if (panelIds.has(panel.id)) throw new SelfRoleConfigError(`duplicate panel id "${panel.id}"`);
    if (messageIds.has(panel.messageId)) {
      throw new SelfRoleConfigError(`message ${panel.messageId} is assigned to more than one panel`);
    }
    panelIds.add(panel.id);
    messageIds.add(panel.messageId);
  }
  return panels;
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

  const optionKeys = new Set<string>();
  const roleIds = new Set<string>();
  const emojis = new Set<string>();
  const options = panel.options.map((option, optionIndex) => {
    const oat = `${at}.options[${optionIndex}]`;
    const o = record(option, oat);
    const key = shortKey(o.key, `${oat}.key`);
    const label = text(o.label, `${oat}.label`, 100);
    const roleId = snowflake(o.roleId, `${oat}.roleId`);
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
    return { key, label, roleId, ...(emoji ? { emoji } : {}), ...(description ? { description } : {}) };
  });

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

function optionalBoolean(value: unknown, at: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new SelfRoleConfigError(`${at} must be boolean`);
  return value;
}
