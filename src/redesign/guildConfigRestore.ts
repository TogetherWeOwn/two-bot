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
type RestoreResource = 'role' | 'channel' | 'emoji';
type RestoreReference = { restoreReference: Exclude<RestoreResource, 'emoji'>; sourceId: string };
type RestoreValue = unknown | RestoreReference | RestoreValue[] | { [key: string]: RestoreValue };
type RestorePath = string | { channelSourceId: string };

export type RestoreIdMap = {
  roles: Record<string, string>;
  channels: Record<string, string>;
  emojis: Record<string, string>;
};

export type RestoreOperation = {
  label: string;
  method: 'POST' | 'PATCH';
  path: RestorePath;
  body: RestoreValue;
  captureId?: { resource: RestoreResource; sourceId: string };
};

export type RestoreOverwriteTarget = {
  currentId: string | null;
  name: string;
  currentOverwrites: GuildConfigOverwrite[];
  desiredOverwrites: GuildConfigOverwrite[];
  inheritedDesiredOverwrites: GuildConfigOverwrite[];
};

export type RestorePlan = {
  counts: { roles: number; channels: number; overwrites: number; settings: number; emojis: number; operations: number };
  knownIds: RestoreIdMap;
  overwriteRoles: Array<{ id: string; name: string; position: number }>;
  overwriteTargets: RestoreOverwriteTarget[];
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

function reference(resource: RestoreReference['restoreReference'], sourceId: string): RestoreReference {
  return { restoreReference: resource, sourceId };
}

function channelCoreBody(channel: GuildConfigChannel, parentId: string | RestoreReference | null): RestoreValue {
  return {
    ...bodyFromFields(channel as unknown as JsonObject, CHANNEL_FIELDS),
    type: channel.type,
    parent_id: parentId,
  };
}

function overwriteBody(overwrites: GuildConfigOverwrite[], guildId: string): RestoreValue[] {
  return overwrites.map((overwrite) => ({
    ...overwrite,
    id: overwrite.type === 0 ? reference('role', overwrite.id === guildId ? guildId : overwrite.id) : overwrite.id,
  }));
}

function emojiImage(emoji: GuildConfigEmoji): string {
  if (!emoji.image || !/^data:image\/(?:png|gif|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(emoji.image)) {
    throw new Error(`Snapshot emoji ${emoji.name ?? emoji.id} has no restorable image data URI.`);
  }
  return emoji.image;
}

function resolvedReference(referenceValue: RestoreReference, ids: { roles: Map<string, string>; channels: Map<string, string> }): string {
  const values = referenceValue.restoreReference === 'role' ? ids.roles : ids.channels;
  const resolved = values.get(referenceValue.sourceId);
  if (!resolved) throw new Error(`Restore dependency ${referenceValue.restoreReference} ${referenceValue.sourceId} has not been created.`);
  return resolved;
}

function resolveValue(value: RestoreValue, ids: { roles: Map<string, string>; channels: Map<string, string> }): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, ids));
  if (value && typeof value === 'object') {
    if ('restoreReference' in value && 'sourceId' in value) return resolvedReference(value as RestoreReference, ids);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, ids)]));
  }
  return value;
}

function resolvedPath(path: RestorePath, channelIds: Map<string, string>): string {
  if (typeof path === 'string') return path;
  const channelId = channelIds.get(path.channelSourceId);
  if (!channelId) throw new Error(`Restore dependency channel ${path.channelSourceId} has not been created.`);
  return `/channels/${channelId}`;
}

function existingCandidate(channel: GuildConfigChannel, parent: GuildConfigChannel | null, current: GuildConfigSnapshot, actualParentId: string | null): GuildConfigChannel | undefined {
  const candidates = current.channels.filter((item) => item.type === channel.type && item.name === channel.name);
  const exact = candidates.filter((item) => item.parent_id === actualParentId);
  if (exact.length > 1 || (exact.length === 0 && candidates.length > 1)) {
    throw new Error(`Target has multiple ${channel.name} channels in ${parent?.name ?? 'the guild root'}; restore is ambiguous.`);
  }
  if (exact[0]) return exact[0];
  return parent && actualParentId === null ? undefined : candidates[0];
}

