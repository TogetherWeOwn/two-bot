import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
} from 'discord.js';
import { log } from '../core/log.ts';
import { totalXpForLevel, type LevelingService, type LevelProfile } from './service.ts';

export const LEVELING_COMMANDS = [
  {
    name: 'rank',
    description: 'Show your XP, level and server rank.',
    options: [
      {
        name: 'member',
        description: 'Show another member.',
        type: ApplicationCommandOptionType.User,
        required: false,
      },
    ],
  },
  {
    name: 'leaderboard',
    description: 'Show the server XP leaderboard.',
  },
] as const;

export interface LevelingDiscordDeps {
  service: LevelingService;
  guildId?: string | null;
}

export function rankText(profile: LevelProfile, displayName: string): string {
  const currentFloor = totalXpForLevel(profile.level);
  const progress = profile.xp - currentFloor;
  const levelSpan = profile.nextLevelXp - currentFloor;
  const next = profile.nextLevelXp - profile.xp;
  return [
    `**${displayName}**`,
    `Level **${profile.level}** · Rank **#${profile.rank}** of **${profile.memberCount}**`,
    `XP **${profile.xp.toLocaleString()}** · ${progress.toLocaleString()}/${levelSpan.toLocaleString()} this level · **${next.toLocaleString()}** to level ${profile.level + 1}`,
  ].join('\n');
}

export async function applyLevelRoles(member: GuildMember, service: LevelingService, level: number): Promise<void> {
  const rewards = await service.roleRewards(member.guild.id);
  if (!rewards.length) return;
  const earned = rewards.filter((reward) => reward.level <= level).map((reward) => reward.roleId);
  if (!earned.length) return;
  try {
    await member.roles.add(earned, `TWO leveling: reached level ${level}`);
  } catch (err) {
    log.error('level_role_reward_failed', {
      guildId: member.guild.id,
      memberId: member.id,
      level,
      roleIds: earned,
      err: String(err),
    });
  }
}

export function registerLeveling(client: Client, deps: LevelingDiscordDeps): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;
    if (interaction.commandName === 'rank') await handleRank(interaction, deps.service);
    if (interaction.commandName === 'leaderboard') await handleLeaderboard(interaction, deps.service);
  });
}

async function handleRank(
  interaction: ChatInputCommandInteraction,
  service: LevelingService,
): Promise<void> {
  const user = interaction.options.getUser('member') ?? interaction.user;
  const profile = await service.profile(interaction.guildId!, user.id);
  await interaction.reply({
    content: rankText(profile, user.globalName ?? user.username),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeaderboard(
  interaction: ChatInputCommandInteraction,
  service: LevelingService,
): Promise<void> {
  const rows = await service.leaderboard(interaction.guildId!, 10);
  const content = rows.length
    ? ['**TWO XP Leaderboard**', ...rows.map((row) =>
        `**${row.rank}.** <@${row.memberId}> · level **${row.level}** · ${row.xp.toLocaleString()} XP`)]
        .join('\n')
    : 'No XP has been earned yet.';
  await interaction.reply({
    content,
    allowedMentions: { parse: [] },
  });
}
