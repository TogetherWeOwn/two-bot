/**
 * Bounded strict gateway ingress policy (TOG-3903 checkpoint).
 *
 * FIXTURE-ONLY readability/shape contract after the TOG-4007 decision. Do not
 * wire this strict synthetic-owner/exact-key policy into actual-staging
 * dispatch. restartGatewayAdmission separates identity/event admission from
 * this contract; neither predicate is persistence consent or execution approval.
 *
 * Fail-closed allowlist for the staging restart seam. Admits only the narrow
 * metadata-safe subset needed for READY, GUILD_CREATE, GUILD_MEMBER_ADD,
 * GUILD_MEMBER_UPDATE, GUILD_MEMBER_REMOVE and MESSAGE_CREATE. Every other
 * event, unknown key at any nested object, malformed shape, unbound actor or
 * non-staging guild/bot binding returns false. Never projects, rewrites, or
 * mutates payloads.
 *
 * This is NOT a full ingress sandbox: it validates shape and binding only.
 * Ordering, replay, session, rate and transport concerns stay with the
 * strategy/shard. See restartGatewayStrategy.ts.
 *
 * Scope is wire JSON (plain data already decoded from the gateway frame).
 * This policy is not a hostile-code sandbox: getters, proxies, or prototype
 * tricks on a live object are outside its threat model. Callers must pass
 * plain decoded payloads.
 */
import type { RestartGatewayPolicy } from './restartGatewayStrategy.ts';
import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from './spec.ts';

/** The only resume URL the policy admits. No loopback or http override. */
const CANONICAL_RESUME_URL = 'wss://gateway.discord.gg';

const POLICY_ERROR = 'Staging gateway policy requires synthetic actors as Discord user ids.';

const SNOWFLAKE = /^(?:[1-9]\d{16,18}|1\d{19})$/;
/** Max uint64: 20 digits all 9s overflows, so bound the 20-digit range. */
const MAX_UINT64 = (1n << 64n) - 1n;
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Discord role color range: 0x000000-0xFFFFFF. */
const MAX_COLOR = 0xffffff;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

/** Nonnegative safe integer only: rejects NaN, Infinity, fractions, negatives. */
function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isColor(value: unknown): value is number {
  return isNonNegativeSafeInt(value) && value <= MAX_COLOR;
}

/** Canonical ISO instant only: round-trips through toISOString. */
function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!CANONICAL_ISO.test(value)) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString() === value;
}

function keysExactlyAllowed(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function hasRequired(value: Record<string, unknown>, required: ReadonlyArray<string>): boolean {
  for (const key of required) {
    if (!(key in value)) return false;
  }
  return true;
}

function isSnowflake(value: unknown): value is string {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) return false;
  if (value.length === 20) {
    try {
      if (BigInt(value) > MAX_UINT64) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isSnowflakeArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!isSnowflake(entry)) return false;
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (typeof entry !== 'string') return false;
  }
  return true;
}

const USER_ALLOWED = new Set(['id', 'username', 'discriminator', 'global_name', 'avatar', 'bot', 'system', 'flags']);
const USER_REQUIRED: ReadonlyArray<string> = ['id', 'username', 'discriminator', 'global_name', 'avatar', 'bot', 'system', 'flags'];

function isStrictUser(
  value: unknown,
  opts: { bot: boolean; id?: string; allowlist?: ReadonlySet<string> },
): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, USER_ALLOWED)) return false;
  if (!hasRequired(value, USER_REQUIRED)) return false;
  const id = value['id'];
  const username = value['username'];
  const discriminator = value['discriminator'];
  const globalName = value['global_name'];
  const avatar = value['avatar'];
  const bot = value['bot'];
  const system = value['system'];
  const flags = value['flags'];
  if (!isSnowflake(id)) return false;
  if (typeof username !== 'string' || username.length === 0) return false;
  if (typeof discriminator !== 'string') return false;
  if (!isStringOrNull(globalName)) return false;
  if (!isStringOrNull(avatar)) return false;
  if (bot !== opts.bot) return false;
  if (system !== false) return false;
  if (!isNonNegativeSafeInt(flags)) return false;
  if (opts.id !== undefined) {
    if (id !== opts.id) return false;
    return true;
  }
  if (opts.allowlist !== undefined) {
    if (opts.allowlist.has(id)) return true;
    return false;
  }
  return true;
}

