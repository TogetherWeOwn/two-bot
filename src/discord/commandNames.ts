import type { ApplicationCommandDataResolvable } from 'discord.js';
import { automationCommandData } from '../automations/discord.ts';
import { LEVELING_COMMANDS } from '../leveling/discord.ts';
import { MODERATION_COMMAND_DATA } from '../moderation/commands.ts';

/** Commands that are always published when a guild is configured. */
export const CORE_COMMAND_DATA: ApplicationCommandDataResolvable[] = [
  ...LEVELING_COMMANDS,
  ...automationCommandData(),
];

/**
 * Every name Owen owns, including feature-gated commands. Deriving this set
 * from the command definitions prevents a new built-in from becoming
 * shadowable because somebody forgot to update a second handwritten list.
 */
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(
  [...CORE_COMMAND_DATA, ...MODERATION_COMMAND_DATA].map(commandName),
);

export function commandName(command: ApplicationCommandDataResolvable): string {
  return 'name' in command ? command.name : command.toJSON().name;
}

/** Discord's total guild application-command ceiling. */
export const DISCORD_GUILD_COMMAND_LIMIT = 100;
/** Space left for admin-defined commands after every Owen command is reserved. */
export const MAX_CUSTOM_COMMANDS = DISCORD_GUILD_COMMAND_LIMIT - BUILTIN_COMMAND_NAMES.size;
