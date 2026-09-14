import type { OperationalAuditKind } from '../audit/events.ts';
import { MODERATION_ACTIONS } from '../moderation/types.ts';

export const AUDIT_ACCEPTANCE_CHANNELS = ['audit-log', 'voice-log', 'moderation-log'] as const;

export const AUDIT_ACCEPTANCE_KINDS: readonly OperationalAuditKind[] = [
  'message_edit',
  'message_delete',
  'member_update',
  'voice_join',
  'voice_leave',
  'voice_move',
  'moderation_action',
];

export interface StagingChannel {
  id: string;
  name: string;
  type: number;
  permission_overwrites?: Array<{ id: string; type?: number; allow?: string; deny: string }>;
}

export type AuditChannelRoute = 'audit' | 'voice' | 'moderation';
export type AuditChannelIds = Record<AuditChannelRoute, string | null>;

export interface AuditAcceptanceResult {
  missing: string[];
  memberReadable: string[];
  duplicates: string[];
  channelIds: AuditChannelIds;
}

/**
 * Whether ANY member could still view this staff-log channel: @everyone must
 * be explicitly denied ViewChannel, and no other role/member overwrite (the
 * bot's own excepted) may allow it back in. Shared between acceptance
 * (`evaluateAuditChannels`) and provisioning (`needsStaffPrivacyRepair` in
 * `provision.ts`) so a stray role/member ViewChannel allow that acceptance
 * would fail on is caught and repaired at provision time too, rather than
 * provisioning reporting the channel `present` while acceptance calls it a
 * privacy failure.
 */
export function staffChannelIsMemberReadable(channel: StagingChannel, guildId: string, botId?: string): boolean {
  const VIEW_CHANNEL = 1n << 10n;
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((overwrite) => overwrite.id === guildId);
  const denied = everyone ? BigInt(everyone.deny) : 0n;
  if ((denied & VIEW_CHANNEL) === 0n) return true;
  return overwrites.some(
    (overwrite) =>
      !(overwrite.id === botId && overwrite.type === 1) &&
      (BigInt(overwrite.allow ?? '0') & VIEW_CHANNEL) !== 0n,
  );
}

/**
 * Logging channels are not just names: every matching channel must be unique,
 * @everyone must be explicitly denied ViewChannel, and no role/member overwrite
 * may allow it back. A readable duplicate is still a privacy failure.
 */
export function evaluateAuditChannels(
  channels: StagingChannel[],
  guildId: string,
  botId?: string,
): AuditAcceptanceResult {
  const missing: string[] = [];
  const memberReadable: string[] = [];
  const duplicates: string[] = [];
  const channelIds: AuditChannelIds = { audit: null, voice: null, moderation: null };

  for (const name of AUDIT_ACCEPTANCE_CHANNELS) {
    const matches = channels.filter((candidate) => candidate.type === 0 && candidate.name === name);
    if (matches.length === 0) {
      missing.push(name);
      continue;
    }
    if (matches.length > 1) duplicates.push(name);

    const readable = matches.some((channel) => staffChannelIsMemberReadable(channel, guildId, botId));
    if (readable) memberReadable.push(name);
    if (matches.length === 1 && !readable) channelIds[routeForName(name)] = matches[0].id;
  }

  return { missing, memberReadable, duplicates, channelIds };
}

function routeForName(name: (typeof AUDIT_ACCEPTANCE_CHANNELS)[number]): AuditChannelRoute {
  if (name === 'voice-log') return 'voice';
  if (name === 'moderation-log') return 'moderation';
  return 'audit';
}

export function auditRouteForKind(kind: OperationalAuditKind): AuditChannelRoute {
  if (kind === 'voice_join' || kind === 'voice_leave' || kind === 'voice_move') return 'voice';
  if (kind === 'moderation_action') return 'moderation';
  return 'audit';
}

export interface AuditAcceptanceRow {
  event_kind: string;
  rows: number | string;
  distinct_entries: number | string;
  incomplete_deliveries: number | string;
  sink_tamper_rows: number | string;
  successful_moderation_rows: number | string;
}

export interface AuditMarkerCount {
  entryId: string;
  eventKind: OperationalAuditKind;
  mirrorMessageId: string | null;
  channelId: string;
  expectedChannelId: string | null;
  messageIds: string[];
}

export interface AuditEvidenceResult {
  missing: OperationalAuditKind[];
  duplicates: OperationalAuditKind[];
  pendingDeliveries: OperationalAuditKind[];
  missingSinkTamper: boolean;
  missingModerationSuccess: boolean;
}

export interface AuditMarkerResult {
  missing: string[];
  duplicates: string[];
  messageIdMismatches: string[];
  channelMismatches: string[];
}

