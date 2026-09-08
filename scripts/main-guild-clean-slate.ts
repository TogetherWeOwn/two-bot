/**
 * Apply the owner-accepted clean-slate structure to the live TWO guild.
 *
 * This script is additive by construction: it creates the accepted roles,
 * categories, channels and starter message only when absent; it never removes
 * an existing guild object or member. Existing same-name channels are adopted
 * only when they are already inside the intended category. Existing overwrite
 * entries are merged rather than replaced.
 *
 * Live execution requires both --apply and --confirm-main-guild. Before the
 * first Discord write it fsyncs a complete pre-export and an empty rollback
 * manifest. Every later write is journalled before the request and settled
 * after the response, so an interrupted operation remains visible to rollback.
 *
 *   DISCORD_BOT_TOKEN=… node scripts/main-guild-clean-slate.ts
 *   DISCORD_BOT_TOKEN=… node scripts/main-guild-clean-slate.ts \
 *     --confirm-main-guild --apply
 *
 * Test-only API overrides must be loopback URLs.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, LIVE_GUILD_NAME } from '../src/staging/spec.ts';
import {
  CATEGORIES,
  MODERATOR_ROLE,
  OPERATIONS_CHANNEL_NAMES,
  OWNER_ROLE,
  PUBLIC_READ_ONLY,
  RULES,
  SCREENING_DESCRIPTION,
  SERVER_DESCRIPTION,
  STARTER_MESSAGE,
  TEXT_CHANNEL_NAMES,
  TOPICS,
  VOICE_CHANNEL_NAMES,
  WELCOME_DESCRIPTION,
} from '../src/redesign/clean-slate.ts';

const APPLY = process.argv.includes('--apply');
const CONFIRMED = process.argv.includes('--confirm-main-guild');
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID ?? LIVE_GUILD_ID;
const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const CONNECT = 1n << 20n;
const SPEAK = 1n << 21n;

type JsonObject = Record<string, unknown>;
type Overwrite = { id: string; type: number; allow: string; deny: string };
type Role = {
  id: string;
  name: string;
  managed: boolean;
  color: number;
  hoist: boolean;
  permissions: string;
  mentionable?: boolean;
  tags?: { bot_id?: string; integration_id?: string };
};
type Channel = {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
  topic?: string | null;
  permission_overwrites: Overwrite[];
};
type Member = {
  user?: { id: string; username?: string; bot?: boolean };
  roles?: string[];
  premium_since?: string | null;
  pending?: boolean;
};
type ApiResult<T> = { status: number; body: T | null };
type ExportState = {
  generatedAt: string;
  applicationId: string;
  guildId: string;
  guild: JsonObject;
  roles: Role[];
  channels: Channel[];
  welcomeScreen: ApiResult<JsonObject>;
  onboarding: ApiResult<JsonObject>;
  membershipScreening: ApiResult<JsonObject>;
  integrations: { status: number; body: Array<{ id: string; name: string | null; applicationId: string | null }> };
  application: { status: number; body: { id: string; name: string | null; flags: number | null } };
  members: Array<{ id: string; bot: boolean; username: string | null; roles: string[]; premiumSince: string | null; pending: boolean }>;
  botInventory: { memberBotIds: string[]; integrationApplicationIds: string[]; guildApplicationId: string | null };
};
type RollbackOperation = {
  id: number;
  label: string;
  kind:
    | 'create-role'
    | 'create-channel'
    | 'patch-channel'
    | 'patch-guild'
    | 'patch-welcome'
    | 'patch-onboarding'
    | 'patch-screening'
    | 'create-message'
    | 'pending-write';
  state: 'pending' | 'applied';
  target: JsonObject;
  fingerprint?: JsonObject;
  inverse?: JsonObject;
  responseId?: string;
  preparedAt: string;
  requestStartedAt?: string;
  appliedAt?: string;
};
type RollbackManifest = {
  version: 1;
  status: 'prepared' | 'applying' | 'apply_failed' | 'applied' | 'postflight_failed';
  generatedAt: string;
  applicationId: string;
  guildId: string;
  preExportPath: string;
  postExportPath: string;
  operations: RollbackOperation[];
};

function die(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function applicationIdFromToken(value: string): string | null {
  const segment = value.trim().split('.')[0];
  if (!segment) return null;
  try {
    const decoded = Buffer.from(segment, 'base64').toString('utf8');
    return /^\d{15,25}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function apiBase(): string {
  const raw = process.env.MAIN_GUILD_API_BASE;
  if (!raw) return 'https://discord.com/api/v10';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    die(2, `MAIN_GUILD_API_BASE is not a URL: ${raw}`);
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    die(2, `MAIN_GUILD_API_BASE is a test seam and only accepts loopback. Got host ${parsed.hostname}.`);
  }
  return raw.replace(/\/$/, '');
}

if (!token) die(2, 'Missing DISCORD_BOT_TOKEN.');
const applicationId = applicationIdFromToken(token);
if (applicationId !== LIVE_BOT_APPLICATION_ID) {
  die(2, `This token is not the live Owen bot (${LIVE_BOT_APPLICATION_ID}). Nothing was contacted.`);
}
if (guildId !== LIVE_GUILD_ID) die(2, `DISCORD_GUILD_ID is not the live guild ${LIVE_GUILD_ID}. Nothing was contacted.`);
if (APPLY && !CONFIRMED) die(2, 'Refusing to write without --confirm-main-guild. Nothing was changed.');

const API = apiBase();
let discordWrites = 0;

async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<ApiResult<T>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody = (await response.json().catch(() => null)) as T | null;
    if (response.status !== 429) return { status: response.status, body: responseBody };
    const retryAfter = Number((responseBody as { retry_after?: number } | null)?.retry_after ?? 1);
    if (!Number.isFinite(retryAfter) || retryAfter < 0) return { status: 429, body: responseBody };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryAfter * 1000));
  }
  return { status: 429, body: null };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

async function allMembers(): Promise<Member[]> {
  const members: Member[] = [];
  let after = '0';
  for (;;) {
    const page = await api<Member[]>('GET', `/guilds/${guildId}/members?limit=1000&after=${after}`);
    if (page.status !== 200 || !page.body) die(1, `Preflight could not read members: HTTP ${page.status}.`);
    members.push(...page.body);
    if (page.body.length < 1000) break;
    const last = page.body.at(-1)?.user?.id;
    if (!last) die(1, 'Preflight member pagination returned an entry without a user id.');
    after = last;
  }
  return members;
}

function botInventory(guild: JsonObject, members: Member[], integrations: ExportState['integrations']): ExportState['botInventory'] {
  const integrationApplicationIds = integrations.body
    .map((integration) => integration.applicationId)
    .filter((id): id is string => Boolean(id))
    .sort();
  return {
    memberBotIds: members.filter((member) => member.user?.bot).map((member) => member.user!.id).sort(),
    integrationApplicationIds,
    guildApplicationId: typeof guild.application_id === 'string' ? guild.application_id : null,
  };
}

async function captureState(): Promise<ExportState> {
  const guild = await api<JsonObject>('GET', `/guilds/${guildId}`);
  const roles = await api<Role[]>('GET', `/guilds/${guildId}/roles`);
  const channels = await api<Channel[]>('GET', `/guilds/${guildId}/channels`);
  const welcomeScreen = await api<JsonObject>('GET', `/guilds/${guildId}/welcome-screen`);
  const onboarding = await api<JsonObject>('GET', `/guilds/${guildId}/onboarding`);
  const membershipScreening = await api<JsonObject>('GET', `/guilds/${guildId}/member-verification`);
  const integrations = await api<JsonObject[]>('GET', `/guilds/${guildId}/integrations`);
  const application = await api<JsonObject>('GET', '/oauth2/applications/@me');
  if (guild.status !== 200 || !guild.body) die(1, `Could not read guild ${guildId}: HTTP ${guild.status}.`);
  if (roles.status !== 200 || !roles.body) die(1, `Could not read guild roles: HTTP ${roles.status}.`);
  if (channels.status !== 200 || !channels.body) die(1, `Could not read guild channels: HTTP ${channels.status}.`);
  if (integrations.status !== 200 || !integrations.body) die(1, `Could not inventory integrations: HTTP ${integrations.status}.`);
  if (application.status !== 200 || !application.body) die(1, `Could not inventory the current application: HTTP ${application.status}.`);
  if (application.body.id !== LIVE_BOT_APPLICATION_ID) die(1, `Current application inventory returned ${String(application.body.id)}, expected Owen ${LIVE_BOT_APPLICATION_ID}.`);
  const rawMembers = await allMembers();
  const integrationEvidence: ExportState['integrations'] = {
    status: integrations.status,
    body: integrations.body.map((integration) => {
      const linkedApplication = integration.application as JsonObject | undefined;
      return {
        id: typeof integration.id === 'string' ? integration.id : '',
        name: typeof integration.name === 'string' ? integration.name : null,
        applicationId: typeof linkedApplication?.id === 'string' ? linkedApplication.id : null,
      };
    }),
  };
  const applicationEvidence: ExportState['application'] = {
    status: application.status,
    body: {
      id: typeof application.body.id === 'string' ? application.body.id : '',
      name: typeof application.body.name === 'string' ? application.body.name : null,
      flags: typeof application.body.flags === 'number' ? application.body.flags : null,
    },
  };
  return {
    generatedAt: new Date().toISOString(),
    applicationId: LIVE_BOT_APPLICATION_ID,
    guildId,
    guild: guild.body,
    roles: roles.body,
    channels: channels.body,
    welcomeScreen,
    onboarding,
    membershipScreening,
    integrations: integrationEvidence,
    application: applicationEvidence,
    members: rawMembers
      .map((member) => ({
        id: member.user?.id ?? '',
        bot: Boolean(member.user?.bot),
        username: member.user?.username ?? null,
        roles: [...(member.roles ?? [])].sort(),
        premiumSince: member.premium_since ?? null,
        pending: Boolean(member.pending),
      }))
      .filter((member) => member.id)
      .sort((a, b) => a.id.localeCompare(b.id)),
    botInventory: botInventory(guild.body, rawMembers, integrationEvidence),
  };
}

function assertAdministrator(state: ExportState, phase: string): void {
  const botMember = state.members.find((member) => member.id === LIVE_BOT_APPLICATION_ID && member.bot);
  if (!botMember) die(1, `${phase}: Owen is missing from the member inventory.`);
  const adminRoles = state.roles.filter((role) => botMember.roles.includes(role.id) && (BigInt(role.permissions) & ADMINISTRATOR) !== 0n);
  if (adminRoles.length === 0) die(1, `${phase}: Owen does not have Administrator. Aborting.`);
}

function assertUnambiguousTargets(state: ExportState): void {
  for (const category of CATEGORIES) {
    const matches = state.channels.filter((channel) => channel.type === 4 && channel.name === category.name);
    if (matches.length > 1) die(1, `Preflight found multiple categories named ${category.name}; refusing ambiguous adoption.`);
    if (!matches[0]) continue;
    for (const name of category.channels) {
      const type = VOICE_CHANNEL_NAMES.has(name) ? 2 : 0;
      const children = state.channels.filter((channel) => channel.type === type && channel.parent_id === matches[0]!.id && channel.name === name);
      if (children.length > 1) die(1, `Preflight found multiple ${name} channels in ${category.name}; refusing ambiguous adoption.`);
    }
  }
  const features = Array.isArray(state.guild.features) ? state.guild.features : [];
  if (state.guild.name !== LIVE_GUILD_NAME) {
    die(1, `Preflight: expected guild name ${LIVE_GUILD_NAME}, received ${String(state.guild.name)}.`);
  }
  if (!features.includes('COMMUNITY')) die(1, 'Preflight: the live guild does not have Discord Community enabled; refusing to change that setting implicitly.');
}

function desiredOverwrite(name: string): Overwrite {
  if (OPERATIONS_CHANNEL_NAMES.has(name)) return { id: guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL) };
  if (PUBLIC_READ_ONLY.has(name)) return { id: guildId, type: 0, allow: String(VIEW_CHANNEL), deny: String(SEND_MESSAGES) };
  if (VOICE_CHANNEL_NAMES.has(name)) return { id: guildId, type: 0, allow: String(VIEW_CHANNEL | CONNECT | SPEAK), deny: '0' };
  return { id: guildId, type: 0, allow: String(VIEW_CHANNEL | SEND_MESSAGES), deny: '0' };
}

function mergeEveryoneOverwrite(existing: Overwrite[], desired: Overwrite): Overwrite[] {
  const relevant = VIEW_CHANNEL | SEND_MESSAGES | CONNECT | SPEAK;
  const index = existing.findIndex((overwrite) => overwrite.id === guildId && overwrite.type === 0);
  if (index === -1) return [...existing, desired];
  const current = existing[index]!;
  const merged = {
    ...current,
    allow: String((BigInt(current.allow) & ~relevant) | BigInt(desired.allow)),
    deny: String((BigInt(current.deny) & ~relevant) | BigInt(desired.deny)),
  };
  return existing.map((overwrite, itemIndex) => (itemIndex === index ? merged : overwrite));
}

function welcomeBody(channelIds: Map<string, string>): JsonObject {
  return {
    enabled: true,
    description: WELCOME_DESCRIPTION,
    welcome_channels: [
      { channel_id: channelIds.get('start-here'), description: 'Four rules, then the server is yours.', emoji_name: '👋' },
      { channel_id: channelIds.get('general'), description: 'Say hello. People notice who comes back.', emoji_name: '💬' },
      { channel_id: channelIds.get('looking-to-play'), description: 'Game, platform, start time — find your crew.', emoji_name: '🎮' },
    ],
  };
}

function onboardingBody(channelIds: Map<string, string>): JsonObject {
  return {
    prompts: [],
    default_channel_ids: ['start-here', 'announcements', 'general', 'looking-to-play'].map((name) => channelIds.get(name)),
    enabled: false,
    mode: 0,
  };
}

const screeningFields = [{ field_type: 'TERMS', label: 'TWO community rules', required: true, values: RULES }];
const screeningBody: JsonObject = {
  form_fields: screeningFields,
  description: SCREENING_DESCRIPTION,
};

function screeningMatches(actual: JsonObject | null): boolean {
  if (!actual || actual.description !== SCREENING_DESCRIPTION) return false;
  const raw = actual.form_fields;
  try {
    const fields = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return matchesSubset(fields, screeningFields);
  } catch {
    return false;
  }
}

function screeningRestoreBody(actual: JsonObject): JsonObject {
  return {
    form_fields: actual.form_fields ?? [],
    description: typeof actual.description === 'string' ? actual.description : '',
  };
}

function matchesSubset(actual: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    return Array.isArray(actual) && actual.length === desired.length && desired.every((item, index) => matchesSubset(actual[index], item));
  }
  if (desired && typeof desired === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(desired as JsonObject).every(([key, value]) => matchesSubset((actual as JsonObject)[key], value));
  }
  return stable(actual) === stable(desired);
}

function bodyMatches(actual: JsonObject | null, desired: JsonObject): boolean {
  return Boolean(actual) && matchesSubset(actual, desired);
}

function sameStringSet(actual: unknown, desired: unknown): boolean {
  if (!Array.isArray(actual) || !Array.isArray(desired)) return false;
  if (!actual.every((item) => typeof item === 'string') || !desired.every((item) => typeof item === 'string')) return false;
  return stable([...actual].sort()) === stable([...desired].sort());
}

function welcomeMatches(actual: JsonObject | null, desired: JsonObject): boolean {
  if (!actual) return false;
  return matchesSubset(actual, {
    description: desired.description,
    welcome_channels: desired.welcome_channels,
  });
}

function onboardingMatches(actual: JsonObject | null, desired: JsonObject): boolean {
  if (!actual || !matchesSubset(actual, { prompts: desired.prompts, enabled: desired.enabled, mode: desired.mode })) return false;
  return sameStringSet(actual.default_channel_ids, desired.default_channel_ids);
}

const me = await api<{ id: string }>('GET', '/users/@me');
if (me.status !== 200 || me.body?.id !== LIVE_BOT_APPLICATION_ID) die(1, `Discord did not authenticate as Owen (${LIVE_BOT_APPLICATION_ID}).`);
const guilds = await api<Array<{ id: string }>>('GET', '/users/@me/guilds');
if (guilds.status !== 200 || !guilds.body?.some((item) => item.id === guildId)) die(1, `Owen is not in guild ${guildId}.`);

const pre = await captureState();
assertAdministrator(pre, 'Preflight');
assertUnambiguousTargets(pre);
if (![200, 404].includes(pre.welcomeScreen.status)) die(1, `Preflight could not capture Welcome Screen rollback state: HTTP ${pre.welcomeScreen.status}.`);
if (pre.onboarding.status !== 200 || !pre.onboarding.body) die(1, `Preflight could not capture Onboarding rollback state: HTTP ${pre.onboarding.status}.`);
if (pre.membershipScreening.status !== 200 || !pre.membershipScreening.body) {
  die(1, `Preflight could not capture Membership Screening rollback state: HTTP ${pre.membershipScreening.status}.`);
}

console.log(`${APPLY ? 'Applying' : 'Planning'} accepted clean-slate structure in ${String(pre.guild.name)} (${guildId}).`);
console.log('Additive path: no existing channel, category, role, overwrite entry, member, bot, integration, or Raid Protection setting is removed.');

if (!APPLY) {
  console.log('Plan complete. Add --confirm-main-guild --apply to persist a pre-export and apply it. No writes were sent.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactDir = resolve(process.env.MAIN_GUILD_ARTIFACT_DIR ?? 'data/main-guild-clean-slate');
mkdirSync(artifactDir, { recursive: true });
const preExportPath = join(artifactDir, `${stamp}-pre.json`);
const postExportPath = join(artifactDir, `${stamp}-post.json`);
const manifestPath = resolve(process.env.UNDO_MANIFEST_PATH ?? join(artifactDir, `${stamp}-rollback.json`));
atomicJson(preExportPath, pre);
const manifest: RollbackManifest = {
  version: 1,
  status: 'prepared',
  generatedAt: new Date().toISOString(),
  applicationId: LIVE_BOT_APPLICATION_ID,
  guildId,
  preExportPath,
  postExportPath,
  operations: [],
};
atomicJson(manifestPath, manifest);
console.log(`Pre-export persisted: ${preExportPath}`);
console.log(`Rollback manifest persisted: ${manifestPath}`);

async function write<T>(operation: Omit<RollbackOperation, 'id' | 'state' | 'preparedAt'>, method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown): Promise<T> {
  const entry: RollbackOperation = {
    ...operation,
    id: manifest.operations.length + 1,
    state: 'pending',
    preparedAt: new Date().toISOString(),
  };
  manifest.status = 'applying';
  manifest.operations.push(entry);
  atomicJson(manifestPath, manifest);
  const abortBeforeRequest = Number(process.env.MAIN_GUILD_TEST_ABORT_BEFORE_REQUEST ?? '0');
  if (abortBeforeRequest > 0 && entry.id >= abortBeforeRequest) die(85, `Test interruption after manifest preparation for operation ${entry.id}.`);
  entry.requestStartedAt = new Date().toISOString();
  atomicJson(manifestPath, manifest);
  const result = await api<T>(method, path, body);
  if (result.status >= 300) {
    manifest.status = 'apply_failed';
    atomicJson(manifestPath, manifest);
    die(1, `Discord write failed for ${entry.label}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  discordWrites++;
  if (result.body && typeof result.body === 'object') {
    if ('id' in result.body && typeof (result.body as { id?: unknown }).id === 'string') {
      entry.responseId = (result.body as { id: string }).id;
    }
    if (entry.kind === 'create-role' || entry.kind === 'create-channel') entry.fingerprint = result.body as JsonObject;
  }
  atomicJson(manifestPath, manifest);
  const abortAfterResponse = Number(process.env.MAIN_GUILD_TEST_ABORT_AFTER_RESPONSE ?? '0');
  if (abortAfterResponse > 0 && discordWrites >= abortAfterResponse) die(87, `Test interruption after Discord accepted write ${discordWrites}, before it was settled.`);
  entry.state = 'applied';
  entry.appliedAt = new Date().toISOString();
  atomicJson(manifestPath, manifest);
  console.log(`DID ${entry.label}`);
  const abortAfter = Number(process.env.MAIN_GUILD_TEST_ABORT_AFTER_WRITES ?? '0');
  if (abortAfter > 0 && discordWrites >= abortAfter) die(86, `Test interruption after ${discordWrites} write(s).`);
  return result.body as T;
}

let roles = [...pre.roles];
for (const wanted of [OWNER_ROLE, MODERATOR_ROLE]) {
  const existing = roles.find((role) => !role.managed && role.name === wanted.name);
  if (existing) continue;
  const created = await write<Role>(
    { label: `create ${wanted.name} role`, kind: 'create-role', target: { name: wanted.name } },
    'POST',
    `/guilds/${guildId}/roles`,
    wanted,
  );
  roles.push(created);
}

let channels = [...pre.channels];
const categoryIds = new Map<string, string>();
for (const category of CATEGORIES) {
  const existing = channels.find((channel) => channel.type === 4 && channel.name === category.name);
  if (existing) {
    categoryIds.set(category.name, existing.id);
    continue;
  }
  const created = await write<Channel>(
    { label: `create category ${category.name}`, kind: 'create-channel', target: { name: category.name, type: 4, parentId: null } },
    'POST',
    `/guilds/${guildId}/channels`,
    { name: category.name, type: 4 },
  );
  channels.push(created);
  categoryIds.set(category.name, created.id);
}

const targetChannelIds = new Map<string, string>();
for (const category of CATEGORIES) {
  const parentId = categoryIds.get(category.name)!;
  for (const name of category.channels) {
    const type = VOICE_CHANNEL_NAMES.has(name) ? 2 : 0;
    const existing = channels.find((channel) => channel.type === type && channel.parent_id === parentId && channel.name === name);
    const overwrite = desiredOverwrite(name);
    if (!existing) {
      const body = {
        name,
        type,
        parent_id: parentId,
        ...(TEXT_CHANNEL_NAMES.has(name) ? { topic: TOPICS[name as keyof typeof TOPICS] } : {}),
        permission_overwrites: [overwrite],
      };
      const created = await write<Channel>(
        { label: `create ${name} in ${category.name}`, kind: 'create-channel', target: { name, type, parentId } },
        'POST',
        `/guilds/${guildId}/channels`,
        body,
      );
      channels.push(created);
      targetChannelIds.set(name, created.id);
      continue;
    }
    targetChannelIds.set(name, existing.id);
    const mergedOverwrites = mergeEveryoneOverwrite(existing.permission_overwrites ?? [], overwrite);
    const desiredTopic = TEXT_CHANNEL_NAMES.has(name) ? TOPICS[name as keyof typeof TOPICS] : existing.topic;
    if (existing.topic === desiredTopic && stable(existing.permission_overwrites ?? []) === stable(mergedOverwrites)) continue;
    const inverse: JsonObject = {
      topic: existing.topic ?? null,
      permission_overwrites: existing.permission_overwrites ?? [],
    };
    await write<Channel>(
      { label: `reconcile ${name} inside ${category.name}`, kind: 'patch-channel', target: { channelId: existing.id }, inverse },
      'PATCH',
      `/channels/${existing.id}`,
      { ...(TEXT_CHANNEL_NAMES.has(name) ? { topic: desiredTopic } : {}), permission_overwrites: mergedOverwrites },
    );
  }
}

const guildDesired = {
  description: SERVER_DESCRIPTION,
  system_channel_id: targetChannelIds.get('start-here'),
};
if (!bodyMatches(pre.guild, guildDesired)) {
  await write<JsonObject>(
    {
      label: 'configure guild description and system channels',
      kind: 'patch-guild',
      target: {},
      inverse: {
        description: pre.guild.description ?? null,
        system_channel_id: pre.guild.system_channel_id ?? null,
      },
    },
    'PATCH',
    `/guilds/${guildId}`,
    guildDesired,
  );
}

const desiredWelcome = welcomeBody(targetChannelIds);
if (!welcomeMatches(pre.welcomeScreen.body, desiredWelcome)) {
  const welcomeInverse = pre.welcomeScreen.status === 404 ? { enabled: false } : pre.welcomeScreen.body!;
  await write<JsonObject>(
    { label: 'configure three-card Welcome Screen', kind: 'patch-welcome', target: {}, inverse: welcomeInverse },
    'PATCH',
    `/guilds/${guildId}/welcome-screen`,
    desiredWelcome,
  );
}

const desiredOnboarding = onboardingBody(targetChannelIds);
if (!onboardingMatches(pre.onboarding.body, desiredOnboarding)) {
  if (pre.onboarding.status !== 200 || !pre.onboarding.body) die(1, `Onboarding pre-state is not restorable (HTTP ${pre.onboarding.status}).`);
  await write<JsonObject>(
    { label: 'keep native Onboarding off', kind: 'patch-onboarding', target: {}, inverse: pre.onboarding.body },
    'PUT',
    `/guilds/${guildId}/onboarding`,
    desiredOnboarding,
  );
}

if (!screeningMatches(pre.membershipScreening.body)) {
  await write<JsonObject>(
    { label: 'configure four-rule Membership Screening', kind: 'patch-screening', target: {}, inverse: screeningRestoreBody(pre.membershipScreening.body!) },
    'PATCH',
    `/guilds/${guildId}/member-verification`,
    screeningBody,
  );
}

const generalId = targetChannelIds.get('general')!;
const messages = await api<Array<{ id: string; author: { id: string }; content: string }>>('GET', `/channels/${generalId}/messages?limit=50`);
if (messages.status !== 200 || !messages.body) die(1, `Could not inspect the target #general starter message: HTTP ${messages.status}.`);
if (!messages.body.some((message) => message.author.id === LIVE_BOT_APPLICATION_ID && message.content === STARTER_MESSAGE)) {
  await write<{ id: string }>(
    {
      label: 'post first-message starter',
      kind: 'create-message',
      target: { channelId: generalId, authorId: LIVE_BOT_APPLICATION_ID, content: STARTER_MESSAGE },
    },
    'POST',
    `/channels/${generalId}/messages`,
    { content: STARTER_MESSAGE, allowed_mentions: { parse: [] } },
  );
}

const post = await captureState();
atomicJson(postExportPath, post);
console.log(`Post-export persisted: ${postExportPath}`);

try {
  assertAdministrator(post, 'Postflight');
  if (stable(post.botInventory) !== stable(pre.botInventory)) throw new Error('bot/application inventory changed');
  if (stable(post.members.map((member) => member.id)) !== stable(pre.members.map((member) => member.id))) throw new Error('member inventory changed');
  if (stable(post.members.filter((member) => member.premiumSince).map((member) => member.id)) !== stable(pre.members.filter((member) => member.premiumSince).map((member) => member.id))) {
    throw new Error('purchased-member inventory changed');
  }
} catch (error) {
  manifest.status = 'postflight_failed';
  atomicJson(manifestPath, manifest);
  die(1, `Postflight failed: ${error instanceof Error ? error.message : String(error)}. Run the guarded rollback command below.`);
}

manifest.status = 'applied';
atomicJson(manifestPath, manifest);
console.log(`Applied ${discordWrites} Discord write(s).`);
console.log(`Rollback: DISCORD_BOT_TOKEN=… node scripts/main-guild-clean-slate-rollback.ts --manifest ${JSON.stringify(manifestPath)} --confirm-main-guild --apply`);
