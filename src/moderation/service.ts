import { createHash } from 'node:crypto';
import { log } from '../core/log.ts';
import { ActionError } from '../internal/errors.ts';
import type { ModerationDiscordClient } from './discord.ts';
import {
  assertModerationAllowed,
  moderationTargetProtection,
  type ModerationTargetProtectionReason,
} from './policy.ts';
import type { ModerationStore } from './store.ts';
import type { AuditSink } from '../audit/service.ts';
import {
  moderationAuditEntryId,
  moderationAuditReason,
  moderationAuditToken,
} from '../audit/moderationIdentity.ts';
import type { ModerationPolicy, ModerationRequest, ModerationResult, ModerationTarget } from './types.ts';

const MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;
const MAX_PURGE = 100;
const MAX_SLOWMODE_SECONDS = 6 * 60 * 60;
/** PermissionFlagsBits.SendMessages. */
const SEND_MESSAGES_BIT = 2048n;

export interface ModerationExecution extends ModerationRequest {
  requestId: string;
  idempotencyKey: string;
}

export class ModerationService {
  private discord: ModerationDiscordClient;
  private store: ModerationStore;
  private policy: ModerationPolicy;
  private now: () => number;
  private audit: AuditSink | null;

  constructor(
    discord: ModerationDiscordClient,
    store: ModerationStore,
    policy: ModerationPolicy,
    now: () => number = Date.now,
    audit: AuditSink | null = null,
  ) {
    this.discord = discord;
    this.store = store;
    this.policy = policy;
    this.now = now;
    this.audit = audit;
  }

  /**
   * Ask, without executing anything, whether this service's policy protects a
   * target from moderation outright.
   *
   * Automod calls this before deleting a message (TOG-3092) so the owner/staff
   * guard runs *ahead* of the mutation instead of after it. Reading the policy
   * off this service - rather than handing automod its own copy - is what keeps
   * the pre-check and the sanction that follows it judging by the same rules.
   */
  targetProtection(target: ModerationTarget): ModerationTargetProtectionReason | undefined {
    return moderationTargetProtection(target, this.policy);
  }

  /**
   * Execute one moderation verb, exactly once per idempotency key.
   *
   * The durable row is the owner and the recovery record. Once a request has
   * reached Discord we never delete it or take it over on a timer: neither a
   * timeout nor a process death can prove that Discord made no change. A retry
   * therefore either replays a stored result or gets `in_progress`; an operator
   * may reconcile an abandoned row, but the bot will not guess and duplicate a
   * destructive action.
   */
  async execute(request: ModerationExecution): Promise<ModerationResult> {
    try {
      validateRequest(request, this.policy);
    } catch (err) {
      await this.recordRefusal(request, err);
      throw err;
    }
    if (request.action === 'moderation.tempban') {
      return this.store.serializeMember(request.guildId, request.target!.userId, () => this.executeClaimed(request));
    }
    if (request.action === 'moderation.lockdown' || request.action === 'moderation.unlock') {
      return this.store.serializeChannel(request.channel!.channelId, () => this.executeClaimed(request));
    }
    return this.executeClaimed(request);
  }

  private async recordRefusal(request: ModerationExecution, err: unknown): Promise<void> {
    if (!(err instanceof ActionError)) return;
    await this.audit?.record({
      entryId: `moderation-refusal:${request.guildId}:${request.idempotencyKey}`,
      kind: 'moderation_action',
      channel: 'moderation',
      guildId: request.guildId,
      occurredAt: new Date(this.now()).toISOString(),
      actorId: request.actor.userId,
      targetId: request.target?.userId ?? null,
      sourceChannelId: request.channel?.channelId ?? null,
      action: request.action,
      metadata: { outcome: 'refused', code: err.code, classification: err.logReason },
    }).catch(() => {
      log.error('moderation_refusal_audit_failed', {
        entryId: `moderation-refusal:${request.guildId}:${request.idempotencyKey}`,
        classification: 'audit_record_failed',
      });
    });
  }

