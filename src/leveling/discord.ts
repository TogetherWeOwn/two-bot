import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
} from 'discord.js';
import { log } from '../core/log.ts';
import { assertStagingGuild } from '../e2e/session.ts';
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

/**
 * The named revoker for `applyLevelRoles` (TOG-4963).
 *
 * Removes configured reward roles the member no longer earns at `level`.
 * Staging-only: fenced by the single shared `assertStagingGuild` before any
 * DB read or Discord write, so the live guild and any other guild are refused
 * with a throw, not a silent no-op. Fail-closed on Manage Roles and hierarchy
 * gaps: if any target is above the bot or the bot cannot manage roles, the
 * whole revoke is refused and logged, never applied partially. Discord write
 * failures are logged, never thrown, matching the grant side.
 */
export async function removeLevelRoles(member: GuildMember, service: LevelingService, level: number): Promise<void> {
  assertStagingGuild(member.guild.id);
  const rewards = await service.roleRewards(member.guild.id);
  if (!rewards.length) return;
  const unearned = rewards
    .filter((reward) => reward.level > level)
    .map((reward) => reward.roleId);
  const held = unearned.filter((roleId) => member.roles.cache.has(roleId));
  if (!held.length) return;
  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    log.error('level_role_revoke_refused', {
      guildId: member.guild.id,
      memberId: member.id,
      level,
      roleIds: held,
      reason: 'bot member does not have Manage Roles',
    });
    return;
  }
  const aboveBot = held.filter((roleId) => {
    const role = member.guild.roles.cache.get(roleId);
    return !role || role.managed || !role.editable;
  });
  if (aboveBot.length) {
    log.error('level_role_revoke_refused', {
      guildId: member.guild.id,
      memberId: member.id,
      level,
      roleIds: held,
      reason: `role hierarchy: ${aboveBot.join(',')} not below the bot`,
    });
    return;
  }
  try {
    await member.roles.remove(held, `TWO leveling: below level thresholds at level ${level}`);
  } catch (err) {
    log.error('level_role_revoke_failed', {
      guildId: member.guild.id,
      memberId: member.id,
      level,
      roleIds: held,
      err: String(err),
    });
  }
}

export function registerLeveling(client: Client, deps: LevelingDiscordDeps): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;
    if (deps.guildId && interaction.guildId !== deps.guildId) return;
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
