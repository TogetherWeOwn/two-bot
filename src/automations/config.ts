import { TWO_STAGING_GUILD_ID } from '../staging/spec.ts';

export interface AutomationConfig {
  enabled: boolean;
  textCommandsEnabled: boolean;
}

/**
 * Automations remain staging-only and default-off until the separately reviewed
 * live rollout changes this boundary. This check is independent of the bot
 * token, so a copied environment still cannot publish commands or post in live.
 */
export function loadAutomationConfig(env: NodeJS.ProcessEnv = process.env): AutomationConfig {
  const enabled = env.TWO_AUTOMATIONS === '1';
  const guildId = env.DISCORD_GUILD_ID?.trim();
  if (enabled && guildId !== TWO_STAGING_GUILD_ID) {
    throw new Error(
      `TWO_AUTOMATIONS=1 is staging-only: expected guild ${TWO_STAGING_GUILD_ID}, ` +
      `got ${guildId || 'unset'}. Live rollout requires a separately reviewed operator change.`,
    );
  }
  return {
    enabled,
    textCommandsEnabled: enabled && env.TWO_TEXT_COMMANDS === '1',
  };
}
