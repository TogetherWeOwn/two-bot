import { TWO_STAGING_GUILD_ID } from '../staging/spec.ts';

export interface AnnouncementsConfig {
  enabled: boolean;
  feedPollSeconds: number;
}

/**
 * The parity slice is staging-only and default-off. Live rollout is a separate,
 * owner-gated operator change after Apollo / Raid Organizer / LFG Tool parity is proven.
 */
export function loadAnnouncementsConfig(env: NodeJS.ProcessEnv = process.env): AnnouncementsConfig {
  const enabled = env.TWO_ANNOUNCEMENTS === '1';
  const guildId = env.DISCORD_GUILD_ID?.trim();
  if (enabled && guildId !== TWO_STAGING_GUILD_ID) {
    throw new Error(
      `TWO_ANNOUNCEMENTS=1 is staging-only: expected guild ${TWO_STAGING_GUILD_ID}, ` +
      `got ${guildId || 'unset'}. Live rollout requires a separately reviewed operator change.`,
    );
  }
  const feedPollSeconds = Number(env.TWO_FEED_POLL_SECONDS ?? 300);
  if (!Number.isInteger(feedPollSeconds) || feedPollSeconds < 60 || feedPollSeconds > 86400) {
    throw new Error('TWO_FEED_POLL_SECONDS must be an integer between 60 and 86400.');
  }
  return { enabled, feedPollSeconds };
}