const READY_ALLOWED = new Set([
  'v',
  'user',
  'guilds',
  'session_id',
  'resume_gateway_url',
  'shard',
  'application',
]);
const READY_REQUIRED: ReadonlyArray<string> = ['v', 'user', 'guilds', 'session_id', 'resume_gateway_url', 'shard', 'application'];
const READY_GUILD_ALLOWED = new Set(['id', 'unavailable']);
const APP_ALLOWED = new Set(['id', 'flags']);

function isReadyPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, READY_ALLOWED)) return false;
  if (!hasRequired(value, READY_REQUIRED)) return false;
  if (value['v'] !== 10) return false;
  if (!isStrictUser(value['user'], { bot: true, id: STAGING_BOT_APPLICATION_ID })) return false;
  const guilds = value['guilds'];
  if (!Array.isArray(guilds) || guilds.length !== 1) return false;
  const guild = guilds[0];
  if (!isRecord(guild)) return false;
  if (!keysExactlyAllowed(guild, READY_GUILD_ALLOWED)) return false;
  if (guild['id'] !== TWO_STAGING_GUILD_ID) return false;
  if (guild['unavailable'] !== true) return false;
  if (!isNonEmptyString(value['session_id'])) return false;
  if (value['resume_gateway_url'] !== CANONICAL_RESUME_URL) return false;
  const shard = value['shard'];
  if (!Array.isArray(shard) || shard.length !== 2) return false;
  if (shard[0] !== 0 || shard[1] !== 1) return false;
  const application = value['application'];
  if (!isRecord(application)) return false;
  if (!keysExactlyAllowed(application, APP_ALLOWED)) return false;
  if (application['id'] !== STAGING_BOT_APPLICATION_ID) return false;
  if (!isNonNegativeSafeInt(application['flags'])) return false;
  return true;
}

const ROLE_ALLOWED = new Set([
  'id',
  'name',
  'color',
  'hoist',
  'position',
  'permissions',
  'managed',
  'mentionable',
  'flags',
  'tags',
]);
const ROLE_REQUIRED: ReadonlyArray<string> = ['id', 'name', 'color', 'hoist', 'position', 'permissions', 'managed', 'mentionable', 'flags'];
const ROLE_TAG_ALLOWED = new Set([
  'bot_id',
  'integration_id',
  'premium_subscriber',
  'subscription_listing_id',
  'available_for_purchase',
  'guild_connections',
]);

function isRoleTags(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, ROLE_TAG_ALLOWED)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'bot_id') {
      if (entry !== STAGING_BOT_APPLICATION_ID) return false;
    } else if (key === 'integration_id' || key === 'subscription_listing_id') {
      if (!isSnowflake(entry)) return false;
    } else if (
      key === 'premium_subscriber' ||
      key === 'available_for_purchase' ||
      key === 'guild_connections'
    ) {
      if (entry !== null) return false;
    } else {
      return false;
    }
  }
  return true;
}

function isRole(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, ROLE_ALLOWED)) return false;
  if (!hasRequired(value, ROLE_REQUIRED)) return false;
  if (!isSnowflake(value['id'])) return false;
  if (typeof value['name'] !== 'string') return false;
  if (!isColor(value['color'])) return false;
  if (typeof value['hoist'] !== 'boolean') return false;
  if (!isNonNegativeSafeInt(value['position'])) return false;
  if (typeof value['permissions'] !== 'string' || !/^\d+$/.test(value['permissions'])) return false;
  if (typeof value['managed'] !== 'boolean') return false;
  if (typeof value['mentionable'] !== 'boolean') return false;
  if (!isNonNegativeSafeInt(value['flags'])) return false;
  if ('tags' in value && value['tags'] !== undefined) {
    if (!isRoleTags(value['tags'])) return false;
  }
  return true;
}

const OVERWRITE_ALLOWED = new Set(['id', 'type', 'allow', 'deny']);

function isOverwrite(value: unknown, allowlist: ReadonlySet<string>): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, OVERWRITE_ALLOWED)) return false;
  if (!hasRequired(value, ['id', 'type', 'allow', 'deny'])) return false;
  const id = value['id'];
  const type = value['type'];
  if (!isSnowflake(id)) return false;
  if (type !== 0 && type !== 1) return false;
  if (typeof value['allow'] !== 'string' || !/^\d+$/.test(value['allow'])) return false;
  if (typeof value['deny'] !== 'string' || !/^\d+$/.test(value['deny'])) return false;
  if (type === 1) {
    if (id !== STAGING_BOT_APPLICATION_ID && !allowlist.has(id)) return false;
  }
  return true;
}

