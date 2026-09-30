#!/usr/bin/env node
/**
 * Bounded TWO Staging gateway acceptance for TOG-3787.
 *
 * Default: read-only preflight. `drive` is the only command that creates
 * fixtures, and it requires --apply plus an explicit expected incident state.
 * The driver never accepts a user token and never automates a human account.
 *
 * Discord REST contracts used here:
 * - Role create/position/assignment/deletion:
 *   https://docs.discord.com/developers/resources/guild
 * - Audit log query and X-Audit-Log-Reason:
 *   https://docs.discord.com/developers/resources/audit-log
 * - 429 retry_after handling:
 *   https://docs.discord.com/developers/topics/rate-limits
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readSecret } from '../src/core/credentials.ts';
import { GuildConfigDiscordApi } from '../src/discord/guildConfigApi.ts';
import {
  ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES,
  ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
  MANAGE_ROLES_PERMISSION,
  ROLE_DELETE_AUDIT_ACTION,
  acceptanceLockKey,
  assertAcceptanceFences,
  discordSnowflakeTimestamp,
  evaluateGatewayEvidence,
  evaluateJoinGatewayEvidence,
  fixtureRoleNames,
  selectFixtureAuditEntries,
  validateAcceptanceRunId,
  validateSnowflake,
  type ContainmentEvidenceRow,
  type ContainmentIncidentEvidence,
  type DiscordAuditEntry,
  type ExpectedIncidentState,
  type JoinEventEvidence,
  type JoinRiskEvidence,
} from '../src/staging/antiNukeAcceptance.ts';
import { canonicalSnapshot, configHash, verifySnapshotIntegrity, type GuildConfigSnapshot } from '../src/redesign/guildConfig.ts';
import { planRestore } from '../src/redesign/guildConfigRestore.ts';
import { openDb, type Db } from '../src/store/db.ts';
import {
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_SERVER_NAME,
  TWO_STAGING_GUILD_ID,
  applicationIdFromToken,
  checkStagingToken,
} from '../src/staging/spec.ts';

const API = 'https://discord.com/api/v10';
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_GATEWAY_POLLS = 30;
const POLL_INTERVAL_MS = 1_000;
const RECENT_ACTOR_WINDOW_MS = 5 * 60 * 1_000;
const DANGEROUS_PERMISSIONS =
  (1n << 1n) | (1n << 2n) | (1n << 3n) | (1n << 4n) |
  (1n << 5n) | (1n << 27n) | (1n << 28n) | (1n << 40n);

type Command = 'preflight' | 'drive' | 'cleanup' | 'verify-join';
type JsonObject = Record<string, unknown>;

type DiscordRole = {
  id: string;
  name: string;
  managed: boolean;
  permissions: string;
  position: number;
};

type DiscordMember = {
  user?: { id?: string; bot?: boolean };
  joined_at?: string;
  roles?: string[];
};

type Manifest = {
  version: 1;
  runId: string;
  createdAt: string;
  targetSha: string;
  guildId: string;
  actorApplicationId: string;
  expectedIncidentState: ExpectedIncidentState;
  names: ReturnType<typeof fixtureRoleNames>;
  roleIds: { capability: string | null; targets: string[] };
  capabilityAssigned: boolean;
  discordWrites: string[];
  cleanup?: { completedAt: string; actions: string[]; recoveredRoleIds: string[] };
};

type CommonContext = {
  runId: string;
  targetRepo: string;
  targetSha: string;
  driverSha: string;
  deployedSha: string;
  deployedShaSource: string;
  guildId: string;
  dbUrl: string;
  databaseFingerprint: string;
  owenToken: string;
  owen: DiscordBotApi;
  guildConfig: GuildConfigDiscordApi;
  db: Db;
  verifierConfig: ReturnType<typeof inspectFullVerifierConfig>;
};

class DiscordBotApi {
  readonly token: string;
  writes: string[] = [];

  constructor(token: string) {
    this.token = token;
  }

  async read<T>(path: string): Promise<T> {
    const response = await this.request<T>('GET', path, undefined, undefined, [200]);
    if (response.body === null) throw new Error(`Discord GET ${path} returned no JSON body.`);
    return response.body;
  }

  async write<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body: unknown, reason: string, accepted: number[]): Promise<T | null> {
    if (!path.startsWith(`/guilds/${TWO_STAGING_GUILD_ID}/`)) {
      throw new Error(`Refusing Discord write outside TWO Staging: ${method} ${path}`);
    }
    if (path.includes(LIVE_GUILD_ID)) throw new Error(`Refusing live guild ${LIVE_GUILD_ID}.`);
    const response = await this.request<T>(method, path, body, reason, accepted);
    this.writes.push(`${method} ${path}`);
    return response.body;
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    reason: string | undefined,
    accepted: number[],
  ): Promise<{ status: number; body: T | null }> {
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason).slice(0, 512) } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const responseBody = (await response.json().catch(() => null)) as T | { retry_after?: number } | null;
      if (response.status === 429) {
        const retryAfter = Number((responseBody as { retry_after?: number } | null)?.retry_after ?? response.headers.get('retry-after') ?? 1);
        if (!Number.isFinite(retryAfter) || retryAfter < 0) throw new Error(`Discord returned invalid retry_after for ${method} ${path}.`);
        await sleep(Math.min(retryAfter, 30) * 1_000);
        continue;
      }
      if (!accepted.includes(response.status)) {
        const code = responseBody && typeof responseBody === 'object' && 'code' in responseBody
          ? ` code=${String((responseBody as { code?: unknown }).code)}`
          : '';
        throw new Error(`Discord ${method} ${path} failed: HTTP ${response.status}${code}`);
      }
      return { status: response.status, body: responseBody as T | null };
    }
    throw new Error(`Discord ${method} ${path} remained rate-limited after ${MAX_RATE_LIMIT_RETRIES} bounded attempts.`);
  }
}

function usage(): never {
  console.error(`
Usage:
  node scripts/staging-anti-nuke-acceptance.ts preflight --snapshot <accepted.json> [--output <evidence.json>]
  node scripts/staging-anti-nuke-acceptance.ts drive --expect dry_run|contained --snapshot <accepted.json> --output <evidence.json> --manifest <manifest.json> --apply
  node scripts/staging-anti-nuke-acceptance.ts cleanup --manifest <manifest.json> [--output <cleanup.json>]
  node scripts/staging-anti-nuke-acceptance.ts verify-join --member-id <snowflake> --since <ISO> --expect-bulk-window true|false --expect-flagged true|false --output <evidence.json>

Required environment (values are never printed):
  TWO_ACCEPTANCE_RUN_ID
  TWO_ACCEPTANCE_TARGET_REPO
  TWO_STAGING_DEPLOYED_SHA=${ANTI_NUKE_ACCEPTANCE_TARGET_SHA}
  TWO_STAGING_DEPLOYED_SHA_SOURCE=<deployment evidence URL/reference>
  DISCORD_STAGING_GUILD_ID=${TWO_STAGING_GUILD_ID}
  DISCORD_STAGING_BOT_TOKEN
  TWO_STAGING_DATABASE_URL
  TWO_STAGING_DATABASE_HOST
  TWO_STAGING_DATABASE_NAME

preflight/drive additionally require:
  TWO_STAGING_ACTOR_APPLICATION_ID
  DISCORD_STAGING_ACTOR_BOT_TOKEN

Full staging verifier prerequisites are reported, never bypassed:
  TWO_AUDIT_ACCEPTANCE_SINCE, TWO_SELF_ROLE_PANELS, DISCORD_GOODBYE_CHANNEL_IDS
`);
  process.exit(2);
}

function parseArgs(argv: string[]): { command: Command; flags: Map<string, string | true> } {
  const rawCommand = argv[0] ?? 'preflight';
  if (!['preflight', 'drive', 'cleanup', 'verify-join'].includes(rawCommand)) usage();
  const flags = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) usage();
    const name = arg.slice(2);
    if (name === 'apply') {
      flags.set(name, true);
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) usage();
    flags.set(name, value);
  }
  return { command: rawCommand as Command, flags };
}

function flag(flags: Map<string, string | true>, name: string, required = false): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value.`);
  if (required && !value) throw new Error(`Missing --${name}.`);
  return value;
}

function booleanFlag(flags: Map<string, string | true>, name: string): boolean | undefined {
  const value = flag(flags, name);
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${name} must be true or false.`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function gitHead(repo: string): string {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not read git HEAD for ${repo}.`);
  return result.stdout.trim();
}

function gitClean(repo: string): boolean {
  const result = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not read git status for ${repo}.`);
  return result.stdout.trim() === '';
}

function atomicJson(path: string, value: unknown): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, resolved);
  const dirFd = openSync(dirname(resolved), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function inspectFullVerifierConfig(): {
  ready: boolean;
  missing: string[];
  auditSince: string | null;
  selfRolePanelConfigured: boolean;
  goodbyeChannelCount: number;
} {
  const missing: string[] = [];
  const auditSince = process.env.TWO_AUDIT_ACCEPTANCE_SINCE?.trim() || null;
  if (!auditSince || !Number.isFinite(Date.parse(auditSince))) missing.push('TWO_AUDIT_ACCEPTANCE_SINCE');
  const selfRolePanelConfigured = Boolean(process.env.TWO_SELF_ROLE_PANELS?.trim());
  if (!selfRolePanelConfigured) missing.push('TWO_SELF_ROLE_PANELS');
  const goodbyeChannelCount = (process.env.DISCORD_GOODBYE_CHANNEL_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean).length;
  if (goodbyeChannelCount === 0) missing.push('DISCORD_GOODBYE_CHANNEL_IDS');
  return { ready: missing.length === 0, missing, auditSince, selfRolePanelConfigured, goodbyeChannelCount };
}

export function validateStagingDatabaseIdentity(url: string, expectedHost: string, expectedName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('TWO_STAGING_DATABASE_URL is not a URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('TWO_STAGING_DATABASE_URL must use Postgres.');
  const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '');
  if (parsed.hostname !== expectedHost || name !== expectedName) {
    throw new Error('TWO_STAGING_DATABASE_URL does not match the exact TWO_STAGING_DATABASE_HOST/TWO_STAGING_DATABASE_NAME fence.');
  }
  return createHash('sha256')
    .update(`${parsed.hostname}:${parsed.port || '5432'}/${name}`)
    .digest('hex');
}

async function commonContext(requireActor: boolean): Promise<CommonContext & { actorApplicationId?: string; actorToken?: string; actor?: DiscordBotApi }> {
  const runId = validateAcceptanceRunId(requiredEnv('TWO_ACCEPTANCE_RUN_ID'));
  const targetRepo = resolve(requiredEnv('TWO_ACCEPTANCE_TARGET_REPO'));
  const targetSha = gitHead(targetRepo);
  if (!gitClean(targetRepo)) throw new Error(`Target checkout ${targetRepo} is dirty; exact-SHA evidence would be ambiguous.`);
  const driverRepo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const driverSha = gitHead(driverRepo);
  if (!gitClean(driverRepo)) throw new Error(`Driver checkout ${driverRepo} is dirty; evidence would not identify the executed code.`);
  const deployedSha = requiredEnv('TWO_STAGING_DEPLOYED_SHA');
  const deployedShaSource = requiredEnv('TWO_STAGING_DEPLOYED_SHA_SOURCE');
  const guildId = requiredEnv('DISCORD_STAGING_GUILD_ID');
  const dbUrl = requiredEnv('TWO_STAGING_DATABASE_URL');
  const databaseFingerprint = validateStagingDatabaseIdentity(
    dbUrl,
    requiredEnv('TWO_STAGING_DATABASE_HOST'),
    requiredEnv('TWO_STAGING_DATABASE_NAME'),
  );

  const owenToken = readSecret('discord_staging_token', ['DISCORD_STAGING_BOT_TOKEN']);
  if (!owenToken) throw new Error('Missing DISCORD_STAGING_BOT_TOKEN.');
  const tokenCheck = checkStagingToken(owenToken);
  if (!tokenCheck.ok) throw new Error(tokenCheck.message);

  let actorApplicationId: string | undefined;
  let actorToken: string | undefined;
  if (requireActor) {
    actorApplicationId = validateSnowflake(requiredEnv('TWO_STAGING_ACTOR_APPLICATION_ID'), 'TWO_STAGING_ACTOR_APPLICATION_ID');
    actorToken = requiredEnv('DISCORD_STAGING_ACTOR_BOT_TOKEN');
    if (applicationIdFromToken(actorToken) !== actorApplicationId) {
      throw new Error('DISCORD_STAGING_ACTOR_BOT_TOKEN does not belong to TWO_STAGING_ACTOR_APPLICATION_ID.');
    }
  }

  assertAcceptanceFences({
    guildId,
    owenApplicationId: STAGING_BOT_APPLICATION_ID,
    actorApplicationId: actorApplicationId ?? '111111111111111111',
    targetSha,
    deployedSha,
  });

  const owen = new DiscordBotApi(owenToken);
  const guildConfig = new GuildConfigDiscordApi({ token: owenToken, applicationId: STAGING_BOT_APPLICATION_ID, guildId });
  await guildConfig.assertIdentity();
  const guild = await owen.read<{ id: string; name: string }>(`/guilds/${guildId}`);
  if (guild.id !== TWO_STAGING_GUILD_ID || guild.name !== STAGING_SERVER_NAME) {
    throw new Error(`Discord authenticated to unexpected guild ${guild.name} (${guild.id}).`);
  }

  const db = await openDb(dbUrl, {
    skipMigrations: true,
    poolMax: 1,
    applicationName: `two-bot-tog-3787-${runId}`,
  });
  try {
    const [lockHigh, lockLow] = acceptanceLockKey();
    const lock = await db.prepare('SELECT pg_try_advisory_lock(?, ?) AS locked').get<{ locked: boolean }>(lockHigh, lockLow);
    if (!lock?.locked) {
      throw new Error('Another TOG-3787 acceptance job holds the staging advisory lock; exactly one E2E job is allowed.');
    }
  } catch (error) {
    await db.close();
    throw error;
  }

  const base: CommonContext = {
    runId,
    targetRepo,
    targetSha,
    driverSha,
    deployedSha,
    deployedShaSource,
    guildId,
    dbUrl,
    databaseFingerprint,
    owenToken,
    owen,
    guildConfig,
    db,
    verifierConfig: inspectFullVerifierConfig(),
  };
  if (!requireActor) return base;
  return { ...base, actorApplicationId, actorToken, actor: new DiscordBotApi(actorToken!) };
}

async function actorPreflight(context: CommonContext & { actorApplicationId: string; actor: DiscordBotApi }): Promise<{
  actorApplicationId: string;
  owenRolePosition: number;
  actorDangerousRoleIds: string[];
  recentActorRows: number;
  activeIncidents: number;
}> {
  const me = await context.actor.read<{ id: string; bot?: boolean }>('/users/@me');
  if (me.id !== context.actorApplicationId || me.bot !== true) {
    throw new Error('The destructive actor credential must authenticate as the declared bot application. User-account automation is forbidden.');
  }
  const actorGuilds = await context.actor.read<Array<{ id: string }>>('/users/@me/guilds');
  if (!actorGuilds.some((guild) => guild.id === TWO_STAGING_GUILD_ID)) throw new Error('Actor bot is not in TWO Staging.');
  if (actorGuilds.some((guild) => guild.id === LIVE_GUILD_ID)) throw new Error(`Actor bot is also in live guild ${LIVE_GUILD_ID}; use a staging-only disposable app.`);

  const [roles, owenMember, actorMember] = await Promise.all([
    context.owen.read<DiscordRole[]>(`/guilds/${context.guildId}/roles`),
    context.owen.read<DiscordMember>(`/guilds/${context.guildId}/members/${STAGING_BOT_APPLICATION_ID}`),
    context.owen.read<DiscordMember>(`/guilds/${context.guildId}/members/${context.actorApplicationId}`),
  ]);
  const owenRoleIds = new Set(owenMember.roles ?? []);
  const actorRoleIds = new Set(actorMember.roles ?? []);
  const owenRolePosition = roles.filter((role) => owenRoleIds.has(role.id)).reduce((max, role) => Math.max(max, role.position), 0);
  const actorDangerousRoleIds = roles
    .filter((role) => actorRoleIds.has(role.id) && (BigInt(role.permissions) & DANGEROUS_PERMISSIONS) !== 0n)
    .map((role) => role.id);
  if (actorDangerousRoleIds.length > 0) {
    throw new Error(`Actor already has ${actorDangerousRoleIds.length} dangerous role(s); refusing to risk removing non-run state.`);
  }

  const cutoff = new Date(Date.now() - RECENT_ACTOR_WINDOW_MS).toISOString();
  const recent = await context.db.prepare(
    `SELECT COUNT(*) AS count FROM containment_events
      WHERE guild_id = ? AND executor_id = ? AND created_at >= ?`,
  ).get<{ count: number }>(context.guildId, context.actorApplicationId, cutoff);
  const active = await context.db.prepare(
    `SELECT COUNT(*) AS count FROM containment_incidents
      WHERE guild_id = ? AND executor_id = ?
        AND (state = 'uncertain' OR cooldown_until > ?)`,
  ).get<{ count: number }>(context.guildId, context.actorApplicationId, new Date().toISOString());
  const recentActorRows = Number(recent?.count ?? 0);
  const activeIncidents = Number(active?.count ?? 0);
  if (recentActorRows > 0 || activeIncidents > 0) {
    throw new Error(`Actor has recent containment state (events=${recentActorRows}, active incidents=${activeIncidents}); wait for a clean bounded window.`);
  }
  return { actorApplicationId: context.actorApplicationId, owenRolePosition, actorDangerousRoleIds, recentActorRows, activeIncidents };
}

export function acceptedSnapshot(path: string, current: GuildConfigSnapshot): { snapshot: GuildConfigSnapshot; hash: string } {
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as GuildConfigSnapshot;
  if (parsed.version !== 1 || parsed.guildId !== TWO_STAGING_GUILD_ID || parsed.applicationId !== STAGING_BOT_APPLICATION_ID) {
    throw new Error('Accepted snapshot is not the Owen QA Test snapshot for TWO Staging.');
  }
  // TOG-7678: verify the tamper-evident seal before hash comparison (TOG-3513).
  // A SnapshotIntegrityError propagates and refuses preflight/drive with zero
  // Discord writes; legacy pre-seal snapshots warn and proceed, matching restore.
  if (verifySnapshotIntegrity(parsed) === 'legacy') {
    console.error('staging-anti-nuke-acceptance: warning: accepted snapshot has no integrity seal (predates TOG-3513); skipping tamper check');
  }
  const hash = configHash(canonicalSnapshot(parsed));
  const currentHash = configHash(canonicalSnapshot(current));
  if (currentHash !== hash) {
    const plan = planRestore(parsed, current);
    throw new Error(`Current staging semantic hash ${currentHash} differs from accepted ${hash}; restore is required (${plan.counts.operations} operation(s)).`);
  }
  return { snapshot: parsed, hash };
}

async function tableCounts(db: Db, guildId: string, actorApplicationId?: string): Promise<Record<string, number>> {
  const event = actorApplicationId
    ? await db.prepare('SELECT COUNT(*) AS count FROM containment_events WHERE guild_id = ? AND executor_id = ?').get<{ count: number }>(guildId, actorApplicationId)
    : await db.prepare('SELECT COUNT(*) AS count FROM containment_events WHERE guild_id = ?').get<{ count: number }>(guildId);
  const incident = actorApplicationId
    ? await db.prepare('SELECT COUNT(*) AS count FROM containment_incidents WHERE guild_id = ? AND executor_id = ?').get<{ count: number }>(guildId, actorApplicationId)
    : await db.prepare('SELECT COUNT(*) AS count FROM containment_incidents WHERE guild_id = ?').get<{ count: number }>(guildId);
  const join = await db.prepare('SELECT COUNT(*) AS count FROM join_risk_flags WHERE guild_id = ?').get<{ count: number }>(guildId);
  return {
    containmentEvents: Number(event?.count ?? 0),
    containmentIncidents: Number(incident?.count ?? 0),
    joinRiskFlags: Number(join?.count ?? 0),
  };
}

async function runPreflight(flags: Map<string, string | true>): Promise<void> {
  const context = await commonContext(true) as CommonContext & { actorApplicationId: string; actor: DiscordBotApi };
  try {
    const snapshotPath = flag(flags, 'snapshot', true)!;
    const actor = await actorPreflight(context);
    const current = await context.guildConfig.capture();
    const accepted = acceptedSnapshot(snapshotPath, current);
    const evidence = {
      version: 1,
      kind: 'two-staging-anti-nuke-preflight',
      generatedAt: new Date().toISOString(),
      runId: context.runId,
      classification: 'read_only_preflight',
      target: {
        requiredSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
        checkoutSha: context.targetSha,
        checkoutClean: true,
        deployedSha: context.deployedSha,
        deployedShaSource: context.deployedShaSource,
        driverSha: context.driverSha,
      },
      fences: {
        guildId: context.guildId,
        owenApplicationId: STAGING_BOT_APPLICATION_ID,
        actorApplicationId: context.actorApplicationId,
        liveGuildContacted: false,
        maxRoleDeletes: ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES,
        e2eAdvisoryLock: true,
        databaseFingerprint: context.databaseFingerprint,
      },
      actor,
      acceptedSnapshotHash: accepted.hash,
      currentSnapshotHash: configHash(canonicalSnapshot(current)),
      rowCounts: await tableCounts(context.db, context.guildId, context.actorApplicationId),
      fullVerifierConfig: context.verifierConfig,
      prerequisites: {
        antiNukeRuntimeExpected: 'TWO_ANTI_NUKE=1; TWO_ANTI_NUKE_DRY_RUN must match the drive expectation; accepted snapshot path configured',
        joinActor: 'one manually-operated human-owned disposable account; no token sharing or user-account automation',
        generalAuditEvidence: 'seven operational audit kinds, one sink-tamper row, one successful moderation mutation, and Discord marker reconciliation after TWO_AUDIT_ACCEPTANCE_SINCE',
      },
      discordWrites: [],
    };
    const output = flag(flags, 'output');
    if (output) atomicJson(output, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    if (!context.verifierConfig.ready) process.exitCode = 1;
  } finally {
    await context.db.close();
  }
}

async function createRole(api: DiscordBotApi, name: string, permissions: string, reason: string): Promise<DiscordRole> {
  const role = await api.write<DiscordRole>('POST', `/guilds/${TWO_STAGING_GUILD_ID}/roles`, {
    name,
    permissions,
    color: 0,
    hoist: false,
    mentionable: false,
  }, reason, [200]);
  if (!role?.id) throw new Error(`Discord did not return the created role ${name}.`);
  return role;
}

async function updateManifest(path: string, manifest: Manifest): Promise<void> {
  atomicJson(path, manifest);
}

async function cleanupFixtures(api: DiscordBotApi, manifest: Manifest, manifestPath?: string): Promise<string[]> {
  const actions: string[] = [];
  const recoveredRoleIds: string[] = [];
  const roles = await api.read<DiscordRole[]>(`/guilds/${manifest.guildId}/roles`);
  const byId = new Map(roles.map((role) => [role.id, role]));
  const startedAt = Date.parse(manifest.createdAt);
  const expected = [
    { kind: 'capability', name: manifest.names.capability, recordedId: manifest.roleIds.capability },
    ...manifest.names.targets.map((name, index) => ({
      kind: `target-${index + 1}`,
      name,
      recordedId: manifest.roleIds.targets[index] ?? null,
    })),
  ];
  const cleanupRoles: Array<{ kind: string; id: string; name: string }> = [];

  for (const fixture of expected) {
    if (fixture.recordedId) {
      const role = byId.get(fixture.recordedId);
      if (role && role.name !== fixture.name) {
        throw new Error(`Refusing cleanup: role ${fixture.recordedId} is now named "${role.name}", expected run fixture "${fixture.name}".`);
      }
      cleanupRoles.push({ kind: fixture.kind, id: fixture.recordedId, name: fixture.name });
      continue;
    }

    // A process kill can land after Discord creates a role but before its ID is
    // fsynced into the manifest. Recover only an exact expected name whose
    // snowflake proves it was created during this run; never search by prefix.
    const matches = roles.filter((role) =>
      role.name === fixture.name
      && discordSnowflakeTimestamp(role.id) >= startedAt - 5_000);
    if (matches.length > 1) throw new Error(`Refusing cleanup: multiple post-start roles are named "${fixture.name}".`);
    if (matches.length === 1) {
      recoveredRoleIds.push(matches[0].id);
      cleanupRoles.push({ kind: fixture.kind, id: matches[0].id, name: fixture.name });
      actions.push(`recovered unpersisted fixture role ${matches[0].id} by exact name and post-start snowflake`);
    }
  }

  const capability = cleanupRoles.find((role) => role.kind === 'capability');
  if (capability) {
    await api.write<null>(
      'DELETE',
      `/guilds/${manifest.guildId}/members/${manifest.actorApplicationId}/roles/${capability.id}`,
      undefined,
      `TOG-3787 ${manifest.runId} cleanup remove capability`,
      [204, 404],
    );
    actions.push(`removed capability role ${capability.id} from actor or it was already absent`);
  }
  for (const fixture of cleanupRoles) {
    await api.write<null>(
      'DELETE',
      `/guilds/${manifest.guildId}/roles/${fixture.id}`,
      undefined,
      `TOG-3787 ${manifest.runId} cleanup delete fixture role`,
      [204, 404],
    );
    actions.push(`deleted fixture role ${fixture.id} or it was already absent`);
  }
  manifest.discordWrites = [...new Set([...manifest.discordWrites, ...api.writes])];
  manifest.cleanup = { completedAt: new Date().toISOString(), actions, recoveredRoleIds };
  if (manifestPath) await updateManifest(manifestPath, manifest);
  return actions;
}

async function readRunRows(context: CommonContext & { actorApplicationId: string }, startedAt: string): Promise<{
  containmentRows: ContainmentEvidenceRow[];
  incidents: ContainmentIncidentEvidence[];
}> {
  const containmentRows = await context.db.prepare(
    `SELECT audit_entry_id, executor_id, action, target_id, weight, occurred_at, state, reason
       FROM containment_events
      WHERE guild_id = ? AND executor_id = ? AND created_at >= ?
      ORDER BY occurred_at, audit_entry_id`,
  ).all<ContainmentEvidenceRow>(context.guildId, context.actorApplicationId, startedAt);
  const incidents = await context.db.prepare(
    `SELECT trigger_audit_entry_id, executor_id, heat, state, result_json
       FROM containment_incidents
      WHERE guild_id = ? AND executor_id = ? AND started_at >= ?
      ORDER BY started_at, id`,
  ).all<ContainmentIncidentEvidence>(context.guildId, context.actorApplicationId, startedAt);
  return { containmentRows, incidents };
}

export type DriveContext = CommonContext & { actorApplicationId: string; actor: DiscordBotApi };

export async function runDrive(
  flags: Map<string, string | true>,
  createContext: () => Promise<DriveContext> = async () => await commonContext(true) as DriveContext,
): Promise<void> {
  if (flags.get('apply') !== true) throw new Error('drive is write-capable and requires --apply. Default preflight is read-only.');
  const expected = flag(flags, 'expect', true);
  if (expected !== 'dry_run' && expected !== 'contained') throw new Error('--expect must be dry_run or contained.');
  const outputPath = flag(flags, 'output', true)!;
  const manifestPath = flag(flags, 'manifest', true)!;
  const snapshotPath = flag(flags, 'snapshot', true)!;
  const context = await createContext();
  const startedAt = new Date().toISOString();
  const names = fixtureRoleNames(context.runId);
  const manifest: Manifest = {
    version: 1,
    runId: context.runId,
    createdAt: startedAt,
    targetSha: context.targetSha,
    guildId: context.guildId,
    actorApplicationId: context.actorApplicationId,
    expectedIncidentState: expected,
    names,
    roleIds: { capability: null, targets: [] },
    capabilityAssigned: false,
    discordWrites: [],
  };
  await updateManifest(manifestPath, manifest);

  let before: GuildConfigSnapshot | null = null;
  let acceptedHash = '';
  let driveError: unknown = null;
  let gatewayEvidence: ReturnType<typeof evaluateGatewayEvidence> | null = null;
  let selectedAuditEntries: DiscordAuditEntry[] = [];
  let runRows: Awaited<ReturnType<typeof readRunRows>> = { containmentRows: [], incidents: [] };
  let countsBefore: Record<string, number> | null = null;
  let fixtureCreationAttempted = false;
  try {
    countsBefore = await tableCounts(context.db, context.guildId, context.actorApplicationId);
    if (!context.verifierConfig.ready) {
      throw new Error(`Full staging verifier inputs are incomplete: ${context.verifierConfig.missing.join(', ')}.`);
    }
    const actor = await actorPreflight(context);
    before = await context.guildConfig.capture();
    acceptedHash = acceptedSnapshot(snapshotPath, before).hash;
    const fixtureNameSet = new Set([names.capability, ...names.targets]);
    const existingFixtures = before.roles.filter((role) => fixtureNameSet.has(role.name));
    if (existingFixtures.length > 0) {
      throw new Error(`Run-specific fixture name already exists: ${existingFixtures.map((role) => role.name).join(', ')}.`);
    }

    for (const name of names.targets) {
      // A lost response may leave a role without a persisted ID. Enable recovery
      // before awaiting creation, but never on a pre-mutation validation failure.
      fixtureCreationAttempted = true;
      const role = await createRole(context.owen, name, '0', `TOG-3787 ${context.runId} create delete fixture`);
      manifest.roleIds.targets.push(role.id);
      manifest.discordWrites = [...context.owen.writes, ...context.actor.writes];
      await updateManifest(manifestPath, manifest);
    }
    const capability = await createRole(
      context.owen,
      names.capability,
      MANAGE_ROLES_PERMISSION.toString(),
      `TOG-3787 ${context.runId} create actor capability`,
    );
    manifest.roleIds.capability = capability.id;
    manifest.discordWrites = [...context.owen.writes, ...context.actor.writes];
    await updateManifest(manifestPath, manifest);

    const rolesBeforePosition = await context.owen.read<DiscordRole[]>(`/guilds/${context.guildId}/roles`);
    const targetPositions = rolesBeforePosition.filter((role) => manifest.roleIds.targets.includes(role.id)).map((role) => role.position);
    const requestedPosition = Math.max(...targetPositions, 0) + 1;
    await context.owen.write<DiscordRole[]>(
      'PATCH',
      `/guilds/${context.guildId}/roles`,
      [{ id: capability.id, position: requestedPosition }],
      `TOG-3787 ${context.runId} position actor capability`,
      [200],
    );
    const positioned = await context.owen.read<DiscordRole[]>(`/guilds/${context.guildId}/roles`);
    const capabilityAfter = positioned.find((role) => role.id === capability.id);
    const targetsAfter = positioned.filter((role) => manifest.roleIds.targets.includes(role.id));
    if (!capabilityAfter || targetsAfter.length !== ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES) throw new Error('Fixture roles disappeared during setup.');
    if (targetsAfter.some((role) => role.position >= capabilityAfter.position)) throw new Error('Actor capability role is not above both delete fixtures.');
    if (capabilityAfter.position >= actor.owenRolePosition) throw new Error('Fixture capability role is not below Owen; containment would refuse hierarchy.');

    await context.owen.write<null>(
      'PUT',
      `/guilds/${context.guildId}/members/${context.actorApplicationId}/roles/${capability.id}`,
      undefined,
      `TOG-3787 ${context.runId} grant bounded actor capability`,
      [204],
    );
    manifest.capabilityAssigned = true;
    manifest.discordWrites = [...context.owen.writes, ...context.actor.writes];
    await updateManifest(manifestPath, manifest);

    for (const [index, roleId] of manifest.roleIds.targets.entries()) {
      await context.actor.write<null>(
        'DELETE',
        `/guilds/${context.guildId}/roles/${roleId}`,
        undefined,
        `TOG-3787 ${context.runId} fixture ${index + 1}/${ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES}`,
        [204],
      );
      if (index + 1 < manifest.roleIds.targets.length) await sleep(250);
    }
    manifest.discordWrites = [...context.owen.writes, ...context.actor.writes];
    await updateManifest(manifestPath, manifest);

    for (let attempt = 0; attempt < MAX_GATEWAY_POLLS; attempt++) {
      const audit = await context.owen.read<{ audit_log_entries: DiscordAuditEntry[] }>(
        `/guilds/${context.guildId}/audit-logs?action_type=${ROLE_DELETE_AUDIT_ACTION}&limit=100`,
      );
      selectedAuditEntries = selectFixtureAuditEntries({
        entries: audit.audit_log_entries ?? [],
        actorApplicationId: context.actorApplicationId,
        targetRoleIds: manifest.roleIds.targets,
        runId: context.runId,
        startedAt,
      });
      runRows = await readRunRows(context, startedAt);
      gatewayEvidence = evaluateGatewayEvidence({
        actorApplicationId: context.actorApplicationId,
        targetRoleIds: manifest.roleIds.targets,
        auditEntries: selectedAuditEntries,
        containmentRows: runRows.containmentRows,
        incidents: runRows.incidents,
        expectedIncidentState: expected,
        capabilityRoleId: capability.id,
      });
      if (gatewayEvidence.ok) break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (!gatewayEvidence?.ok) throw new Error(`Gateway evidence did not converge: ${gatewayEvidence?.errors.join('; ') ?? 'no verdict'}`);
  } catch (error) {
    driveError = error;
  } finally {
    let cleanupActions: string[] = [];
    let cleanupError: unknown = null;
    try {
      if (fixtureCreationAttempted) {
        cleanupActions = await cleanupFixtures(context.owen, manifest, manifestPath);
      }
    } catch (error) {
      cleanupError = error;
    }

    let after: GuildConfigSnapshot | null = null;
    let postHash: string | null = null;
    let restoreOperations: number | null = null;
    try {
      after = await context.guildConfig.capture();
      postHash = configHash(canonicalSnapshot(after));
      if (before) restoreOperations = planRestore(before, after).counts.operations;
    } catch (error) {
      cleanupError ??= error;
    }
    let countsAfter: Record<string, number> | null = null;
    let evidenceCollectionError: unknown = null;
    try {
      countsAfter = await tableCounts(context.db, context.guildId, context.actorApplicationId);
    } catch (error) {
      evidenceCollectionError = error;
    }
    const preHash = before ? configHash(canonicalSnapshot(before)) : null;
    const semanticRestored = preHash !== null && postHash === preHash && restoreOperations === 0;
    const success = !driveError
      && !cleanupError
      && !evidenceCollectionError
      && gatewayEvidence?.ok === true
      && semanticRestored;
    const evidence = {
      version: 1,
      kind: 'two-staging-anti-nuke-gateway-acceptance',
      generatedAt: new Date().toISOString(),
      runId: context.runId,
      classification: success ? 'real_gateway_audit_receipt' : 'unproven',
      success,
      target: {
        requiredSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
        checkoutSha: context.targetSha,
        deployedSha: context.deployedSha,
        deployedShaSource: context.deployedShaSource,
        driverSha: context.driverSha,
      },
      fences: {
        guildId: context.guildId,
        owenApplicationId: STAGING_BOT_APPLICATION_ID,
        actorApplicationId: context.actorApplicationId,
        liveGuildContacted: false,
        destructiveScenarioCount: manifest.roleIds.targets.length,
        maxDestructiveScenarioCount: ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES,
        e2eAdvisoryLock: true,
        databaseFingerprint: context.databaseFingerprint,
      },
      expectation: expected,
      startedAt,
      acceptedSnapshotHash: acceptedHash || null,
      preSemanticHash: preHash,
      postSemanticHash: postHash,
      semanticRestored,
      restoreOperations,
      rowCounts: { before: countsBefore, after: countsAfter },
      fixtures: manifest,
      discordAuditEntries: selectedAuditEntries,
      containmentRows: runRows.containmentRows,
      incidents: runRows.incidents,
      gatewayVerdict: gatewayEvidence,
      cleanup: { actions: cleanupActions, error: cleanupError instanceof Error ? cleanupError.message : cleanupError ? String(cleanupError) : null },
      error: driveError instanceof Error ? driveError.message : driveError ? String(driveError) : null,
      evidenceCollectionError: evidenceCollectionError instanceof Error
        ? evidenceCollectionError.message
        : evidenceCollectionError
          ? String(evidenceCollectionError)
          : null,
      provenance: {
        driverDatabaseWrites: 0,
        limitation: 'Correlation proves matching Discord audit and durable rows; operator custody of the staging database and deployment evidence remains part of the acceptance chain.',
      },
      fullVerifierConfig: context.verifierConfig,
    };
    try {
      atomicJson(outputPath, evidence);
      console.log(JSON.stringify(evidence, null, 2));
    } finally {
      await context.db.close();
    }
    if (!evidence.success) process.exitCode = 1;
  }
}

function readManifest(path: string): Manifest {
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8')) as Manifest;
  if (manifest.version !== 1 || manifest.guildId !== TWO_STAGING_GUILD_ID || manifest.targetSha !== ANTI_NUKE_ACCEPTANCE_TARGET_SHA) {
    throw new Error('Manifest is not a TOG-3787 exact-target TWO Staging manifest.');
  }
  validateAcceptanceRunId(manifest.runId);
  validateSnowflake(manifest.actorApplicationId, 'manifest actorApplicationId');
  if (manifest.roleIds.capability) validateSnowflake(manifest.roleIds.capability, 'manifest capability role');
  for (const roleId of manifest.roleIds.targets) validateSnowflake(roleId, 'manifest target role');
  const names = fixtureRoleNames(manifest.runId);
  if (JSON.stringify(names) !== JSON.stringify(manifest.names)) throw new Error('Manifest fixture names do not match its run id.');
  return manifest;
}

async function runCleanup(flags: Map<string, string | true>): Promise<void> {
  const manifestPath = flag(flags, 'manifest', true)!;
  const manifest = readManifest(manifestPath);
  if (requiredEnv('TWO_ACCEPTANCE_RUN_ID') !== manifest.runId) throw new Error('TWO_ACCEPTANCE_RUN_ID does not match the cleanup manifest.');
  const context = await commonContext(false);
  try {
    const actions = await cleanupFixtures(context.owen, manifest, manifestPath);
    const evidence = {
      version: 1,
      kind: 'two-staging-anti-nuke-cleanup',
      generatedAt: new Date().toISOString(),
      runId: manifest.runId,
      guildId: manifest.guildId,
      actions,
      discordWrites: context.owen.writes,
    };
    const output = flag(flags, 'output');
    if (output) atomicJson(output, evidence);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await context.db.close();
  }
}

async function runVerifyJoin(flags: Map<string, string | true>): Promise<void> {
  const memberId = validateSnowflake(flag(flags, 'member-id', true)!, '--member-id');
  const since = flag(flags, 'since', true)!;
  if (!Number.isFinite(Date.parse(since))) throw new Error('--since must be an ISO timestamp.');
  const expectedBulkWindow = booleanFlag(flags, 'expect-bulk-window');
  const expectedFlagged = booleanFlag(flags, 'expect-flagged');
  if (expectedBulkWindow === undefined || expectedFlagged === undefined) {
    throw new Error('verify-join requires --expect-bulk-window and --expect-flagged so the scenario cannot be relabeled after observation.');
  }
  const outputPath = flag(flags, 'output', true)!;
  const context = await commonContext(false);
  try {
    const member = await context.owen.read<DiscordMember>(`/guilds/${context.guildId}/members/${memberId}`);
    const discordMember = {
      id: member.user?.id ?? '',
      bot: member.user?.bot === true,
      joined_at: member.joined_at ?? '',
      roles: member.roles ?? [],
    };
    const eventRows = await context.db.prepare(
      `SELECT member_id, occurred_at, source FROM events
        WHERE guild_id = ? AND member_id = ? AND event_type = 'member_join' AND occurred_at >= ?
        ORDER BY occurred_at`,
    ).all<JoinEventEvidence>(context.guildId, memberId, since);
    const riskRows = await context.db.prepare(
      `SELECT event_id, member_id, joined_at, source, score, reasons_json, bulk_join_window, flagged
         FROM join_risk_flags
        WHERE guild_id = ? AND member_id = ? AND joined_at >= ?
        ORDER BY joined_at`,
    ).all<JoinRiskEvidence>(context.guildId, memberId, since);
    const verdict = evaluateJoinGatewayEvidence({
      guildId: context.guildId,
      memberId,
      since,
      discordMember,
      eventRows,
      riskRows,
      expectedBulkWindow,
      expectedFlagged,
    });
    const evidence = {
      version: 1,
      kind: 'two-staging-join-risk-gateway-observation',
      generatedAt: new Date().toISOString(),
      runId: context.runId,
      classification: verdict.ok ? 'real_gateway_join_correlated' : 'unproven',
      success: verdict.ok,
      target: {
        requiredSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
        checkoutSha: context.targetSha,
        deployedSha: context.deployedSha,
        deployedShaSource: context.deployedShaSource,
        driverSha: context.driverSha,
      },
      fences: {
        guildId: context.guildId,
        owenApplicationId: STAGING_BOT_APPLICATION_ID,
        memberId,
        liveGuildContacted: false,
        joinScenarioCount: 1,
        humanTokenAccepted: false,
        databaseFingerprint: context.databaseFingerprint,
      },
      lowerBound: since,
      expectation: { bulkJoinWindow: expectedBulkWindow, flagged: expectedFlagged },
      discordMember,
      eventRows,
      riskRows,
      verdict,
      discordWrites: [],
      provenance: {
        driverDatabaseWrites: 0,
        limitation: 'Correlation proves matching Discord membership and durable rows; operator custody of the staging database and deployment evidence remains part of the acceptance chain.',
      },
    };
    atomicJson(outputPath, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    if (!verdict.ok) process.exitCode = 1;
  } finally {
    await context.db.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, flags } = parseArgs(argv);
  if (command === 'preflight') await runPreflight(flags);
  else if (command === 'drive') await runDrive(flags);
  else if (command === 'cleanup') await runCleanup(flags);
  else await runVerifyJoin(flags);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`staging-anti-nuke-acceptance: ${message}`);
    process.exitCode = 1;
  });
}
