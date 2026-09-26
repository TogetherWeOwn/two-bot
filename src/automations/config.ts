import { assertActivationPermitted, botTokenFrom } from '../live/activation.ts';

export interface AutomationConfig {
  enabled: boolean;
  textCommandsEnabled: boolean;
}

/**
 * Default-off. When enabled, the guild and the application behind the bot token
 * must pass the live-activation allowlist (`src/live/activation.ts`), so a
 * copied environment cannot publish commands or post in live unless
 * `automations` is cleared there.
 */
export function loadAutomationConfig(
  env: NodeJS.ProcessEnv = process.env,
  token: string | null = botTokenFrom(env),
): AutomationConfig {
  const enabled = env.TWO_AUTOMATIONS === '1';
  if (enabled) assertActivationPermitted('automations', env.DISCORD_GUILD_ID, token);
  return {
    enabled,
    textCommandsEnabled: enabled && env.TWO_TEXT_COMMANDS === '1',
  };
}
