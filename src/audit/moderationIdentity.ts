import { createHash } from 'node:crypto';
import { MODERATION_ACTIONS, type ModerationActionName } from '../moderation/types.ts';

const MARKER = /^\[two-audit:v1:([a-f0-9]{32}):(moderation\.[a-z_]+):(\d{17,20})\](?: |$)/;

export function moderationAuditToken(guildId: string, idempotencyKey: string): string {
  return createHash('sha256')
    .update(`moderation-audit:v1:${guildId}:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
}

export function moderationAuditEntryId(guildId: string, token: string): string {
  return `moderation-success:${guildId}:${token}`;
}

export function moderationAuditReason(
  guildId: string,
  idempotencyKey: string,
  action: ModerationActionName | 'moderation.unban_scheduled',
  actorId: string,
  reason: string,
): string {
  return `[two-audit:v1:${moderationAuditToken(guildId, idempotencyKey)}:${action}:${actorId}] ${reason}`;
}

export function parseModerationAuditReason(
  reason: string | null | undefined,
): {
  token: string;
  action: ModerationActionName | 'moderation.unban_scheduled';
  actorId: string;
} | null {
  const match = MARKER.exec(reason ?? '');
  if (!match) return null;
  const action = match[2];
  if (action !== 'moderation.unban_scheduled' && !(MODERATION_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }
  return {
    token: match[1],
    action: action as ModerationActionName | 'moderation.unban_scheduled',
    actorId: match[3],
  };
}
