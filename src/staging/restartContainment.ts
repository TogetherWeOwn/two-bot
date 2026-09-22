/**
 * Fail-closed actual-staging rota restart containment (TOG-3903).
 *
 * A staging-only, default-off gate for launching the REAL application
 * entrypoint (`src/index.ts`) against the actual staging gateway. When the
 * opt-in flag is absent or malformed the process refuses before any network
 * or datastore effect; when it is set the preflight runs before the
 * database is opened and returns fail-closed substitutions for every
 * unrelated Discord write path plus a human-ingestion firewall for the
 * funnel/rota observation paths.
 *
 * Normal production behavior is unchanged: the module defaults to inert and
 * touches nothing unless the exact `TWO_STAGING_RESTART_CONTAINMENT=1`
 * opt-in plus a staging token, staging database, and disposable loopback
 * database checks all pass.
 *
 * What this contains (all Discord mutations EXCEPT the single command
 * registry publication and the ordinary session welcome, which stay live
 * under the existing guards):
 *   - rota + audit notice sends: `RotaNoticeDelivery.stop()` and
 *     `options.dryRun` on the operational audit mirror, applied at
 *     construction sites in `src/index.ts` — never a production default.
 *   - command registry writes/deletes beyond the single publication: the
 *     automations disable sweep runs only through the registry's existing
 *     `beforeFirstSync` hook; containment does not add a writer.
 *   - role changes: session onboarding mode already suppresses leveling
 *     role writes and forbids armed anti-nuke (`src/index.ts:141-147`);
 *     containment refuses any other combination.
 *   - member-facing DMs and unrelated sends: callers pass the returned
 *     `dryRun`-equivalent flags (raid/containment announcers log only,
 *     session goodbye returns early) — no global dry-run redefinition.
 *   - real human/member ingestion: `FunnelHandlers` subclass drops every
 *     gateway funnel write BEFORE it persists, except writes that identify
 *     a configured synthetic staging actor; unknown events/actors fail
 *     closed. The rota observer chain is intact — containment never
 *     monkeypatches it away; the firewall sits downstream in
 *     `OnboardingRota` so staging actors still traverse the unmodified
 *     classifier and `eligible()` checks.
 */

import { applicationIdFromToken, LIVE_GUILD_ID, STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from './spec.ts';
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
  if (parsed.hostname !== '127.0.0.1' || !parsed.port) {
    return refuse(
      'Staging restart containment requires a disposable loopback database ' +
        '(127.0.0.1 with an explicit port). Refusing to continue.',
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

/** Whether the containment seam is armed in this process. */
export function stagingRestartContainmentArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return checkStagingRestartPreflight(env, {
    discordToken: env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN ?? '',
    databaseUrl: env.TWO_DATABASE_URL ?? '',
    stagingDatabaseUrl: env.TWO_STAGING_DATABASE_URL ?? '',
    guildId: env.DISCORD_GUILD_ID ?? '',
  }).ok;
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
 * Deliberately NOT a `FunnelHandlers` override of `onLeave`/`onInviteClick`:
 * the entrypoint has no `onLeave` call under containment (see
 * `containmentLeaveMode`), and `onInviteClick` is a redirect-service path,
 * not a gateway observation — leaving both unwired is the containment.
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

  private synthetic(memberId: string): boolean {
    return this.syntheticActorIds.has(memberId);
  }

  override async onJoin(i: JoinInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.memberId)) return null;
    return super.onJoin(i);
  }

  override async onGateCleared(i: GateClearedInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.memberId)) return null;
    return super.onGateCleared(i);
  }

  override async onMessage(i: MessageInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.memberId)) return null;
    return super.onMessage(i);
  }

  override async onVoiceJoin(i: VoiceInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.memberId)) return null;
    return super.onVoiceJoin(i);
  }

  override async onVoiceLeave(i: VoiceInput): Promise<FunnelEvent | null> {
    if (!this.synthetic(i.memberId)) return null;
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
