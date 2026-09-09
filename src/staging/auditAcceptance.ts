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
}

export interface AuditEvidenceResult {
  missing: OperationalAuditKind[];
  duplicates: OperationalAuditKind[];
  pendingDeliveries: OperationalAuditKind[];
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
  return { missing, duplicates, pendingDeliveries };
}

export function auditAcceptanceSql(guildId: string, since?: string): string {
  const quotedGuild = guildId.replaceAll("'", "''");
  const kinds = AUDIT_ACCEPTANCE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const sinceSql = since ? ` AND occurred_at >= '${since.replaceAll("'", "''")}'` : '';
  return `SELECT event_kind, COUNT(*) AS rows, COUNT(DISTINCT entry_id) AS distinct_entries,\n` +
    `       COUNT(*) FILTER (WHERE delivery_state <> 'delivered') AS incomplete_deliveries\n` +
    `FROM operational_audit_log\n` +
    `WHERE guild_id = '${quotedGuild}' AND event_kind IN (${kinds})${sinceSql}\n` +
    `GROUP BY event_kind ORDER BY event_kind;`;
}