const CHANNEL_ALLOWED = new Set([
  'id',
  'type',
  'guild_id',
  'name',
  'position',
  'permission_overwrites',
  'nsfw',
  'parent_id',
  'bitrate',
  'user_limit',
]);
const CHANNEL_REQUIRED: ReadonlyArray<string> = ['id', 'type', 'guild_id', 'name', 'position', 'permission_overwrites'];

function isChannel(value: unknown, allowlist: ReadonlySet<string>): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, CHANNEL_ALLOWED)) return false;
  if (!hasRequired(value, CHANNEL_REQUIRED)) return false;
  if (!isSnowflake(value['id'])) return false;
  if (value['type'] !== 0 && value['type'] !== 2 && value['type'] !== 4) return false;
  if (value['guild_id'] !== TWO_STAGING_GUILD_ID) return false;
  if (typeof value['name'] !== 'string' || value['name'].length === 0) return false;
  if (!isNonNegativeSafeInt(value['position'])) return false;
  const overwrites = value['permission_overwrites'];
  if (!Array.isArray(overwrites)) return false;
  for (const entry of overwrites) {
    if (!isOverwrite(entry, allowlist)) return false;
  }
  if ('nsfw' in value && value['nsfw'] !== undefined && typeof value['nsfw'] !== 'boolean') return false;
  if ('parent_id' in value && value['parent_id'] !== undefined && value['parent_id'] !== null) {
    if (!isSnowflake(value['parent_id'])) return false;
  }
  if ('bitrate' in value && value['bitrate'] !== undefined && !isNonNegativeSafeInt(value['bitrate'])) {
    return false;
  }
  if ('user_limit' in value && value['user_limit'] !== undefined && !isNonNegativeSafeInt(value['user_limit'])) {
    return false;
  }
  return true;
}

const GUILD_MEMBER_ALLOWED = new Set(['user', 'roles', 'joined_at', 'deaf', 'mute', 'flags', 'pending']);
const GUILD_MEMBER_REQUIRED: ReadonlyArray<string> = ['user', 'roles', 'joined_at', 'deaf', 'mute', 'flags', 'pending'];

function isGuildMember(value: unknown, allowlist: ReadonlySet<string>): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, GUILD_MEMBER_ALLOWED)) return false;
  if (!hasRequired(value, GUILD_MEMBER_REQUIRED)) return false;
  const user = value['user'];
  if (!isRecord(user)) return false;
  const userId = user['id'];
  if (!isSnowflake(userId)) return false;
  if (userId === STAGING_BOT_APPLICATION_ID) {
    if (!isStrictUser(user, { bot: true, id: STAGING_BOT_APPLICATION_ID })) return false;
  } else {
    if (!isStrictUser(user, { bot: false, allowlist })) return false;
  }
  if (!isSnowflakeArray(value['roles'])) return false;
  if (!isCanonicalIso(value['joined_at'])) return false;
  if (typeof value['deaf'] !== 'boolean') return false;
  if (typeof value['mute'] !== 'boolean') return false;
  if (typeof value['pending'] !== 'boolean') return false;
  if (!isNonNegativeSafeInt(value['flags'])) return false;
  return true;
}

const GUILD_ALLOWED = new Set([
  'id',
  'name',
  'icon',
  'splash',
  'discovery_splash',
  'owner_id',
  'region',
  'afk_channel_id',
  'afk_timeout',
  'verification_level',
  'default_message_notifications',
  'explicit_content_filter',
  'mfa_level',
  'application_id',
  'system_channel_id',
  'system_channel_flags',
  'rules_channel_id',
  'vanity_url_code',
  'description',
  'banner',
  'premium_tier',
  'preferred_locale',
  'public_updates_channel_id',
  'nsfw_level',
  'premium_progress_bar_enabled',
  'unavailable',
  'member_count',
  'large',
  'joined_at',
  'features',
  'emojis',
  'stickers',
  'roles',
  'channels',
  'threads',
  'members',
  'presences',
  'voice_states',
  'stage_instances',
  'guild_scheduled_events',
  'soundboard_sounds',
]);
const GUILD_REQUIRED: ReadonlyArray<string> = ['id', 'owner_id', 'roles', 'channels', 'members', 'unavailable'];

function isEmptyArrayField(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  if (value.length !== 0) return false;
  return true;
}

