/**
 * Deterministically undo an applied main-guild clean-slate manifest.
 *
 * The script first proves the live Owen application, live guild, Administrator
 * permission, and bot/application inventory recorded by the pre-export. It then
 * walks applied operations in reverse. Created objects/messages are deleted
 * only when they still match their recorded identity; pre-existing settings
 * are restored from the manifest's captured inverse bodies.
 *
 *   DISCORD_BOT_TOKEN=… node scripts/main-guild-clean-slate-rollback.ts \
 *     --manifest data/main-guild-clean-slate/...-rollback.json \
 *     --confirm-main-guild --apply
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, LIVE_GUILD_NAME } from '../src/staging/spec.ts';

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID ?? LIVE_GUILD_ID;
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--confirm-main-guild');
const ADMINISTRATOR = 1n << 3n;

type JsonObject = Record<string, unknown>;
type Member = { user?: { id: string; bot?: boolean }; roles?: string[] };
type Role = { id: string; name: string; managed: boolean; permissions: string };
type Operation = {
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
  state: 'pending' | 'applied' | 'rolled_back';
  target: JsonObject;
  fingerprint?: JsonObject;
  inverse?: JsonObject;
  responseId?: string;
  requestStartedAt?: string;
  rollbackAt?: string;
};
type Manifest = {
  version: 1;
  status: string;
  applicationId: string;
  guildId: string;
  preExportPath: string;
  postExportPath: string;
  operations: Operation[];
};
type PreExport = {
  applicationId: string;
  guildId: string;
  botInventory: { memberBotIds: string[]; integrationApplicationIds: string[]; guildApplicationId: string | null };
};

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
function applicationIdFromToken(raw: string): string | null {
  const segment = raw.trim().split('.')[0];
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
function atomicJson(path: string, valueToWrite: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(valueToWrite, null, 2)}\n`);
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
function stable(valueToCompare: unknown): string {
  if (Array.isArray(valueToCompare)) return `[${valueToCompare.map(stable).join(',')}]`;
  if (valueToCompare && typeof valueToCompare === 'object') {
    return `{${Object.entries(valueToCompare as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(valueToCompare);
}
function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matchesSubset(actual[index], item));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected as JsonObject).every(([key, valueToMatch]) => matchesSubset((actual as JsonObject)[key], valueToMatch));
  }
  return stable(actual) === stable(expected);
}

if (!token) die(2, 'Missing DISCORD_BOT_TOKEN.');
if (applicationIdFromToken(token) !== LIVE_BOT_APPLICATION_ID) die(2, `This token is not the live Owen bot (${LIVE_BOT_APPLICATION_ID}). Nothing was contacted.`);
if (guildId !== LIVE_GUILD_ID) die(2, `DISCORD_GUILD_ID is not the live guild ${LIVE_GUILD_ID}. Nothing was contacted.`);
if (!APPLY || !CONFIRMED) die(2, 'Rollback requires both --confirm-main-guild and --apply. Nothing was contacted.');

const manifestPath = resolve(value('manifest') ?? die(2, 'Rollback requires --manifest <path>.'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
if (manifest.version !== 1 || manifest.applicationId !== LIVE_BOT_APPLICATION_ID || manifest.guildId !== LIVE_GUILD_ID) {
  die(2, 'Manifest identity does not match the live Owen bot and guild.');
}
const preExportPath = resolve(manifest.preExportPath);
if (dirname(preExportPath) !== dirname(manifestPath)) die(2, 'Manifest pre-export must be in the same artifact directory as the manifest.');
const pre = JSON.parse(readFileSync(preExportPath, 'utf8')) as PreExport;
if (pre.applicationId !== manifest.applicationId || pre.guildId !== manifest.guildId) die(2, 'Pre-export identity does not match the rollback manifest.');
const API = apiBase();

async function api<T>(method: 'GET' | 'DELETE' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<{ status: number; body: T | null }> {
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

async function members(): Promise<Member[]> {
  const out: Member[] = [];
  let after = '0';
  for (;;) {
    const page = await api<Member[]>('GET', `/guilds/${guildId}/members?limit=1000&after=${after}`);
    if (page.status !== 200 || !page.body) die(1, `Rollback preflight could not read members: HTTP ${page.status}.`);
    out.push(...page.body);
    if (page.body.length < 1000) return out;
    const last = page.body.at(-1)?.user?.id;
    if (!last) die(1, 'Rollback member pagination returned an entry without a user id.');
    after = last;
  }
}

const me = await api<{ id: string }>('GET', '/users/@me');
if (me.status !== 200 || me.body?.id !== LIVE_BOT_APPLICATION_ID) die(1, 'Rollback preflight did not authenticate as Owen.');
const guilds = await api<Array<{ id: string }>>('GET', '/users/@me/guilds');
if (guilds.status !== 200 || !guilds.body?.some((guild) => guild.id === guildId)) die(1, `Owen is not in guild ${guildId}.`);
const roles = await api<Role[]>('GET', `/guilds/${guildId}/roles`);
const currentMembers = await members();
if (roles.status !== 200 || !roles.body) die(1, `Rollback preflight could not read roles: HTTP ${roles.status}.`);
const botMember = currentMembers.find((member) => member.user?.id === LIVE_BOT_APPLICATION_ID && member.user.bot);
if (!botMember || !roles.body.some((role) => botMember.roles?.includes(role.id) && (BigInt(role.permissions) & ADMINISTRATOR) !== 0n)) {
  die(1, 'Rollback preflight: Owen does not have Administrator.');
}
const integrations = await api<JsonObject[]>('GET', `/guilds/${guildId}/integrations`);
const guild = await api<JsonObject>('GET', `/guilds/${guildId}`);
if (integrations.status !== 200 || !integrations.body || guild.status !== 200 || !guild.body) die(1, 'Rollback preflight could not inventory bots/applications.');
if (guild.body.name !== LIVE_GUILD_NAME) die(1, `Rollback preflight: expected guild name ${LIVE_GUILD_NAME}, received ${String(guild.body.name)}.`);
const inventory = {
  memberBotIds: currentMembers.filter((member) => member.user?.bot).map((member) => member.user!.id).sort(),
  integrationApplicationIds: integrations.body
    .map((integration) => {
      const application = integration.application as JsonObject | undefined;
      return typeof application?.id === 'string' ? application.id : null;
    })
    .filter((id): id is string => Boolean(id))
    .sort(),
  guildApplicationId: typeof guild.body.application_id === 'string' ? guild.body.application_id : null,
};
if (stable(inventory) !== stable(pre.botInventory)) die(1, 'Rollback preflight bot/application inventory does not match the pre-export.');

async function must(method: 'DELETE' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<void> {
  const result = await api<unknown>(method, path, body);
  if (method === 'DELETE' && result.status === 404) return;
  if (result.status >= 300) die(1, `Rollback failed: ${method} ${path} returned HTTP ${result.status}.`);
}

async function rollback(operation: Operation): Promise<void> {
  if (operation.kind === 'pending-write') die(1, `Operation ${operation.id} has no recoverable rollback kind.`);
  if (operation.kind === 'create-role') {
    if (!operation.responseId || !operation.fingerprint) die(1, `Manifest lacks the created role fingerprint for ${operation.label}.`);
    const liveRoles = await api<Role[]>('GET', `/guilds/${guildId}/roles`);
    const role = liveRoles.body?.find((item) => item.id === operation.responseId);
    if (role && !matchesSubset(role, operation.fingerprint)) die(1, `Created role ${operation.responseId} drifted from its creation fingerprint.`);
    if (role && currentMembers.some((member) => member.roles?.includes(role.id))) die(1, `Created role ${operation.responseId} is now assigned to a member; refusing deletion.`);
    if (role) await must('DELETE', `/guilds/${guildId}/roles/${role.id}`);
  } else if (operation.kind === 'create-channel') {
    if (!operation.responseId || !operation.fingerprint) die(1, `Manifest lacks the created channel fingerprint for ${operation.label}.`);
    const channels = await api<Array<JsonObject>>('GET', `/guilds/${guildId}/channels`);
    const channel = channels.body?.find((item) => item.id === operation.responseId);
    if (channel && !matchesSubset(channel, operation.fingerprint)) die(1, `Created channel ${operation.responseId} drifted from its creation fingerprint.`);
    if (channel && operation.target.type !== 4) {
      const messages = await api<Array<{ id: string; author?: { id?: string } }>>('GET', `/channels/${operation.responseId}/messages?limit=1`);
      if (messages.status === 200 && messages.body?.some((message) => message.author?.id !== LIVE_BOT_APPLICATION_ID)) {
        die(1, `Created channel ${operation.responseId} contains a member message; refusing deletion.`);
      }
      if (messages.status !== 200 && messages.status !== 405) die(1, `Could not check created channel ${operation.responseId} for later use: HTTP ${messages.status}.`);
    }
    if (channel) await must('DELETE', `/channels/${String(channel.id)}`);
  } else if (operation.kind === 'create-message') {
    if (!operation.responseId) die(1, `Manifest lacks the created message id for ${operation.label}.`);
    const channelId = String(operation.target.channelId);
    const message = await api<{ id: string; author?: { id?: string }; content?: string }>('GET', `/channels/${channelId}/messages/${operation.responseId}`);
    if (message.status === 200 && message.body) {
      if (message.body.author?.id !== operation.target.authorId || message.body.content !== operation.target.content) die(1, `Created message ${operation.responseId} no longer matches the manifest guard.`);
      await must('DELETE', `/channels/${channelId}/messages/${operation.responseId}`);
    } else if (message.status !== 404) {
      die(1, `Could not guard the created message ${operation.responseId}: HTTP ${message.status}.`);
    }
  } else if (operation.kind === 'patch-channel') {
    await must('PATCH', `/channels/${String(operation.target.channelId)}`, operation.inverse);
  } else if (operation.kind === 'patch-guild') {
    await must('PATCH', `/guilds/${guildId}`, operation.inverse);
  } else if (operation.kind === 'patch-welcome') {
    await must('PATCH', `/guilds/${guildId}/welcome-screen`, operation.inverse);
  } else if (operation.kind === 'patch-onboarding') {
    await must('PUT', `/guilds/${guildId}/onboarding`, operation.inverse);
  } else if (operation.kind === 'patch-screening') {
    await must('PATCH', `/guilds/${guildId}/member-verification`, operation.inverse);
  }
}

async function recoverInterruptedCreate(operation: Operation): Promise<boolean> {
  if (operation.kind === 'create-role') {
    const liveRoles = await api<Role[]>('GET', `/guilds/${guildId}/roles`);
    const matches = (liveRoles.body ?? []).filter((role) => !role.managed && role.name === operation.target.name);
    if (matches.length > 1) die(1, `Interrupted ${operation.label} now has ${matches.length} matching roles; refusing an ambiguous delete.`);
    operation.responseId = matches[0]?.id;
    return matches.length === 1;
  }
  if (operation.kind === 'create-channel') {
    const channels = await api<Array<{ id: string; name: string; type: number; parent_id: string | null }>>('GET', `/guilds/${guildId}/channels`);
    const matches = (channels.body ?? []).filter((channel) =>
      channel.name === operation.target.name &&
      channel.type === operation.target.type &&
      channel.parent_id === operation.target.parentId
    );
    if (matches.length > 1) die(1, `Interrupted ${operation.label} now has ${matches.length} matching channels; refusing an ambiguous delete.`);
    operation.responseId = matches[0]?.id;
    return matches.length === 1;
  }
  if (operation.kind === 'create-message') {
    const channelId = String(operation.target.channelId);
    const messages = await api<Array<{ id: string; author?: { id?: string }; content?: string }>>('GET', `/channels/${channelId}/messages?limit=50`);
    if (messages.status !== 200 || !messages.body) die(1, `Could not recover interrupted ${operation.label}: HTTP ${messages.status}.`);
    const matches = messages.body.filter((message) => message.author?.id === operation.target.authorId && message.content === operation.target.content);
    if (matches.length > 1) die(1, `Interrupted ${operation.label} now has ${matches.length} matching messages; refusing an ambiguous delete.`);
    operation.responseId = matches[0]?.id;
    return matches.length === 1;
  }
  return true;
}

async function pendingPatchNeedsRollback(operation: Operation): Promise<boolean> {
  if (operation.kind === 'patch-channel') {
    const channel = await api<JsonObject>('GET', `/channels/${String(operation.target.channelId)}`);
    if (channel.status === 404) die(1, `Interrupted ${operation.label} target no longer exists.`);
    if (channel.status !== 200 || !channel.body) die(1, `Could not inspect interrupted ${operation.label}: HTTP ${channel.status}.`);
    return stable(channel.body) !== stable(operation.inverse);
  }
  if (operation.kind === 'patch-guild') {
    const current = await api<JsonObject>('GET', `/guilds/${guildId}`);
    if (current.status !== 200 || !current.body) die(1, `Could not inspect interrupted ${operation.label}: HTTP ${current.status}.`);
    return stable(current.body) !== stable(operation.inverse);
  }
  if (operation.kind === 'patch-welcome') {
    const current = await api<JsonObject>('GET', `/guilds/${guildId}/welcome-screen`);
    if (current.status !== 200 || !current.body) die(1, `Could not inspect interrupted ${operation.label}: HTTP ${current.status}.`);
    return stable(current.body) !== stable(operation.inverse);
  }
  if (operation.kind === 'patch-onboarding') {
    const current = await api<JsonObject>('GET', `/guilds/${guildId}/onboarding`);
    if (current.status !== 200 || !current.body) die(1, `Could not inspect interrupted ${operation.label}: HTTP ${current.status}.`);
    return stable(current.body) !== stable(operation.inverse);
  }
  if (operation.kind === 'patch-screening') {
    const current = await api<JsonObject>('GET', `/guilds/${guildId}/member-verification`);
    if (current.status !== 200 || !current.body) die(1, `Could not inspect interrupted ${operation.label}: HTTP ${current.status}.`);
    return stable(current.body) !== stable(operation.inverse);
  }
  return true;
}

for (const operation of [...manifest.operations].reverse()) {
  if (operation.state === 'rolled_back') continue;
  if (operation.state === 'pending' && !operation.requestStartedAt) {
    console.log(`SKIPPED ${operation.label}: the manifest proves the Discord request was never sent.`);
    operation.state = 'rolled_back';
    operation.rollbackAt = new Date().toISOString();
    atomicJson(manifestPath, manifest);
    continue;
  }
  if (operation.state === 'pending' && !operation.responseId) {
    const existed = await recoverInterruptedCreate(operation);
    if (!existed) {
      console.log(`SKIPPED ${operation.label}: Discord has no matching object, so the interrupted request did not persist.`);
      operation.state = 'rolled_back';
      operation.rollbackAt = new Date().toISOString();
      atomicJson(manifestPath, manifest);
      continue;
    }
    if (!operation.responseId && !(await pendingPatchNeedsRollback(operation))) {
      console.log(`SKIPPED ${operation.label}: the target still equals its captured pre-state.`);
      operation.state = 'rolled_back';
      operation.rollbackAt = new Date().toISOString();
      atomicJson(manifestPath, manifest);
      continue;
    }
    atomicJson(manifestPath, manifest);
  }
  if (operation.state === 'pending') operation.state = 'applied';
  await rollback(operation);
  operation.state = 'rolled_back';
  operation.rollbackAt = new Date().toISOString();
  atomicJson(manifestPath, manifest);
  console.log(`UNDID ${operation.label}`);
}
manifest.status = 'rolled_back';
atomicJson(manifestPath, manifest);
console.log(`Rollback complete: ${manifestPath}`);
