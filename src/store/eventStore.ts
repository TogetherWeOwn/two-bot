import type { Db } from './driver.ts';
import {
  idempotencyKey,
  isMeasurableGateClearing,
  MESSAGE_RUNGS,
  type EventType,
  type FunnelEvent,
  type MessageRung,
} from '../core/events.ts';

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
 *
 * Every method is async. That is the one visible consequence of moving to
 * Postgres - no Node Postgres client is synchronous - and the reason call
 * sites gained an `await` in TWO-18. Names, arguments and return values are
 * otherwise unchanged.
 *
 * Concurrency: two processes write here now (the bot and the website), so
 * "check then insert" is not safe on its own - both can pass the check. Writes
 * lean on the database instead: `ON CONFLICT DO NOTHING` on the idempotency
 * key decides the winner atomically, and every projection update is guarded so
 * that applying it twice, or out of order, lands in the same place.
 */
export class EventStore {
  // NB: explicit field + assignment, not a `private db` parameter property.
  // Node's type-stripping loader rejects parameter properties. See docs/STACK.md.
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async record(e: FunnelEvent, opts: { membershipObservedAt?: string } = {}): Promise<RecordResult> {
    const key = idempotencyKey(e);
    const observedAt = opts.membershipObservedAt;
    if (observedAt !== undefined && (
      !['member_join', 'member_leave'].includes(e.eventType) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(observedAt) ||
      !Number.isFinite(Date.parse(observedAt))
    )) throw new Error('membershipObservedAt requires a membership event and a valid UTC timestamp');
    const metadata = observedAt === undefined ? e.metadata : { ...e.metadata, membershipObservedAt: observedAt };

    return this.db.transaction(async (tx) => {
      // Insert first and let the unique index arbitrate. A SELECT-then-INSERT
      // would let two processes both see "not there" and one of them blow up
      // on the constraint.
      const inserted = await tx
        .prepare(
          `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
        )
        .get<{ id: number }>(
          e.eventType,
          e.memberId,
          e.guildId,
          e.occurredAt,
          e.source,
          metadata ? JSON.stringify(metadata) : null,
          key,
        );

      if (!inserted) {
        // Someone else has it - either an earlier call or the other process.
        const existing = await tx
          .prepare(`SELECT id FROM events WHERE idempotency_key = ?`)
          .get<{ id: number }>(key);
        if (existing && observedAt !== undefined) {
          // A live redelivery reconfirms presence, not attribution or occurrence.
          await tx.prepare(
            `UPDATE events SET metadata =
               (COALESCE(metadata::jsonb, '{}'::jsonb) || jsonb_build_object('membershipObservedAt', ?::text))::text
             WHERE id = ? AND (metadata::jsonb ->> 'membershipObservedAt' IS NULL
               OR (metadata::jsonb ->> 'membershipObservedAt')::timestamptz < ?::timestamptz)`,
          ).run(observedAt, existing.id, observedAt);
          await this.project(tx, e);
        }
        return { inserted: false, eventId: existing ? Number(existing.id) : null };
      }

      await this.project(tx, e);
      return { inserted: true, eventId: Number(inserted.id) };
    });
  }

  /** Update the members cache to reflect one new event. */
  private async project(db: Db, e: FunnelEvent): Promise<void> {
    if (!e.memberId) return;
    await db
      .prepare(
        `INSERT INTO members (guild_id, member_id) VALUES (?, ?)
         ON CONFLICT (guild_id, member_id) DO NOTHING`,
      )
      .run(e.guildId, e.memberId);

    const set = (col: string, val: string | null, onlyIfNull = false) => {
      const guard = onlyIfNull ? ` AND ${col} IS NULL` : '';
      return db
        .prepare(
          `UPDATE members SET ${col} = ? WHERE guild_id = ? AND member_id = ?${guard}`,
        )
        .run(val, e.guildId, e.memberId);
    };

    // Recency must never move backwards. `set` above is an unconditional
    // assignment, which is fine for a column written once, but the message
    // rungs are also written by the backfill with timestamps that are older
    // than anything the live bot has seen.
    const advance = (col: string, val: string) =>
      db
        .prepare(
          `UPDATE members SET ${col} = ? WHERE guild_id = ? AND member_id = ?
            AND (${col} IS NULL OR ${col} < ?)`,
        )
        .run(val, e.guildId, e.memberId, val);

    switch (e.eventType) {
      case 'member_join':
      case 'member_leave':
        await this.projectMembership(db, e.guildId, e.memberId);
        break;
      case 'gate_cleared':
        // Earliest wins. A rejoin re-screens the member and the live listener
        // would happily write a second, later clearing; the first one is the
        // one the conversion number is about.
        await set('gate_cleared_at', e.occurredAt, true);
        break;
      case 'first_message':
        await set('first_message_at', e.occurredAt, true);
        await set('last_active_at', e.occurredAt);
        break;
      // The middle rung of the message ladder. It has no column and nothing
      // reports on it - it exists so the third message is identifiable. See
      // MESSAGE_RUNGS in src/core/events.ts.
      case 'second_message':
        await advance('last_active_at', e.occurredAt);
        break;
      case 'third_message':
        await set('third_message_at', e.occurredAt, true);
        await advance('last_active_at', e.occurredAt);
        break;
      case 'first_voice_session':
        await set('first_voice_at', e.occurredAt, true);
        await set('last_active_at', e.occurredAt);
        break;
      case 'member_inactive':
        await set('inactive_flagged_at', e.occurredAt);
        break;
      case 'invite_click':
        break;
    }
  }

  private async projectMembership(db: Db, guildId: string, memberId: string): Promise<void> {
    // Attribution follows actual join time; presence follows live dispatch order
    // when supplied, otherwise historical occurrence time. Neither rewrites history.
    // Inactivity resets on the latest actual join establishing a newer membership
    // spell, independent of whether a newer leave currently wins presence.
    // Reconfirming presence is not activity: a duplicate observation keeps the
    // original occurrence, so it cannot clear a later flag.
    // Read AFTER acquiring the member lock: a competing transaction may have
    // committed while we waited. A same-statement CTE would retain its old snapshot.
    await db.prepare(
      `SELECT member_id FROM members WHERE guild_id = ? AND member_id = ? FOR UPDATE`,
    ).get(guildId, memberId);
    await db.prepare(
      `WITH membership AS (
         SELECT id, event_type, occurred_at, source,
           COALESCE((metadata::jsonb ->> 'membershipObservedAt')::timestamptz, occurred_at) AS ordered_at
         FROM events WHERE guild_id = ? AND member_id = ?
           AND event_type IN ('member_join', 'member_leave')
       ), latest_join AS (
         SELECT occurred_at, source FROM membership WHERE event_type = 'member_join'
         ORDER BY occurred_at DESC, id ASC LIMIT 1
       ), latest_presence AS (
         SELECT event_type, occurred_at, ordered_at FROM membership
         ORDER BY ordered_at DESC, (event_type = 'member_leave') DESC, id DESC LIMIT 1
       )
       UPDATE members SET
         joined_at = COALESCE((SELECT occurred_at FROM latest_join), joined_at),
         join_source = COALESCE((SELECT source FROM latest_join), join_source),
         left_at = CASE WHEN p.event_type = 'member_leave' THEN p.occurred_at ELSE NULL END,
         inactive_flagged_at = CASE WHEN inactive_flagged_at <= (SELECT occurred_at FROM latest_join)
           THEN NULL ELSE inactive_flagged_at END
       FROM latest_presence p WHERE guild_id = ? AND member_id = ?`,
    ).run(guildId, memberId, guildId, memberId);
  }

  /**
   * Record a once-per-member milestone, keeping the EARLIEST time we know of.
   *
   * `record` is write-once by idempotency key, which is right for the live bot:
   * the first message it sees is the first message. Backfill breaks that
   * assumption - it can discover a message older than one already on file - and
   * when it does, the older timestamp is the true one. Used by the backfill for
   * first_message and first_voice_session.
   */
  async recordEarliest(e: FunnelEvent): Promise<RecordResult> {
    const key = idempotencyKey(e);
    const first = await this.record(e);
    if (first.inserted) return first;

    return this.db.transaction(async (tx) => {
      // Re-read inside the transaction and hold the row: between the record()
      // above and here, the other process may have moved it.
      const existing = await tx
        .prepare(`SELECT id, occurred_at FROM events WHERE idempotency_key = ? FOR UPDATE`)
        .get<{ id: number; occurred_at: string }>(key);
      if (!existing) return first;
      if (e.occurredAt >= existing.occurred_at) {
        return { inserted: false, eventId: Number(existing.id) };
      }

      await tx
        .prepare(`UPDATE events SET occurred_at = ?, source = ?, metadata = ? WHERE id = ?`)
        .run(e.occurredAt, e.source, e.metadata ? JSON.stringify(e.metadata) : null, existing.id);

      // The members projection guards these columns with "only if null", so it
      // will not move a value backwards on its own. Do it explicitly.
      const col =
        e.eventType === 'first_message'
          ? 'first_message_at'
          : e.eventType === 'third_message'
            ? 'third_message_at'
            : e.eventType === 'first_voice_session'
              ? 'first_voice_at'
              : null;
      // second_message has no column by design - it is a rung marker in the
      // log, nothing more - so there is nothing to pull backwards here.
      if (col) {
        await tx
          .prepare(
            `UPDATE members SET ${col} = ?
              WHERE guild_id = ? AND member_id = ? AND (${col} IS NULL OR ${col} > ?)`,
          )
          .run(e.occurredAt, e.guildId, e.memberId, e.occurredAt);
      }
      return { inserted: false, eventId: Number(existing.id) };
    });
  }

  /** Mark a member row as a bot so the funnel queries can exclude it. */
  async markBot(guildId: string, memberId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO members (guild_id, member_id, is_bot) VALUES (?, ?, TRUE)
         ON CONFLICT (guild_id, member_id) DO UPDATE SET is_bot = TRUE`,
      )
      .run(guildId, memberId);
  }

  /** Bump activity without emitting a funnel event (every message, not just the first). */
  async touchActivity(guildId: string, memberId: string, atIso: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO members (guild_id, member_id, last_active_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id, member_id) DO UPDATE SET last_active_at = excluded.last_active_at
           WHERE members.last_active_at IS NULL OR members.last_active_at < excluded.last_active_at`,
      )
      .run(guildId, memberId, atIso);
  }

  /**
   * Which message milestone a message arriving at `atIso` would fill, or null
   * if it fills none.
   *
   * The ladder lives in the event log rather than in a counter column: a
   * member's rung is "the lowest of first/second/third_message they do not have
   * yet". That keeps `members` a projection of `events` - the schema's rule -
   * and it means the number that matters, WHEN the third message landed, is
   * recorded rather than inferred from a total. A running count could never
   * answer AM7's question: 40 messages today says nothing about day 7.
   *
   * Null once all three are on file, which is the common case for a talkative
   * member and costs one indexed read per message. There is no fourth rung; we
   * stop counting at the bar.
   */
  async nextMessageRung(
    guildId: string,
    memberId: string,
    atIso: string,
  ): Promise<MessageRung | null> {
    const rows = await this.db
      .prepare(
        `SELECT event_type, occurred_at FROM events
          WHERE guild_id = ? AND member_id = ? AND event_type IN (?, ?, ?)`,
      )
      .all<{ event_type: string; occurred_at: string }>(guildId, memberId, ...MESSAGE_RUNGS);
    const filled = new Map(rows.map((r) => [r.event_type, r.occurred_at]));

    let below: string | null = null;
    for (const rung of MESSAGE_RUNGS) {
      const at = filled.get(rung);
      if (at === undefined) {
        // Strictly after the rung below. A gateway resume can redeliver a
        // message we have already counted, and a redelivery carries the
        // original timestamp - so "same instant as the rung below" is treated
        // as the same message, not a new one. Two genuinely distinct messages
        // in the same millisecond are lost to this, which costs a member their
        // text activation in a case we have never seen; counting a redelivery
        // twice would inflate AM7, and inflating AM7 is the failure this whole
        // change exists to end.
        return below !== null && atIso <= below ? null : rung;
      }
      below = at;
    }
    return null;
  }

  async hasEvent(guildId: string, memberId: string, type: EventType): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS x FROM events WHERE guild_id = ? AND member_id = ? AND event_type = ? LIMIT 1`,
      )
      .get(guildId, memberId, type);
    return !!row;
  }

  /**
   * Seconds between the first `from` event and the first `to` event for one
   * member. Returns null if either side never happened, which is the common
   * case and not an error - it just means that member has not crossed the
   * stage yet.
   *
   * Used for the "under 60 seconds" claim in TWO-7. Measuring it from the
   * event log rather than a timer means it stays true across bot restarts.
   */
  async secondsBetween(
    guildId: string,
    memberId: string,
    from: EventType,
    to: EventType,
  ): Promise<number | null> {
    const row = await this.db
      .prepare(
        `SELECT
           MIN(CASE WHEN event_type = ? THEN occurred_at END) AS a,
           MIN(CASE WHEN event_type = ? THEN occurred_at END) AS b
         FROM events
         WHERE guild_id = ? AND member_id = ? AND event_type IN (?, ?)`,
      )
      .get<{ a: string | null; b: string | null }>(from, to, guildId, memberId, from, to);
    if (!row?.a || !row?.b) return null;
    return (Date.parse(row.b) - Date.parse(row.a)) / 1000;
  }

  /**
   * Seconds from `member_join` to `gate_cleared` for one member, or null when
   * there is no measurable clearing on file (TOG-6474).
   *
   * A backfilled clearing (`source` starting with `backfill:`, or
   * `metadata.timestampIsJoinTime` - see `isMeasurableGateClearing`) says THAT
   * the member is through the gate, never WHEN: its `occurred_at` is the join
   * time, a placeholder. Feeding it to time-to-clear arithmetic would print
   * members clearing in 0s. Such rows still count toward conversion - that is
   * what the binary is for - they just never feed timing.
   *
   * The generic `secondsBetween` above stays source-blind on purpose: its
   * other pairs (join -> channel_routed, join -> first_message) have no
   * placeholder rows, so the exclusion belongs to the gate pair, not to it.
   */
  async timeToGateClearSeconds(guildId: string, memberId: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        `SELECT source, metadata, occurred_at FROM events
         WHERE guild_id = ? AND member_id = ? AND event_type = 'gate_cleared'
         ORDER BY occurred_at ASC
         LIMIT 1`,
      )
      .get<{ source: string; metadata: string | null; occurred_at: string }>(guildId, memberId);
    if (!row) return null;
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    if (!isMeasurableGateClearing(row.source, metadata)) return null;
    return this.secondsBetween(guildId, memberId, 'member_join', 'gate_cleared');
  }

