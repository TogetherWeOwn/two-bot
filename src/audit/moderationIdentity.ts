import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MODERATION_ACTIONS, type ModerationActionName } from '../moderation/types.ts';

const MARKER = /^\[two-audit:v1:([a-f0-9]{32}):(moderation\.[a-z_]+):(\d{17,20}):([a-f0-9]{16})\](?: |$)/;

export function moderationAuditToken(guildId: string, idempotencyKey: string): string {
  return createHash('sha256')
    .update(`moderation-audit:v1:${guildId}:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
}

export function moderationAuditEntryId(guildId: string, token: string): string {
  return `moderation-success:${guildId}:${token}`;
}

/**
 * The token alone is a one-way hash of (guildId, idempotencyKey), never a
 * signature over the visible marker fields - anything with the bot's Discord
 * token can already set an arbitrary `X-Audit-Log-Reason` on a same-bot
 * action (raid-remove.ts, kick.ts, containment quarantine) without ever
 * calling this function, so a syntactically valid token/action/actor proves
 * nothing on its own (TOG-2223 #8). The MAC is keyed on a secret those
 * callers never see - only the in-process ModerationService mints and
 * verifies it - so a forged marker fails verification even though the
 * forger holds the same bot credential.
 */
function markerMac(
  secret: string,
  guildId: string,
  token: string,
  action: string,
  actorId: string,
): string {
  return createHmac('sha256', secret)
    .update(`moderation-audit-mac:v1:${guildId}:${token}:${action}:${actorId}`)
    .digest('hex')
    .slice(0, 16);
}

export function moderationAuditReason(
  secret: string | null,
  guildId: string,
  idempotencyKey: string,
  action: ModerationActionName | 'moderation.unban_scheduled',
  actorId: string,
  reason: string,
): string {
  if (!secret) return reason;
  const token = moderationAuditToken(guildId, idempotencyKey);
  const mac = markerMac(secret, guildId, token, action, actorId);
  return `[two-audit:v1:${token}:${action}:${actorId}:${mac}] ${reason}`;
}

export function parseModerationAuditReason(
  secret: string | null,
  guildId: string,
  reason: string | null | undefined,
): {
  token: string;
  action: ModerationActionName | 'moderation.unban_scheduled';
  actorId: string;
} | null {
  if (!secret) return null;
  const match = MARKER.exec(reason ?? '');
  if (!match) return null;
  const [, token, action, actorId, mac] = match as unknown as [string, string, string, string, string];
  if (action !== 'moderation.unban_scheduled' && !(MODERATION_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }
  const expected = markerMac(secret, guildId, token, action, actorId);
  if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) return null;
  return {
    token,
    action: action as ModerationActionName | 'moderation.unban_scheduled',
    actorId,
  };
}
