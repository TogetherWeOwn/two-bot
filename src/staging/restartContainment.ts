/**
 * Staging restart containment helpers (TOG-3903), not execution authorization.
 *
 * The opt-in preflight runs before storage opens. src/index.ts omits unrelated
 * writers/jobs, and the gateway dispatcher filters before attribution, audit,
 * or ordinary persistence. This funnel firewall is a second boundary. The
 * real rota observer/classifier and scheduler are retained; notice delivery
 * is stopped before its first sweep. No command or welcome write is exempt.
 *
 * Default-off preserves normal production behavior. These application gates
 * alone do NOT establish disposable-storage ownership, process exclusivity,
 * a sanitized launch environment, or a transport boundary. Those acceptance
 * prerequisites must be verified separately before actual staging execution.
 */

import { applicationIdFromToken, LIVE_GUILD_ID, STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from './spec.ts';
// TOG-9656: the storage gate shares the single test-host allowlist with the
// suite guard (scripts/test-db-guard.ts) — disposable means allowlisted, not
// loopback-only, so the sanctioned agent-testdb sandbox passes. Production and
// staging hosts stay refused. scripts/ is not imported anywhere else in src/;
// this pure, dependency-free policy module is the one exception, to keep the
// allowlist in exactly one place.
import { isAllowedTestDatabaseUrl } from '../../scripts/test-db-guard.ts';
import {
  FunnelHandlers,
  type GateClearedInput,
  type JoinInput,
  type MessageInput,
  type VoiceInput,
} from '../core/handlers.ts';
import type { EventStore } from '../store/eventStore.ts';
import type { LevelingService } from '../leveling/service.ts';
import type { CommunityFactStore } from '../analytics/communityFacts.ts';
import type { FunnelEvent } from '../core/events.ts';

/** Exact opt-in value. Anything else — including "true" — is inert. */
export const STAGING_RESTART_CONTAINMENT_FLAG = 'TWO_STAGING_RESTART_CONTAINMENT';

/** Isolation controls the preflight requires beyond the flag. */
export interface StagingRestartPreflightControls {
  discordToken: string;
  databaseUrl: string;
  stagingDatabaseUrl?: string | null;
  guildId?: string | null;
}

export interface StagingRestartPreflight {
  ok: boolean;
  /** Fail-closed reason when refusing. Never includes a secret. */
  reason?: string;
}

function dbTarget(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return null;
  }
}

function dbName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

/**
 * Refuse production guild/bot, malformed binding, missing isolation
 * controls, and unsafe credentials/storage — before any network or
 * datastore effect. Pure: reads its arguments, touches nothing.
 */
