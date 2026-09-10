import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import { nowIso } from '../core/events.ts';
import { log } from '../core/log.ts';
import type { CommunityFactStore } from './communityFacts.ts';

export const COMMUNITY_ATTENDANCE_COMMAND = {
  name: 'attendance',
  description: 'Record a verified human attendee for a Discord event occurrence.',
  defaultMemberPermissions: PermissionFlagsBits.ManageEvents,
  options: [
    {
      name: 'event-occurrence',
      description: 'Scheduled event id or stable occurrence id.',
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: 'member',
      description: 'Human member who attended.',
      type: ApplicationCommandOptionType.User,
      required: true,
    },
  ],
} as const;

export interface CommunityAttendanceDeps {
  facts: CommunityFactStore;
  guildId?: string | null;
  now?: () => string;
}

export async function recordCommunityAttendance(
  interaction: ChatInputCommandInteraction,
  deps: CommunityAttendanceDeps,
): Promise<boolean> {
  const eventOccurrenceId = interaction.options.getString('event-occurrence', true).trim();
  const member = interaction.options.getUser('member', true);
  const inserted = await deps.facts.recordAttendance({
    guildId: interaction.guildId!,
    actorId: member.id,
    isBot: member.bot,
    eventOccurrenceId,
    occurredAt: (deps.now ?? nowIso)(),
    proof: 'host_checkin',
  });
  await interaction.reply({
    content: inserted
      ? `Recorded <@${member.id}> for event occurrence \`${eventOccurrenceId}\`.`
      : `Attendance for <@${member.id}> and event occurrence \`${eventOccurrenceId}\` was already recorded.`,
    allowedMentions: { parse: [] },
    flags: MessageFlags.Ephemeral,
  });
  return inserted;
}

export function registerCommunityAttendance(client: Client, deps: CommunityAttendanceDeps): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'attendance' || !interaction.guildId) return;
    if (deps.guildId && interaction.guildId !== deps.guildId) return;
    try {
      await recordCommunityAttendance(interaction, deps);
    } catch (err) {
      log.error('community_attendance_failed', { guildId: interaction.guildId, err: String(err) });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Attendance was not recorded.', flags: MessageFlags.Ephemeral });
      }
    }
  });
}