export function evaluateAuditEvidence(rows: AuditAcceptanceRow[]): AuditEvidenceResult {
  const byKind = new Map(rows.map((row) => [row.event_kind, row]));
  const missing: OperationalAuditKind[] = [];
  const duplicates: OperationalAuditKind[] = [];
  const pendingDeliveries: OperationalAuditKind[] = [];
  for (const kind of AUDIT_ACCEPTANCE_KINDS) {
    const row = byKind.get(kind);
    if (!row || Number(row.distinct_entries) < 1) {
      missing.push(kind);
      continue;
    }
    if (Number(row.rows) !== Number(row.distinct_entries)) duplicates.push(kind);
    if (Number(row.incomplete_deliveries) > 0) pendingDeliveries.push(kind);
  }
  return {
    missing,
    duplicates,
    pendingDeliveries,
    missingSinkTamper: !rows.some((row) => Number(row.sink_tamper_rows) > 0),
    missingModerationSuccess: !rows.some(
      (row) => row.event_kind === 'moderation_action' && Number(row.successful_moderation_rows) > 0,
    ),
  };
}

export function evaluateAuditMarkers(rows: AuditMarkerCount[]): AuditMarkerResult {
  const missing: string[] = [];
  const duplicates: string[] = [];
  const messageIdMismatches: string[] = [];
  const channelMismatches: string[] = [];
  for (const row of rows) {
    if (!row.expectedChannelId || row.channelId !== row.expectedChannelId) {
      channelMismatches.push(row.entryId);
      continue;
    }
    if (row.messageIds.length === 0) missing.push(row.entryId);
    else if (row.messageIds.length > 1) duplicates.push(row.entryId);
    if (row.messageIds.length === 1 && row.messageIds[0] !== row.mirrorMessageId) {
      messageIdMismatches.push(row.entryId);
    }
  }
  return { missing, duplicates, messageIdMismatches, channelMismatches };
}

export function auditAcceptanceSql(
  guildId: string,
  since?: string,
  acceptedSinkIds: readonly string[] = [],
): string {
  const quotedGuild = guildId.replaceAll("'", "''");
  const kinds = AUDIT_ACCEPTANCE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const sinceSql = since ? ` AND occurred_at >= '${since.replaceAll("'", "''")}'` : '';
  const sinks = acceptedSinkIds.map((id) => `'${id.replaceAll("'", "''")}'`).join(', ');
  const tamperSql = sinks
    ? `mirror_channel_id IS NULL AND delivery_state = 'none' AND source_channel_id IN (${sinks})`
    : 'FALSE';
  const mutatingModerationActions = [
    ...MODERATION_ACTIONS.filter((action) => action !== 'moderation.warn'),
    'moderation.unban_scheduled',
  ].map((action) => `'${action}'`).join(', ');
  return `SELECT event_kind,\n` +
    `       COUNT(*) FILTER (WHERE mirror_channel_id IS NOT NULL) AS rows,\n` +
    `       COUNT(DISTINCT entry_id) FILTER (WHERE mirror_channel_id IS NOT NULL) AS distinct_entries,\n` +
    `       COUNT(*) FILTER (WHERE mirror_channel_id IS NOT NULL AND delivery_state <> 'delivered') AS incomplete_deliveries,\n` +
    `       COUNT(*) FILTER (WHERE ${tamperSql}) AS sink_tamper_rows,\n` +
    `       COUNT(*) FILTER (WHERE event_kind = 'moderation_action' ` +
    `AND mirror_channel_id IS NOT NULL AND delivery_state = 'delivered' ` +
    `AND metadata_json LIKE '%\"origin\":\"moderation_service\"%' ` +
    `AND metadata_json LIKE '%\"auditLogEntryId\":%' ` +
    `AND action IN (${mutatingModerationActions})) AS successful_moderation_rows\n` +
    `FROM operational_audit_log\n` +
    `WHERE guild_id = '${quotedGuild}' AND event_kind IN (${kinds})${sinceSql}\n` +
    `GROUP BY event_kind ORDER BY event_kind;`;
}

export function auditMarkerRowsSql(guildId: string, since: string): string {
  const quotedGuild = guildId.replaceAll("'", "''");
  const quotedSince = since.replaceAll("'", "''");
  const kinds = AUDIT_ACCEPTANCE_KINDS.map((kind) => `'${kind}'`).join(', ');
  return `SELECT entry_id, event_kind, mirror_channel_id, mirror_message_id FROM operational_audit_log ` +
    `WHERE guild_id = '${quotedGuild}' AND event_kind IN (${kinds}) ` +
    `AND occurred_at >= '${quotedSince}' AND mirror_channel_id IS NOT NULL ORDER BY entry_id;`;
}
