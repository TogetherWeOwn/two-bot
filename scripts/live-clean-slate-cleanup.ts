import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { applicationIdFromToken, LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, LIVE_GUILD_NAME } from '../src/staging/spec.ts';
import {
  ACTIVE_CATEGORY_IDS,
  ACTIVE_CHANNEL_IDS,
  ADMINISTRATOR,
  ARCHIVE_PHASE,
  buildManifest,
  type Channel,
  type CleanupManifest,
  type JsonObject,
  LEGACY_CATEGORY_IDS,
  LEGACY_CHANNEL_IDS,
  normalizeOverwrites,
  operationSemanticHash,
  planSignature,
  planArchiveOperations,
  type Role,
  SNAPSHOT_MAX_AGE_MS,
  stable,
  type LiveCleanupSnapshot,
  withSemanticHash,
} from '../src/redesign/live-cleanup.ts';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--confirm-main-guild');
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID ?? LIVE_GUILD_ID;

type ApiResult<T> = { status: number; body: T | null };
type RawMember = { user?: { id: string; username?: string; bot?: boolean }; roles?: string[]; premium_since?: string | null; pending?: boolean };

type OperationFile = {
  version: 1;
  phase: typeof ARCHIVE_PHASE;
  generatedAt: string;
  guildId: string;
  applicationId: string;
  snapshotSemanticHash: string;
  operationSemanticHash: string;
  operationCount: number;
  operations: CleanupManifest['operations'];
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

function apiBase(): string {
  const raw = process.env.MAIN_GUILD_API_BASE;
  if (!raw) return 'https://discord.com/api/v10';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    die(2, `MAIN_GUILD_API_BASE is not a URL: ${raw}`);
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) die(2, `MAIN_GUILD_API_BASE only accepts loopback test seams. Got ${parsed.hostname}.`);
  return raw.replace(/\/$/, '');
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomicFile(path: string, body: string): void {
  ensurePrivateDir(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function atomicJson(path: string, valueToWrite: unknown): void {
  atomicFile(path, `${JSON.stringify(valueToWrite, null, 2)}\n`);
}

function createImmutable(path: string, body: string): void {
  ensurePrivateDir(dirname(path));
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function createImmutableJson(path: string, valueToWrite: unknown): void {
  createImmutable(path, `${JSON.stringify(valueToWrite, null, 2)}\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

if (!token) die(2, 'Missing DISCORD_BOT_TOKEN.');
if (applicationIdFromToken(token) !== LIVE_BOT_APPLICATION_ID) die(2, `This token is not live Owen (${LIVE_BOT_APPLICATION_ID}). Nothing was contacted.`);
if (guildId !== LIVE_GUILD_ID) die(2, `DISCORD_GUILD_ID is not the live guild ${LIVE_GUILD_ID}. Nothing was contacted.`);
if (!CONFIRMED) die(2, 'Refusing to contact the live guild without --confirm-main-guild.');
if (value('phase') !== ARCHIVE_PHASE) die(2, `Only --phase ${ARCHIVE_PHASE} is implemented.`);
const runDir = resolve(value('run-dir') ?? die(2, '--run-dir is required.'));
const snapshotDir = join(runDir, 'snapshot');
const planDir = join(runDir, 'plan');
const phaseDir = join(runDir, 'phase-01');
const snapshotPath = join(snapshotDir, 'pre.json');
const holdersPath = join(snapshotDir, 'holders.csv');
const referencesPath = join(snapshotDir, 'references.json');
const operationsPath = join(planDir, 'operations.json');
const planRollbackPath = join(planDir, 'rollback.json');
const planLogPath = join(runDir, 'plan.log');
const phaseRollbackPath = join(phaseDir, 'rollback.json');
const phasePostPath = join(phaseDir, 'post.json');
const phaseLogPath = join(runDir, 'phase-01.log');
const API = apiBase();

let discordWrites = 0;
let logPath = planLogPath;
let logLines: string[] = [];
function log(message: string): void {
  console.log(message);
  logLines.push(message);
}
function finalizeLog(): void {
  if (!existsSync(logPath)) createImmutable(logPath, `${logLines.join('\n')}\n`);
  else chmodSync(logPath, 0o600);
}

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

async function allMembers(): Promise<RawMember[]> {
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

async function captureSnapshot(): Promise<LiveCleanupSnapshot> {
  const [me, guilds, guild, roles, channels, integrations, application, welcome, onboarding, screening, members] = await Promise.all([
    mustGet<{ id: string }>('/users/@me', 'Authenticate bot'),
    mustGet<Array<{ id: string }>>('/users/@me/guilds', 'Read bot guilds'),
    mustGet<JsonObject>(`/guilds/${guildId}`, 'Read guild'),
    mustGet<Role[]>(`/guilds/${guildId}/roles`, 'Read roles'),
    mustGet<Channel[]>(`/guilds/${guildId}/channels`, 'Read channels'),
    mustGet<JsonObject[]>(`/guilds/${guildId}/integrations`, 'Read integrations'),
    mustGet<JsonObject>('/oauth2/applications/@me', 'Read application'),
    api<JsonObject>('GET', `/guilds/${guildId}/welcome-screen`),
    api<JsonObject>('GET', `/guilds/${guildId}/onboarding`),
    api<JsonObject>('GET', `/guilds/${guildId}/member-verification`),
    allMembers(),
  ]);
  if (me.id !== LIVE_BOT_APPLICATION_ID || application.id !== LIVE_BOT_APPLICATION_ID) die(1, 'Discord identity does not match live Owen.');
  if (!guilds.some((guildItem) => guildItem.id === guildId)) die(1, `Owen is not in guild ${guildId}.`);
  if (guild.name !== LIVE_GUILD_NAME) die(1, `Expected guild name ${LIVE_GUILD_NAME}, received ${String(guild.name)}.`);
  const references = {
    welcomeScreen: { status: welcome.status, body: welcome.body },
    onboarding: { status: onboarding.status, body: onboarding.body },
    membershipScreening: { status: screening.status, body: screening.body },
    guildReferences: {
      applicationId: guild.application_id ?? null,
      systemChannelId: guild.system_channel_id ?? null,
      rulesChannelId: guild.rules_channel_id ?? null,
      publicUpdatesChannelId: guild.public_updates_channel_id ?? null,
      safetyAlertsChannelId: guild.safety_alerts_channel_id ?? null,
    },
  };
  return withSemanticHash({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: LIVE_BOT_APPLICATION_ID,
    guildId,
    guild,
    roles,
    channels: channels.map((channel) => ({ ...channel, permission_overwrites: normalizeOverwrites(channel.permission_overwrites ?? []) })),
    members: members.map((member) => ({
      id: member.user?.id ?? '',
      bot: Boolean(member.user?.bot),
      username: member.user?.username ?? null,
      roles: [...(member.roles ?? [])].sort(),
      premiumSince: member.premium_since ?? null,
      pending: Boolean(member.pending),
    })).filter((member) => member.id).sort((a, b) => a.id.localeCompare(b.id)),
    integrations: integrations.map((integration) => {
      const linkedApplication = integration.application as JsonObject | undefined;
      const linkedRole = integration.role_id;
      return {
        id: typeof integration.id === 'string' ? integration.id : '',
        name: typeof integration.name === 'string' ? integration.name : null,
        applicationId: typeof linkedApplication?.id === 'string' ? linkedApplication.id : null,
        roleId: typeof linkedRole === 'string' ? linkedRole : null,
      };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    references,
  });
}

function holdersCsv(snapshot: LiveCleanupSnapshot): string {
  const rows = ['member_id,username,bot,role_id,role_name'];
  const roleName = new Map(snapshot.roles.map((role) => [role.id, role.name]));
  for (const member of snapshot.members) {
    for (const roleId of member.roles) {
      rows.push([member.id, member.username ?? '', member.bot ? 'true' : 'false', roleId, roleName.get(roleId) ?? ''].map((field) => JSON.stringify(field)).join(','));
    }
  }
  return `${rows.join('\n')}\n`;
}

function assertManifest(manifest: CleanupManifest, snapshot: LiveCleanupSnapshot): void {
  const age = Date.now() - Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > SNAPSHOT_MAX_AGE_MS) throw new Error('Snapshot is not fresh enough for apply (maximum age: 24 hours).');
  const operations = planArchiveOperations(snapshot);
  if (manifest.applicationId !== LIVE_BOT_APPLICATION_ID || manifest.guildId !== LIVE_GUILD_ID) throw new Error('Manifest identity mismatch.');
  if (manifest.snapshotGeneratedAt !== snapshot.generatedAt) throw new Error('Manifest snapshot timestamp mismatch.');
  if (manifest.snapshotSemanticHash !== snapshot.semanticHash) throw new Error('Manifest snapshot semantic hash mismatch.');
  const generatedOperationHash = operationSemanticHash(operations);
  const expectedSignature = planSignature(token!, snapshot.generatedAt, snapshot.semanticHash, generatedOperationHash);
  if (manifest.planSignature !== expectedSignature) throw new Error('Manifest plan signature is invalid for this token, snapshot, and operation hash.');
  if (manifest.operationCount !== operations.length || manifest.operationSemanticHash !== generatedOperationHash) throw new Error('Generated operation count/hash differs from the reviewed dry-run manifest.');
  if (manifest.operationCount !== manifest.operations.length || operationSemanticHash(manifest.operations) !== manifest.operationSemanticHash) throw new Error('Stored manifest operations do not match their recorded semantic hash.');
  if (stable(manifest.operations.map(({ state: _state, requestStartedAt: _requestStartedAt, appliedAt: _appliedAt, rolledBackAt: _rolledBackAt, ...operation }) => operation)) !== stable(operations)) throw new Error('Stored manifest operation bodies differ from the deterministic plan.');
  if (stable(manifest.reviewedLegacyChannelIds) !== stable([...LEGACY_CHANNEL_IDS])) throw new Error('Reviewed 112-channel allowlist differs.');
  if (stable(manifest.reviewedLegacyCategoryIds) !== stable([...LEGACY_CATEGORY_IDS])) throw new Error('Reviewed 18-category allowlist differs.');
  if (stable(manifest.activeChannelIds) !== stable([...ACTIVE_CHANNEL_IDS]) || stable(manifest.activeCategoryIds) !== stable([...ACTIVE_CATEGORY_IDS])) throw new Error('Active-tree allowlist differs.');
  const expectedIds = operations.map((operation) => operation.id);
  if (stable(manifest.operations.map((operation) => operation.id)) !== stable(expectedIds)) throw new Error('Generated operation IDs differ from the reviewed dry-run manifest.');
}

async function dryRun(): Promise<void> {
  if (existsSync(snapshotPath) || existsSync(operationsPath) || existsSync(planRollbackPath)) die(2, 'Run directory already contains a plan; choose a new RUN_DIR.');
  ensurePrivateDir(snapshotDir);
  ensurePrivateDir(planDir);
  const snapshot = await captureSnapshot();
  const operations = planArchiveOperations(snapshot);
  const manifest = buildManifest(snapshot, snapshotPath, operations, token!);
  const operationFile: OperationFile = {
    version: 1,
    phase: ARCHIVE_PHASE,
    generatedAt: snapshot.generatedAt,
    guildId,
    applicationId: LIVE_BOT_APPLICATION_ID,
    snapshotSemanticHash: snapshot.semanticHash,
    operationSemanticHash: manifest.operationSemanticHash,
    operationCount: operations.length,
    operations: manifest.operations,
  };
  createImmutableJson(snapshotPath, snapshot);
  createImmutable(holdersPath, holdersCsv(snapshot));
  createImmutableJson(referencesPath, snapshot.references);
  createImmutableJson(operationsPath, operationFile);
  createImmutableJson(planRollbackPath, manifest);
  log(`Dry-run complete: ${operations.length} deterministic category-overwrite operations; 112 legacy channels are hidden through 18 reviewed categories.`);
  log(`Snapshot semantic hash: ${snapshot.semanticHash}`);
  log(`Operation semantic hash: ${manifest.operationSemanticHash}`);
  log('Applied 0 Discord write(s).');
  finalizeLog();
}

async function apply(): Promise<void> {
  for (const required of [snapshotPath, holdersPath, referencesPath, operationsPath, planRollbackPath]) {
    if (!existsSync(required)) die(2, `Apply requires the dry-run artifact ${required}.`);
    if ((statSync(required).mode & 0o077) !== 0) die(2, `Artifact is not mode-0600/private: ${required}.`);
  }
  const snapshot = readJson<LiveCleanupSnapshot>(snapshotPath);
  const planned = readJson<CleanupManifest>(planRollbackPath);
  assertManifest(planned, snapshot);
  let phaseManifest: CleanupManifest;
  if (existsSync(phaseRollbackPath)) {
    phaseManifest = readJson<CleanupManifest>(phaseRollbackPath);
    if (phaseManifest.status === 'applied') die(2, 'Phase is already applied; no writes were replayed.');
    if (phaseManifest.status === 'rolled_back' || phaseManifest.status === 'rolling_back' || phaseManifest.status === 'rollback_failed') die(2, `Phase manifest is in ${phaseManifest.status}; apply cannot resume it.`);
    assertManifest(phaseManifest, snapshot);
    if (phaseManifest.operationSemanticHash !== planned.operationSemanticHash || phaseManifest.snapshotSemanticHash !== planned.snapshotSemanticHash || phaseManifest.planSignature !== planned.planSignature) die(2, 'Resume manifest does not match the dry-run manifest.');
  } else {
    phaseManifest = structuredClone(planned);
    phaseManifest.status = 'applying';
    ensurePrivateDir(phaseDir);
    atomicJson(phaseRollbackPath, phaseManifest);
  }
  const fresh = await captureSnapshot();
  const acceptableHashes = new Set<string>();
  const requesting = phaseManifest.operations.filter((operation) => operation.state === 'requesting');
  if (requesting.length > 1) die(1, 'Resume manifest has more than one requesting operation.');
  const variants = requesting.length === 0 ? [false] : [false, true];
  for (const requestingApplied of variants) {
    const acceptable = structuredClone(snapshot);
    for (const operation of phaseManifest.operations) {
      if (operation.state !== 'applied' && !(requestingApplied && operation.state === 'requesting')) continue;
      const category = acceptable.channels.find((channel) => channel.id === operation.objectId)!;
      category.permission_overwrites = operation.write.permission_overwrites;
    }
    const { semanticHash: _acceptableHash, ...acceptableInput } = acceptable;
    acceptableHashes.add(withSemanticHash({ ...acceptableInput, generatedAt: fresh.generatedAt }).semanticHash);
  }
  if (!acceptableHashes.has(fresh.semanticHash)) die(1, `Live state drifted since dry-run/resume: got ${fresh.semanticHash}.`);
  phaseManifest.status = 'applying';
  atomicJson(phaseRollbackPath, phaseManifest);
  logPath = phaseLogPath;
  logLines = [];
  log(`Apply starting from reviewed operation hash ${phaseManifest.operationSemanticHash}.`);
  const abortAfter = Number(process.env.LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES ?? '0');
  for (const operation of phaseManifest.operations) {
    const liveCategory = await mustGet<Channel>(`/channels/${operation.objectId}`, `Read category ${operation.objectId}`);
    const liveBefore = normalizeOverwrites(liveCategory.permission_overwrites ?? []);
    if (operation.state === 'applied') {
      if (stable(liveBefore) !== stable(operation.write.permission_overwrites)) die(1, `Applied operation ${operation.id} drifted; refusing replay.`);
      continue;
    }
    if (operation.state === 'requesting') {
      if (stable(liveBefore) === stable(operation.write.permission_overwrites)) {
        operation.state = 'applied';
        operation.appliedAt = new Date().toISOString();
        atomicJson(phaseRollbackPath, phaseManifest);
        continue;
      }
      if (stable(liveBefore) !== stable(operation.expectedBefore.permission_overwrites)) die(1, `Interrupted operation ${operation.id} has ambiguous state.`);
    } else if (stable(liveBefore) !== stable(operation.expectedBefore.permission_overwrites)) {
      die(1, `Expected before-state mismatch for ${operation.id}.`);
    }
    operation.state = 'requesting';
    operation.requestStartedAt = new Date().toISOString();
    atomicJson(phaseRollbackPath, phaseManifest);
    const result = await api<Channel>('PATCH', `/channels/${operation.objectId}`, operation.write);
    if (result.status === 429 || result.status >= 300 || !result.body) {
      phaseManifest.status = 'apply_failed';
      atomicJson(phaseRollbackPath, phaseManifest);
      die(1, `Discord write failed for ${operation.id}: HTTP ${result.status}. No retry was attempted.`);
    }
    const returned = normalizeOverwrites(result.body.permission_overwrites ?? []);
    if (stable(returned) !== stable(operation.write.permission_overwrites)) {
      phaseManifest.status = 'apply_failed';
      atomicJson(phaseRollbackPath, phaseManifest);
      die(1, `Discord returned a partial/unexpected state for ${operation.id}.`);
    }
    discordWrites++;
    if (abortAfter > 0 && discordWrites >= abortAfter) die(86, `Test interruption after ${discordWrites} accepted write(s).`);
    operation.state = 'applied';
    operation.appliedAt = new Date().toISOString();
    atomicJson(phaseRollbackPath, phaseManifest);
    log(`DID ${operation.id}`);
  }
  const post = await captureSnapshot();
  const { semanticHash: _ignoredSemanticHash, ...expectedPostInput } = structuredClone(snapshot);
  for (const operation of phaseManifest.operations) {
    const category = expectedPostInput.channels.find((channel) => channel.id === operation.objectId)!;
    category.permission_overwrites = operation.write.permission_overwrites;
  }
  const expectedPostHashed = withSemanticHash({ ...expectedPostInput, generatedAt: post.generatedAt });
  if (post.semanticHash !== expectedPostHashed.semanticHash) {
    phaseManifest.status = 'apply_failed';
    atomicJson(phaseRollbackPath, phaseManifest);
    die(1, `Postflight semantic hash mismatch: expected ${expectedPostHashed.semanticHash}, got ${post.semanticHash}.`);
  }
  if (existsSync(phasePostPath)) {
    const persistedPost = readJson<LiveCleanupSnapshot>(phasePostPath);
    if (persistedPost.semanticHash !== post.semanticHash) die(1, 'Existing phase post-snapshot differs from the verified live post-state.');
  } else {
    createImmutableJson(phasePostPath, post);
  }
  phaseManifest.status = 'applied';
  atomicJson(phaseRollbackPath, phaseManifest);
  log(`Applied ${discordWrites} Discord write(s).`);
  log(`Post semantic hash: ${post.semanticHash}`);
  log(`Rollback: DISCORD_GUILD_ID=${LIVE_GUILD_ID} node scripts/live-clean-slate-cleanup-rollback.ts --manifest ${JSON.stringify(phaseRollbackPath)} --confirm-main-guild --apply`);
  finalizeLog();
}

await (APPLY ? apply() : dryRun());