function isGuildCreate(value: unknown, allowlist: ReadonlySet<string>): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, GUILD_ALLOWED)) return false;
  if (!hasRequired(value, GUILD_REQUIRED)) return false;
  if (value['id'] !== TWO_STAGING_GUILD_ID) return false;
  const ownerId = value['owner_id'];
  if (!isSnowflake(ownerId)) return false;
  if (!allowlist.has(ownerId)) return false;
  if (value['unavailable'] !== false) return false;
  if ('name' in value && value['name'] !== undefined && typeof value['name'] !== 'string') return false;
  if ('icon' in value && !isStringOrNull(value['icon'])) return false;
  if ('splash' in value && !isStringOrNull(value['splash'])) return false;
  if ('discovery_splash' in value && !isStringOrNull(value['discovery_splash'])) return false;
  if ('region' in value && value['region'] !== undefined && value['region'] !== null) {
    if (typeof value['region'] !== 'string') return false;
  }
  if ('afk_channel_id' in value && value['afk_channel_id'] !== undefined && value['afk_channel_id'] !== null) {
    if (!isSnowflake(value['afk_channel_id'])) return false;
  }
  if ('afk_timeout' in value && value['afk_timeout'] !== undefined && !isNonNegativeSafeInt(value['afk_timeout'])) {
    return false;
  }
  if (
    'verification_level' in value &&
    value['verification_level'] !== undefined &&
    !isNonNegativeSafeInt(value['verification_level'])
  ) {
    return false;
  }
  if (
    'default_message_notifications' in value &&
    value['default_message_notifications'] !== undefined &&
    !isNonNegativeSafeInt(value['default_message_notifications'])
  ) {
    return false;
  }
  if (
    'explicit_content_filter' in value &&
    value['explicit_content_filter'] !== undefined &&
    !isNonNegativeSafeInt(value['explicit_content_filter'])
  ) {
    return false;
  }
  if ('mfa_level' in value && value['mfa_level'] !== undefined && !isNonNegativeSafeInt(value['mfa_level'])) {
    return false;
  }
  if ('application_id' in value && value['application_id'] !== undefined && value['application_id'] !== null) {
    if (value['application_id'] !== STAGING_BOT_APPLICATION_ID) return false;
  }
  if (
    'system_channel_id' in value &&
    value['system_channel_id'] !== undefined &&
    value['system_channel_id'] !== null
  ) {
    if (!isSnowflake(value['system_channel_id'])) return false;
  }
  if (
    'system_channel_flags' in value &&
    value['system_channel_flags'] !== undefined &&
    !isNonNegativeSafeInt(value['system_channel_flags'])
  ) {
    return false;
  }
  if ('rules_channel_id' in value && value['rules_channel_id'] !== undefined && value['rules_channel_id'] !== null) {
    if (!isSnowflake(value['rules_channel_id'])) return false;
  }
  if ('vanity_url_code' in value && !isStringOrNull(value['vanity_url_code'])) return false;
  if ('description' in value && !isStringOrNull(value['description'])) return false;
  if ('banner' in value && !isStringOrNull(value['banner'])) return false;
  if (
    'premium_tier' in value &&
    value['premium_tier'] !== undefined &&
    !isNonNegativeSafeInt(value['premium_tier'])
  ) {
    return false;
  }
  if (
    'preferred_locale' in value &&
    value['preferred_locale'] !== undefined &&
    typeof value['preferred_locale'] !== 'string'
  ) {
    return false;
  }
  if (
    'public_updates_channel_id' in value &&
    value['public_updates_channel_id'] !== undefined &&
    value['public_updates_channel_id'] !== null
  ) {
    if (!isSnowflake(value['public_updates_channel_id'])) return false;
  }
  if (
    'nsfw_level' in value &&
    value['nsfw_level'] !== undefined &&
    !isNonNegativeSafeInt(value['nsfw_level'])
  ) {
    return false;
  }
  if (
    'premium_progress_bar_enabled' in value &&
    value['premium_progress_bar_enabled'] !== undefined &&
    typeof value['premium_progress_bar_enabled'] !== 'boolean'
  ) {
    return false;
  }
  if (
    'member_count' in value &&
    value['member_count'] !== undefined &&
    !isNonNegativeSafeInt(value['member_count'])
  ) {
    return false;
  }
  if ('large' in value && value['large'] !== undefined && typeof value['large'] !== 'boolean') return false;
  if ('joined_at' in value && value['joined_at'] !== undefined && !isCanonicalIso(value['joined_at'])) {
    return false;
  }
  if ('features' in value && value['features'] !== undefined && !isStringArray(value['features'])) return false;
  if (!isEmptyArrayField(value['emojis'])) return false;
  if (!isEmptyArrayField(value['stickers'])) return false;
  if (!isEmptyArrayField(value['threads'])) return false;
  if (!isEmptyArrayField(value['presences'])) return false;
  if (!isEmptyArrayField(value['voice_states'])) return false;
  if (!isEmptyArrayField(value['stage_instances'])) return false;
  if (!isEmptyArrayField(value['guild_scheduled_events'])) return false;
  if (!isEmptyArrayField(value['soundboard_sounds'])) return false;
  const roles = value['roles'];
  if (!Array.isArray(roles)) return false;
  for (const role of roles) {
    if (!isRole(role)) return false;
  }
  const channels = value['channels'];
  if (!Array.isArray(channels)) return false;
  for (const channel of channels) {
    if (!isChannel(channel, allowlist)) return false;
  }
  const members = value['members'];
  if (!Array.isArray(members) || members.length === 0) return false;
  let sawBot = false;
  for (const member of members) {
    if (!isGuildMember(member, allowlist)) return false;
    const user = (member as Record<string, unknown>)['user'] as Record<string, unknown>;
    if (user['id'] === STAGING_BOT_APPLICATION_ID) sawBot = true;
  }
  if (!sawBot) return false;
  return true;
}

