import { randomUUID } from 'node:crypto';
import { ActionError } from '../internal/errors.ts';
import type { ModerationResolver } from './resolver.ts';
import type { ModerationService } from './service.ts';
import { requireModerationReason, type ModerationActionName } from './types.ts';

export interface ModerationActionContext {
  guildId: string;
  resolver: ModerationResolver;
  service: ModerationService;
  idempotencyKey: string;
}

export async function runModerationAction(
  action: ModerationActionName,
  body: Record<string, unknown>,
  ctx: ModerationActionContext,
): Promise<{ result: Record<string, unknown>; outcome: string }> {
  const actorId = requireSnowflake(body, 'actor_id');
  const actor = await ctx.resolver.actor(ctx.guildId, actorId);
  const reason = requireModerationReason(body.reason);
  const targetId = targetAction(action) ? requireSnowflake(body, 'target_id') : undefined;
  const channelId = channelAction(action) ? requireSnowflake(body, 'channel_id') : undefined;
  const target = targetId ? await ctx.resolver.target(ctx.guildId, targetId) : undefined;
  const channel = channelId ? await ctx.resolver.channel(channelId) : undefined;

  const botHighestRolePosition = target
    ? await ctx.resolver.botHighestRolePosition(ctx.guildId)
    : undefined;

  const result = await ctx.service.execute({
    action,
    guildId: ctx.guildId,
    actor,
    target,
    channel,
    botHighestRolePosition,
    reason,
    requestId: randomUUID(),
    idempotencyKey: ctx.idempotencyKey,
    durationSeconds: optionalInteger(body, 'duration_seconds'),
    count: optionalInteger(body, 'count'),
    seconds: optionalInteger(body, 'seconds'),
  });
  return {
    result: {
      outcome: result.outcome,
      ...(result.affected === undefined ? {} : { affected: result.affected }),
    },
    outcome: result.outcome,
    ...(result.replayed ? { innerReplayed: true } : {}),
  };
}

function targetAction(action: ModerationActionName): boolean {
  return action === 'moderation.ban' || action === 'moderation.tempban' || action === 'moderation.kick' || action === 'moderation.timeout' || action === 'moderation.warn';
}

function channelAction(action: ModerationActionName): boolean {
  return action === 'moderation.purge' || action === 'moderation.slowmode' || action === 'moderation.lockdown' || action === 'moderation.unlock';
}

function requireSnowflake(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
    throw new ActionError('malformed', `"${field}" must be a Discord id`, {
      logReason: `bad_${field}`,
    });
  }
  return value;
}

function optionalInteger(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new ActionError('malformed', `"${field}" must be an integer`, {
      logReason: `bad_${field}`,
    });
  }
  return Number(value);
}
