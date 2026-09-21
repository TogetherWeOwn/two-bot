import { ChannelType, PermissionFlagsBits, type Client, type TextChannel } from 'discord.js';

export interface RotaNoticeAccessInput {
  guildId: string;
  channelId: string;
  /** Explicit accepted human readers, never inferred from staff roles. */
  allowedReaderIds: readonly string[] | ReadonlySet<string>;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Read-only pre-send snapshot, NOT an atomic permission/send guarantee. Returns
 * null on unknown state or fetch failure, without logging identities or errors.
 * Full member-fetch completion plus stable REST approximate counts is a census
 * consistency check, not an exact or atomic membership proof. Skew fails closed.
 * The future sender must re-run this immediately before sending/recovery and
 * separately enforce feature gates, eligibility, durable claims and recovery.
 */
export async function verifyRotaNoticeAccess(
  client: Client,
  input: RotaNoticeAccessInput,
): Promise<TextChannel | null> {
  try {
    if (!client || !input || !validId(input.guildId) || !validId(input.channelId)) return null;
    const botId = client.user?.id;
    if (!validId(botId) || client.user?.bot !== true) return null;
    const allowed = new Set(input.allowedReaderIds ?? []);
    if (!allowed.size || allowed.has(botId) || [...allowed].some(id => !validId(id))) return null;

    // REST withCounts refreshes approximateMemberCount, NOT gateway memberCount.
    const guild = await client.guilds.fetch({ guild: input.guildId, force: true, withCounts: true });
    if (!guild || guild.id !== input.guildId || guild.available !== true ||
        !validId(guild.ownerId) || !allowed.has(guild.ownerId)) return null;
    const ownerId = guild.ownerId;
    const countBefore = guild.approximateMemberCount;
    if (!validCount(countBefore)) return null;

    const roles = await guild.roles.fetch();
    const everyone = roles.get(guild.id);
    if (!everyone || everyone.id !== guild.id || everyone.guild.id !== guild.id) return null;
    const channel = await guild.channels.fetch(input.channelId, { force: true });
    if (!channel || channel.id !== input.channelId || channel.type !== ChannelType.GuildText ||
        channel.guild.id !== input.guildId) return null;
    if ((channel as unknown as { partial?: boolean }).partial) return null;

    const VIEW = PermissionFlagsBits.ViewChannel;
    const HISTORY = PermissionFlagsBits.ReadMessageHistory;
    const SEND = PermissionFlagsBits.SendMessages;
    // Unknown permissions are not proof of a deny. Owner/admin bypasses matter.
    const everyonePermissions = channel.permissionsFor(everyone);
    if (!everyonePermissions || everyonePermissions.has(VIEW)) return null;
    const bot = await guild.members.fetch({ user: botId, force: true });
    if (!bot || bot.id !== botId || bot.partial || bot.guild.id !== guild.id ||
        bot.user.id !== botId || bot.user.bot !== true ||
        !channel.permissionsFor(bot)?.has(VIEW | HISTORY | SEND)) return null;

    const all = await guild.members.fetch();
    const refreshed = await client.guilds.fetch({ guild: input.guildId, force: true, withCounts: true });
    if (!refreshed || refreshed.id !== input.guildId || refreshed.available !== true ||
        refreshed.ownerId !== ownerId || refreshed.approximateMemberCount !== countBefore) return null;
    if (!all || all.size !== countBefore || !all.has(botId)) return null;

    for (const [id, member] of all) {
      if (!member || member.partial || !validId(id) || member.id !== id ||
          member.guild.id !== input.guildId || member.user.id !== id ||
          typeof member.user.bot !== 'boolean' || member.user.partial) return null;
      const permissions = channel.permissionsFor(member);
      if (!permissions) return null;
      if (id === botId && (!member.user.bot || !permissions.has(VIEW | HISTORY | SEND))) return null;
      if (permissions.has(VIEW) && id !== botId && !allowed.has(id)) return null;
    }
    for (const id of allowed) {
      const reader = all.get(id);
      if (!reader || reader.user.bot !== false || !channel.permissionsFor(reader)?.has(VIEW | HISTORY)) return null;
    }
    return channel;
  } catch {
    return null;
  }
}
