import { AuditLogEvent, Events, type Client, type GuildAuditLogsEntry, type GuildMember } from 'discord.js';
import { log } from '../core/log.ts';
import { ActionError } from '../internal/errors.ts';
import type { GuildConfigSnapshot } from '../redesign/guildConfig.ts';
import { canonicalSnapshot, configHash } from '../redesign/guildConfig.ts';
import { planRestore } from '../redesign/guildConfigRestore.ts';
import type { ContainmentConfig } from './containmentConfig.ts';
import { QuarantineError, type ContainmentDiscordClient } from './containmentDiscord.ts';
import { ContainmentStore } from './containmentStore.ts';

export type DestructiveAction =
  | 'member.kick'
  | 'member.ban'
  | 'channel.delete'
  | 'role.delete'
  | 'webhook.create'
  | 'webhook.update'
  | 'webhook.delete';

const DESTRUCTIVE_ACTIONS = new Map<number, { action: DestructiveAction; weight: number }>([
  [AuditLogEvent.MemberKick, { action: 'member.kick', weight: 1 }],
  [AuditLogEvent.MemberBanAdd, { action: 'member.ban', weight: 1 }],
  [AuditLogEvent.ChannelDelete, { action: 'channel.delete', weight: 3 }],
  [AuditLogEvent.RoleDelete, { action: 'role.delete', weight: 3 }],
  [AuditLogEvent.WebhookCreate, { action: 'webhook.create', weight: 1 }],
  [AuditLogEvent.WebhookUpdate, { action: 'webhook.update', weight: 1 }],
  [AuditLogEvent.WebhookDelete, { action: 'webhook.delete', weight: 1 }],
]);

export interface DestructiveAuditEvent {
  auditEntryId: string;
  guildId: string;
  executorId: string | null;
  action: DestructiveAction;
  targetId: string | null;
  occurredAt: string;
  weight: number;
}

export interface RestoreAdvisor {
  advise(guildId: string): Promise<Record<string, unknown>>;
}

export interface ContainmentAlert {
  kind: 'containment';
  guildId: string;
  executorId: string | null;
  action: DestructiveAction;
  targetId: string | null;
  heat: number;
  threshold: number;
  outcome: string;
  removedRoleIds?: string[];
  restore?: Record<string, unknown>;
}

export type ContainmentAnnouncer = (alert: ContainmentAlert) => Promise<void>;

export class SnapshotRestoreAdvisor implements RestoreAdvisor {
  private snapshot: GuildConfigSnapshot;
  private capture: () => Promise<GuildConfigSnapshot>;

  constructor(snapshot: GuildConfigSnapshot, capture: () => Promise<GuildConfigSnapshot>) {
    this.snapshot = snapshot;
    this.capture = capture;
  }

  async advise(guildId: string): Promise<Record<string, unknown>> {
    if (this.snapshot.guildId !== guildId) {
      return { outcome: 'snapshot_guild_mismatch', snapshotGuildId: this.snapshot.guildId };
    }
    const current = await this.capture();
    const plan = planRestore(this.snapshot, current);
    return {
      outcome: plan.counts.operations === 0 ? 'no_restore_needed' : 'restore_required',
      operations: plan.counts.operations,
      counts: plan.counts,
      snapshotHash: configHash(canonicalSnapshot(this.snapshot)),
      currentHash: configHash(canonicalSnapshot(current)),
    };
  }
}

export class DestructiveContainment {
  private store: ContainmentStore;
  private discord: ContainmentDiscordClient;
  private config: ContainmentConfig;
  private announce: ContainmentAnnouncer;
  private restore: RestoreAdvisor | null;
  private now: () => number;

  constructor(options: {
    store: ContainmentStore;
    discord: ContainmentDiscordClient;
    config: ContainmentConfig;
    announce: ContainmentAnnouncer;
    restore?: RestoreAdvisor | null;
    now?: () => number;
  }) {
    this.store = options.store;
    this.discord = options.discord;
    this.config = options.config;
    this.announce = options.announce;
    this.restore = options.restore ?? null;
    this.now = options.now ?? Date.now;
  }

