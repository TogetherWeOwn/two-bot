import { AuditLogEvent, type GuildAuditLogsEntry } from 'discord.js';
import type { OperationalAuditEvent } from './events.ts';

const MODERATION_ACTIONS = new Map<AuditLogEvent, string>([
  [AuditLogEvent.MemberKick, 'member_kick'],
  [AuditLogEvent.MemberPrune, 'member_prune'],
  [AuditLogEvent.MemberBanAdd, 'member_ban'],
  [AuditLogEvent.MemberBanRemove, 'member_unban'],
  [AuditLogEvent.MemberUpdate, 'member_update'],
  [AuditLogEvent.MemberRoleUpdate, 'member_role_update'],
  [AuditLogEvent.MemberMove, 'member_move'],
  [AuditLogEvent.MemberDisconnect, 'member_disconnect'],
  [AuditLogEvent.MessageDelete, 'message_delete'],
  [AuditLogEvent.MessageBulkDelete, 'message_bulk_delete'],
]);

export function moderationAuditEvent(
  entry: GuildAuditLogsEntry,
  guildId: string,
): OperationalAuditEvent | null {
  const action = MODERATION_ACTIONS.get(entry.action);
  if (!action) return null;

  const extra = entry.extra as Record<string, unknown> | null;
  const extraChannel = extra?.channel as { id?: unknown } | undefined;
  const count = numberOrNull(extra?.count ?? extra?.removed);

  return {
    entryId: `discord-audit:${guildId}:${entry.id}`,
    kind: 'moderation_action',
    channel: 'moderation',
    guildId,
    occurredAt: new Date(entry.createdTimestamp).toISOString(),
    actorId: entry.executorId,
    targetId: entry.targetId,
    sourceChannelId: typeof extraChannel?.id === 'string' ? extraChannel.id : null,
    action,
    metadata: {
      auditLogEntryId: entry.id,
      count,
    },
  };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
