import { randomUUID } from 'node:crypto';
import type { Db } from '../store/driver.ts';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface ModerationAuditRow {
  requestId: string;
  guildId: string;
  actorId: string;
  action: string;
  targetId?: string | null;
  channelId?: string | null;
  reason: string;
  outcome: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface ScheduledUnban {
  guildId: string;
  userId: string;
  reason: string;
}

export class ModerationStore {
  private db: Db;
  private now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  async hasAuditIdempotencyKey(guildId: string, idempotencyKey: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT request_id FROM moderation_audit WHERE guild_id = ? AND idempotency_key = ? LIMIT 1`,
    ).get<{ request_id: string }>(guildId, idempotencyKey);
    return Boolean(row);
  }

  async recordAudit(row: ModerationAuditRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO moderation_audit
         (request_id, guild_id, actor_id, action, target_id, channel_id, reason,
          outcome, idempotency_key, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id) DO NOTHING`,
    ).run(
      row.requestId,
      row.guildId,
      row.actorId,
      row.action,
      row.targetId ?? null,
      row.channelId ?? null,
      row.reason,
      row.outcome,
      row.idempotencyKey,
      JSON.stringify(row.metadata ?? {}),
      iso(this.now()),
    );
  }

  async addWarning(guildId: string, userId: string, actorId: string, reason: string, requestId: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO moderation_warnings
         (id, guild_id, user_id, actor_id, reason, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id) DO NOTHING`,
    ).run(randomUUID(), guildId, userId, actorId, reason, requestId, iso(this.now()));
  }

  async scheduleUnban(guildId: string, userId: string, executeAt: string, reason: string, requestId: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO moderation_scheduled_unbans
         (guild_id, user_id, execute_at, reason, request_id, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (request_id) DO NOTHING`,
    ).run(guildId, userId, executeAt, reason, requestId, iso(this.now()));
  }

  async claimDueUnbans(limit = 25): Promise<Array<ScheduledUnban & { requestId: string }>> {
    const rows = await this.db.prepare(
      `SELECT request_id, guild_id, user_id, reason
         FROM moderation_scheduled_unbans
        WHERE state = 'pending' AND execute_at <= ?
        ORDER BY execute_at ASC
        LIMIT ?`,
    ).all<{ request_id: string; guild_id: string; user_id: string; reason: string }>(iso(this.now()), limit);
    return rows.map((row) => ({
      requestId: row.request_id,
      guildId: row.guild_id,
      userId: row.user_id,
      reason: row.reason,
    }));
  }

  async completeUnban(requestId: string): Promise<void> {
    await this.db.prepare(
      `UPDATE moderation_scheduled_unbans SET state = 'done', completed_at = ? WHERE request_id = ?`,
    ).run(iso(this.now()), requestId);
  }
}