  private async executeClaimed(request: ModerationExecution): Promise<ModerationResult> {
    const claim = await this.store.claim(
      request.guildId,
      request.idempotencyKey,
      request.action,
      hashOf(request),
    );
    if (claim.state === 'replayed') {
      const result = storedResult(claim.stored);
      await this.recordSuccess(request, result);
      return result;
    }
    if (claim.state === 'in_flight') {
      throw new ActionError('in_progress', 'An earlier attempt at this moderation action has an uncertain outcome', {
        logReason: 'moderation_idempotent_in_flight',
      });
    }
    if (claim.state === 'mismatch') {
      throw new ActionError('malformed', 'This idempotency key was used for a different moderation request', {
        logReason: 'moderation_idempotency_key_reused',
      });
    }

    let result: ModerationResult;
    try {
      result = await this.carryOut(request);
    } catch (err) {
      if (isSafePreMutationFailure(err)) {
        await this.store.release(request.guildId, request.idempotencyKey).catch(() => undefined);
      }
      throw err;
    }

    await this.store.complete(request.guildId, request.idempotencyKey, {
      outcome: result.outcome,
      result: { outcome: result.outcome, affected: result.affected ?? null },
    });
    await this.recordSuccess(request, result);
    return result;
  }

  private async recordSuccess(request: ModerationExecution, result: ModerationResult): Promise<void> {
    const token = moderationAuditToken(request.guildId, request.idempotencyKey);
    await this.audit?.record({
      entryId: moderationAuditEntryId(request.guildId, token),
      kind: 'moderation_action',
      channel: 'moderation',
      guildId: request.guildId,
      occurredAt: new Date(this.now()).toISOString(),
      actorId: request.actor.userId,
      targetId: request.target?.userId ?? null,
      sourceChannelId: request.channel?.channelId ?? null,
      action: request.action,
      metadata: {
        origin: 'moderation_service',
        outcome: result.outcome,
        durationSeconds: request.durationSeconds,
        count: request.count,
        seconds: request.seconds,
        affected: result.affected,
      },
    }).catch(() => {
      log.error('moderation_operational_audit_failed', {
        entryId: moderationAuditEntryId(request.guildId, token),
        classification: 'audit_record_failed',
      });
    });
  }

  private auditReason(request: ModerationExecution): string {
    return moderationAuditReason(
      this.policy.moderationAuditSecret ?? null,
      request.guildId,
      request.idempotencyKey,
      request.action,
      request.actor.userId,
      request.reason,
    );
  }

  private async carryOut(request: ModerationExecution): Promise<ModerationResult> {
    const targetId = request.target?.userId;
    const channelId = request.channel?.channelId;
    let result: ModerationResult;

    switch (request.action) {
      case 'moderation.ban':
        await this.discord.ban(request.guildId, targetId!, this.auditReason(request));
        result = { outcome: 'banned' };
        break;
      case 'moderation.tempban': {
        const seconds = Number(request.durationSeconds);
        // Stage the expiry BEFORE the ban. It is not active until Discord
        // accepts the ban; a crash after that point is recovered by activating
        // staged rows at the next sweep, while a definite rejection can cancel
        // this exact row without changing an existing tempban.
        await this.store.stageUnban(
          request.guildId,
          targetId!,
          new Date(this.now() + seconds * 1000).toISOString(),
          `Temporary ban expired: ${request.reason}`,
          request.requestId,
        );
        try {
          await this.discord.ban(request.guildId, targetId!, this.auditReason(request));
        } catch (err) {
          if (isSafePreMutationFailure(err)) await this.store.cancelStagedUnban(request.requestId);
          throw err;
        }
        await this.store.activateStagedUnban(request.guildId, targetId!, request.requestId);
        result = { outcome: 'temporarily_banned' };
        break;
      }
      case 'moderation.kick':
        await this.discord.kick(request.guildId, targetId!, this.auditReason(request));
        result = { outcome: 'kicked' };
        break;
      case 'moderation.timeout': {
        const seconds = Number(request.durationSeconds);
        const until = new Date(this.now() + seconds * 1000).toISOString();
        await this.discord.timeout(request.guildId, targetId!, until, this.auditReason(request));
        result = { outcome: 'timed_out' };
        break;
      }
      case 'moderation.warn':
        await this.store.addWarning(request.guildId, targetId!, request.actor.userId, request.reason, request.requestId);
        result = { outcome: 'warned' };
        break;
      case 'moderation.purge': {
        const count = Number(request.count);
        const affected = await this.discord.purge(channelId!, count, this.auditReason(request));
        result = { outcome: 'purged', affected };
        break;
      }
      case 'moderation.slowmode': {
        const seconds = Number(request.seconds);
        await this.discord.setSlowmode(channelId!, seconds, this.auditReason(request));
        result = { outcome: 'slowmode_updated' };
        break;
      }
      case 'moderation.lockdown':
        result = { outcome: await this.lockChannel(channelId!, request) };
        break;
      case 'moderation.unlock':
        result = { outcome: await this.unlockChannel(channelId!, request) };
        break;
    }

    await this.store.recordAudit({
      requestId: request.requestId,
      guildId: request.guildId,
      actorId: request.actor.userId,
      action: request.action,
      targetId,
      channelId,
      reason: request.reason,
      outcome: result.outcome,
      idempotencyKey: request.idempotencyKey,
      metadata: {
        duration_seconds: request.durationSeconds,
        count: request.count,
        seconds: request.seconds,
        affected: result.affected,
      },
    }).catch((err: unknown) => {
      // Discord already accepted the action. Audit loss is serious and logged,
      // but returning a retryable error would invite a duplicate mutation.
      log.error('moderation_audit_failed', { requestId: request.requestId, err: String(err) });
    });
    return result;
  }

