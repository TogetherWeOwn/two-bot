import { ActionError } from '../internal/errors.ts';

const API = 'https://discord.com/api/v10';
const DANGEROUS_PERMISSIONS =
  (1n << 1n) | // KickMembers
  (1n << 2n) | // BanMembers
  (1n << 3n) | // Administrator
  (1n << 4n) | // ManageChannels
  (1n << 5n) | // ManageGuild
  (1n << 27n) | // ManageWebhooks
  (1n << 28n) | // ManageRoles
  (1n << 40n); // ModerateMembers

interface DiscordMember {
  roles?: unknown;
}

interface DiscordRole {
  id?: unknown;
  position?: unknown;
  permissions?: unknown;
  managed?: unknown;
}

export interface QuarantineResult {
  removedRoleIds: string[];
  skippedRoleIds: string[];
}

export class QuarantineError extends Error {
  causeError: unknown;
  removedRoleIds: string[];

  constructor(causeError: unknown, removedRoleIds: string[]) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
    this.name = 'QuarantineError';
    this.causeError = causeError;
    this.removedRoleIds = removedRoleIds;
  }
}

export interface ContainmentDiscordClient {
  quarantine(guildId: string, userId: string, reason: string): Promise<QuarantineResult>;
}

export interface ContainmentDiscordOptions {
  token: string;
  botUserId: string;
  base?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ContainmentDiscord implements ContainmentDiscordClient {
  private options: ContainmentDiscordOptions;
  private base: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: ContainmentDiscordOptions) {
    this.options = options;
    this.base = options.base ?? API;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async quarantine(guildId: string, userId: string, reason: string): Promise<QuarantineResult> {
    const [member, bot, roles] = await Promise.all([
      this.json<DiscordMember>('GET', `/guilds/${guildId}/members/${userId}`),
      this.json<DiscordMember>('GET', `/guilds/${guildId}/members/${this.options.botUserId}`),
      this.json<DiscordRole[]>('GET', `/guilds/${guildId}/roles`),
    ]);
    const targetRoleIds = new Set(stringArray(member.roles));
    const botRoleIds = new Set(stringArray(bot.roles));
    const normalized = Array.isArray(roles)
      ? roles.flatMap((role) => typeof role.id === 'string' ? [{
          id: role.id,
          position: Number(role.position ?? 0),
          permissions: BigInt(typeof role.permissions === 'string' ? role.permissions : '0'),
          managed: role.managed === true,
        }] : [])
      : [];
    const botPosition = normalized
      .filter((role) => botRoleIds.has(role.id))
      .reduce((highest, role) => Math.max(highest, role.position), 0);
    const dangerous = normalized.filter((role) =>
      targetRoleIds.has(role.id)
      && role.id !== guildId
      && (role.permissions & DANGEROUS_PERMISSIONS) !== 0n);
    const blocked = dangerous.filter((role) => role.managed || role.position >= botPosition);
    if (blocked.length > 0) {
      throw new ActionError(
        'discord_rejected',
        'Owen cannot safely remove every dangerous role held by the executor',
        { logReason: blocked.some((role) => role.managed) ? 'containment_managed_role_blocked' : 'containment_hierarchy_blocked' },
      );
    }
    const removable = dangerous;
    const removedRoleIds: string[] = [];
    for (const role of removable) {
      try {
        await this.request('DELETE', `/guilds/${guildId}/members/${userId}/roles/${role.id}`, undefined, reason, [200, 204, 404]);
        removedRoleIds.push(role.id);
      } catch (error) {
        throw new QuarantineError(error, removedRoleIds);
      }
    }
    return { removedRoleIds, skippedRoleIds: [] };
  }

  private async json<T>(method: string, path: string): Promise<T> {
    const response = await this.request(method, path, undefined, '', [200]);
    return await response.json() as T;
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    reason: string,
    accepted: number[],
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bot ${this.options.token}`,
          ...(reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason).slice(0, 512) } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!accepted.includes(response.status)) throwForStatus(response);
      return response;
    } catch (error) {
      if (error instanceof ActionError) throw error;
      if (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError') {
        throw new ActionError('upstream_timeout', `Discord did not answer in ${this.timeoutMs}ms`, {
          logReason: 'containment_discord_timeout',
        });
      }
      throw new ActionError('discord_unavailable', 'Discord was unreachable', {
        logReason: 'containment_discord_unreachable',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function throwForStatus(response: Response): never {
  if (response.status === 429) {
    throw new ActionError('rate_limited', 'Discord rate-limited this request', {
      logReason: 'containment_discord_rate_limited',
      retryAfter: Math.max(1, Math.ceil(Number(response.headers.get('retry-after') ?? '1'))),
    });
  }
  if (response.status >= 500) {
    throw new ActionError('discord_unavailable', `Discord returned ${response.status}`, {
      logReason: 'containment_discord_5xx',
    });
  }
  throw new ActionError('discord_rejected', `Discord refused the request with ${response.status}`, {
    logReason: `containment_discord_${response.status}`,
  });
}