export function planRestore(snapshot: GuildConfigSnapshot, current: GuildConfigSnapshot): RestorePlan {
  if (snapshot.guildId !== current.guildId) throw new Error(`Snapshot guild ${snapshot.guildId} does not match target guild ${current.guildId}.`);
  const roleIds = new Map<string, string>([[snapshot.guildId, current.guildId]]);
  const channelIds = new Map<string, string>();
  const emojiIds = new Map<string, string>();
  const roleOperations: RestoreOperation[] = [];
  const rolePositionOperations: RestoreOperation[] = [];
  const categoryOperations: RestoreOperation[] = [];
  const channelOperations: RestoreOperation[] = [];
  const channelPositionOperations: RestoreOperation[] = [];
  const overwriteOperations: RestoreOperation[] = [];
  const settingsOperations: RestoreOperation[] = [];
  const emojiOperations: RestoreOperation[] = [];
  let roleWrites = 0;
  let channelWrites = 0;
  let overwriteWrites = 0;
  let settingsWrites = 0;
  let emojiWrites = 0;

  const currentRoleIds = new Set(current.roles.map((role) => role.id));
  for (const role of snapshot.roles.filter((item) => item.managed && currentRoleIds.has(item.id))) {
    roleIds.set(role.id, role.id);
  }
  const snapshotRolesById = new Map(snapshot.roles.map((role) => [role.id, role]));
  const overwriteRoleIds = new Set<string>();

  const currentRolesByName = new Map(current.roles.filter((role) => !role.managed).map((role) => [role.name, role]));
  const sourceRoles = snapshot.roles.filter((item) => !item.managed && item.id !== snapshot.guildId).sort((a, b) => a.position - b.position);
  let rolePositionsDiffer = false;
  for (const role of sourceRoles) {
    const actual = currentRolesByName.get(role.name);
    if (!actual) {
      roleOperations.push({
        label: `create role ${role.name}`,
        method: 'POST',
        path: `/guilds/${current.guildId}/roles`,
        body: roleBody(role),
        captureId: { resource: 'role', sourceId: role.id },
      });
      roleWrites++;
      rolePositionsDiffer = true;
      continue;
    }
    roleIds.set(role.id, actual.id);
    rolePositionsDiffer ||= role.position !== actual.position;
    if (!same(roleBody(role), roleBody(actual))) {
      roleOperations.push({ label: `patch role ${role.name}`, method: 'PATCH', path: `/guilds/${current.guildId}/roles/${actual.id}`, body: roleBody(role) });
      roleWrites++;
    }
  }
  if (rolePositionsDiffer) {
    rolePositionOperations.push({
      label: 'restore role positions',
      method: 'PATCH',
      path: `/guilds/${current.guildId}/roles`,
      body: sourceRoles.map((role) => ({ id: reference('role', role.id), position: role.position })),
    });
    roleWrites++;
  }

  const currentCategories = new Map(current.channels.filter((channel) => channel.type === 4).map((channel) => [channel.name, channel]));
  let channelPositionsDiffer = false;
  const sourceChannelPositions: RestoreValue[] = [];
  for (const category of snapshot.channels.filter((channel) => channel.type === 4).sort((a, b) => a.position - b.position)) {
    const actual = currentCategories.get(category.name);
    if (actual) {
      channelIds.set(category.id, actual.id);
      channelPositionsDiffer ||= category.position !== actual.position;
    } else {
      categoryOperations.push({
        label: `create category ${category.name}`,
        method: 'POST',
        path: `/guilds/${current.guildId}/channels`,
        body: { name: category.name, type: 4, position: category.position },
        captureId: { resource: 'channel', sourceId: category.id },
      });
      channelWrites++;
      channelPositionsDiffer = true;
    }
    sourceChannelPositions.push({ id: reference('channel', category.id), position: category.position });

    const expectedOverwrites = category.permission_overwrites ?? [];
    const knownExpectedOverwrites = expectedOverwrites.map((overwrite) => ({
      ...overwrite,
      id: overwrite.type === 0 ? (overwrite.id === snapshot.guildId ? current.guildId : roleIds.get(overwrite.id) ?? overwrite.id) : overwrite.id,
    }));
    const hasUnresolvedRoleReference = expectedOverwrites.some((overwrite) => overwrite.type === 0 && overwrite.id !== snapshot.guildId && !roleIds.has(overwrite.id));
    if ((!actual && expectedOverwrites.length > 0) || hasUnresolvedRoleReference || !same(knownExpectedOverwrites, actual?.permission_overwrites ?? [])) {
      for (const overwrite of expectedOverwrites) {
        if (overwrite.type === 0 && overwrite.id !== snapshot.guildId) overwriteRoleIds.add(overwrite.id);
      }
      overwriteOperations.push({
        label: `restore overwrites ${category.name}`,
        method: 'PATCH',
        path: { channelSourceId: category.id },
        body: { permission_overwrites: overwriteBody(expectedOverwrites, snapshot.guildId) },
      });
      overwriteWrites += expectedOverwrites.length || 1;
    }
  }

  for (const channel of snapshot.channels.filter((item) => item.type !== 4).sort((a, b) => a.position - b.position)) {
    const parent = channel.parent_id ? snapshot.channels.find((item) => item.id === channel.parent_id) ?? null : null;
    const actualParentId = parent ? channelIds.get(parent.id) ?? null : null;
    const actual = existingCandidate(channel, parent, current, actualParentId);
    const targetParent = parent ? reference('channel', parent.id) : null;
    const expectedKnown = channelCoreBody(channel, actualParentId);
    const targetBody = channelCoreBody(channel, targetParent);

    if (!actual) {
      channelOperations.push({
        label: `create channel ${channel.name}`,
        method: 'POST',
        path: `/guilds/${current.guildId}/channels`,
        body: { ...(targetBody as JsonObject), position: channel.position },
        captureId: { resource: 'channel', sourceId: channel.id },
      });
      channelWrites++;
      channelPositionsDiffer = true;
    } else {
      channelIds.set(channel.id, actual.id);
      channelPositionsDiffer ||= channel.position !== actual.position;
      const actualBody = channelCoreBody(actual, actual.parent_id);
      if ((parent && !actualParentId) || !same(expectedKnown, actualBody)) {
        channelOperations.push({ label: `patch channel ${channel.name}`, method: 'PATCH', path: { channelSourceId: channel.id }, body: targetBody });
        channelWrites++;
      }
    }
    sourceChannelPositions.push({
      id: reference('channel', channel.id),
      position: channel.position,
      parent_id: parent ? reference('channel', parent.id) : null,
    });

    const expectedOverwrites = channel.permission_overwrites ?? [];
    const knownExpectedOverwrites = expectedOverwrites.map((overwrite) => ({
      ...overwrite,
      id: overwrite.type === 0 ? (overwrite.id === snapshot.guildId ? current.guildId : roleIds.get(overwrite.id) ?? overwrite.id) : overwrite.id,
    }));
    const hasCreatedRoleReference = expectedOverwrites.some((overwrite) => overwrite.type === 0 && overwrite.id !== snapshot.guildId && !roleIds.has(overwrite.id));
    if ((!actual && expectedOverwrites.length > 0) || hasCreatedRoleReference || !same(knownExpectedOverwrites, actual?.permission_overwrites ?? [])) {
      for (const overwrite of expectedOverwrites) {
        if (overwrite.type === 0 && overwrite.id !== snapshot.guildId) overwriteRoleIds.add(overwrite.id);
      }
      overwriteOperations.push({
        label: `restore overwrites ${channel.name}`,
        method: 'PATCH',
        path: { channelSourceId: channel.id },
        body: { permission_overwrites: overwriteBody(expectedOverwrites, snapshot.guildId) },
      });
      overwriteWrites += expectedOverwrites.length || 1;
    }
  }

  if (channelPositionsDiffer) {
    channelPositionOperations.push({
      label: 'restore channel positions',
      method: 'PATCH',
      path: `/guilds/${current.guildId}/channels`,
      body: sourceChannelPositions,
    });
    channelWrites++;
  }

  const guildBody = bodyFromFields(snapshot.guild, GUILD_FIELDS) as Record<string, RestoreValue>;
  let unresolvedGuildChannel = false;
  const knownGuildBody = { ...guildBody } as JsonObject;
  for (const field of ['system_channel_id', 'rules_channel_id', 'public_updates_channel_id', 'afk_channel_id'] as const) {
    const snapshotChannelId = snapshot.guild[field];
    if (typeof snapshotChannelId === 'string') {
      guildBody[field] = reference('channel', snapshotChannelId);
      const knownId = channelIds.get(snapshotChannelId);
      knownGuildBody[field] = knownId ?? null;
      unresolvedGuildChannel ||= !knownId;
    } else if (snapshotChannelId === null) {
      guildBody[field] = null;
      knownGuildBody[field] = null;
    }
  }
  const currentGuildBody = bodyFromFields(current.guild, Object.keys(knownGuildBody));
  if (unresolvedGuildChannel || !same(knownGuildBody, currentGuildBody)) {
    settingsOperations.push({ label: 'restore guild settings', method: 'PATCH', path: `/guilds/${current.guildId}`, body: guildBody });
    settingsWrites++;
  }

  const currentEmojis = new Map(current.emojis.filter((emoji) => emoji.name).map((emoji) => [emoji.name!, emoji]));
  for (const emoji of snapshot.emojis.filter((item) => !item.managed && item.name)) {
    const roles = emoji.roles.map((roleId) => reference('role', roleId));
    const knownRoles = emoji.roles.map((roleId) => roleIds.get(roleId) ?? roleId);
    const hasCreatedRoleReference = emoji.roles.some((roleId) => !roleIds.has(roleId));
    const actual = currentEmojis.get(emoji.name!);
    if (!actual) {
      emojiOperations.push({
        label: `create emoji ${emoji.name}`,
        method: 'POST',
        path: `/guilds/${current.guildId}/emojis`,
        body: { name: emoji.name, image: emojiImage(emoji), roles },
        captureId: { resource: 'emoji', sourceId: emoji.id },
      });
      emojiWrites++;
    } else {
      emojiIds.set(emoji.id, actual.id);
      if (hasCreatedRoleReference || !same({ name: emoji.name, roles: knownRoles }, { name: actual.name, roles: actual.roles })) {
        emojiOperations.push({ label: `patch emoji ${emoji.name}`, method: 'PATCH', path: `/guilds/${current.guildId}/emojis/${actual.id}`, body: { name: emoji.name, roles } });
        emojiWrites++;
      }
    }
  }

  for (const emoji of snapshot.emojis.filter((item) => item.managed)) {
    const actual = current.emojis.find((item) => item.managed && item.id === emoji.id);
    if (actual) emojiIds.set(emoji.id, actual.id);
  }

  const overwriteRoles = [...overwriteRoleIds].map((roleId) => {
    const role = snapshotRolesById.get(roleId);
    if (!role) throw new Error(`Snapshot overwrite references unknown role ${roleId}.`);
    return { id: role.id, name: role.name, position: role.position };
  });
  const overwriteTargets = [...snapshot.channels.filter((channel) =>
    overwriteOperations.some((operation) => typeof operation.path !== 'string' && operation.path.channelSourceId === channel.id))]
    .map((channel) => {
      const currentId = channelIds.get(channel.id) ?? null;
      const currentChannel = currentId ? current.channels.find((item) => item.id === currentId) : undefined;
      const sourceParent = channel.parent_id ? snapshot.channels.find((item) => item.id === channel.parent_id) : undefined;
      return {
        currentId,
        name: channel.name,
        currentOverwrites: currentChannel?.permission_overwrites ?? [],
        desiredOverwrites: channel.permission_overwrites ?? [],
        inheritedDesiredOverwrites: sourceParent?.permission_overwrites ?? [],
      };
    });

  const operations = [
    ...roleOperations,
    ...rolePositionOperations,
    ...categoryOperations,
    ...channelOperations,
    ...channelPositionOperations,
    ...overwriteOperations,
    ...settingsOperations,
    ...emojiOperations,
  ];
  return {
    counts: {
      roles: roleWrites,
      channels: channelWrites,
      overwrites: overwriteWrites,
      settings: settingsWrites,
      emojis: emojiWrites,
      operations: operations.length,
    },
    knownIds: { roles: Object.fromEntries(roleIds), channels: Object.fromEntries(channelIds), emojis: Object.fromEntries(emojiIds) },
    overwriteRoles,
    overwriteTargets,
    operations,
  };
}

