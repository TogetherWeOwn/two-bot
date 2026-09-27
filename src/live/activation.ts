import { credentialSource, readSecret } from '../core/credentials.ts';
import {
  applicationIdFromToken,
  LIVE_BOT_APPLICATION_ID,
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  TWO_STAGING_GUILD_ID,
} from '../staging/spec.ts';

/**
 * The one live-activation allowlist (TOG-3186).
 *
 * Before this module there were five staging fences and they disagreed: two
 * checked the guild only, one checked guild and application, automod was a
 * denylist naming the live guild (every third guild passed), and moderation
 * had no fence at all. Every capability that can mutate a guild now asks this
 * module, and this module only.
 *
 * Exactly two identities are ever permitted:
 *   - the staging pair: TWO Staging guild + Owen QA Test application;
 *   - the live pair: the TWO guild + the live Owen application, and only for a
 *     capability listed in LIVE_CLEARED_CAPABILITIES.
 * Everything else fails closed: an unknown guild, an unknown application, a
 * token that does not parse, a mixed pair, an unknown capability name.
 *
 * The application id is derived from the bot token, never from an env var. The
 * live token has been bound under a generic secret name before (see
 * `src/staging/spec.ts`), so "which bot is this" must come from the credential
 * that actually talks to Discord.
 */

export const LIVE_CAPABILITIES = ['self_roles', 'announcements', 'automations', 'automod', 'moderation'] as const;
export type LiveCapability = (typeof LIVE_CAPABILITIES)[number];

/**
 * Capabilities cleared to run in the live guild. Clearing one is a reviewed
 * code change to this line, one capability at a time, and clears nothing else.
 * TOG-5356 clears self_roles only (unblocks TOG-2796); nothing else runs live.
 */
export const LIVE_CLEARED_CAPABILITIES: readonly LiveCapability[] = ['self_roles'];

export type ActivationDecision =
  | { permitted: true; environment: 'staging' | 'live'; applicationId: string }
  | { permitted: false; reason: string };

export function isLiveCapability(name: string): name is LiveCapability {
  return (LIVE_CAPABILITIES as readonly string[]).includes(name);
}

export function evaluateActivation(
  capability: string,
  guildId: string | null | undefined,
  token: string | null | undefined,
  cleared: readonly string[] = LIVE_CLEARED_CAPABILITIES,
): ActivationDecision {
  if (!isLiveCapability(capability)) {
    return { permitted: false, reason: `unknown capability "${capability}"` };
  }
  const unknownCleared = cleared.filter((name) => !isLiveCapability(name));
  if (unknownCleared.length) {
    return { permitted: false, reason: `live clearance names unknown capability "${unknownCleared.join('", "')}"` };
  }
  const applicationId = token ? applicationIdFromToken(token) : null;
  if (!applicationId) {
    return { permitted: false, reason: 'the bot token is missing or unparseable, so its application is unknown' };
  }
  const guild = guildId?.trim() || null;
  const got = `guild ${guild ?? 'unset'} and application ${applicationId}`;
  if (guild === TWO_STAGING_GUILD_ID && applicationId === STAGING_BOT_APPLICATION_ID) {
    return { permitted: true, environment: 'staging', applicationId };
  }
  if (guild === LIVE_GUILD_ID && applicationId === LIVE_BOT_APPLICATION_ID) {
    if (cleared.includes(capability)) return { permitted: true, environment: 'live', applicationId };
    return { permitted: false, reason: `${capability} is not cleared for the live guild (got ${got})` };
  }
  return {
    permitted: false,
    reason:
      `expected guild ${TWO_STAGING_GUILD_ID} with application ${STAGING_BOT_APPLICATION_ID}, ` +
      `or a live-cleared capability on guild ${LIVE_GUILD_ID} with application ${LIVE_BOT_APPLICATION_ID}; got ${got}`,
  };
}

/** Throws unless `capability` may run for this guild and token. Returns which environment it is. */
export function assertActivationPermitted(
  capability: string,
  guildId: string | null | undefined,
  token: string | null | undefined,
  cleared: readonly string[] = LIVE_CLEARED_CAPABILITIES,
): 'staging' | 'live' {
  const decision = evaluateActivation(capability, guildId, token, cleared);
  if (!decision.permitted) {
    throw new Error(`Live-activation allowlist refused ${capability}: ${decision.reason}.`);
  }
  return decision.environment;
}

/** The same token source as `loadConfig().discordToken`, for config loaders that only see `env`. */
export function botTokenFrom(env: NodeJS.ProcessEnv): string | null {
  return readSecret('discord_token', ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN'], credentialSource(env));
}
