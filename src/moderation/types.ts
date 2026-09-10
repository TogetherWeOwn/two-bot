import { ActionError } from '../internal/errors.ts';

export const MODERATION_ACTIONS = [
  'moderation.ban',
  'moderation.tempban',
  'moderation.kick',
  'moderation.timeout',
  'moderation.warn',
  'moderation.purge',
  'moderation.slowmode',
  'moderation.lockdown',
  'moderation.unlock',
] as const;

export type ModerationActionName = (typeof MODERATION_ACTIONS)[number];

export const MODERATION_COMMANDS = [
  'ban',
  'tempban',
  'kick',
  'timeout',
  'warn',
  'purge',
  'slowmode',
  'lockdown',
  'unlock',
] as const;

export type ModerationCommandName = (typeof MODERATION_COMMANDS)[number];

export interface ModerationActor {
  userId: string;
  roleIds: string[];
  highestRolePosition: number;
  permissions: bigint;
}

export interface ModerationTarget {
  userId: string;
  roleIds: string[];
  highestRolePosition: number;
  isBot: boolean;
  isGuildOwner: boolean;
}

export interface ModerationChannel {
  channelId: string;
  type: number;
}

export interface ModerationRequest {
  action: ModerationActionName;
  guildId: string;
  actor: ModerationActor;
  target?: ModerationTarget;
  channel?: ModerationChannel;
  botHighestRolePosition?: number;
  reason: string;
  durationSeconds?: number;
  count?: number;
  seconds?: number;
}

export interface ModerationResult {
  outcome: string;
  affected?: number;
  replayed?: boolean;
}

export interface ModerationPolicy {
  owenUserId: string;
  protectedRoleIds: ReadonlySet<string>;
  botUserId?: string | null;
}

export function requireModerationReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ActionError('malformed', '"reason" must be a non-empty string', {
      logReason: 'missing_reason',
    });
  }
  const reason = value.trim();
  if (reason.length > 512) {
    throw new ActionError('malformed', '"reason" is longer than 512 characters', {
      logReason: 'reason_too_long',
    });
  }
  return reason;
}