export function checkStagingRestartPreflight(
  env: NodeJS.ProcessEnv,
  controls: StagingRestartPreflightControls,
): StagingRestartPreflight {
  const refuse = (reason: string): StagingRestartPreflight => ({ ok: false, reason });
  if (env[STAGING_RESTART_CONTAINMENT_FLAG] !== '1') {
    return refuse(
      `${STAGING_RESTART_CONTAINMENT_FLAG} is not '1'. Staging restart containment is inert; ` +
        'refusing actual-staging execution.',
    );
  }
  const guildId = controls.guildId?.trim() ?? '';
  if (!/^\d{17,20}$/.test(guildId) || guildId === LIVE_GUILD_ID || guildId !== TWO_STAGING_GUILD_ID) {
    return refuse(
      'Staging restart containment requires DISCORD_GUILD_ID to be the TWO Staging guild ' +
        `(${TWO_STAGING_GUILD_ID}); got '${guildId || '(unset)'}'. Refusing to continue.`,
    );
  }
  const appId = applicationIdFromToken(controls.discordToken ?? '');
  if (appId !== STAGING_BOT_APPLICATION_ID) {
    return refuse(
      'Staging restart containment requires the staging bot token ' +
        `(${STAGING_BOT_APPLICATION_ID}); got application '${appId ?? 'unparseable'}'. ` +
        'Refusing to run. Nothing was contacted.',
    );
  }
  const stagingUrl = controls.stagingDatabaseUrl?.trim() ?? '';
  if (!stagingUrl) {
    return refuse('Staging restart containment requires TWO_STAGING_DATABASE_URL. Refusing to continue.');
  }
  try {
    const binding = new URL(stagingUrl);
    if (!['postgres:', 'postgresql:'].includes(binding.protocol) || !binding.hostname || binding.pathname.length < 2) {
      return refuse('Staging restart containment requires a valid staging database binding.');
    }
  } catch {
    return refuse('Staging restart containment requires a valid staging database binding.');
  }
  const url = controls.databaseUrl?.trim() ?? '';
  if (!/^postgres(ql)?:\/\//.test(url)) {
    return refuse('Staging restart containment requires a postgres TWO_DATABASE_URL. Refusing to continue.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('Staging restart containment could not parse TWO_DATABASE_URL. Refusing to continue.');
  }
  if (!isAllowedTestDatabaseUrl(url) || !parsed.port) {
    return refuse(
      'Staging restart containment requires a disposable isolated test database ' +
        '(agent-testdb, 127.0.0.1/localhost, or the CI "postgres" service, with an explicit port). ' +
        'Production and staging hosts are never valid. Refusing to continue.',
    );
  }
  if (parsed.search) {
    return refuse('Staging restart containment refuses connection-option injection. Refusing to continue.');
  }
  if (!/staging|test/i.test(dbName(url))) {
    return refuse(
      `Staging restart containment requires a staging/test database name; got '${dbName(url) || '(unparseable)'}'. ` +
        'Refusing to continue.',
    );
  }
  const liveTarget = dbTarget(stagingUrl);
  if (liveTarget && dbTarget(url) === liveTarget) {
    return refuse(
      'Staging restart containment refuses a database target matching TWO_STAGING_DATABASE_URL. ' +
        'Refusing to continue.',
    );
  }
  return { ok: true };
}

/**
 * Throw-friendly entrypoint for `src/index.ts`: throws the refusal reason
 * before the database opens. Never logs or returns a secret.
 */
export function assertStagingRestartPreflight(
  env: NodeJS.ProcessEnv,
  controls: StagingRestartPreflightControls,
): void {
  const verdict = checkStagingRestartPreflight(env, controls);
  if (!verdict.ok) throw new Error(verdict.reason);
}

/** Check the effective credentials loaded by the entrypoint, not a second env snapshot. */
export function stagingRestartContainmentArmed(
  env: NodeJS.ProcessEnv,
  controls: StagingRestartPreflightControls,
): boolean {
  return checkStagingRestartPreflight(env, controls).ok;
}

/**
 * Human-ingestion firewall for the funnel observation paths.
 *
 * Drops every gateway funnel write BEFORE ordinary handlers persist it,
 * except writes that identify a configured synthetic staging actor. Rota
 * observer dispatch is untouched — the observer keeps consuming gateway
 * input on its real per-subject chains, and staging actors still traverse
 * the unmodified classifier and `eligible()` checks downstream. Unknown
 * events/actors fail closed (dropped, never written, never relabeled).
 *
 * Includes leave events. onInviteClick belongs to the separate redirect
 * service, which this entrypoint never starts.
 */
export class StagingRestartFunnelFirewall extends FunnelHandlers {
  private syntheticActorIds: ReadonlySet<string>;

  constructor(
    store: EventStore,
    leveling: LevelingService | null,
    facts: CommunityFactStore | null,
    syntheticActorIds: ReadonlySet<string>,
  ) {
    super(store, leveling, facts);
    this.syntheticActorIds = syntheticActorIds;
  }

  private synthetic(guildId: string, memberId: string): boolean {
    return guildId === TWO_STAGING_GUILD_ID && this.syntheticActorIds.has(memberId);
  }

  override async onLeave(guildId: string, memberId: string, occurredAt?: string, opts: { isBot?: boolean } = {}): Promise<FunnelEvent | null> {
    if (!this.synthetic(guildId, memberId)) return null;
    return super.onLeave(guildId, memberId, occurredAt, opts);
  }

  override async onJoin(i: JoinInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.guildId, i.memberId)) return null;
    return super.onJoin(i);
  }

  override async onGateCleared(i: GateClearedInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.guildId, i.memberId)) return null;
    return super.onGateCleared(i);
  }

  override async onMessage(i: MessageInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.guildId, i.memberId)) return null;
    return super.onMessage(i);
  }

  override async onVoiceJoin(i: VoiceInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.guildId, i.memberId)) return null;
    return super.onVoiceJoin(i);
  }

  override async onVoiceLeave(i: VoiceInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.guildId, i.memberId)) return null;
    return super.onVoiceLeave(i);
  }
}

/**
 * Parse the explicit synthetic staging-actor allowlist. Empty/missing is a
 * valid closed firewall (drops everything); malformed ids are a hard error.
 */
export function parseSyntheticStagingActorIds(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') return new Set();
  const ids = raw.split(',').map((id) => id.trim()).filter((id) => id !== '');
  const seen = new Set<string>();
  for (const id of ids) {
    if (!/^\d{17,20}$/.test(id) || seen.has(id)) {
      throw new Error(`${STAGING_RESTART_CONTAINMENT_FLAG} synthetic actors must be comma-separated Discord user ids.`);
    }
    seen.add(id);
  }
  if (!seen.size) {
    throw new Error(`${STAGING_RESTART_CONTAINMENT_FLAG} synthetic actors must be comma-separated Discord user ids.`);
  }
  return seen;
}