  /**
   * Lock a channel while preserving every other bit of the @everyone
   * overwrite (TOG-1659 High 1). `recordLockdown` is insert-only: a repeated
   * lockdown may refresh the reason, but it cannot replace the original
   * pre-lock masks with the already-locked masks.
   */
  private async lockChannel(channelId: string, request: ModerationExecution): Promise<string> {
    const existing = await this.store.getLockdown(channelId);
    const current = await this.discord.getEveryoneOverwrite(channelId, request.guildId);
    const prior = current ?? { allow: '0', deny: '0' };
    await this.store.recordLockdown({
      channelId,
      guildId: request.guildId,
      priorAllow: prior.allow,
      priorDeny: prior.deny,
      priorExists: current !== null,
      reason: request.reason,
    });
    // Preserve unrelated permission edits made while the channel is locked.
    // The durable record is only for the eventual unlock.
    const denied = setBit(prior.deny, SEND_MESSAGES_BIT);
    const allowed = clearBit(prior.allow, SEND_MESSAGES_BIT);
    try {
      await this.discord.putEveryoneOverwrite(channelId, request.guildId, { allow: allowed, deny: denied }, this.auditReason(request));
    } catch (err) {
      if (!existing && isSafePreMutationFailure(err)) {
        await this.store.clearLockdown(channelId).catch(() => undefined);
      }
      throw err;
    }
    return 'locked_down';
  }

  /**
   * Restore the @everyone overwrite recorded at lockdown time. The recovery row
   * is deleted only after Discord accepts the restore, so a failed PUT remains
   * retryable without losing the original masks.
   */
  private async unlockChannel(channelId: string, request: ModerationExecution): Promise<string> {
    const recorded = await this.store.getLockdown(channelId);
    if (recorded) {
      if (recorded.priorExists) {
        await this.discord.putEveryoneOverwrite(
          channelId,
          request.guildId,
          { allow: recorded.priorAllow, deny: recorded.priorDeny },
          this.auditReason(request),
        );
      } else {
        await this.discord.deleteEveryoneOverwrite(channelId, request.guildId, this.auditReason(request));
      }
      await this.store.clearLockdown(channelId);
      return 'unlocked';
    }
    const current = await this.discord.getEveryoneOverwrite(channelId, request.guildId);
    const prior = current ?? { allow: '0', deny: '0' };
    await this.discord.putEveryoneOverwrite(
      channelId,
      request.guildId,
      { allow: clearBit(prior.allow, SEND_MESSAGES_BIT), deny: clearBit(prior.deny, SEND_MESSAGES_BIT) },
      this.auditReason(request),
    );
    return 'unlocked';
  }

