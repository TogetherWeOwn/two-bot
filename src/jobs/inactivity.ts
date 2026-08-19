import type { Db } from '../store/db.ts';
import type { EventStore } from '../store/eventStore.ts';
import { nowIso } from '../core/events.ts';
import { log } from '../core/log.ts';

/**
 * Flag members who have gone quiet.
 *
 * This only writes an event and returns a list. It does NOT message anybody -
 * any outbound DM or ping needs CEO sign-off first (see docs/PRIVACY.md).
 */
export function flagInactive(db: Db, store: EventStore, days: number): string[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT guild_id, member_id FROM members
        WHERE left_at IS NULL
          AND is_bot = 0
          AND COALESCE(last_active_at, joined_at) < ?
          AND (inactive_flagged_at IS NULL OR inactive_flagged_at < ?)`,
    )
    .all(cutoff, cutoff) as { guild_id: string; member_id: string }[];

  const at = nowIso();
  for (const r of rows) {
    store.record({
      guildId: r.guild_id,
      memberId: r.member_id,
      eventType: 'member_inactive',
      occurredAt: at,
      source: 'job:inactivity',
      metadata: { thresholdDays: days },
    });
  }
  log.info('inactivity_scan', { days, flagged: rows.length });
  return rows.map((r) => r.member_id);
}

/** Members who joined and never said a word. The highest-leverage list we have. */
export function joinedNeverPosted(db: Db, guildId: string): string[] {
  return (
    db
      .prepare(
        `SELECT member_id FROM members
          WHERE guild_id = ? AND joined_at IS NOT NULL
            AND first_message_at IS NULL AND first_voice_at IS NULL
            AND left_at IS NULL AND is_bot = 0
          ORDER BY joined_at DESC`,
      )
      .all(guildId) as { member_id: string }[]
  ).map((r) => r.member_id);
}
