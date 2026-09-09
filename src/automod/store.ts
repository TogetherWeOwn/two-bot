import type { Db } from '../store/driver.ts';
import type { AutomodFilter } from './types.ts';

export class AutomodStore {
  private db: Db;
  private now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  async recordViolation(
    guildId: string,
    userId: string,
    filter: AutomodFilter,
    messageId: string,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.prepare(
        `SELECT user_id, violation_count FROM automod_violations
          WHERE guild_id = ? AND last_message_id = ?`,
      ).get<{ user_id: string; violation_count: number }>(guildId, messageId);
      if (existing) {
        if (existing.user_id !== userId) throw new Error('automod message id belongs to another user');
        return Number(existing.violation_count);
      }

      const row = await tx.prepare(
        `INSERT INTO automod_violations
           (guild_id, user_id, violation_count, last_filter, last_message_id, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE
           SET violation_count = automod_violations.violation_count + 1,
               last_filter = excluded.last_filter,
               last_message_id = excluded.last_message_id,
               updated_at = excluded.updated_at
         RETURNING violation_count`,
      ).get<{ violation_count: number }>(
        guildId,
        userId,
        filter,
        messageId,
        new Date(this.now()).toISOString(),
      );
      if (!row) throw new Error('automod violation row was not returned');
      return Number(row.violation_count);
    });
  }
}