  /** Distinct members who reached a given stage. Repeatable events count once. */
  async countMembersWith(type: EventType): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT member_id) AS n FROM events
         WHERE event_type = ? AND member_id IS NOT NULL`,
      )
      .get<{ n: number }>(type);
    return Number(row?.n ?? 0);
  }

  /**
   * Count events of one type, optionally within a single guild.
   *
   * `guildId` is optional because the live bot serves one guild and every
   * caller there means "all of them". The staging database does NOT have that
   * property: it accumulates a fixture set per guild id it has ever been
   * seeded with, and the unscoped count then sums them. Measured 2026-09-05 -
   * `staging-reset.ts` seeded correctly under the real guild
   * `1545644954272137297` while an older synthetic set under
   * `999999999999999001` was still present, and the verification step reported
   * every count as exactly doubled and exited 1 on a database that was in fact
   * correct. Seeding and clearing were already guild-scoped; only the counting
   * was not.
   */
  async countByType(type: EventType, guildId?: string): Promise<number> {
    const row =
      guildId === undefined
        ? await this.db
            .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = ?`)
            .get<{ n: number }>(type)
        : await this.db
            .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = ? AND guild_id = ?`)
            .get<{ n: number }>(type, guildId);
    return Number(row?.n ?? 0);
  }

  async recent(limit = 20): Promise<unknown[]> {
    return this.db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(limit);
  }
}
