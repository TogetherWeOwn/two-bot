import { createHash } from 'node:crypto';
import {
  CATEGORIES,
  MODERATOR_ROLE,
  OWNER_ROLE,
  SERVER_DESCRIPTION,
  TEXT_CHANNEL_NAMES,
  TOPICS,
  VOICE_CHANNEL_NAMES,
  desiredEveryoneOverwrite,
} from './clean-slate.ts';

type JsonObject = Record<string, unknown>;

export type GuildConfigRole = {
  id: string;
  name: string;
  managed: boolean;
  color: number;
  hoist: boolean;
  permissions: string;
  mentionable: boolean;
  position: number;
};

export type GuildConfigOverwrite = {
  id: string;
  type: number;
  allow: string;
  deny: string;
};

export type GuildConfigChannel = {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
  position: number;
  topic?: string | null;
  nsfw?: boolean;
  bitrate?: number;
  user_limit?: number;
  rate_limit_per_user?: number;
  permission_overwrites: GuildConfigOverwrite[];
};

export type GuildConfigEmoji = {
  id: string;
  name: string | null;
  roles: string[];
  require_colons: boolean;
  managed: boolean;
  animated: boolean;
  available: boolean;
};

export type GuildConfigSnapshot = {
  version: 1;
  generatedAt: string;
  applicationId: string;
  guildId: string;
  guild: JsonObject;
  roles: GuildConfigRole[];
  channels: GuildConfigChannel[];
  emojis: GuildConfigEmoji[];
};

export type DriftItem = {
  path: string;
  expected: unknown;
  actual: unknown;
  restore: 'create' | 'patch' | 'manual';
};

export type GuildConfigDriftReport = {
  version: 1;
  generatedAt: string;
  guildId: string;
  snapshotHash: string;
  acceptedSpecHash: string;
  counts: { roles: number; channels: number; overwrites: number; emojis: number; drift: number };
  drift: DriftItem[];
};

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function configHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export const GUILD_CONFIG_FIELDS = [
  'name',
  'description',
  'verification_level',
  'default_message_notifications',
  'explicit_content_filter',
  'afk_timeout',
  'preferred_locale',
  'premium_progress_bar_enabled',
  'system_channel_flags',
  'system_channel_id',
  'rules_channel_id',
  'public_updates_channel_id',
  'afk_channel_id',
] as const;

export function canonicalSnapshot(snapshot: GuildConfigSnapshot): JsonObject {
  return {
    version: snapshot.version,
    applicationId: snapshot.applicationId,
    guildId: snapshot.guildId,
    guild: Object.fromEntries(GUILD_CONFIG_FIELDS.map((field) => [field, snapshot.guild[field] ?? null])),
    roles: [...snapshot.roles]
      .map((role) => ({
        id: role.id,
        name: role.name,
        managed: role.managed,
        color: role.color,
        hoist: role.hoist,
        permissions: role.permissions,
        mentionable: role.mentionable,
        position: role.position,
      }))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    channels: [...snapshot.channels]
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parent_id: channel.parent_id,
        position: channel.position,
        topic: channel.topic ?? null,
        nsfw: channel.nsfw ?? false,
        bitrate: channel.bitrate ?? null,
        user_limit: channel.user_limit ?? null,
        rate_limit_per_user: channel.rate_limit_per_user ?? null,
        permission_overwrites: [...(channel.permission_overwrites ?? [])].sort((a, b) => a.type - b.type || a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    emojis: [...snapshot.emojis]
      .map((emoji) => ({
        id: emoji.id,
        name: emoji.name,
        roles: [...(emoji.roles ?? [])].sort(),
        require_colons: emoji.require_colons,
        managed: emoji.managed,
        animated: emoji.animated,
        available: emoji.available,
      }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id)),
  };
}

export function snapshotCounts(snapshot: GuildConfigSnapshot): GuildConfigDriftReport['counts'] {
  return {
    roles: snapshot.roles.length,
    channels: snapshot.channels.length,
    overwrites: snapshot.channels.reduce((sum, channel) => sum + (channel.permission_overwrites?.length ?? 0), 0),
    emojis: snapshot.emojis.length,
    drift: 0,
  };
}

export function acceptedSpec(guildId: string): JsonObject {
  return {
    guild: { description: SERVER_DESCRIPTION },
    roles: [OWNER_ROLE, MODERATOR_ROLE],
    categories: CATEGORIES.map((category, position) => ({
      name: category.name,
      type: 4,
      position,
      channels: category.channels.map((name, channelPosition) => ({
        name,
        type: VOICE_CHANNEL_NAMES.has(name) ? 2 : 0,
        position: channelPosition,
        ...(TEXT_CHANNEL_NAMES.has(name) ? { topic: TOPICS[name as keyof typeof TOPICS] } : {}),
        everyoneOverwrite: desiredEveryoneOverwrite(guildId, name),
      })),
    })),
  };
}

function pushIfDifferent(drift: DriftItem[], path: string, expected: unknown, actual: unknown, restore: DriftItem['restore']): void {
  if (stable(expected) !== stable(actual)) drift.push({ path, expected, actual, restore });
}

export function driftAgainstAcceptedSpec(snapshot: GuildConfigSnapshot): GuildConfigDriftReport {
  const drift: DriftItem[] = [];
  const wanted = acceptedSpec(snapshot.guildId);
  pushIfDifferent(drift, 'guild.description', SERVER_DESCRIPTION, snapshot.guild.description ?? null, 'patch');

  for (const role of [OWNER_ROLE, MODERATOR_ROLE]) {
    const actual = snapshot.roles.find((item) => !item.managed && item.name === role.name);
    if (!actual) {
      drift.push({ path: `roles.${role.name}`, expected: role, actual: null, restore: 'create' });
      continue;
    }
    for (const field of ['color', 'hoist', 'permissions', 'mentionable'] as const) {
      pushIfDifferent(drift, `roles.${role.name}.${field}`, role[field], actual[field], 'patch');
    }
  }

  for (const category of CATEGORIES) {
    const actualCategory = snapshot.channels.find((channel) => channel.type === 4 && channel.name === category.name);
    if (!actualCategory) {
      drift.push({ path: `channels.${category.name}`, expected: { name: category.name, type: 4 }, actual: null, restore: 'create' });
      continue;
    }
    for (const name of category.channels) {
      const type = VOICE_CHANNEL_NAMES.has(name) ? 2 : 0;
      const actual = snapshot.channels.find((channel) => channel.type === type && channel.name === name && channel.parent_id === actualCategory.id);
      if (!actual) {
        drift.push({ path: `channels.${category.name}.${name}`, expected: { name, type, parent: category.name }, actual: null, restore: 'create' });
        continue;
      }
      if (TEXT_CHANNEL_NAMES.has(name)) pushIfDifferent(drift, `channels.${category.name}.${name}.topic`, TOPICS[name as keyof typeof TOPICS], actual.topic ?? null, 'patch');
      const expectedOverwrite = desiredEveryoneOverwrite(snapshot.guildId, name);
      const actualOverwrite = actual.permission_overwrites?.find((overwrite) => overwrite.id === snapshot.guildId && overwrite.type === 0) ?? null;
      pushIfDifferent(drift, `channels.${category.name}.${name}.everyoneOverwrite`, expectedOverwrite, actualOverwrite, 'patch');
    }
  }

  const counts = snapshotCounts(snapshot);
  counts.drift = drift.length;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    guildId: snapshot.guildId,
    snapshotHash: configHash(canonicalSnapshot(snapshot)),
    acceptedSpecHash: configHash(wanted),
    counts,
    drift,
  };
}
