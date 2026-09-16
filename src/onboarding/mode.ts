import type { ActionName } from '../internal/actions.ts';

/** Session onboarding has no role-writing path, including internal actions. */
export function actionsForOnboardingMode(
  mode: 'legacy' | 'session',
  enabled: Set<ActionName>,
): Set<ActionName> {
  const actions = new Set(enabled);
  if (mode === 'session') actions.delete('role.assign');
  return actions;
}

/**
 * Leveling reward roles are a role write, so session mode does not apply them.
 * XP, level-ups and `/rank` are unaffected - only `member.roles.add` is
 * suppressed. Configuring `level_role_rewards` is therefore not enough to break
 * the zero-role-write guarantee a live guild relies on.
 */
export function levelRoleWritesForOnboardingMode(mode: 'legacy' | 'session'): boolean {
  return mode !== 'session';
}
