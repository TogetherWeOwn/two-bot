/**
 * Config for the invite redirect service (TOG-116).
 *
 * Read straight from the environment rather than through src/core/config.ts,
 * for the same reason internal/config.ts does: this is a separate process with
 * a separate lifecycle, and it deliberately does NOT need a Discord token. It
 * reads a campaign table and writes an event; it never talks to Discord. Giving
 * it the bot token to start would be handing a public-facing listener a
 * credential it has no use for.
 *
 * | Variable | Meaning |
 * |---|---|
 * | `TWO_REDIRECT_BIND_HOST` | Address to bind. Default `127.0.0.1`, for the reverse proxy in front of it. |
 * | `TWO_REDIRECT_PORT` | Default `8088`. |
 * | `DISCORD_GUILD_ID` | Which guild the clicks belong to. Required. |
 * | `TWO_REDIRECT_FALLBACK_CODE` | Invite code for `/` and for database outages. Optional but recommended. |
 * | `TWO_DATABASE_URL` | The funnel database, as everywhere else. |
 */

import { isValidInviteCode } from './campaigns.ts';

export interface RedirectConfig {
  host: string;
  port: number;
  guildId: string;
  fallbackInviteCode: string | null;
}

export function loadRedirectConfig(env: NodeJS.ProcessEnv = process.env): RedirectConfig {
  const guildId = env.DISCORD_GUILD_ID || '';
  if (!guildId) {
    throw new Error(
      'The invite redirect needs DISCORD_GUILD_ID - a click has to be recorded against a guild.',
    );
  }
  const rawPort = env.TWO_REDIRECT_PORT ?? '8088';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `TWO_REDIRECT_PORT="${rawPort}" is invalid - expected an integer port 1-65535.`,
    );
  }
  const fallbackInviteCode = env.TWO_REDIRECT_FALLBACK_CODE || null;
  if (fallbackInviteCode !== null && !isValidInviteCode(fallbackInviteCode)) {
    throw new Error(
      `TWO_REDIRECT_FALLBACK_CODE="${fallbackInviteCode}" is invalid - pass the invite code only, not a discord.gg/ URL.`,
    );
  }
  return {
    host: env.TWO_REDIRECT_BIND_HOST || '127.0.0.1',
    port,
    guildId,
    fallbackInviteCode,
  };
}
