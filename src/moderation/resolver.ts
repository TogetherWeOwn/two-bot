import { PermissionFlagsBits } from 'discord.js';
import { ActionError } from '../internal/errors.ts';
import type { ModerationActor, ModerationChannel, ModerationTarget } from './types.ts';

export interface ModerationResolver {
  actor(guildId: string, userId: string): Promise<ModerationActor>;
  target(guildId: string, userId: string): Promise<ModerationTarget>;
  channel(channelId: string): Promise<ModerationChannel>;
  botHighestRolePosition(guildId: string): Promise<number>;
}

interface GuildData {
  owner_id?: unknown;
}

interface MemberData {
  user?: { id?: unknown; bot?: unknown };
  roles?: unknown;
}

interface RoleData {
  id?: unknown;
  position?: unknown;
  permissions?: unknown;
}

interface ChannelData {
  id?: unknown;
  type?: unknown;
}

export interface RestModerationResolverOptions {
  token: string;
  botUserId: string;
  base?: string;
  fetchImpl?: typeof fetch;
}

export class RestModerationResolver implements ModerationResolver {
  private options: RestModerationResolverOptions;
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(options: RestModerationResolverOptions) {
    this.options = options;
    this.base = options.base ?? 'https://discord.com/api/v10';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async actor(guildId: string, userId: string): Promise<ModerationActor> {
    const [member, roles] = await Promise.all([
      this.get<MemberData>(`/guilds/${guildId}/members/${userId}`),
      this.roles(guildId),
    ]);
    const roleIds = stringArray(member.roles);
    let permissions = 0n;
    let highestRolePosition = 0;
    for (const role of roles) {
      if (!roleIds.includes(role.id)) continue;
      permissions |= role.permissions;
      highestRolePosition = Math.max(highestRolePosition, role.position);
    }
    if ((permissions & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) {
      permissions = ~0n;
    }
    return { userId, roleIds, highestRolePosition, permissions };
  }

  async target(guildId: string, userId: string): Promise<ModerationTarget> {
    const [member, roles, guild] = await Promise.all([
      this.get<MemberData>(`/guilds/${guildId}/members/${userId}`),
      this.roles(guildId),
      this.get<GuildData>(`/guilds/${guildId}`),
    ]);
    const roleIds = stringArray(member.roles);
    return {
      userId,
      roleIds,
      highestRolePosition: roles
        .filter((role) => roleIds.includes(role.id))
        .reduce((highest, role) => Math.max(highest, role.position), 0),
      isBot: member.user?.bot === true,
      isGuildOwner: guild.owner_id === userId,
    };
  }

  async channel(channelId: string): Promise<ModerationChannel> {
    const channel = await this.get<ChannelData>(`/channels/${channelId}`);
    return { channelId, type: Number(channel.type ?? -1) };
  }

  async botHighestRolePosition(guildId: string): Promise<number> {
    return (await this.actor(guildId, this.options.botUserId)).highestRolePosition;
  }

  private async roles(guildId: string): Promise<Array<{ id: string; position: number; permissions: bigint }>> {
    const roles = await this.get<RoleData[]>(`/guilds/${guildId}/roles`);
    return Array.isArray(roles)
      ? roles.flatMap((role) => {
          if (typeof role.id !== 'string') return [];
          return [{
            id: role.id,
            position: Number(role.position ?? 0),
            permissions: BigInt(typeof role.permissions === 'string' ? role.permissions : '0'),
          }];
        })
      : [];
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        headers: { Authorization: `Bot ${this.options.token}` },
      });
    } catch {
      throw new ActionError('discord_unavailable', 'Discord was unreachable', {
        logReason: 'discord_unreachable',
      });
    }
    if (res.status === 429) {
      throw new ActionError('rate_limited', 'Discord rate-limited this request', {
        logReason: 'discord_rate_limited',
        retryAfter: Math.max(1, Math.ceil(Number(res.headers.get('retry-after') ?? '1'))),
      });
    }
    if (res.status >= 500) {
      throw new ActionError('discord_unavailable', `Discord returned ${res.status}`, {
        logReason: 'discord_5xx',
      });
    }
    if (!res.ok) {
      throw new ActionError('discord_rejected', `Discord refused the lookup with ${res.status}`, {
        logReason: `discord_${res.status}`,
      });
    }
    return await res.json() as T;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
