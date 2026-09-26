import { readSecret, credentialSource } from '../core/credentials.ts';
import { assertActivationPermitted, botTokenFrom } from '../live/activation.ts';
import { MODERATION_ACTIONS } from './types.ts';

export interface ModerationConfig {
  enabled: boolean;
  owenUserId: string;
  protectedRoleIds: Set<string>;
  /**
   * Null when moderation is enabled without a secret provisioned: markers are
   * then never minted or trusted, which is safe (falls back to the pre-MAC
   * "reason discarded on correlation" behaviour) but forgoes the gateway
   * convergence TOG-2223 #8 protects.
   */
  moderationAuditSecret: string | null;
}

export function loadModerationConfig(
  env: NodeJS.ProcessEnv = process.env,
  token: string | null = botTokenFrom(env),
): ModerationConfig {
  const enabled = env.TWO_MODERATION === '1';
  // TOG-3186: moderation had no guild fence at all before the allowlist.
  if (enabled) assertActivationPermitted('moderation', env.DISCORD_GUILD_ID, token);
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
  const moderationAuditSecret = readSecret(
    'moderation_audit_secret',
    ['TWO_MODERATION_AUDIT_SECRET'],
    credentialSource(env),
  );
  return { enabled, owenUserId, protectedRoleIds, moderationAuditSecret };
}

export { MODERATION_ACTIONS };
