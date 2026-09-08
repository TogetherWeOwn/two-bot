import type { Db } from './driver.ts';
import type { SelfRoleAuditRow } from '../selfRoles/types.ts';

export class SelfRoleStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Claim a Discord dispatch before mutating roles; gateway replays lose. */
  async claimAudit(row: SelfRoleAuditRow): Promise<boolean> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO self_role_audit
           (event_id, guild_id, panel_id, member_id, source_id, option_key, role_id,
            source, operation, outcome, code, reason, added_role_ids, removed_role_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
      )
      .get<{ event_id: string }>(...values({ ...row, outcome: 'processing', code: null, reason: null }));
    return !!inserted;
  }

  async finishAudit(row: SelfRoleAuditRow): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE self_role_audit SET
           guild_id = ?, panel_id = ?, member_id = ?, source_id = ?, option_key = ?, role_id = ?,
           source = ?, operation = ?, outcome = ?, code = ?, reason = ?, added_role_ids = ?, removed_role_ids = ?
         WHERE event_id = ?`,
      )
      .run(
        row.guildId,
        row.panelId,
        row.memberId,
        row.sourceId,
        row.optionKey,
        row.roleId,
        row.source,
        row.operation,
        row.outcome,
        row.code,
        row.reason,
        JSON.stringify(row.addedRoleIds),
        JSON.stringify(row.removedRoleIds),
        row.eventId,
      );
    if (result.changes !== 1) throw new Error(`self-role audit ${row.eventId} was not claimed`);
  }
}

function values(row: SelfRoleAuditRow): unknown[] {
  return [
    row.eventId,
    row.guildId,
    row.panelId,
    row.memberId,
    row.sourceId,
    row.optionKey,
    row.roleId,
    row.source,
    row.operation,
    row.outcome,
    row.code,
    row.reason,
    JSON.stringify(row.addedRoleIds),
    JSON.stringify(row.removedRoleIds),
    new Date().toISOString(),
  ];
}