export async function applyRestorePlan(api: GuildConfigDiscordApi, plan: RestorePlan): Promise<RestoreIdMap> {
  const ids = {
    roles: new Map(Object.entries(plan.knownIds.roles)),
    channels: new Map(Object.entries(plan.knownIds.channels)),
    emojis: new Map(Object.entries(plan.knownIds.emojis)),
  };
  for (const operation of plan.operations) {
    const result = await api.write<{ id?: string }>(operation.method, resolvedPath(operation.path, ids.channels), resolveValue(operation.body, ids));
    if (!operation.captureId) continue;
    if (!result?.id) throw new Error(`${operation.label} returned no Discord id.`);
    const values = ids[`${operation.captureId.resource}s`];
    values.set(operation.captureId.sourceId, result.id);
  }
  return {
    roles: Object.fromEntries(ids.roles),
    channels: Object.fromEntries(ids.channels),
    emojis: Object.fromEntries(ids.emojis),
  };
}

export function remapSnapshotIds(snapshot: GuildConfigSnapshot, ids: RestoreIdMap): GuildConfigSnapshot {
  const roleId = (sourceId: string) => ids.roles[sourceId] ?? sourceId;
  const channelId = (sourceId: string) => ids.channels[sourceId] ?? sourceId;
  const emojiId = (sourceId: string) => ids.emojis[sourceId] ?? sourceId;
  const guild = { ...snapshot.guild };
  for (const field of ['system_channel_id', 'rules_channel_id', 'public_updates_channel_id', 'afk_channel_id'] as const) {
    const sourceId = guild[field];
    if (typeof sourceId === 'string') guild[field] = channelId(sourceId);
  }
  return {
    ...snapshot,
    guild,
    roles: snapshot.roles.map((role) => ({ ...role, id: roleId(role.id) })),
    channels: snapshot.channels.map((channel) => ({
      ...channel,
      id: channelId(channel.id),
      parent_id: channel.parent_id ? channelId(channel.parent_id) : null,
      permission_overwrites: channel.permission_overwrites.map((overwrite) => ({
        ...overwrite,
        id: overwrite.type === 0 ? roleId(overwrite.id) : channelId(overwrite.id),
      })),
    })),
    emojis: snapshot.emojis.map((emoji) => ({
      ...emoji,
      id: emojiId(emoji.id),
      roles: emoji.roles.map(roleId),
    })),
  };
}

export function snapshotsEqual(left: GuildConfigSnapshot, right: GuildConfigSnapshot): boolean {
  return configHash(canonicalSnapshot(left)) === configHash(canonicalSnapshot(right));
}
