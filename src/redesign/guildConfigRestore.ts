import type { GuildConfigDiscordApi } from '../discord/guildConfigApi.ts';
import {
  canonicalSnapshot,
  configHash,
  type GuildConfigChannel,
  type GuildConfigEmoji,
  type GuildConfigRole,
  type GuildConfigSnapshot,
  type GuildConfigOverwrite,
  GUILD_CONFIG_FIELDS,
} from './guildConfig.ts';

type JsonObject = Record<string, unknown>;

export type RestoreOperation = {
  label: string;
  method: 'POST' | 'PATCH';
  path: string;
  body: JsonObject | Array<JsonObject>;
};

export type RestorePlan = {
  counts: { roles: number; channels: number; overwrites: number; settings: number; emojis: number; operations: number };
  operations: RestoreOperation[];
};

const ROLE_FIELDS = ['name', 'color', 'hoist', 'permissions', 'mentionable'] as const;
const CHANNEL_FIELDS = ['name', 'topic', 'nsfw', 'bitrate', 'user_limit', 'rate_limit_per_user'] as const;
const GUILD_FIELDS = GUILD_CONFIG_FIELDS.filter((field) => !field.endsWith('_channel_id'));

function bodyFromFields(source: JsonObject, fields: readonly string[]): JsonObject {
  return Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
}

function same(a: unknown, b: unknown): boolean {
  return configHash(a) === configHash(b);
}

function roleBody(role: GuildConfigRole): JsonObject {
  return bodyFromFields(role as unknown as JsonObject, ROLE_FIELDS);
}

function channelBody(channel: GuildConfigChannel, parentId: string | null, overwrites: GuildConfigOverwrite[]): JsonObject {
  return {
    ...bodyFromFields(channel as unknown as JsonObject, CHANNEL_FIELDS),
    type: channel.type,
    parent_id: parentId,
    permission_overwrites: overwrites,
  };
}

