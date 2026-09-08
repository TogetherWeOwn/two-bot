import { ActionError } from '../internal/errors.ts';
import type { ModerationDiscordClient } from './discord.ts';
import { assertModerationAllowed } from './policy.ts';
import type { ModerationStore } from './store.ts';
import type { ModerationPolicy, ModerationRequest, ModerationResult } from './types.ts';

const MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;
const MAX_PURGE = 100;
const MAX_SLOWMODE_SECONDS = 6 * 60 * 60;

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

  async execute(request: ModerationExecution): Promise<ModerationResult> {
    if (await this.store.hasAuditIdempotencyKey(request.guildId, request.idempotencyKey)) {
      throw new ActionError('replayed', 'This moderation interaction has already been handled', {
        logReason: 'moderation_idempotent_replay',
      });
    }
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
        await this.discord.ban(request.guildId, targetId!, request.reason);
        await this.store.scheduleUnban(
          request.guildId,
          targetId!,
          new Date(this.now() + seconds * 1000).toISOString(),
          `Temporary ban expired: ${request.reason}`,
          request.requestId,
        );
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
        await this.discord.setLockdown(channelId!, request.guildId, true, request.reason);
        result = { outcome: 'locked_down' };
        break;
      case 'moderation.unlock':
        await this.discord.setLockdown(channelId!, request.guildId, false, request.reason);
        result = { outcome: 'unlocked' };
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

  async runDueUnbans(): Promise<number> {
    const jobs = await this.store.claimDueUnbans();
    let completed = 0;
    for (const job of jobs) {
      await this.discord.unban(job.guildId, job.userId, job.reason);
      await this.store.completeUnban(job.requestId);
      await this.store.recordAudit({
        requestId: `${job.requestId}:unban`,
        guildId: job.guildId,
        actorId: 'system',
        action: 'moderation.unban_scheduled',
        targetId: job.userId,
        reason: job.reason,
        outcome: 'unbanned',
        idempotencyKey: job.requestId,
      });
      completed++;
    }
    return completed;
  }
}

function integerBetween(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ActionError('malformed', `"${field}" must be an integer between ${min} and ${max}`, {
      logReason: `bad_${field}`,
    });
  }
  return Number(value);
}
