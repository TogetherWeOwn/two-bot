import type { OperationalAuditKind } from '../audit/events.ts';

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

export interface AuditAcceptanceResult {
  missing: string[];
  memberReadable: string[];
  duplicates: string[];
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
  const VIEW_CHANNEL = 1n << 10n;

  for (const name of AUDIT_ACCEPTANCE_CHANNELS) {
    const matches = channels.filter((candidate) => candidate.type === 0 && candidate.name === name);
    if (matches.length === 0) {
      missing.push(name);
      continue;
    }
    if (matches.length > 1) duplicates.push(name);

    const readable = matches.some((channel) => {
      const overwrites = channel.permission_overwrites ?? [];
      const everyone = overwrites.find((overwrite) => overwrite.id === guildId);
      const denied = everyone ? BigInt(everyone.deny) : 0n;
      if ((denied & VIEW_CHANNEL) === 0n) return true;
      return overwrites.some(
        (overwrite) =>
          !(overwrite.id === botId && overwrite.type === 1) &&
          (BigInt(overwrite.allow ?? '0') & VIEW_CHANNEL) !== 0n,
      );
    });
    if (readable) memberReadable.push(name);
  }

  return { missing, memberReadable, duplicates };
}

export interface AuditAcceptanceRow {
  event_kind: string;
  rows: number | string;
  distinct_entries: number | string;
  incomplete_deliveries: number | string;
  sink_tamper_rows: number | string;
}

export interface AuditMarkerCount {
  entryId: string;
  mirrorMessageId: string | null;
  channelId: string;
  messageIds: string[];
}

export interface AuditEvidenceResult {
  missing: OperationalAuditKind[];
  duplicates: OperationalAuditKind[];
  pendingDeliveries: OperationalAuditKind[];
  missingSinkTamper: boolean;
}

export interface AuditMarkerResult {
  missing: string[];
  duplicates: string[];
  messageIdMismatches: string[];
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
  };
}

export function evaluateAuditMarkers(rows: AuditMarkerCount[]): AuditMarkerResult {
  const missing: string[] = [];
  const duplicates: string[] = [];
  const messageIdMismatches: string[] = [];
  for (const row of rows) {
    if (row.messageIds.length === 0) missing.push(row.entryId);
    else if (row.messageIds.length > 1) duplicates.push(row.entryId);
    if (row.messageIds.length === 1 && row.messageIds[0] !== row.mirrorMessageId) {
      messageIdMismatches.push(row.entryId);
    }
  }
  return { missing, duplicates, messageIdMismatches };
}

export function auditAcceptanceSql(guildId: string, since?: string): string {
  const quotedGuild = guildId.replaceAll("'", "''");
  const kinds = AUDIT_ACCEPTANCE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const sinceSql = since ? ` AND occurred_at >= '${since.replaceAll("'", "''")}'` : '';
  return `SELECT event_kind,\n` +
    `       COUNT(*) FILTER (WHERE mirror_channel_id IS NOT NULL) AS rows,\n` +
    `       COUNT(DISTINCT entry_id) FILTER (WHERE mirror_channel_id IS NOT NULL) AS distinct_entries,\n` +
    `       COUNT(*) FILTER (WHERE mirror_channel_id IS NOT NULL AND delivery_state <> 'delivered') AS incomplete_deliveries,\n` +
    `       COUNT(*) FILTER (WHERE mirror_channel_id IS NULL AND delivery_state = 'none') AS sink_tamper_rows\n` +
    `FROM operational_audit_log\n` +
    `WHERE guild_id = '${quotedGuild}' AND event_kind IN (${kinds})${sinceSql}\n` +
    `GROUP BY event_kind ORDER BY event_kind;`;
}

export function auditMarkerRowsSql(guildId: string, since: string): string {
  const quotedGuild = guildId.replaceAll("'", "''");
  const quotedSince = since.replaceAll("'", "''");
  const kinds = AUDIT_ACCEPTANCE_KINDS.map((kind) => `'${kind}'`).join(', ');
  return `SELECT entry_id, mirror_channel_id, mirror_message_id FROM operational_audit_log ` +
    `WHERE guild_id = '${quotedGuild}' AND event_kind IN (${kinds}) ` +
    `AND occurred_at >= '${quotedSince}' AND mirror_channel_id IS NOT NULL ORDER BY entry_id;`;
}
