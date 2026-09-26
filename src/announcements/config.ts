import { assertActivationPermitted, botTokenFrom } from '../live/activation.ts';

export interface AnnouncementsConfig {
  enabled: boolean;
  feedPollSeconds: number;
}

/**
 * Default-off. When enabled, the guild and bot token must pass the live-activation
 * allowlist (`src/live/activation.ts`): staging always, live only once
 * `announcements` is cleared there.
 */
export function loadAnnouncementsConfig(
  env: NodeJS.ProcessEnv = process.env,
  token: string | null = botTokenFrom(env),
): AnnouncementsConfig {
  const enabled = env.TWO_ANNOUNCEMENTS === '1';
  if (enabled) assertActivationPermitted('announcements', env.DISCORD_GUILD_ID, token);
  const feedPollSeconds = Number(env.TWO_FEED_POLL_SECONDS ?? 300);
  if (!Number.isInteger(feedPollSeconds) || feedPollSeconds < 60 || feedPollSeconds > 86400) {
    throw new Error('TWO_FEED_POLL_SECONDS must be an integer between 60 and 86400.');
  }
  return { enabled, feedPollSeconds };
}