function emojiImage(emoji: GuildConfigEmoji): string {
  const extension = emoji.animated ? 'gif' : 'png';
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${extension}`;
}

export function planRestore(snapshot: GuildConfigSnapshot, current: GuildConfigSnapshot): RestorePlan {
  if (snapshot.guildId !== current.guildId) throw new Error(`Snapshot guild ${snapshot.guildId} does not match target guild ${current.guildId}.`);
  const operations: RestoreOperation[] = [];
  const roleIds = new Map<string, string>();
  const channelIds = new Map<string, string>();
  let roleWrites = 0;
  let channelWrites = 0;
  let overwriteWrites = 0;
  let settingsWrites = 0;
  let emojiWrites = 0;

  const currentRolesByName = new Map(current.roles.filter((role) => !role.managed).map((role) => [role.name, role]));
  for (const role of snapshot.roles.filter((item) => !item.managed && item.id !== snapshot.guildId)) {
    const actual = currentRolesByName.get(role.name);
    if (!actual) {
      operations.push({ label: `create role ${role.name}`, method: 'POST', path: `/guilds/${current.guildId}/roles`, body: roleBody(role) });
      roleWrites++;
      continue;
    }
    roleIds.set(role.id, actual.id);
    if (!same(roleBody(role), roleBody(actual))) {
      operations.push({ label: `patch role ${role.name}`, method: 'PATCH', path: `/guilds/${current.guildId}/roles/${actual.id}`, body: roleBody(role) });
      roleWrites++;
    }
  }

  const currentCategories = new Map(current.channels.filter((channel) => channel.type === 4).map((channel) => [channel.name, channel]));
  for (const category of snapshot.channels.filter((channel) => channel.type === 4).sort((a, b) => a.position - b.position)) {
    const actual = currentCategories.get(category.name);
    if (actual) channelIds.set(category.id, actual.id);
    else {
      operations.push({ label: `create category ${category.name}`, method: 'POST', path: `/guilds/${current.guildId}/channels`, body: { name: category.name, type: 4 } });
      channelWrites++;
    }
  }

  for (const channel of snapshot.channels.filter((item) => item.type !== 4).sort((a, b) => a.position - b.position)) {
    const parent = channel.parent_id ? snapshot.channels.find((item) => item.id === channel.parent_id) : null;
    const actualParentId: string | null = parent ? currentCategories.get(parent.name)?.id ?? null : null;
    if (parent && !actualParentId) continue;
    const candidates = current.channels.filter((item) => item.type === channel.type && item.name === channel.name && item.parent_id === actualParentId);
    if (candidates.length > 1) throw new Error(`Target has multiple ${channel.name} channels in ${parent?.name ?? 'the guild root'}; restore is ambiguous.`);
    const actual = candidates[0];
    const overwrites = channel.permission_overwrites.map((overwrite) => ({
      ...overwrite,
      id: overwrite.id === snapshot.guildId ? current.guildId : roleIds.get(overwrite.id) ?? overwrite.id,
    }));
    if (!actual) {
      operations.push({ label: `create channel ${channel.name}`, method: 'POST', path: `/guilds/${current.guildId}/channels`, body: channelBody(channel, actualParentId, overwrites) });
      channelWrites++;
      overwriteWrites += overwrites.length;
      continue;
    }
    channelIds.set(channel.id, actual.id);
    const expected = channelBody(channel, actualParentId, overwrites);
    const actualBody = channelBody(actual, actual.parent_id, actual.permission_overwrites ?? []);
    if (!same(expected, actualBody)) {
      operations.push({ label: `patch channel ${channel.name}`, method: 'PATCH', path: `/channels/${actual.id}`, body: expected });
      channelWrites++;
      if (!same(overwrites, actual.permission_overwrites ?? [])) overwriteWrites++;
    }
  }

  const guildBody = bodyFromFields(snapshot.guild, GUILD_FIELDS);
  for (const field of ['system_channel_id', 'rules_channel_id', 'public_updates_channel_id', 'afk_channel_id'] as const) {
    const snapshotChannelId = snapshot.guild[field];
    if (typeof snapshotChannelId === 'string') guildBody[field] = channelIds.get(snapshotChannelId) ?? null;
    else if (snapshotChannelId === null) guildBody[field] = null;
  }
  const currentGuildBody = bodyFromFields(current.guild, Object.keys(guildBody));
  if (!same(guildBody, currentGuildBody)) {
    operations.push({ label: 'restore guild settings', method: 'PATCH', path: `/guilds/${current.guildId}`, body: guildBody });
    settingsWrites++;
  }

  const currentEmojis = new Map(current.emojis.filter((emoji) => emoji.name).map((emoji) => [emoji.name!, emoji]));
  for (const emoji of snapshot.emojis.filter((item) => !item.managed && item.name)) {
    const roles = emoji.roles.map((roleId) => roleIds.get(roleId) ?? roleId);
    const actual = currentEmojis.get(emoji.name!);
    if (!actual) {
      operations.push({ label: `create emoji ${emoji.name}`, method: 'POST', path: `/guilds/${current.guildId}/emojis`, body: { name: emoji.name, image: emojiImage(emoji), roles } });
      emojiWrites++;
    } else if (!same({ name: emoji.name, roles }, { name: actual.name, roles: actual.roles })) {
      operations.push({ label: `patch emoji ${emoji.name}`, method: 'PATCH', path: `/guilds/${current.guildId}/emojis/${actual.id}`, body: { name: emoji.name, roles } });
      emojiWrites++;
    }
  }

  return {
    counts: {
      roles: roleWrites,
      channels: channelWrites,
      overwrites: overwriteWrites,
      settings: settingsWrites,
      emojis: emojiWrites,
      operations: operations.length,
    },
    operations,
  };
}

export async function applyRestorePlan(api: GuildConfigDiscordApi, plan: RestorePlan): Promise<void> {
  for (const operation of plan.operations) await api.write(operation.method, operation.path, operation.body);
}

export function snapshotsEqual(left: GuildConfigSnapshot, right: GuildConfigSnapshot): boolean {
  return configHash(canonicalSnapshot(left)) === configHash(canonicalSnapshot(right));
}
