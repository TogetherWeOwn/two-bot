import type { Db } from './db.ts';
import { idempotencyKey, type EventType, type FunnelEvent } from '../core/events.ts';

export interface RecordResult {
  /** false when this exact event was already on file - not an error. */
  inserted: boolean;
  eventId: number | null;
}

/**
 * The only write path into the funnel log.
 *
 * Every emitter goes through here so that (a) idempotency is enforced in one
 * place and (b) the `members` projection can never drift from `events`.
 */
export class EventStore {
  // NB: explicit field + assignment, not a `private db` parameter property.
  // Node's type-stripping loader rejects parameter properties. See docs/STACK.md.
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  record(e: FunnelEvent): RecordResult {
    const key = idempotencyKey(e);
    const existing = this.db
      .prepare(`SELECT id FROM events WHERE idempotency_key = ?`)
      .get(key) as { id: number } | undefined;
    if (existing) return { inserted: false, eventId: existing.id };

    const info = this.db
      .prepare(
        `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.eventType,
        e.memberId,
        e.guildId,
        e.occurredAt,
        e.source,
        e.metadata ? JSON.stringify(e.metadata) : null,
        key,
      );

    this.project(e);
    return { inserted: true, eventId: Number(info.lastInsertRowid) };
  }

  /** Update the members cache to reflect one new event. */
  private project(e: FunnelEvent): void {
    if (!e.memberId) return;
    const db = this.db;
    db.prepare(
      `INSERT OR IGNORE INTO members (guild_id, member_id) VALUES (?, ?)`,
    ).run(e.guildId, e.memberId);

    const set = (col: string, val: string | null, onlyIfNull = false) => {
      const guard = onlyIfNull ? ` AND ${col} IS NULL` : '';
      db.prepare(
        `UPDATE members SET ${col} = ? WHERE guild_id = ? AND member_id = ?${guard}`,
      ).run(val, e.guildId, e.memberId);
    };

    switch (e.eventType) {
      case 'member_join':
        set('joined_at', e.occurredAt);
        set('join_source', e.source);
        set('left_at', null);
        set('inactive_flagged_at', null);
        break;
      case 'first_message':
        set('first_message_at', e.occurredAt, true);
        set('last_active_at', e.occurredAt);
        break;
      case 'first_voice_session':
        set('first_voice_at', e.occurredAt, true);
        set('last_active_at', e.occurredAt);
        break;
      case 'member_inactive':
        set('inactive_flagged_at', e.occurredAt);
        break;
      case 'member_leave':
        set('left_at', e.occurredAt);
        break;
      case 'invite_click':
        break;
    }
  }

  /** Bump activity without emitting a funnel event (every message, not just the first). */
  touchActivity(guildId: string, memberId: string, atIso: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO members (guild_id, member_id) VALUES (?, ?)`)
      .run(guildId, memberId);
    this.db
      .prepare(
        `UPDATE members SET last_active_at = ?
         WHERE guild_id = ? AND member_id = ? AND (last_active_at IS NULL OR last_active_at < ?)`,
      )
      .run(atIso, guildId, memberId, atIso);
  }

  hasEvent(guildId: string, memberId: string, type: EventType): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM events WHERE guild_id = ? AND member_id = ? AND event_type = ? LIMIT 1`,
      )
      .get(guildId, memberId, type);
    return !!row;
  }

  countByType(type: EventType): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = ?`)
      .get(type) as { n: number };
    return row.n;
  }

  recent(limit = 20): unknown[] {
    return this.db
      .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }
}
