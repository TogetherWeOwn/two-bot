/**
 * Temp-voice configuration (TOG-3052).
 *
 * Staging-only and default-off, the same shape as the other parity slices.
 * The live rename of `Squad` into a generator is a separate, owner-gated
 * operator change; nothing here may point at the live guild.
 */
import { TWO_STAGING_GUILD_ID } from '../staging/spec.ts';

export const TEMP_VOICE_CONTROLS = [
  'name',
  'limit',
  'lock',
  'unlock',
  'permit',
  'reject',
  'hide',
  'reveal',
  'kick',
  'claim',
  'transfer',
  'bitrate',
] as const;

export type TempVoiceControl = (typeof TEMP_VOICE_CONTROLS)[number];

export interface TempVoiceConfig {
  enabled: boolean;
  generatorChannelId: string;
  categoryId: string;
  /** Channels that are never candidates for deletion regardless of any row. */
  protectedChannelIds: ReadonlySet<string>;
  emptyGraceSeconds: number;
  sweepSeconds: number;
  maxPerUser: number;
  maxPerGuild: number;
  createCooldownSeconds: number;
  nameTemplate: string;
  panelChannelId: string | null;
  disabledControls: ReadonlySet<TempVoiceControl>;
}

const SNOWFLAKE = /^\d{15,25}$/u;

function requireSnowflake(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim() ?? '';
  if (!SNOWFLAKE.test(value)) {
    throw new Error(`${key} must be a Discord snowflake when TWO_TEMP_VOICE=1; got ${value || 'unset'}.`);
  }
  return value;
}

function optionalSnowflake(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim() ?? '';
  if (!value) return null;
  if (!SNOWFLAKE.test(value)) throw new Error(`${key} must be a Discord snowflake; got ${value}.`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}; got ${raw}.`);
  }
  return value;
}

function parseDisabledControls(raw: string | undefined): ReadonlySet<TempVoiceControl> {
  const parts = (raw ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  const known = new Set<string>(TEMP_VOICE_CONTROLS);
  const unknown = parts.filter((part) => !known.has(part));
  if (unknown.length) {
    throw new Error(
      `TWO_TEMP_VOICE_DISABLED_CONTROLS names unknown controls: ${unknown.join(', ')}. ` +
      `Valid controls: ${TEMP_VOICE_CONTROLS.join(', ')}.`,
    );
  }
  return new Set(parts as TempVoiceControl[]);
}

/**
 * A disabled feature must never throw on a half-configured environment, so the
 * ids are only validated once TWO_TEMP_VOICE=1 has asked for them.
 */
export function loadTempVoiceConfig(env: NodeJS.ProcessEnv = process.env): TempVoiceConfig {
  const enabled = env.TWO_TEMP_VOICE === '1';
  if (!enabled) {
    return {
      enabled: false,
      generatorChannelId: '',
      categoryId: '',
      protectedChannelIds: new Set(),
      emptyGraceSeconds: 60,
      sweepSeconds: 30,
      maxPerUser: 1,
      maxPerGuild: 40,
      createCooldownSeconds: 30,
      nameTemplate: "{username}'s channel",
      panelChannelId: null,
      disabledControls: new Set(),
    };
  }

  const guildId = env.DISCORD_GUILD_ID?.trim();
  if (guildId !== TWO_STAGING_GUILD_ID) {
    throw new Error(
      `TWO_TEMP_VOICE=1 is staging-only: expected guild ${TWO_STAGING_GUILD_ID}, ` +
      `got ${guildId || 'unset'}. Live rollout requires a separately reviewed operator change.`,
    );
  }

  const generatorChannelId = requireSnowflake(env, 'TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID');
  const categoryId = requireSnowflake(env, 'TWO_TEMP_VOICE_CATEGORY_ID');

  // `Lobby` sits in the same category as the generator and must survive every
  // sweep. It is excluded by id, on top of - never instead of - the persisted
  // row check in the service.
  const protectedChannelIds = new Set<string>([generatorChannelId, categoryId]);
  for (const raw of (env.TWO_TEMP_VOICE_PROTECTED_CHANNEL_IDS ?? '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    if (!SNOWFLAKE.test(value)) {
      throw new Error(`TWO_TEMP_VOICE_PROTECTED_CHANNEL_IDS contains a non-snowflake entry: ${value}.`);
    }
    protectedChannelIds.add(value);
  }

  const nameTemplate = env.TWO_TEMP_VOICE_NAME_TEMPLATE?.trim() || "{username}'s channel";
  if (nameTemplate.length > 90) {
    throw new Error('TWO_TEMP_VOICE_NAME_TEMPLATE must be 90 characters or fewer.');
  }

  return {
    enabled,
    generatorChannelId,
    categoryId,
    protectedChannelIds,
    emptyGraceSeconds: integer(env, 'TWO_TEMP_VOICE_EMPTY_GRACE_SECONDS', 60, 5, 3600),
    // Half the grace window, so an empty channel outlives its grace by at most
    // one sweep rather than two. The sweep is a handful of indexed reads.
    sweepSeconds: integer(env, 'TWO_TEMP_VOICE_SWEEP_SECONDS', 30, 15, 3600),
    maxPerUser: integer(env, 'TWO_TEMP_VOICE_MAX_PER_USER', 1, 1, 10),
    // Discord caps a category at 50 channels; staying under it keeps the
    // generator itself creatable and leaves room for Lobby.
    maxPerGuild: integer(env, 'TWO_TEMP_VOICE_MAX_PER_GUILD', 40, 1, 45),
    createCooldownSeconds: integer(env, 'TWO_TEMP_VOICE_CREATE_COOLDOWN_SECONDS', 30, 0, 3600),
    nameTemplate,
    panelChannelId: optionalSnowflake(env, 'TWO_TEMP_VOICE_PANEL_CHANNEL_ID'),
    disabledControls: parseDisabledControls(env.TWO_TEMP_VOICE_DISABLED_CONTROLS),
  };
}