const MEMBER_EVENT_ALLOWED = new Set([
  'guild_id',
  'user',
  'nick',
  'avatar',
  'roles',
  'joined_at',
  'premium_since',
  'deaf',
  'mute',
  'pending',
  'flags',
]);
const MEMBER_EVENT_REQUIRED: ReadonlyArray<string> = ['guild_id', 'user', 'roles', 'joined_at', 'deaf', 'mute', 'pending', 'flags'];

function isMemberAddOrUpdate(value: unknown, allowlist: ReadonlySet<string>): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, MEMBER_EVENT_ALLOWED)) return false;
  if (!hasRequired(value, MEMBER_EVENT_REQUIRED)) return false;
  if (value['guild_id'] !== TWO_STAGING_GUILD_ID) return false;
  if (!isStrictUser(value['user'], { bot: false, allowlist })) return false;
  if ('nick' in value && !isStringOrNull(value['nick'])) return false;
  if ('avatar' in value && !isStringOrNull(value['avatar'])) return false;
  if (!isSnowflakeArray(value['roles'])) return false;
  if (!isCanonicalIso(value['joined_at'])) return false;
  if (value['premium_since'] !== undefined && value['premium_since'] !== null) {
    if (!isCanonicalIso(value['premium_since'])) return false;
  }
  if (typeof value['deaf'] !== 'boolean') return false;
  if (typeof value['mute'] !== 'boolean') return false;
  if (typeof value['pending'] !== 'boolean') return false;
  if (!isNonNegativeSafeInt(value['flags'])) return false;
  return true;
}

const MEMBER_REMOVE_ALLOWED = new Set(['guild_id', 'user']);

function isMemberRemove(value: unknown, allowlist: ReadonlySet<string>): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, MEMBER_REMOVE_ALLOWED)) return false;
  if (!hasRequired(value, ['guild_id', 'user'])) return false;
  if (value['guild_id'] !== TWO_STAGING_GUILD_ID) return false;
  if (!isStrictUser(value['user'], { bot: false, allowlist })) return false;
  return true;
}

const MESSAGE_ALLOWED = new Set([
  'id',
  'channel_id',
  'guild_id',
  'author',
  'member',
  'content',
  'timestamp',
  'edited_timestamp',
  'tts',
  'mention_everyone',
  'mentions',
  'mention_roles',
  'attachments',
  'embeds',
  'pinned',
  'type',
  'referenced_message',
]);
const MESSAGE_REQUIRED: ReadonlyArray<string> = [
  'id',
  'channel_id',
  'guild_id',
  'author',
  'content',
  'timestamp',
  'edited_timestamp',
  'tts',
  'mention_everyone',
  'mentions',
  'mention_roles',
  'attachments',
  'embeds',
  'pinned',
  'type',
];
const MESSAGE_MEMBER_ALLOWED = new Set(['roles', 'joined_at', 'deaf', 'mute', 'flags', 'user']);
const MESSAGE_MEMBER_REQUIRED: ReadonlyArray<string> = ['roles', 'joined_at', 'deaf', 'mute', 'flags'];

