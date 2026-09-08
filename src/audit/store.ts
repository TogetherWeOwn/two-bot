import type { Db } from '../store/driver.ts';
import type { OperationalAuditEvent } from './events.ts';

export class OperationalAuditStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async record(event: OperationalAuditEvent): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO operational_audit_log
           (entry_id, event_kind, guild_id, occurred_at, actor_id, target_id,
            source_channel_id, destination_channel_id, message_id, action,
            metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (entry_id) DO NOTHING`,
      )
      .run(
        event.entryId,
        event.kind,
        event.guildId,
        event.occurredAt,
        event.actorId ?? null,
        event.targetId ?? null,
        event.sourceChannelId ?? null,
        event.destinationChannelId ?? null,
        event.messageId ?? null,
        event.action ?? null,
        JSON.stringify(event.metadata ?? {}),
        new Date().toISOString(),
      );
    return result.changes === 1;
  }
}
