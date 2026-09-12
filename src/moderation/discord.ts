import { log } from '../core/log.ts';
import { ActionError } from '../internal/errors.ts';

const API = 'https://discord.com/api/v10';

/** PermissionFlagsBits.SendMessages, as the decimal string Discord expects. */
const SEND_MESSAGES = '2048';
const EVERYONE_OVERWRITE_TYPE = 0;
const MAX_AUDIT_REASON_BYTES = 512;

export interface EveryoneOverwrite {
  allow: string;
  deny: string;
}

export interface ModerationDiscordClient {
  ban(guildId: string, userId: string, reason: string): Promise<void>;
  unban(guildId: string, userId: string, reason: string): Promise<void>;
  kick(guildId: string, userId: string, reason: string): Promise<void>;
  timeout(guildId: string, userId: string, until: string | null, reason: string): Promise<void>;
  deleteMessage?(channelId: string, messageId: string, reason: string): Promise<void>;
  purge(channelId: string, count: number, reason: string): Promise<number>;
  setSlowmode(channelId: string, seconds: number, reason: string): Promise<void>;
  /** Read the channel's current @everyone overwrite. Null when none exists. */
  getEveryoneOverwrite(channelId: string, guildId: string): Promise<EveryoneOverwrite | null>;
  /** Write the @everyone overwrite. Both masks are full bitmasks. */
  putEveryoneOverwrite(channelId: string, guildId: string, overwrite: EveryoneOverwrite, reason: string): Promise<void>;
  /** Remove the overwrite entirely when none existed before lockdown. */
  deleteEveryoneOverwrite(channelId: string, guildId: string, reason: string): Promise<void>;
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

  async deleteMessage(channelId: string, messageId: string, reason: string): Promise<void> {
    await this.call('DELETE', `/channels/${channelId}/messages/${messageId}`, undefined, reason, [200, 204, 404]);
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

  async getEveryoneOverwrite(channelId: string, guildId: string): Promise<EveryoneOverwrite | null> {
    const res = await this.call('GET', `/channels/${channelId}`, undefined, '', [200]);
    const body = await readJson(res) as { permission_overwrites?: unknown } | null;
    if (!body || !Array.isArray(body.permission_overwrites)) return null;
    const row = body.permission_overwrites.find((entry): entry is { allow: string | number; deny: string | number } =>
      typeof entry === 'object' && entry !== null
      && (entry as { id?: unknown }).id === guildId
      && (entry as { type?: unknown }).type === EVERYONE_OVERWRITE_TYPE);
    if (!row) return null;
    return { allow: String(row.allow), deny: String(row.deny) };
  }

  async putEveryoneOverwrite(
    channelId: string,
    guildId: string,
    overwrite: EveryoneOverwrite,
    reason: string,
  ): Promise<void> {
    await this.call(
      'PUT',
      `/channels/${channelId}/permissions/${guildId}`,
      { type: EVERYONE_OVERWRITE_TYPE, allow: overwrite.allow, deny: overwrite.deny },
      reason,
      [200, 204],
    );
  }

  async deleteEveryoneOverwrite(channelId: string, guildId: string, reason: string): Promise<void> {
    await this.call(
      'DELETE',
      `/channels/${channelId}/permissions/${guildId}`,
      undefined,
      reason,
      [200, 204, 404],
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
          'X-Audit-Log-Reason': encodeAuditReason(reason),
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

function encodeAuditReason(reason: string): string {
  const scrubbed = reason.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  let truncated = scrubbed;
  let encoded = encodeURIComponent(truncated);
  // requireModerationReason bounds the caller's own text to 512 UTF-16 units,
  // but URL-encoding can expand it well past Discord's 512-*byte* header
  // limit - the mismatch that let already-accepted content vanish with no
  // trace (TOG-2223 #4). Truncation still has to happen (Discord will 400 an
  // over-length header outright), but it must never happen silently: log
  // exactly what was cut so an operator reading an audit-log entry months
  // later isn't staring at reason text that quietly isn't what was recorded.
  while (encoded.length > MAX_AUDIT_REASON_BYTES) {
    truncated = [...truncated].slice(0, -1).join('');
    encoded = encodeURIComponent(truncated);
  }
  if (truncated.length !== scrubbed.length) {
    log.error('moderation_audit_reason_truncated', {
      originalLength: scrubbed.length,
      truncatedLength: truncated.length,
      encodedLength: encoded.length,
    });
  }
  return encoded;
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
