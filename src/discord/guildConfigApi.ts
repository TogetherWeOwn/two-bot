import type {
  GuildConfigChannel,
  GuildConfigEmoji,
  GuildConfigRole,
  GuildConfigSnapshot,
} from '../redesign/guildConfig.ts';
import type { RestorePlan } from '../redesign/guildConfigRestore.ts';

type JsonObject = Record<string, unknown>;
type ApiResult<T> = { status: number; body: T | null };

export type GuildConfigApiOptions = {
  apiBase?: string;
  cdnBase?: string;
  token: string;
  applicationId: string;
  guildId: string;
};

function checkedTestBase(raw: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL: ${raw}`);
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`${name} is a test seam and only accepts loopback. Got host ${parsed.hostname}.`);
  }
  return raw.replace(/\/$/, '');
}

export function checkedApiBase(raw: string | undefined): string {
  return raw ? checkedTestBase(raw, 'GUILD_CONFIG_API_BASE') : 'https://discord.com/api/v10';
}

export function checkedCdnBase(raw: string | undefined): string {
  return raw ? checkedTestBase(raw, 'GUILD_CONFIG_CDN_BASE') : 'https://cdn.discordapp.com';
}

export class GuildConfigDiscordApi {
  readonly apiBase: string;
  readonly cdnBase: string;
  readonly token: string;
  readonly applicationId: string;
  readonly guildId: string;
  writes = 0;

  constructor(options: GuildConfigApiOptions) {
    this.apiBase = checkedApiBase(options.apiBase);
    this.cdnBase = checkedCdnBase(options.cdnBase);
    this.token = options.token;
    this.applicationId = options.applicationId;
    this.guildId = options.guildId;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const responseBody = (await response.json().catch(() => null)) as T | null;
      if (response.status !== 429) return { status: response.status, body: responseBody };
      const retryAfter = Number((responseBody as { retry_after?: number } | null)?.retry_after ?? 1);
      if (!Number.isFinite(retryAfter) || retryAfter < 0) return { status: 429, body: responseBody };
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 30) * 1000));
    }
    return { status: 429, body: null };
  }

  async assertIdentity(): Promise<void> {
    const me = await this.request<{ id: string }>('GET', '/users/@me');
    if (me.status !== 200 || me.body?.id !== this.applicationId) {
      throw new Error(`Discord did not authenticate as expected application ${this.applicationId}: HTTP ${me.status}.`);
    }
    const guilds = await this.request<Array<{ id: string }>>('GET', '/users/@me/guilds');
    if (guilds.status !== 200 || !guilds.body?.some((guild) => guild.id === this.guildId)) {
      throw new Error(`Application ${this.applicationId} is not in guild ${this.guildId}.`);
    }
  }

  async assertRestorePermissions(snapshot: GuildConfigSnapshot, plan: Pick<RestorePlan, 'counts' | 'overwriteRoles' | 'overwriteTargets'>): Promise<void> {
    const member = await this.request<{ roles?: string[] }>('GET', `/guilds/${this.guildId}/members/${this.applicationId}`);
    if (member.status !== 200 || !member.body) throw new Error(`Could not read Owen's guild member for permission preflight: HTTP ${member.status}.`);
    const heldRoleIds = new Set([this.guildId, ...(member.body.roles ?? [])]);
    const heldRoles = snapshot.roles.filter((role) => heldRoleIds.has(role.id));
    const permissions = heldRoles.reduce((mask, role) => mask | BigInt(role.permissions), 0n);
    const administrator = (permissions & (1n << 3n)) !== 0n;
    const needsManageRoles = plan.counts.roles > 0 || plan.counts.overwrites > 0;
    const required = [
      ...(plan.counts.settings ? [{ name: 'Manage Guild', bit: 1n << 5n }] : []),
      ...(plan.counts.channels || plan.counts.overwrites ? [{ name: 'Manage Channels', bit: 1n << 4n }] : []),
      ...(needsManageRoles ? [{ name: 'Manage Roles', bit: 1n << 28n }] : []),
      ...(plan.counts.emojis ? [{ name: 'Manage Guild Expressions', bit: 1n << 30n }] : []),
    ];
    const missing = administrator ? [] : required.filter((permission) => (permissions & permission.bit) === 0n).map((permission) => permission.name);
    if (missing.length > 0) throw new Error(`Restore permission preflight failed: missing ${missing.join(', ')}.`);
    if (needsManageRoles && snapshot.guild.owner_id !== this.applicationId) {
      const botPosition = Math.max(...heldRoles.map((role) => role.position), -1);
      const targets = plan.counts.roles > 0
        ? snapshot.roles.filter((role) => !role.managed && role.id !== this.guildId)
        : plan.overwriteRoles;
      const blocked = targets.filter((role) => botPosition <= role.position);
      if (blocked.length > 0) {
        throw new Error(`Restore hierarchy preflight failed: Owen role position ${botPosition} is not above overwrite target ${blocked.map((role) => `${role.name} (${role.position})`).join(', ')}.`);
      }
    }
    if (!administrator) {
      const effectivePermissions = (overwrites: GuildConfigChannel['permission_overwrites']) => {
        let effective = permissions;
        const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === this.guildId);
        if (everyone) effective = (effective & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
        let roleAllow = 0n;
        let roleDeny = 0n;
        for (const overwrite of overwrites.filter((item) => item.type === 0 && heldRoleIds.has(item.id) && item.id !== this.guildId)) {
          roleAllow |= BigInt(overwrite.allow);
          roleDeny |= BigInt(overwrite.deny);
        }
        effective = (effective & ~roleDeny) | roleAllow;
        const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === this.applicationId);
        if (memberOverwrite) effective = (effective & ~BigInt(memberOverwrite.deny)) | BigInt(memberOverwrite.allow);
        return effective;
      };
      const blockedTargets = plan.overwriteTargets.flatMap((target) => {
        const permissionCeiling = effectivePermissions(target.permissionCeilingOverwrites);
        const actionPermissions = target.currentId ? effectivePermissions(target.currentOverwrites) : permissionCeiling;
        const missingChannelPermissions = [
          { name: 'Manage Channels', bit: 1n << 4n },
          { name: 'Manage Roles', bit: 1n << 28n },
        ].filter((permission) => (actionPermissions & permission.bit) === 0n).map((permission) => permission.name);
        const requested = target.desiredOverwrites.reduce((mask, overwrite) => mask | BigInt(overwrite.allow) | BigInt(overwrite.deny), 0n);
        const unowned = requested & ~permissionCeiling;
        if (missingChannelPermissions.length === 0 && unowned === 0n) return [];
        return [`${target.name} (missing ${missingChannelPermissions.join(', ') || 'none'}; unowned mask ${unowned})`];
      });
      if (blockedTargets.length > 0) {
        throw new Error(`Restore channel permission preflight failed: ${blockedTargets.join('; ')}.`);
      }
    }
  }

  async captureEmojiImage(emoji: GuildConfigEmoji): Promise<string | undefined> {
    if (emoji.managed || !emoji.name) return undefined;
    const extension = emoji.animated ? 'gif' : 'png';
    const response = await fetch(`${this.cdnBase}/emojis/${emoji.id}.${extension}`);
    if (!response.ok) throw new Error(`Could not download emoji ${emoji.name}: HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? `image/${extension}`;
    if (!contentType.startsWith('image/')) throw new Error(`Emoji ${emoji.name} returned non-image content type ${contentType}.`);
    return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  }

  async capture(): Promise<GuildConfigSnapshot> {
    const [guild, roles, channels, emojis] = await Promise.all([
      this.request<JsonObject>('GET', `/guilds/${this.guildId}`),
      this.request<GuildConfigRole[]>('GET', `/guilds/${this.guildId}/roles`),
      this.request<GuildConfigChannel[]>('GET', `/guilds/${this.guildId}/channels`),
      this.request<GuildConfigEmoji[]>('GET', `/guilds/${this.guildId}/emojis`),
    ]);
    if (guild.status !== 200 || !guild.body) throw new Error(`Could not read guild ${this.guildId}: HTTP ${guild.status}.`);
    if (roles.status !== 200 || !roles.body) throw new Error(`Could not read guild roles: HTTP ${roles.status}.`);
    if (channels.status !== 200 || !channels.body) throw new Error(`Could not read guild channels: HTTP ${channels.status}.`);
    if (emojis.status !== 200 || !emojis.body) throw new Error(`Could not read guild emojis: HTTP ${emojis.status}.`);
    const capturedEmojis = await Promise.all(emojis.body.map(async (emoji) => ({ ...emoji, image: await this.captureEmojiImage(emoji) })));
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      applicationId: this.applicationId,
      guildId: this.guildId,
      guild: guild.body,
      roles: roles.body,
      channels: channels.body,
      emojis: capturedEmojis,
    };
  }

  async write<T>(method: string, path: string, body: unknown): Promise<T | null> {
    const result = await this.request<T>(method, path, body);
    if (result.status >= 300) throw new Error(`Discord write ${method} ${path} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
    this.writes++;
    return result.body;
  }
}
