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
export async function flagInactive(db: Db, store: EventStore, days: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await db
    .prepare(
      `SELECT guild_id, member_id FROM members
        WHERE left_at IS NULL
          AND NOT is_bot
          AND COALESCE(last_active_at, joined_at) < ?
          AND (inactive_flagged_at IS NULL OR inactive_flagged_at < ?)`,
    )
    .all<{ guild_id: string; member_id: string }>(cutoff, cutoff);

  const at = nowIso();
  for (const r of rows) {
    await store.record({
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
export async function joinedNeverPosted(db: Db, guildId: string): Promise<string[]> {
  return (
    await db
      .prepare(
        `SELECT member_id FROM members
          WHERE guild_id = ? AND joined_at IS NOT NULL
            AND first_message_at IS NULL AND first_voice_at IS NULL
            AND left_at IS NULL AND NOT is_bot
          ORDER BY joined_at DESC`,
      )
      .all<{ member_id: string }>(guildId)
  ).map((r) => r.member_id);
}
