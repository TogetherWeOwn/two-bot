import { AuditLogEvent, type GuildAuditLogsEntry } from 'discord.js';
import type { OperationalAuditEvent } from './events.ts';
import { moderationAuditEntryId, parseModerationAuditReason } from './moderationIdentity.ts';

export interface RawDiscordDispatch {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

export function rawMessageAuditEvent(
  packet: RawDiscordDispatch,
  shardId: number,
  observedAt?: string,
): OperationalAuditEvent | null {
  if (packet.op !== 0 || (packet.t !== 'MESSAGE_UPDATE' && packet.t !== 'MESSAGE_DELETE')) return null;
  if (!packet.d || typeof packet.d !== 'object' || Array.isArray(packet.d)) return null;
  const data = packet.d as Record<string, unknown>;
  const guildId = stringOrNull(data.guild_id);
  const channelId = stringOrNull(data.channel_id);
  const messageId = stringOrNull(data.id);
  if (!guildId || !channelId || !messageId) return null;
  const observed = observedAt ?? new Date().toISOString();
  if (packet.t === 'MESSAGE_DELETE') {
    return {
      entryId: `message-delete:${guildId}:${messageId}`,
      kind: 'message_delete', channel: 'audit', guildId, occurredAt: observed,
      actorId: null, targetId: null, sourceChannelId: channelId, messageId,
    };
  }

  const editedAt = validIso(data.edited_timestamp);
  const authorId = data.author && typeof data.author === 'object' && !Array.isArray(data.author)
    ? stringOrNull((data.author as Record<string, unknown>).id)
    : null;
  const identity = editedAt ?? `shard-${shardId}:sequence-${packet.s ?? 'unknown'}`;
  return {
    entryId: `message-edit:${guildId}:${messageId}:${identity}`,
    kind: 'message_edit', channel: 'audit', guildId, occurredAt: editedAt ?? observed,
    actorId: authorId, targetId: authorId, sourceChannelId: channelId, messageId,
  };
}

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
  [AuditLogEvent.ChannelUpdate, 'channel_update'],
  [AuditLogEvent.ChannelOverwriteCreate, 'channel_overwrite_create'],
  [AuditLogEvent.ChannelOverwriteUpdate, 'channel_overwrite_update'],
  [AuditLogEvent.ChannelOverwriteDelete, 'channel_overwrite_delete'],
]);

export function moderationAuditEvent(
  entry: GuildAuditLogsEntry,
  guildId: string,
  botUserId?: string | null,
  moderationAuditSecret?: string | null,
): OperationalAuditEvent | null {
  const action = MODERATION_ACTIONS.get(entry.action);
  if (!action) return null;

  const extra = entry.extra as Record<string, unknown> | null;
  const extraChannel = extra?.channel as { id?: unknown } | undefined;
  const count = numberOrNull(extra?.count ?? extra?.removed);
  const marker = parseModerationAuditReason(moderationAuditSecret ?? null, guildId, entry.reason);
  const correlated = marker && botUserId && entry.executorId === botUserId ? marker : null;

  const correlatedChannel = correlated && isChannelAction(correlated.action)
    ? entry.targetId
    : null;
  return {
    entryId: correlated
      ? moderationAuditEntryId(guildId, correlated.token)
      : `discord-audit:${guildId}:${entry.id}`,
    kind: 'moderation_action',
    channel: 'moderation',
    guildId,
    occurredAt: new Date(entry.createdTimestamp).toISOString(),
    actorId: correlated?.actorId ?? entry.executorId,
    targetId: correlatedChannel ? null : entry.targetId,
    sourceChannelId: typeof extraChannel?.id === 'string'
      ? extraChannel.id
      : correlatedChannel,
    action: correlated?.action ?? action,
    metadata: {
      auditLogEntryId: entry.id,
      count,
      ...(correlated
        ? {
            origin: 'moderation_service',
            outcome: outcomeFor(correlated.action),
            ...(count === null ? {} : { affected: count }),
          }
        : {}),
    },
  };
}

function isChannelAction(action: string): boolean {
  return action === 'moderation.purge' || action === 'moderation.slowmode'
    || action === 'moderation.lockdown' || action === 'moderation.unlock';
}

function outcomeFor(action: string): string {
  if (action === 'moderation.ban') return 'banned';
  if (action === 'moderation.tempban') return 'temporarily_banned';
  if (action === 'moderation.kick') return 'kicked';
  if (action === 'moderation.timeout') return 'timed_out';
  if (action === 'moderation.warn') return 'warned';
  if (action === 'moderation.purge') return 'purged';
  if (action === 'moderation.slowmode') return 'slowmode_updated';
  if (action === 'moderation.lockdown') return 'locked_down';
  if (action === 'moderation.unlock') return 'unlocked';
  return 'unbanned';
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