  /**
   * Fire every due scheduled unban. Rows are claimed atomically before any
   * Discord call (TOG-1659 High 4): two overlapping sweeps cannot process
   * the same job. A failed unban is requeued, so the next sweep retries it.
   */
  async runDueUnbans(): Promise<number> {
    const jobs = await this.store.claimDueUnbans();
    let completed = 0;
    let firstError: unknown;
    for (const job of jobs) {
      try {
        const token = moderationAuditToken(job.guildId, job.requestId);
        const acted = await this.store.serializeMember(job.guildId, job.userId, async () => {
          if (!await this.store.ownsUnbanClaim(job.requestId, job.claimToken)) return false;
          await this.discord.unban(
            job.guildId,
            job.userId,
            moderationAuditReason(
              this.policy.moderationAuditSecret ?? null,
              job.guildId,
              job.requestId,
              'moderation.unban_scheduled',
              this.policy.botUserId ?? this.policy.owenUserId,
              job.reason,
            ),
          );
          await this.store.completeUnban(job.requestId, job.claimToken);
          return true;
        });
        if (!acted) continue;
        await this.store.recordAudit({
          requestId: `${job.requestId}:unban`,
          guildId: job.guildId,
          actorId: this.policy.botUserId ?? this.policy.owenUserId,
          action: 'moderation.unban_scheduled',
          targetId: job.userId,
          reason: job.reason,
          outcome: 'unbanned',
          idempotencyKey: job.requestId,
        }).catch((err: unknown) => {
          log.error('moderation_unban_audit_failed', { requestId: job.requestId, err: String(err) });
        });
        await this.audit?.record({
          entryId: moderationAuditEntryId(job.guildId, token),
          kind: 'moderation_action',
          channel: 'moderation',
          guildId: job.guildId,
          occurredAt: new Date(this.now()).toISOString(),
          actorId: this.policy.botUserId ?? this.policy.owenUserId,
          targetId: job.userId,
          action: 'moderation.unban_scheduled',
          metadata: { origin: 'moderation_service', outcome: 'unbanned' },
        }).catch(() => {
          log.error('moderation_operational_audit_failed', {
            entryId: moderationAuditEntryId(job.guildId, token),
            classification: 'audit_record_failed',
          });
        });
        completed++;
      } catch (err) {
        if (isSafePreMutationFailure(err)) {
          await this.store.requeueUnban(job.requestId, job.claimToken).catch(() => undefined);
        }
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
    return completed;
  }
}

function storedResult(stored: { outcome: string; result: Record<string, unknown> }): ModerationResult {
  const affected = stored.result.affected;
  return {
    outcome: stored.outcome,
    ...(typeof affected === 'number' ? { affected } : {}),
    replayed: true,
  };
}

function validateRequest(request: ModerationExecution, policy: ModerationPolicy): void {
  assertModerationAllowed(request, policy);
  switch (request.action) {
    case 'moderation.tempban':
      integerBetween(request.durationSeconds, 60, 365 * 24 * 60 * 60, 'duration_seconds');
      break;
    case 'moderation.timeout':
      integerBetween(request.durationSeconds, 60, MAX_TIMEOUT_SECONDS, 'duration_seconds');
      break;
    case 'moderation.purge':
      integerBetween(request.count, 1, MAX_PURGE, 'count');
      break;
    case 'moderation.slowmode':
      integerBetween(request.seconds, 0, MAX_SLOWMODE_SECONDS, 'seconds');
      break;
  }
}

function isSafePreMutationFailure(error: unknown): boolean {
  return error instanceof ActionError && error.code === 'discord_rejected';
}

function setBit(mask: string, bit: bigint): string {
  return (BigInt(mask) | bit).toString();
}

function clearBit(mask: string, bit: bigint): string {
  return (BigInt(mask) & ~bit).toString();
}

/**
 * Binds an idempotency key to one request content. The action, target,
 * channel and the bounded numbers are what make the request what it is; the
 * reason is included so a key reused for "spam" then "harassment" against the
 * same target is named as the caller bug it is.
 */
function hashOf(request: ModerationExecution): string {
  const canonical = JSON.stringify({
    action: request.action,
    guildId: request.guildId,
    targetId: request.target?.userId ?? null,
    channelId: request.channel?.channelId ?? null,
    reason: request.reason,
    durationSeconds: request.durationSeconds ?? null,
    count: request.count ?? null,
    seconds: request.seconds ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function integerBetween(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ActionError('malformed', `"${field}" must be an integer between ${min} and ${max}`, {
      logReason: `bad_${field}`,
    });
  }
  return Number(value);
}
