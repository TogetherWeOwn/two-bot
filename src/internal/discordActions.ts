/**
 * The Discord calls behind the two actions in this slice.
 *
 * Deliberately raw fetch rather than discord.js: these are three endpoints,
 * each needs its own hard timeout, and `guild.add_member` sends a member's
 * OAuth token in the body - a path where I want to see exactly what is sent
 * and exactly what is kept. Nothing in this file logs a request body.
 *
 * No retries. docs/INTERNAL_ACTIONS.md §5: a member is standing there waiting,
 * so we fail fast with a typed error and the website falls back to an invite
 * link. A retry here would blow the caller's 2s budget for no gain.
 */
import { ActionError } from './errors.ts';

const API = 'https://discord.com/api/v10';

export type AddMemberOutcome = 'added' | 'already_member';

export interface ActionDiscord {
  /** Current role ids, or null if we could not read the member. */
  memberRoles(guildId: string, userId: string): Promise<string[] | null>;
  addRole(guildId: string, userId: string, roleId: string): Promise<void>;
  addMember(guildId: string, userId: string, accessToken: string): Promise<AddMemberOutcome>;
}

export interface DiscordActionsOptions {
  token: string;
  /** Override the API host. Used by tools/mock-discord. */
  base?: string;
  /** Budget for guild.add_member, ms. Sits inside the website's 2s. */
  addMemberTimeoutMs?: number;
  /** Budget for the role calls, ms. */
  roleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DiscordActions implements ActionDiscord {
  private token: string;
  private base: string;
  private addMemberTimeout: number;
  private roleTimeout: number;
  private fetchImpl: typeof fetch;

  constructor(o: DiscordActionsOptions) {
    this.token = o.token;
    this.base = o.base ?? API;
    this.addMemberTimeout = o.addMemberTimeoutMs ?? 1500;
    this.roleTimeout = o.roleTimeoutMs ?? 2000;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async memberRoles(guildId: string, userId: string): Promise<string[] | null> {
    const res = await this.call('GET', `/guilds/${guildId}/members/${userId}`, undefined, this.roleTimeout);
    if (res.status === 404) return null;
    throwForStatus(res);
    const body = (await readJson(res)) as { roles?: unknown } | null;
    return Array.isArray(body?.roles) ? (body.roles as string[]).map(String) : null;
  }

  async addRole(guildId: string, userId: string, roleId: string): Promise<void> {
    const res = await this.call(
      'PUT',
      `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      undefined,
      this.roleTimeout,
    );
    throwForStatus(res);
  }

  /**
   * PUT /guilds/{guild}/members/{user} with the bot token in the header and
   * the member's OAuth token in the body. 201 means we added them, 204 means
   * they were already in - both are a success, and they are different things
   * to show a person (§3).
   *
   * `accessToken` is a function argument and a request body. It is not stored
   * on `this`, not returned, and not passed to anything that logs.
   */
  async addMember(guildId: string, userId: string, accessToken: string): Promise<AddMemberOutcome> {
    const res = await this.call(
      'PUT',
      `/guilds/${guildId}/members/${userId}`,
      { access_token: accessToken },
      this.addMemberTimeout,
    );
    if (res.status === 201) return 'added';
    if (res.status === 204) return 'already_member';
    throwForStatus(res);
    // Any other 2xx is Discord doing something undocumented; treat the member
    // as present rather than telling a person who is now in the server that
    // they are not.
    return 'already_member';
  }

  private async call(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        method,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bot ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // The error object can quote the request we sent, so nothing here goes
      // near a log line - the code is all the caller needs.
      if (isAbort(err)) {
        throw new ActionError('upstream_timeout', `Discord did not answer in ${timeoutMs}ms`, {
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

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Map a Discord status onto §2's table.
 *
 * 429 is retryable and carries Discord's own Retry-After. 5xx is
 * discord_unavailable. Everything else in the 4xx range is Discord answering
 * and saying no, which is not retryable however many times the site tries.
 */
export function throwForStatus(res: Response): void {
  if (res.status < 400) return;

  if (res.status === 429) {
    const retryAfter = Math.max(1, Math.ceil(Number(res.headers.get('retry-after') ?? '1')));
    throw new ActionError('rate_limited', 'Discord rate-limited this request', {
      logReason: 'discord_rate_limited',
      retryAfter,
    });
  }
  if (res.status >= 500) {
    throw new ActionError('discord_unavailable', `Discord returned ${res.status}`, {
      logReason: 'discord_5xx',
    });
  }
  // 403 on role.assign is usually role hierarchy, not a missing permission
  // bit, and Discord's message says nothing about it. Say so once, here.
  const hint =
    res.status === 403
      ? ' (check the bot has the permission, and that its highest role is above the target role)'
      : '';
  throw new ActionError('discord_rejected', `Discord refused the request with ${res.status}${hint}`, {
    logReason: `discord_${res.status}`,
  });
}
