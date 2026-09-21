import {
  ApplicationCommandOptionType, Events, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import type { DiscordOnboardingRota } from './onboardingRota.ts';
import { log } from '../core/log.ts';

export const ROTA_ACKNOWLEDGEMENT_COMMAND = {
  name: 'rota-acknowledge',
  description: 'Accepted primary: acknowledge ownership of a newcomer response.',
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
  dmPermission: false,
  options: [{
    name: 'message-link', description: 'Discord link to the newcomer’s first eligible message.',
    type: ApplicationCommandOptionType.String, required: true,
  }],
} as const;

export async function acknowledgeRotaInteraction(
  interaction: ChatInputCommandInteraction,
  observer: Pick<DiscordOnboardingRota, 'acknowledgePrimary'>,
): Promise<void> {
  try {
    // Reserve the observation before waiting for the ephemeral deferral.
    const [recorded] = await Promise.all([
      observer.acknowledgePrimary(interaction),
      interaction.deferReply({ flags: MessageFlags.Ephemeral }),
    ]);
    await interaction.editReply({
      content: recorded
        ? 'Primary acknowledgement recorded. A human reply is still required; the 24-hour target is unchanged.'
        : 'No new acknowledgement recorded. The request may be ineligible or already acknowledged.',
      allowedMentions: { parse: [] },
    });
  } catch {
    // Never log interaction payloads, message links, identities, or SQL errors.
    log.error('onboarding_rota_acknowledgement_failed', { classification: 'measurement_gap' });
  }
}

export function registerRotaAcknowledgement(
  client: Client, guildId: string, observer: Pick<DiscordOnboardingRota, 'acknowledgePrimary'>,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== ROTA_ACKNOWLEDGEMENT_COMMAND.name ||
        interaction.guildId !== guildId) return;
    void acknowledgeRotaInteraction(interaction, observer);
  });
}
