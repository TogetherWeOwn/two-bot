import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applicationIdFromToken, LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, LIVE_GUILD_NAME } from '../src/staging/spec.ts';
import {
  ADMINISTRATOR,
  type Channel,
  type CleanupManifest,
  type JsonObject,
  inFlightDriftIsOurs,
  journalSignature,
  type LiveCleanupSnapshot,
  normalizeOverwrites,
  semanticSnapshot,
  sha256,
  stable,
  operationSemanticHash,
  planArchiveOperations,
  planSignature,
  syncedChildIds,
} from '../src/redesign/live-cleanup.ts';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--confirm-main-guild');
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID ?? LIVE_GUILD_ID;

type ApiResult<T> = { status: number; body: T | null };
type Role = { id: string; permissions: string; position?: number };
type RawMember = { user?: { id: string; username?: string; bot?: boolean }; roles?: string[]; premium_since?: string | null; pending?: boolean };

function die(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}
function value(name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const found = argv[index + 1];
  if (!found || found.startsWith('--')) die(2, `--${name} needs a value.`);
  return found;
}
function apiBase(): string {
  const raw = process.env.MAIN_GUILD_API_BASE;
  if (!raw) return 'https://discord.com/api/v10';
  let parsed: URL;
  try { parsed = new URL(raw); } catch { die(2, `MAIN_GUILD_API_BASE is not a URL: ${raw}`); }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) die(2, `MAIN_GUILD_API_BASE only accepts loopback test seams. Got ${parsed.hostname}.`);
  return raw.replace(/\/$/, '');
}
function atomicJson(path: string, valueToWrite: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(valueToWrite, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}
/**
 * The only sanctioned way to persist the manifest. Re-signs the mutable journal on
 * every write so a manifest edited between runs fails verification rather than being
 * trusted — journal state is what grants the in-flight exception below.
 */
function checkpoint(path: string, valueToWrite: CleanupManifest): void {
  valueToWrite.journalSignature = journalSignature(token!, valueToWrite);
  atomicJson(path, valueToWrite);
}

if (!token) die(2, 'Missing DISCORD_BOT_TOKEN.');
if (applicationIdFromToken(token) !== LIVE_BOT_APPLICATION_ID) die(2, `This token is not live Owen (${LIVE_BOT_APPLICATION_ID}). Nothing was contacted.`);
if (guildId !== LIVE_GUILD_ID) die(2, `DISCORD_GUILD_ID is not the live guild ${LIVE_GUILD_ID}. Nothing was contacted.`);
if (!APPLY || !CONFIRMED) die(2, 'Rollback requires both --confirm-main-guild and --apply. Nothing was contacted.');
const manifestPath = resolve(value('manifest') ?? die(2, '--manifest is required.'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CleanupManifest;
if (manifest.version !== 1 || manifest.kind !== 'live-clean-slate-cleanup' || manifest.applicationId !== LIVE_BOT_APPLICATION_ID || manifest.guildId !== LIVE_GUILD_ID) die(2, 'Manifest identity is invalid.');
const snapshot = JSON.parse(readFileSync(resolve(manifest.snapshotPath), 'utf8')) as LiveCleanupSnapshot;
if (snapshot.generatedAt !== manifest.snapshotGeneratedAt) die(2, 'Pre-snapshot timestamp does not match the manifest.');
if (snapshot.semanticHash !== manifest.snapshotSemanticHash || snapshot.semanticHash !== sha256(semanticSnapshot(snapshot))) die(2, 'Pre-snapshot hash does not match the manifest.');
const deterministicOperations = planArchiveOperations(snapshot);
const deterministicHash = operationSemanticHash(deterministicOperations);
if (manifest.planSignature !== planSignature(token, snapshot.generatedAt, snapshot.semanticHash, deterministicHash)) die(2, 'Manifest plan signature is invalid for this token, snapshot, and operation hash.');
// The plan signature covers only immutable plan content. Operation states select which
// operations rollback touches and which one gets the in-flight exception, so they are
// authenticated separately — otherwise relabelling an applied operation `requesting`
// would be enough to make rollback overwrite unrelated live drift.
if (manifest.journalSignature !== journalSignature(token, manifest)) die(2, 'Manifest journal signature is invalid; operation states or timestamps were modified outside a run.');
if (manifest.operationCount !== deterministicOperations.length || manifest.operationSemanticHash !== deterministicHash || manifest.operations.length !== deterministicOperations.length) die(2, 'Manifest operation count/hash differs from the deterministic plan.');
if (stable(manifest.operations.map(({ state: _state, requestStartedAt: _requestStartedAt, appliedAt: _appliedAt, rolledBackAt: _rolledBackAt, ...operation }) => operation)) !== stable(deterministicOperations)) die(2, 'Manifest operation bodies differ from the deterministic plan.');
const API = apiBase();

async function api<T>(method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<ApiResult<T>> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseBody = (await response.json().catch(() => null)) as T | null;
  return { status: response.status, body: responseBody };
}
async function mustGet<T>(path: string, label: string): Promise<T> {
  const result = await api<T>('GET', path);
  if (result.status === 429) die(1, `${label}: Discord returned 429. Stop; no retry was attempted.`);
  if (result.status !== 200 || result.body === null) die(1, `${label}: HTTP ${result.status}.`);
  return result.body;
}
async function members(): Promise<RawMember[]> {
  const out: RawMember[] = [];
  let after = '0';
  for (;;) {
    const page = await mustGet<RawMember[]>(`/guilds/${guildId}/members?limit=1000&after=${after}`, 'Read members');
    out.push(...page);
    if (page.length < 1000) return out;
    const last = page.at(-1)?.user?.id;
    if (!last) die(1, 'Member pagination returned an entry without an id.');
    after = last;
  }
}

function nonChannelSemantic(
  currentGuild: JsonObject,
  currentRoles: Role[],
  rawMembers: RawMember[],
  currentIntegrations: JsonObject[],
  currentWelcome: ApiResult<JsonObject>,
  currentOnboarding: ApiResult<JsonObject>,
  currentScreening: ApiResult<JsonObject>,
): JsonObject {
  return {
    version: 1,
    applicationId: LIVE_BOT_APPLICATION_ID,
    guildId,
    guild: currentGuild,
    roles: [...currentRoles].sort((a, b) => a.id.localeCompare(b.id)),
    members: rawMembers.map((member) => ({
      id: member.user?.id ?? '',
      bot: Boolean(member.user?.bot),
      username: member.user?.username ?? null,
      roles: [...(member.roles ?? [])].sort(),
      premiumSince: member.premium_since ?? null,
      pending: Boolean(member.pending),
    })).filter((member) => member.id).sort((a, b) => a.id.localeCompare(b.id)),
    integrations: currentIntegrations.map((integration) => {
      const linkedApplication = integration.application as JsonObject | undefined;
      return {
        id: typeof integration.id === 'string' ? integration.id : '',
        name: typeof integration.name === 'string' ? integration.name : null,
        applicationId: typeof linkedApplication?.id === 'string' ? linkedApplication.id : null,
        roleId: typeof integration.role_id === 'string' ? integration.role_id : null,
      };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    references: {
      welcomeScreen: { status: currentWelcome.status, body: currentWelcome.body },
      onboarding: { status: currentOnboarding.status, body: currentOnboarding.body },
      membershipScreening: { status: currentScreening.status, body: currentScreening.body },
      guildReferences: {
        applicationId: currentGuild.application_id ?? null,
        systemChannelId: currentGuild.system_channel_id ?? null,
        rulesChannelId: currentGuild.rules_channel_id ?? null,
        publicUpdatesChannelId: currentGuild.public_updates_channel_id ?? null,
        safetyAlertsChannelId: currentGuild.safety_alerts_channel_id ?? null,
      },
    },
  };
}

const snapshotSemantic = semanticSnapshot(snapshot);
const { channels: _snapshotChannels, ...snapshotNonChannel } = snapshotSemantic;

const [me, guilds, guild, roles, currentMembers, integrations, application, welcome, onboarding, screening] = await Promise.all([
  mustGet<{ id: string }>('/users/@me', 'Authenticate bot'),
  mustGet<Array<{ id: string }>>('/users/@me/guilds', 'Read bot guilds'),
  mustGet<JsonObject>(`/guilds/${guildId}`, 'Read guild'),
  mustGet<Role[]>(`/guilds/${guildId}/roles`, 'Read roles'),
  members(),
  mustGet<JsonObject[]>(`/guilds/${guildId}/integrations`, 'Read integrations'),
  mustGet<JsonObject>('/oauth2/applications/@me', 'Read application'),
  api<JsonObject>('GET', `/guilds/${guildId}/welcome-screen`),
  api<JsonObject>('GET', `/guilds/${guildId}/onboarding`),
  api<JsonObject>('GET', `/guilds/${guildId}/member-verification`),
]);
if (me.id !== LIVE_BOT_APPLICATION_ID || application.id !== LIVE_BOT_APPLICATION_ID || !guilds.some((item) => item.id === guildId) || guild.name !== LIVE_GUILD_NAME) die(1, 'Rollback identity preflight failed.');
if (stable(nonChannelSemantic(guild, roles, currentMembers, integrations, welcome, onboarding, screening)) !== stable(snapshotNonChannel)) die(1, 'Rollback preflight found non-channel drift from the pre-snapshot.');
const botMember = currentMembers.find((member) => member.user?.id === LIVE_BOT_APPLICATION_ID && member.user.bot);
if (!botMember || !roles.some((role) => botMember.roles?.includes(role.id) && (BigInt(role.permissions) & ADMINISTRATOR) !== 0n)) die(1, 'Rollback preflight: Owen does not have Administrator.');
const preRollbackChannels = await mustGet<Channel[]>(`/guilds/${guildId}/channels`, 'Read rollback channel preflight');
if (stable(preRollbackChannels.map((channel) => channel.id).sort()) !== stable(snapshot.channels.map((channel) => channel.id).sort())) die(1, 'Rollback preflight channel/category inventory drifted from the pre-snapshot.');
const preRollbackById = new Map(preRollbackChannels.map((channel) => [channel.id, channel]));
function operationState(operation: CleanupManifest['operations'][number], channels: Map<string, Channel>): 'applied' | 'inverse' | 'parent_inverse' | 'mixed' | 'drifted' {
  const expectedApplied = stable(normalizeOverwrites(operation.write.permission_overwrites));
  const expectedInverse = stable(normalizeOverwrites(operation.inverseWrite.permission_overwrites));
  if (operation.objectType === 'channel') {
    const current = channels.get(operation.objectId);
    if (!current) return 'drifted';
    const overwrites = stable(normalizeOverwrites(current.permission_overwrites ?? []));
    if (expectedApplied === expectedInverse && overwrites === expectedInverse) return 'inverse';
    if (overwrites === expectedApplied) return 'applied';
    if (overwrites === expectedInverse) return 'inverse';
    const original = snapshot.channels.find((channel) => channel.id === operation.objectId)!;
    const parentOperation = manifest.operations.find((item) => item.objectType === 'category' && item.objectId === original.parent_id);
    if (parentOperation && overwrites === stable(normalizeOverwrites(parentOperation.inverseWrite.permission_overwrites))) return 'parent_inverse';
    return 'drifted';
  }
  const affected = [operation.objectId, ...snapshot.channels
    .filter((channel) => channel.parent_id === operation.objectId && stable(normalizeOverwrites(channel.permission_overwrites ?? [])) === expectedInverse)
    .map((channel) => channel.id)];
  const states = affected.map((id) => {
    const current = channels.get(id);
    if (!current) return 'drifted';
    const overwrites = stable(normalizeOverwrites(current.permission_overwrites ?? []));
    if (overwrites === expectedApplied) return 'applied';
    if (overwrites === expectedInverse) return 'inverse';
    return 'drifted';
  });
  if (states.includes('drifted')) return 'drifted';
  if (expectedApplied === expectedInverse && states.every((state) => state === 'applied')) return 'inverse';
  if (states.every((state) => state === 'applied')) return 'applied';
  if (states.every((state) => state === 'inverse')) return 'inverse';
  return 'mixed';
}
// Apply journals `requesting` before it issues the PATCH and never leaves more than
// one, so at most one operation can be in flight. That operation's own object — and
// only that object — is allowed to hold an arbitrary live value: not knowing whether
// the write landed is exactly the case rollback exists to undo. `inverseWrite` is a
// complete replacement of the object's overwrites, so writing it restores the
// pre-snapshot state from any starting point, and the post-rollback semantic-hash
// equality check still has to pass before this run is called rolled back.
//
// The exception stops there. `inFlightDriftIsOurs` refuses it when a synchronized
// child sits at a value our PATCH could not have produced, because that is a third
// party's write and granting the exception would clobber it. The journal signature
// checked above is what makes `state === 'requesting'` trustworthy enough to key
// this on at all.
const inFlight = manifest.operations.filter((operation) => operation.state === 'requesting');
if (inFlight.length > 1) die(1, `Rollback manifest has ${inFlight.length} in-flight operations; at most one is recoverable.`);
const inFlightCandidate = inFlight[0] ?? null;
const inFlightId = inFlightCandidate !== null && inFlightDriftIsOurs(snapshot, inFlightCandidate, new Map(preRollbackChannels.map((channel) => [channel.id, normalizeOverwrites(channel.permission_overwrites ?? [])])))
  ? inFlightCandidate.id
  : null;
if (inFlightCandidate !== null && inFlightId === null) {
  console.log(`In-flight operation ${inFlightCandidate.id} is NOT eligible for the recovery exception: a synchronized child holds a value this phase could not have written. Treating it as ordinary drift.`);
}
for (const operation of manifest.operations) {
  const state = operationState(operation, preRollbackById);
  if ((operation.state === 'pending' || operation.state === 'rolled_back') && state !== 'inverse') {
    die(1, `Rollback preflight operation ${operation.id} must be coherently inverse while ${operation.state}.`);
  }
  if (operation.state !== 'pending' && operation.state !== 'rolled_back' && state === 'drifted' && operation.id !== inFlightId) {
    die(1, `Rollback preflight operation ${operation.id} drifted from both applied and inverse state.`);
  }
}
for (const current of preRollbackChannels) {
  const operation = manifest.operations.find((item) => item.objectId === current.id || item.objectId === current.parent_id);
  if (operation) continue;
  const original = snapshot.channels.find((channel) => channel.id === current.id)!;
  const currentShape = { ...current, permission_overwrites: normalizeOverwrites(current.permission_overwrites ?? []) };
  const originalShape = { ...original, permission_overwrites: normalizeOverwrites(original.permission_overwrites ?? []) };
  if (stable(currentShape) !== stable(originalShape)) die(1, `Rollback preflight untouched channel ${current.id} drifted from the pre-snapshot.`);
}
manifest.status = 'rolling_back';
checkpoint(manifestPath, manifest);
const rollbackOrder: string[] = [];

for (const operation of [...manifest.operations].reverse()) {
  if (operation.state === 'rolled_back' || operation.state === 'pending') continue;
  const currentChannels = await mustGet<Channel[]>(`/guilds/${guildId}/channels`, `Read rollback operation ${operation.objectId}`);
  const currentState = operationState(operation, new Map(currentChannels.map((channel) => [channel.id, channel])));
  if (currentState === 'inverse') {
    operation.state = 'rolled_back';
    operation.rolledBackAt = new Date().toISOString();
    checkpoint(manifestPath, manifest);
    continue;
  }
  if (currentState === 'drifted' && operation.id !== inFlightId) {
    manifest.status = 'rollback_failed';
    checkpoint(manifestPath, manifest);
    die(1, `Rollback target ${operation.objectId} drifted from both applied and inverse state.`);
  }
  if (currentState === 'drifted') console.log(`RECOVERING in-flight ${operation.id} from a partial write on ${operation.objectId}`);
  const result = await api<Channel>('PATCH', `/channels/${operation.objectId}`, operation.inverseWrite);
  if (result.status === 429 || result.status >= 300 || !result.body) {
    manifest.status = 'rollback_failed';
    checkpoint(manifestPath, manifest);
    die(1, `Rollback failed for ${operation.id}: HTTP ${result.status}. No retry was attempted.`);
  }
  const restored = normalizeOverwrites(result.body.permission_overwrites ?? []);
  if (stable(restored) !== stable(operation.inverseWrite.permission_overwrites)) {
    manifest.status = 'rollback_failed';
    checkpoint(manifestPath, manifest);
    die(1, `Rollback returned a partial/unexpected state for ${operation.id}.`);
  }
  // Discord's sync only carries children that matched the category's *previous* value,
  // so a category left at a partial value re-syncs nothing and its children stay where
  // the interrupted write put them. Restore every synchronized child explicitly before
  // checkpointing, or the operation would be marked `rolled_back` while children remain
  // at the applied value — which is what made the post-rollback hash fail with the
  // operation already checkpointed, leaving nothing for a retry to re-enter.
  for (const childId of syncedChildIds(snapshot, operation)) {
    const child = (await mustGet<Channel>(`/channels/${childId}`, `Read rollback child ${childId}`));
    if (stable(normalizeOverwrites(child.permission_overwrites ?? [])) === stable(operation.inverseWrite.permission_overwrites)) continue;
    const childResult = await api<Channel>('PATCH', `/channels/${childId}`, operation.inverseWrite);
    if (childResult.status === 429 || childResult.status >= 300 || !childResult.body || stable(normalizeOverwrites(childResult.body.permission_overwrites ?? [])) !== stable(operation.inverseWrite.permission_overwrites)) {
      manifest.status = 'rollback_failed';
      checkpoint(manifestPath, manifest);
      die(1, `Rollback could not restore synchronized child ${childId} of ${operation.id}: HTTP ${childResult.status}. No retry was attempted.`);
    }
    console.log(`RESYNCED ${childId} under ${operation.id}`);
  }
  operation.state = 'rolled_back';
  operation.rolledBackAt = new Date().toISOString();
  rollbackOrder.push(operation.id);
  checkpoint(manifestPath, manifest);
  console.log(`UNDID ${operation.id}`);
}

const [postGuild, postRoles, postMembers, postIntegrations, postWelcome, postOnboarding, postScreening, currentChannels] = await Promise.all([
  mustGet<JsonObject>(`/guilds/${guildId}`, 'Read post-rollback guild'),
  mustGet<Role[]>(`/guilds/${guildId}/roles`, 'Read post-rollback roles'),
  members(),
  mustGet<JsonObject[]>(`/guilds/${guildId}/integrations`, 'Read post-rollback integrations'),
  api<JsonObject>('GET', `/guilds/${guildId}/welcome-screen`),
  api<JsonObject>('GET', `/guilds/${guildId}/onboarding`),
  api<JsonObject>('GET', `/guilds/${guildId}/member-verification`),
  mustGet<Channel[]>(`/guilds/${guildId}/channels`, 'Read post-rollback channels'),
]);
const currentChannelIds = currentChannels.map((channel) => channel.id).sort();
if (stable(currentChannelIds) !== stable(snapshot.channels.map((channel) => channel.id).sort())) die(1, 'Post-rollback channel/category inventory differs from the pre-snapshot.');
const restored = {
  version: 1 as const,
  generatedAt: snapshot.generatedAt,
  applicationId: LIVE_BOT_APPLICATION_ID,
  guildId,
  guild: postGuild,
  roles: postRoles as LiveCleanupSnapshot['roles'],
  channels: currentChannels.map((channel) => ({ ...channel, permission_overwrites: normalizeOverwrites(channel.permission_overwrites ?? []) })),
  members: postMembers.map((member) => ({
    id: member.user?.id ?? '',
    bot: Boolean(member.user?.bot),
    username: member.user?.username ?? null,
    roles: [...(member.roles ?? [])].sort(),
    premiumSince: member.premium_since ?? null,
    pending: Boolean(member.pending),
  })).filter((member) => member.id).sort((a, b) => a.id.localeCompare(b.id)),
  integrations: postIntegrations.map((integration) => {
    const linkedApplication = integration.application as JsonObject | undefined;
    return {
      id: typeof integration.id === 'string' ? integration.id : '',
      name: typeof integration.name === 'string' ? integration.name : null,
      applicationId: typeof linkedApplication?.id === 'string' ? linkedApplication.id : null,
      roleId: typeof integration.role_id === 'string' ? integration.role_id : null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id)),
  references: {
    welcomeScreen: { status: postWelcome.status, body: postWelcome.body },
    onboarding: { status: postOnboarding.status, body: postOnboarding.body },
    membershipScreening: { status: postScreening.status, body: postScreening.body },
    guildReferences: {
      applicationId: postGuild.application_id ?? null,
      systemChannelId: postGuild.system_channel_id ?? null,
      rulesChannelId: postGuild.rules_channel_id ?? null,
      publicUpdatesChannelId: postGuild.public_updates_channel_id ?? null,
      safetyAlertsChannelId: postGuild.safety_alerts_channel_id ?? null,
    },
  },
};
const restoredHash = sha256(semanticSnapshot(restored));
if (restoredHash !== snapshot.semanticHash) die(1, `Post-rollback semantic hash mismatch: expected ${snapshot.semanticHash}, got ${restoredHash}.`);
manifest.status = 'rolled_back';
checkpoint(manifestPath, manifest);
console.log(`Rollback complete: ${manifestPath}`);
console.log(`Reverse order: ${rollbackOrder.join(', ')}`);
console.log(`Restored snapshot semantic hash: ${restoredHash}`);
