import { ActionError } from '../internal/errors.ts';

const API = 'https://discord.com/api/v10';

export interface ModerationDiscordClient {
  ban(guildId: string, userId: string, reason: string): Promise<void>;
  unban(guildId: string, userId: string, reason: string): Promise<void>;
  kick(guildId: string, userId: string, reason: string): Promise<void>;
  timeout(guildId: string, userId: string, until: string | null, reason: string): Promise<void>;
  purge(channelId: string, count: number, reason: string): Promise<number>;
  setSlowmode(channelId: string, seconds: number, reason: string): Promise<void>;
  setLockdown(channelId: string, guildId: string, locked: boolean, reason: string): Promise<void>;
}

export interface ModerationDiscordOptions {
  token: string;
  base?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ModerationDiscord implements ModerationDiscordClient {
  private options: ModerationDiscordOptions;
  private base: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: ModerationDiscordOptions) {
    this.options = options;
    this.base = options.base ?? API;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async ban(guildId: string, userId: string, reason: string): Promise<void> {
    await this.call('PUT', `/guilds/${guildId}/bans/${userId}`, {}, reason, [200, 204]);
  }

  async unban(guildId: string, userId: string, reason: string): Promise<void> {
    await this.call('DELETE', `/guilds/${guildId}/bans/${userId}`, undefined, reason, [200, 204, 404]);
  }

  async kick(guildId: string, userId: string, reason: string): Promise<void> {
    await this.call('DELETE', `/guilds/${guildId}/members/${userId}`, undefined, reason, [200, 204, 404]);
  }

  async timeout(guildId: string, userId: string, until: string | null, reason: string): Promise<void> {
    await this.call(
      'PATCH',
      `/guilds/${guildId}/members/${userId}`,
      { communication_disabled_until: until },
      reason,
      [200],
    );
  }

  async purge(channelId: string, count: number, reason: string): Promise<number> {
    const listed = await this.call('GET', `/channels/${channelId}/messages?limit=${count}`, undefined, reason, [200]);
    const body = await readJson(listed) as Array<{ id?: unknown }> | null;
    const ids = Array.isArray(body) ? body.map((row) => row.id).filter((id): id is string => typeof id === 'string') : [];
    if (ids.length === 0) return 0;
    if (ids.length === 1) {
      await this.call('DELETE', `/channels/${channelId}/messages/${ids[0]}`, undefined, reason, [200, 204]);
    } else {
      await this.call('POST', `/channels/${channelId}/messages/bulk-delete`, { messages: ids }, reason, [200, 204]);
    }
    return ids.length;
  }

  async setSlowmode(channelId: string, seconds: number, reason: string): Promise<void> {
    await this.call('PATCH', `/channels/${channelId}`, { rate_limit_per_user: seconds }, reason, [200]);
  }

  async setLockdown(channelId: string, guildId: string, locked: boolean, reason: string): Promise<void> {
    const deny = locked ? '2048' : '0';
    const allow = locked ? '0' : '2048';
    await this.call(
      'PUT',
      `/channels/${channelId}/permissions/${guildId}`,
      { type: 0, allow, deny },
      reason,
      [200, 204],
    );
  }

  private async call(
    method: string,
    path: string,
    body: unknown,
    reason: string,
    accepted: number[],
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bot ${this.options.token}`,
          'X-Audit-Log-Reason': encodeURIComponent(reason).slice(0, 512),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!accepted.includes(res.status)) throwForStatus(res);
      return res;
    } catch (error) {
      if (error instanceof ActionError) throw error;
      if (isAbort(error)) {
        throw new ActionError('upstream_timeout', `Discord did not answer in ${this.timeoutMs}ms`, {
          logReason: 'discord_timeout',
        });
      }
      throw new ActionError('discord_unavailable', 'Discord was unreachable', {
        logReason: 'discord_unreachable',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function throwForStatus(res: Response): never {
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
  throw new ActionError('discord_rejected', `Discord refused the request with ${res.status}`, {
    logReason: `discord_${res.status}`,
  });
}
