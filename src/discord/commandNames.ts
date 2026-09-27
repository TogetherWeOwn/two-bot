import type { ApplicationCommandDataResolvable } from 'discord.js';
import { automationCommandData } from '../automations/discord.ts';
import { LEVELING_COMMANDS } from '../leveling/discord.ts';
import { MODERATION_COMMAND_DATA } from '../moderation/commands.ts';
import { COMMUNITY_ATTENDANCE_COMMAND } from '../analytics/communityAttendance.ts';
import { announcementCommandData } from '../announcements/discord.ts';
import { ROTA_ACKNOWLEDGEMENT_COMMAND } from './rotaAcknowledgement.ts';
import { tempVoiceCommandData } from '../tempVoice/discord.ts';

/** Commands that are always published when a guild is configured. */
export const CORE_COMMAND_DATA: ApplicationCommandDataResolvable[] = [...LEVELING_COMMANDS];

/** Community scorecard commands, published only while its durable capture is enabled. */
export const COMMUNITY_COMMAND_DATA: ApplicationCommandDataResolvable[] = [COMMUNITY_ATTENDANCE_COMMAND];

/** Staging-gated event, LFG, and feed-relay commands. */
export const ANNOUNCEMENT_COMMAND_DATA: ApplicationCommandDataResolvable[] = announcementCommandData();

/** Staging-gated automation commands, reserved even while publication is off. */
export const AUTOMATION_COMMAND_DATA: ApplicationCommandDataResolvable[] = automationCommandData();

/** Staging-gated temporary-voice commands (TOG-3052). */
export const TEMP_VOICE_COMMAND_DATA: ApplicationCommandDataResolvable[] = tempVoiceCommandData();

/**
 * Every name Owen owns, including feature-gated commands. Deriving this set
 * from the command definitions prevents a new built-in from becoming
 * shadowable because somebody forgot to update a second handwritten list.
 */
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(
  [
    ...CORE_COMMAND_DATA,
    ...COMMUNITY_COMMAND_DATA,
    ...AUTOMATION_COMMAND_DATA,
    ...ANNOUNCEMENT_COMMAND_DATA,
    ...TEMP_VOICE_COMMAND_DATA,
    ...MODERATION_COMMAND_DATA,
    ROTA_ACKNOWLEDGEMENT_COMMAND,
  ].map(commandName),
);

export function commandName(command: ApplicationCommandDataResolvable): string {
  return 'name' in command ? command.name : command.toJSON().name;
}

/** Discord's total guild application-command ceiling. */
export const DISCORD_GUILD_COMMAND_LIMIT = 100;
/** Space left for admin-defined commands after every Owen command is reserved. */
export const MAX_CUSTOM_COMMANDS = DISCORD_GUILD_COMMAND_LIMIT - BUILTIN_COMMAND_NAMES.size;
