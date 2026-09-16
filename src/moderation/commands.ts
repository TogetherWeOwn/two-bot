import { randomUUID } from 'node:crypto';
import {
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
} from 'discord.js';
import { ActionError } from '../internal/errors.ts';
import type { ModerationResolver } from './resolver.ts';
import type { ModerationService } from './service.ts';
import { MODERATION_COMMANDS, requireModerationReason, type ModerationActionName } from './types.ts';

export interface ModerationCommandOptions {
  guildId: string;
  resolver: ModerationResolver;
  service: ModerationService;
}

export const MODERATION_COMMAND_DATA = [
  targetCommand('ban', 'Ban a member'),
  targetDurationCommand('tempban', 'Temporarily ban a member'),
  targetCommand('kick', 'Kick a member'),
  targetDurationCommand('timeout', 'Timeout a member'),
  targetCommand('warn', 'Record a warning for a member'),
  new SlashCommandBuilder()
    .setName('purge').setDescription('Delete recent messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName('count').setDescription('Messages to delete (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
    .addStringOption(reasonOption),
  new SlashCommandBuilder()
    .setName('slowmode').setDescription('Set channel slowmode')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((o) => o.setName('seconds').setDescription('Delay in seconds (0 disables)').setMinValue(0).setMaxValue(21600).setRequired(true))
    .addStringOption(reasonOption),
  channelCommand('lockdown', 'Prevent @everyone from sending messages'),
  channelCommand('unlock', 'Allow @everyone to send messages'),
].map((command) => command.setDMPermission(false).toJSON());

export function registerModerationHandler(client: Client, options: ModerationCommandOptions): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !MODERATION_COMMANDS.includes(interaction.commandName as never)) return;
    if (interaction.guildId !== options.guildId || !interaction.member) {
      await interaction.reply({ content: 'This command is restricted to the configured guild.', ephemeral: true });
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
      const result = await executeInteraction(interaction, options);
      await interaction.editReply(formatResult(result.outcome, result.affected));
    } catch (error) {
      const message = error instanceof ActionError && error.code === 'replayed'
        ? 'This moderation interaction was already completed.'
        : error instanceof ActionError || error instanceof TypeError
          ? error.message
          : 'The moderation action failed.';
      if (interaction.deferred || interaction.replied) await interaction.editReply(message);
      else await interaction.reply({ content: message, ephemeral: true });
    }
  });
}

async function executeInteraction(interaction: ChatInputCommandInteraction, options: ModerationCommandOptions) {
  const member = interaction.member as GuildMember;
  const actor = {
    userId: interaction.user.id,
    roleIds: member.roles.cache.map((role) => role.id),
    highestRolePosition: member.roles.highest.position,
    permissions: member.permissions.bitfield,
  };
  const command = interaction.commandName;
  const action = `moderation.${command}` as ModerationActionName;
  const reason = requireModerationReason(interaction.options.getString('reason', true));
  const targetUser = interaction.options.getUser('target');
  const target = targetUser ? await options.resolver.target(options.guildId, targetUser.id) : undefined;
  const botHighestRolePosition = target
    ? await options.resolver.botHighestRolePosition(options.guildId)
    : undefined;
  const channel = channelAction(action) ? await options.resolver.channel(interaction.channelId) : undefined;

  return options.service.execute({
    action,
    guildId: options.guildId,
    actor,
    target,
    channel,
    botHighestRolePosition,
    reason,
    requestId: randomUUID(),
    idempotencyKey: interaction.id,
    durationSeconds: interaction.options.getInteger('duration_seconds') ?? undefined,
    count: interaction.options.getInteger('count') ?? undefined,
    seconds: interaction.options.getInteger('seconds') ?? undefined,
  });
}

function targetCommand(name: 'ban' | 'kick' | 'warn', description: string) {
  return new SlashCommandBuilder()
    .setName(name).setDescription(description)
    .setDefaultMemberPermissions(permissionFor(name))
    .addUserOption((o) => o.setName('target').setDescription('Member to moderate').setRequired(true))
    .addStringOption(reasonOption);
}

function targetDurationCommand(name: 'tempban' | 'timeout', description: string) {
  return new SlashCommandBuilder()
    .setName(name).setDescription(description)
    .setDefaultMemberPermissions(permissionFor(name))
    .addUserOption((o) => o.setName('target').setDescription('Member to moderate').setRequired(true))
    .addIntegerOption((o) => o.setName('duration_seconds').setDescription('Duration in seconds').setMinValue(60).setRequired(true))
    .addStringOption(reasonOption);
}

function channelCommand(name: 'lockdown' | 'unlock', description: string) {
  return new SlashCommandBuilder()
    .setName(name).setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption(reasonOption);
}

function reasonOption(option: import('discord.js').SlashCommandStringOption) {
  return option.setName('reason').setDescription('Mandatory audit reason').setMaxLength(512).setRequired(true);
}

function permissionFor(name: 'ban' | 'tempban' | 'kick' | 'timeout' | 'warn') {
  if (name === 'ban' || name === 'tempban') return PermissionFlagsBits.BanMembers;
  if (name === 'kick') return PermissionFlagsBits.KickMembers;
  return PermissionFlagsBits.ModerateMembers;
}

function channelAction(action: ModerationActionName): boolean {
  return action === 'moderation.purge' || action === 'moderation.slowmode' || action === 'moderation.lockdown' || action === 'moderation.unlock';
}

function formatResult(outcome: string, affected?: number): string {
  return affected === undefined ? `Moderation action completed: ${outcome}.` : `Moderation action completed: ${outcome} (${affected}).`;
}