function isMessageMember(value: unknown, authorId: string): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, MESSAGE_MEMBER_ALLOWED)) return false;
  if (!hasRequired(value, MESSAGE_MEMBER_REQUIRED)) return false;
  if (!isSnowflakeArray(value['roles'])) return false;
  if (!isCanonicalIso(value['joined_at'])) return false;
  if (typeof value['deaf'] !== 'boolean') return false;
  if (typeof value['mute'] !== 'boolean') return false;
  if (!isNonNegativeSafeInt(value['flags'])) return false;
  if ('user' in value && value['user'] !== undefined) {
    if (!isStrictUser(value['user'], { bot: false, id: authorId })) return false;
  }
  return true;
}

function isMessageCreate(value: unknown, allowlist: ReadonlySet<string>): boolean {
  if (!isRecord(value)) return false;
  if (!keysExactlyAllowed(value, MESSAGE_ALLOWED)) return false;
  if (!hasRequired(value, MESSAGE_REQUIRED)) return false;
  if (!isSnowflake(value['id'])) return false;
  if (!isSnowflake(value['channel_id'])) return false;
  if (value['guild_id'] !== TWO_STAGING_GUILD_ID) return false;
  const author = value['author'];
  if (!isStrictUser(author, { bot: false, allowlist })) return false;
  const authorId = (author as Record<string, unknown>)['id'] as string;
  if ('member' in value && value['member'] !== undefined) {
    if (!isMessageMember(value['member'], authorId)) return false;
  }
  if (value['content'] !== '') return false;
  if (!isCanonicalIso(value['timestamp'])) return false;
  if (value['edited_timestamp'] !== null) return false;
  if (value['tts'] !== false) return false;
  if (value['mention_everyone'] !== false) return false;
  if (!Array.isArray(value['mentions']) || value['mentions'].length !== 0) return false;
  if (!Array.isArray(value['mention_roles']) || value['mention_roles'].length !== 0) return false;
  if (!Array.isArray(value['attachments']) || value['attachments'].length !== 0) return false;
  if (!Array.isArray(value['embeds']) || value['embeds'].length !== 0) return false;
  if (value['pinned'] !== false) return false;
  if (value['type'] !== 0) return false;
  if ('referenced_message' in value && value['referenced_message'] !== undefined) {
    if (value['referenced_message'] !== null) return false;
  }
  return true;
}

/**
 * Build the bounded staging gateway policy. The allowlist is copied and
 * validated first; malformed entries throw a static error. The live policy
 * holds its own copy, so mutating the caller's Set afterwards cannot broaden
 * admission. Synthetic actors must be plain Discord user ids: the staging/live
 * bot ids and the staging/live guild ids are never valid actor entries.
 * An empty set is a valid closed policy: only the bot-only READY handshake
 * can pass.
 */
export function createRestartGatewayPolicy(syntheticActorIds: ReadonlySet<string>): RestartGatewayPolicy {
  if (!(syntheticActorIds instanceof Set)) {
    throw new Error(POLICY_ERROR);
  }
  const allowlist = new Set<string>();
  for (const id of syntheticActorIds) {
    if (!isSnowflake(id)) {
      throw new Error(POLICY_ERROR);
    }
    if (
      id === STAGING_BOT_APPLICATION_ID ||
      id === LIVE_BOT_APPLICATION_ID ||
      id === TWO_STAGING_GUILD_ID ||
      id === LIVE_GUILD_ID
    ) {
      throw new Error(POLICY_ERROR);
    }
    if (allowlist.has(id)) {
      throw new Error(POLICY_ERROR);
    }
    allowlist.add(id);
  }
  return (type: string, data: unknown): boolean => {
    try {
      if (typeof type !== 'string') return false;
      if (type === 'READY') {
        if (isReadyPayload(data)) return true;
        return false;
      }
      if (type === 'GUILD_CREATE') {
        if (isGuildCreate(data, allowlist)) return true;
        return false;
      }
      if (type === 'GUILD_MEMBER_ADD') {
        if (isMemberAddOrUpdate(data, allowlist)) return true;
        return false;
      }
      if (type === 'GUILD_MEMBER_UPDATE') {
        if (isMemberAddOrUpdate(data, allowlist)) return true;
        return false;
      }
      if (type === 'GUILD_MEMBER_REMOVE') {
        if (isMemberRemove(data, allowlist)) return true;
        return false;
      }
      if (type === 'MESSAGE_CREATE') {
        if (isMessageCreate(data, allowlist)) return true;
        return false;
      }
      return false;
    } catch {
      return false;
    }
  };
}
