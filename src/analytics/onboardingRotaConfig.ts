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
    /** Explicit authorized notice readers, never inferred from staff roles. */
    readerIds?: readonly string[];
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
  // Explicit reader set for the future staff-only notice: accepted primary,
  // Community Manager and President & COO principals, never inferred from
  // staff roles. A valid list is not a permissions check. The sender must
  // verify guild identity and staff-only visibility against Discord before
  // every send.
  const readerRaw = env.TWO_ONBOARDING_ROTA_READER_IDS?.trim();
  let readerIds: readonly string[] | undefined;
  if (readerRaw !== undefined && readerRaw !== '') {
    const ids = readerRaw.split(',').map((id) => id.trim()).filter((id) => id !== '');
    const seen = new Set<string>();
    for (const id of ids) {
      if (!/^\d{17,20}$/.test(id) || seen.has(id)) {
        throw new Error('Onboarding rota reader binding requires comma-separated Discord user ids.');
      }
      seen.add(id);
    }
    if (!seen.size) throw new Error('Onboarding rota reader binding requires comma-separated Discord user ids.');
    readerIds = [...seen];
  }
  return { enabled: true, noticeEnabled, guildId, pseudonymKey, noticeChannelId,
    ...(primaryActorId ? { primaryActorId } : {}),
    ...(readerIds ? { readerIds } : {}) };

}
