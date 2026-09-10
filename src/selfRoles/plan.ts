import type { SelfRoleOption, SelfRolePanel } from './types.ts';

export type SelfRolePlan =
  | {
      ok: true;
      option: SelfRoleOption;
      operation: 'add' | 'remove' | 'replace';
      addRoleIds: string[];
      removeRoleIds: string[];
      outcome: 'assigned' | 'removed' | 'switched' | 'already_held' | 'already_absent';
    }
  | { ok: false; code: 'unknown_option' | 'wrong_source'; reason: string };

export function planSelfRoleChange(opts: {
  panel: SelfRolePanel;
  optionKey: string;
  memberRoleIds: readonly string[];
  source: SelfRolePanel['mode'];
  remove: boolean;
}): SelfRolePlan {
  const { panel, optionKey, source, remove } = opts;
  if (source !== panel.mode) {
    return {
      ok: false,
      code: 'wrong_source',
      reason: `panel ${panel.id} expects ${panel.mode}, received ${source}`,
    };
  }
  const option = panel.options.find((o) => o.key === optionKey);
  if (!option) {
    return { ok: false, code: 'unknown_option', reason: `panel ${panel.id} has no option ${optionKey}` };
  }

  const held = new Set(opts.memberRoleIds);
  if (remove) {
    return {
      ok: true,
      option,
      operation: 'remove',
      addRoleIds: [],
      removeRoleIds: held.has(option.roleId) ? [option.roleId] : [],
      outcome: held.has(option.roleId) ? 'removed' : 'already_absent',
    };
  }

  if (!panel.exclusive) {
    return {
      ok: true,
      option,
      operation: 'add',
      addRoleIds: held.has(option.roleId) ? [] : [option.roleId],
      removeRoleIds: [],
      outcome: held.has(option.roleId) ? 'already_held' : 'assigned',
    };
  }

  const removeRoleIds = panel.options
    .map((o) => o.roleId)
    .filter((roleId) => roleId !== option.roleId && held.has(roleId));
  const addRoleIds = held.has(option.roleId) ? [] : [option.roleId];
  return {
    ok: true,
    option,
    operation: 'replace',
    addRoleIds,
    removeRoleIds,
    outcome:
      removeRoleIds.length > 0
        ? 'switched'
        : addRoleIds.length > 0
          ? 'assigned'
          : 'already_held',
  };
}

/** Component ids are signed by Discord, but still parsed as untrusted input. */
export function selfRoleCustomId(panelId: string, optionKey?: string): string {
  return optionKey === undefined ? `two:self-role:${panelId}` : `two:self-role:${panelId}:${optionKey}`;
}

export function parseSelfRoleCustomId(customId: string): { panelId: string; optionKey?: string } | null {
  const match = /^two:self-role:([a-z0-9][a-z0-9_-]*)(?::([a-z0-9][a-z0-9_-]*))?$/.exec(customId);
  if (!match) return null;
  return { panelId: match[1], ...(match[2] ? { optionKey: match[2] } : {}) };
}

export function reactionOptionKey(panel: SelfRolePanel, emoji: { id: string | null; name: string | null }): string | null {
  const key = emoji.id ?? emoji.name;
  if (!key) return null;
  return panel.options.find((o) => o.emoji && emojiIdentity(o.emoji) === key)?.key ?? null;
}

/** Unicode stays unchanged; Discord custom-emoji mentions compare by snowflake. */
export function emojiIdentity(value: string): string {
  return /^<a?:[^:>]+:(\d{17,20})>$/.exec(value)?.[1] ?? value;
}

/** Discord's reaction endpoint wants name:id rather than the component mention. */
export function reactionEndpointEmoji(value: string): string {
  const custom = /^<a?:([^:>]+):(\d{17,20})>$/.exec(value);
  return custom ? `${custom[1]}:${custom[2]}` : value;
}
