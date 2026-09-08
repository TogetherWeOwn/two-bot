import { createHash } from 'node:crypto';
import { ActionError } from '../internal/errors.ts';
import type { ModerationDiscordClient } from './discord.ts';
import { assertModerationAllowed } from './policy.ts';
import type { ModerationStore } from './store.ts';
import type { ModerationPolicy, ModerationRequest, ModerationResult } from './types.ts';

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

  constructor(
    discord: ModerationDiscordClient,
    store: ModerationStore,
    policy: ModerationPolicy,
    now: () => number = Date.now,
  ) {
    this.discord = discord;
    this.store = store;
    this.policy = policy;
    this.now = now;
  }

  /**
   * Execute one moderation verb, exactly once per idempotency key.
   *
   * The claim on moderation_idempotency is taken BEFORE any Discord mutation
   * and the result is written AFTER it (TOG-1659 High 3). Both entry paths -
   * slash commands and signed internal actions - land here, so there is one
   * at-most-once path for both. A crash between claim and result leaves an
   * in_flight row that a later attempt takes over once stale: at-most-once
   * inside a living process, a bounded window across a crash.
   */
  async execute(request: ModerationExecution): Promise<ModerationResult> {
    const claim = await this.store.claim(
      request.guildId,
      request.idempotencyKey,
      request.action,
      hashOf(request),
    );
    if (claim.state === 'replayed') {
      throw new ActionError('replayed', 'This moderation interaction has already been handled', {
        logReason: 'moderation_idempotent_replay',
      });
    }
    if (claim.state === 'in_flight') {
      throw new ActionError('in_progress', 'An earlier attempt at this moderation action is still running', {
        logReason: 'moderation_idempotent_in_flight',
      });
    }
    if (claim.state === 'mismatch') {
      throw new ActionError('malformed', 'This idempotency key was used for a different moderation request', {
        logReason: 'moderation_idempotency_key_reused',
      });
    }

    try {
      const result = await this.carryOut(request);
      await this.store.complete(request.guildId, request.idempotencyKey, {
        outcome: result.outcome,
        result: { outcome: result.outcome, affected: result.affected ?? null },
      });
      return result;
    } catch (err) {
      // Give the key back so a retry of a retryable failure is a real second
      // attempt. For tempban the scheduled unban is NOT undone: it was
      // written before the ban on purpose, and if the ban itself failed
      // there is nothing for it to do except unban an unbanned user.
      await this.store.release(request.guildId, request.idempotencyKey).catch(() => undefined);
      throw err;
    }
  }

  private async carryOut(request: ModerationExecution): Promise<ModerationResult> {
    assertModerationAllowed(request, this.policy);
    const targetId = request.target?.userId;
    const channelId = request.channel?.channelId;
    let result: ModerationResult;

    switch (request.action) {
      case 'moderation.ban':
        await this.discord.ban(request.guildId, targetId!, request.reason);
        result = { outcome: 'banned' };
        break;
      case 'moderation.tempban': {
        const seconds = integerBetween(request.durationSeconds, 60, 365 * 24 * 60 * 60, 'duration_seconds');
        // Persist the expiry job BEFORE the ban (TOG-1659 High 2). If the
        // process dies after Discord accepts the ban, the job still fires:
        // worst case is an unban for a ban the moderator can re-apply, never
        // a permanent ban the moderator asked to be temporary.
        await this.store.scheduleUnban(
          request.guildId,
          targetId!,
          new Date(this.now() + seconds * 1000).toISOString(),
          `Temporary ban expired: ${request.reason}`,
          request.requestId,
        );
        await this.discord.ban(request.guildId, targetId!, request.reason);
        result = { outcome: 'temporarily_banned' };
        break;
      }
      case 'moderation.kick':
        await this.discord.kick(request.guildId, targetId!, request.reason);
        result = { outcome: 'kicked' };
        break;
      case 'moderation.timeout': {
        const seconds = integerBetween(request.durationSeconds, 60, MAX_TIMEOUT_SECONDS, 'duration_seconds');
        const until = new Date(this.now() + seconds * 1000).toISOString();
        await this.discord.timeout(request.guildId, targetId!, until, request.reason);
        result = { outcome: 'timed_out' };
        break;
      }
      case 'moderation.warn':
        await this.store.addWarning(request.guildId, targetId!, request.actor.userId, request.reason, request.requestId);
        result = { outcome: 'warned' };
        break;
      case 'moderation.purge': {
        const count = integerBetween(request.count, 1, MAX_PURGE, 'count');
        const affected = await this.discord.purge(channelId!, count, request.reason);
        result = { outcome: 'purged', affected };
        break;
      }
      case 'moderation.slowmode': {
        const seconds = integerBetween(request.seconds, 0, MAX_SLOWMODE_SECONDS, 'seconds');
        await this.discord.setSlowmode(channelId!, seconds, request.reason);
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
    });
    return result;
  }

  /**
   * Lock a channel while preserving every other bit of the @everyone
   * overwrite (TOG-1659 High 1). The prior allow/deny masks are read BEFORE
   * the write and stored durably; unlock restores them exactly. Locking an
   * already-locked channel refreshes the stored masks from the live channel,
   * which by construction has SendMessages denied and nothing else changed.
   */
  private async lockChannel(channelId: string, request: ModerationExecution): Promise<string> {
    const current = await this.discord.getEveryoneOverwrite(channelId, request.guildId);
    const prior = current ?? { allow: '0', deny: '0' };
    const denied = setBit(prior.deny, SEND_MESSAGES_BIT);
    const allowed = clearBit(prior.allow, SEND_MESSAGES_BIT);
    await this.store.recordLockdown({
      channelId,
      guildId: request.guildId,
      priorAllow: prior.allow,
      priorDeny: prior.deny,
      reason: request.reason,
    });
    await this.discord.putEveryoneOverwrite(channelId, request.guildId, { allow: allowed, deny: denied }, request.reason);
    return 'locked_down';
  }

  /**
   * Restore the @everyone overwrite recorded at lockdown time. With no
   * recorded state - the bot restarted and lost nothing Discord still holds,
   * or the lock pre-dates this feature - fall back to clearing only the
   * SendMessages deny, which is the minimal change that cannot grant a
   * permission the channel did not have.
   */
  private async unlockChannel(channelId: string, request: ModerationExecution): Promise<string> {
    const recorded = await this.store.takeLockdown(channelId);
    if (recorded) {
      await this.discord.putEveryoneOverwrite(
        channelId,
        request.guildId,
        { allow: recorded.priorAllow, deny: recorded.priorDeny },
        request.reason,
      );
      return 'unlocked';
    }
    const current = await this.discord.getEveryoneOverwrite(channelId, request.guildId);
    const prior = current ?? { allow: '0', deny: '0' };
    await this.discord.putEveryoneOverwrite(
      channelId,
      request.guildId,
      { allow: clearBit(prior.allow, SEND_MESSAGES_BIT), deny: clearBit(prior.deny, SEND_MESSAGES_BIT) },
      request.reason,
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
    for (const job of jobs) {
      try {
        await this.discord.unban(job.guildId, job.userId, job.reason);
        await this.store.completeUnban(job.requestId);
        await this.store.recordAudit({
          requestId: `${job.requestId}:unban`,
          guildId: job.guildId,
          actorId: this.policy.botUserId ?? this.policy.owenUserId,
          action: 'moderation.unban_scheduled',
          targetId: job.userId,
          reason: job.reason,
          outcome: 'unbanned',
          idempotencyKey: job.requestId,
        });
        completed++;
      } catch (err) {
        await this.store.requeueUnban(job.requestId).catch(() => undefined);
        throw err;
      }
    }
    return completed;
  }
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
