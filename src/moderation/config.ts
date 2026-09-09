import { MODERATION_ACTIONS } from './types.ts';

export interface ModerationConfig {
  enabled: boolean;
  owenUserId: string;
  protectedRoleIds: Set<string>;
}

export function loadModerationConfig(env: NodeJS.ProcessEnv = process.env): ModerationConfig {
  const enabled = env.TWO_MODERATION === '1';
  const owenUserId = env.TWO_OWEN_USER_ID ?? '';
  const protectedRoleIds = new Set(
    (env.TWO_MODERATION_PROTECTED_ROLE_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (enabled && !/^\d{17,20}$/.test(owenUserId)) {
    throw new Error('TWO_MODERATION=1 requires TWO_OWEN_USER_ID to be Owen\'s Discord id.');
  }
  for (const roleId of protectedRoleIds) {
    if (!/^\d{17,20}$/.test(roleId)) {
      throw new Error('TWO_MODERATION_PROTECTED_ROLE_IDS must contain Discord role ids.');
    }
  }
  return { enabled, owenUserId, protectedRoleIds };
}

export { MODERATION_ACTIONS };