  async observe(event: DestructiveAuditEvent): Promise<void> {
    const occurredMs = Date.parse(event.occurredAt);
    const stale = !Number.isFinite(occurredMs) || this.now() - occurredMs > this.config.eventMaxAgeSeconds * 1000;
    const protectedExecutor = event.executorId === null
      || this.config.protectedUserIds.has(event.executorId)
      || this.config.trustedUserIds.has(event.executorId);
    const state = stale ? 'stale' : protectedExecutor ? 'ignored' : 'observe';
    const reason = stale
      ? 'audit entry is too old to trigger a fresh incident'
      : event.executorId === null
        ? 'audit entry has no executor; refusing to guess'
        : this.config.trustedUserIds.has(event.executorId)
          ? 'executor is explicitly trusted'
          : this.config.protectedUserIds.has(event.executorId)
            ? 'executor is protected from automatic containment'
            : 'counted toward destructive-action heat';
    const claim = await this.store.claimEvent({ ...event, state, reason }, this.config.windowSeconds);
    if (!claim.claimed || state !== 'observe' || !event.executorId) return;
    if (claim.heat < this.config.heatThreshold) return;
    const incident = await this.store.beginIncident(
      event.guildId,
      event.executorId,
      event.auditEntryId,
      claim.heat,
      this.config.windowSeconds,
    );
    if (!incident) return;

    const base = {
      kind: 'containment' as const,
      guildId: event.guildId,
      executorId: event.executorId,
      action: event.action,
      targetId: event.targetId,
      heat: claim.heat,
      threshold: this.config.heatThreshold,
    };
    if (this.config.dryRun) {
      const restore = await this.restore?.advise(event.guildId).catch((error: unknown) => ({ outcome: 'restore_check_failed', error: String(error) }));
      await this.store.completeIncident(event.auditEntryId, 'dry_run', { restore: restore ?? null });
      await this.announce({ ...base, outcome: 'dry_run', restore: restore ?? undefined });
      return;
    }

    try {
      const result = await this.discord.quarantine(
        event.guildId,
        event.executorId,
        `Owen anti-nuke containment: heat ${claim.heat}/${this.config.heatThreshold}; trigger ${event.auditEntryId}`,
      );
      const restore = await this.restore?.advise(event.guildId).catch((error: unknown) => ({ outcome: 'restore_check_failed', error: String(error) }));
      await this.store.completeIncident(event.auditEntryId, 'contained', { ...result, restore: restore ?? null });
      await this.announce({ ...base, outcome: 'contained', removedRoleIds: result.removedRoleIds, restore: restore ?? undefined });
    } catch (error) {
      const cause = error instanceof QuarantineError ? error.causeError : error;
      const removedRoleIds = error instanceof QuarantineError ? error.removedRoleIds : [];
      const uncertain = removedRoleIds.length > 0
        || (cause instanceof ActionError && ['rate_limited', 'discord_unavailable', 'upstream_timeout'].includes(cause.code));
      const outcome = uncertain ? 'uncertain' : 'refused';
      await this.store.completeIncident(event.auditEntryId, outcome, {
        error: cause instanceof Error ? cause.message : String(cause),
        removedRoleIds,
      });
      await this.announce({ ...base, outcome, removedRoleIds });
    }
  }
}

export function auditEvent(entry: GuildAuditLogsEntry, guildId: string): DestructiveAuditEvent | null {
  const destructive = DESTRUCTIVE_ACTIONS.get(Number(entry.action));
  if (!destructive) return null;
  return {
    auditEntryId: entry.id,
    guildId,
    executorId: entry.executorId ?? null,
    action: destructive.action,
    targetId: typeof entry.targetId === 'string' ? entry.targetId : null,
    occurredAt: new Date(entry.createdTimestamp).toISOString(),
    weight: destructive.weight,
  };
}

export function registerContainment(client: Client, containment: DestructiveContainment, guildId: string): void {
  client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    if (guild.id !== guildId) return;
    const normalized = auditEvent(entry, guild.id);
    if (!normalized) return;
    try {
      await containment.observe(normalized);
    } catch (error) {
      log.error('containment_event_failed', { guildId, auditEntryId: entry.id, err: String(error) });
    }
  });
}

export interface JoinRiskAlert {
  guildId: string;
  memberId: string;
  score: number;
  reasons: string[];
  bulkJoinWindow: boolean;
}

export class JoinRiskScorer {
  private store: ContainmentStore;
  private config: ContainmentConfig;
  private announce: (alert: JoinRiskAlert) => Promise<void>;
  private now: () => number;

  constructor(options: {
    store: ContainmentStore;
    config: ContainmentConfig;
    announce: (alert: JoinRiskAlert) => Promise<void>;
    now?: () => number;
  }) {
    this.store = options.store;
    this.config = options.config;
    this.announce = options.announce;
    this.now = options.now ?? Date.now;
  }

  async observe(member: Pick<GuildMember, 'id' | 'guild' | 'user' | 'joinedTimestamp'>, source = 'unknown'): Promise<void> {
    if (member.user.bot || member.guild.id !== this.config.guildId) return;
    const now = member.joinedTimestamp ?? this.now();
    const accountAgeMs = now - member.user.createdTimestamp;
    const accountReasons: string[] = [];
    let accountScore = 0;
    if (accountAgeMs < 24 * 60 * 60 * 1000) {
      accountScore = 3;
      accountReasons.push('account younger than 24 hours');
    } else if (accountAgeMs < 7 * 24 * 60 * 60 * 1000) {
      accountScore = 1;
      accountReasons.push('account younger than 7 days');
    }
    const bulkJoinWindow = Boolean(this.config.bulkJoinWindowUntil && Date.parse(this.config.bulkJoinWindowUntil) >= now);
    const joinedAt = new Date(now).toISOString();
    const result = await this.store.recordJoinRisk({
      eventId: `${member.guild.id}:${member.id}:${joinedAt}`,
      guildId: member.guild.id,
      memberId: member.id,
      accountCreatedAt: new Date(member.user.createdTimestamp).toISOString(),
      joinedAt,
      source,
      accountScore,
      accountReasons,
      bulkJoinWindow,
      windowSeconds: this.config.joinRiskWindowSeconds,
      joinThreshold: this.config.joinRiskThreshold,
    });
    if (result.persisted && result.flagged) {
      await this.announce({
        guildId: member.guild.id,
        memberId: member.id,
        score: result.score,
        reasons: result.reasons,
        bulkJoinWindow,
      });
    }
  }
}

