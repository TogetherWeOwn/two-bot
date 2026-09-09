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
