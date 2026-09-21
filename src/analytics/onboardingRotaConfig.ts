import { credentialSource, readSecret } from '../core/credentials.ts';
import { LIVE_GUILD_ID } from '../staging/spec.ts';

export type OnboardingRotaRuntimeConfig =
  | { enabled: false; noticeEnabled: false }
  | {
    enabled: true;
    noticeEnabled: boolean;
    guildId: string;
    pseudonymKey: string;
    noticeChannelId: string | null;
    primaryActorId?: string;
  };

/** Boot-only controls. No collection or Discord side effects happen here. */
export function loadOnboardingRotaConfig(
  env: NodeJS.ProcessEnv = process.env,
): OnboardingRotaRuntimeConfig {
  const enabled = env.TWO_ONBOARDING_ROTA_MEASUREMENT === '1';
  // The master off switch must work even with a stale notice flag or bad key.
  if (!enabled) return { enabled: false, noticeEnabled: false };

  const guildId = env.DISCORD_GUILD_ID?.trim() ?? '';
  const stagingGuildId = env.DISCORD_STAGING_GUILD_ID?.trim() ?? '';
  if (!/^\d{17,20}$/.test(guildId) || guildId === LIVE_GUILD_ID || guildId !== stagingGuildId) {
    throw new Error(
      'Onboarding rota is staging-only: DISCORD_GUILD_ID must match ' +
      'DISCORD_STAGING_GUILD_ID and must not be the live TWO guild.',
    );
  }

  const pseudonymKey = readSecret(
    'onboarding_rota_pseudonym_key',
    ['TWO_ONBOARDING_ROTA_PSEUDONYM_KEY'],
    credentialSource(env),
  );
  if (!pseudonymKey || Buffer.byteLength(pseudonymKey, 'utf8') < 32 || !pseudonymKey.trim()) {
    throw new Error('Onboarding rota requires a pseudonym key of at least 32 bytes.');
  }

  const noticeEnabled = env.TWO_ONBOARDING_ROTA_NOTICE === '1';
  const noticeChannelId = noticeEnabled ? env.DISCORD_STAFF_ALERT_CHANNEL_ID?.trim() ?? '' : null;
  if (noticeEnabled && !/^\d{17,20}$/.test(noticeChannelId ?? '')) {
    throw new Error('Onboarding rota notices require DISCORD_STAFF_ALERT_CHANNEL_ID.');
  }
  const primaryActorId = env.TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID?.trim();
  if (primaryActorId !== undefined && !/^\d{17,20}$/.test(primaryActorId)) {
    throw new Error('Onboarding rota primary binding requires a valid Discord user id.');
  }
  // A valid id is not a permissions check. The sender must verify guild identity
  // and staff-only visibility against Discord before every send.
  return { enabled: true, noticeEnabled, guildId, pseudonymKey, noticeChannelId,
    ...(primaryActorId ? { primaryActorId } : {}) };

}
