/**
 * Durable ownership for generated voice channels (TOG-3052).
 *
 * Postgres is the source of truth. Every write here is idempotent so a replayed
 * gateway event or a retried sweep converges rather than duplicating.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../store/driver.ts';

export interface TempVoiceRow {
  id: string;
  guildId: string;
  /** NULL only between reserving the row and Discord acknowledging the create. */
  channelId: string | null;
  generatorId: string;
  categoryId: string;
  ownerId: string;
  /** Durable, fixed destination for an interrupted ownership transition. */
  pendingOwnerId: string | null;
  createdBy: string;
  name: string;
  createdAt: string;
  lastRenamedAt: string | null;
  emptySince: string | null;
}

/** Why an anti-abuse claim was refused, before any Discord call was made. */
export type TempVoiceRefusal = 'user_cap' | 'guild_cap' | 'cooldown';

export interface TempVoiceAuditInput {
  guildId: string;
  actorId: string | null;
  channelId: string | null;
  action: string;
  outcome: string;
  reason?: string;
}

function mapRow(row: Record<string, unknown>): TempVoiceRow {
  const text = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: text(row.channel_id),
    generatorId: String(row.generator_id),
    categoryId: String(row.category_id),
    ownerId: String(row.owner_id),
    pendingOwnerId: text(row.pending_owner_id),
    createdBy: String(row.created_by),
    name: String(row.name),
    createdAt: String(row.created_at),
    lastRenamedAt: text(row.last_renamed_at),
    emptySince: text(row.empty_since),
  };
}

export class TempVoiceStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Claim a slot and write the row BEFORE the Discord create call, so a crash
   * mid-create leaves a dangling reservation rather than an unowned channel.
   *
   * Serialize reservations per guild: different owners still compete for the
   * same guild cap. This also serializes the per-user cap and cooldown check.
   * A per-user lock alone lets two users both claim the last guild slot.
   */
  async reserveIfUnderCaps(input: {
    guildId: string;
    generatorId: string;
    categoryId: string;
    ownerId: string;
    name: string;
    createdAt: string;
    maxPerUser: number;
    maxPerGuild: number;
    cooldownSeconds: number;
  }): Promise<{ ok: true; row: TempVoiceRow } | { ok: false; reason: TempVoiceRefusal }> {
    return this.db.transaction(async (tx) => {
      await tx.prepare(`SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`)
        .get(`tempvoice:${input.guildId}`);

      const mine = await tx.prepare(
        `SELECT COUNT(*) AS total FROM temp_voice_channels WHERE guild_id = ? AND owner_id = ?`,
      ).get<{ total: number }>(input.guildId, input.ownerId);
      if (Number(mine?.total ?? 0) >= input.maxPerUser) return { ok: false as const, reason: 'user_cap' as const };

      const all = await tx.prepare(
        `SELECT COUNT(*) AS total FROM temp_voice_channels WHERE guild_id = ?`,
      ).get<{ total: number }>(input.guildId);
      if (Number(all?.total ?? 0) >= input.maxPerGuild) return { ok: false as const, reason: 'guild_cap' as const };

      if (input.cooldownSeconds > 0) {
        const last = await tx.prepare(
          `SELECT last_created_at FROM temp_voice_creates WHERE guild_id = ? AND user_id = ?`,
        ).get<{ last_created_at: unknown }>(input.guildId, input.ownerId);
        const lastAt = last?.last_created_at ? Date.parse(String(last.last_created_at)) : NaN;
        const nowMs = Date.parse(input.createdAt);
        if (Number.isFinite(lastAt) && nowMs - lastAt < input.cooldownSeconds * 1000) {
          return { ok: false as const, reason: 'cooldown' as const };
        }
      }

      const id = randomUUID();
      await tx.prepare(
        `INSERT INTO temp_voice_channels
           (id, guild_id, channel_id, generator_id, category_id, owner_id, created_by, name, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.guildId, input.generatorId, input.categoryId,
        input.ownerId, input.ownerId, input.name, input.createdAt,
      );
      await tx.prepare(
        `INSERT INTO temp_voice_creates (guild_id, user_id, last_created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET last_created_at = excluded.last_created_at`,
      ).run(input.guildId, input.ownerId, input.createdAt);

      return {
        ok: true as const,
        row: {
          id,
          guildId: input.guildId,
          channelId: null,
          generatorId: input.generatorId,
          categoryId: input.categoryId,
          ownerId: input.ownerId,
          pendingOwnerId: null,
          createdBy: input.ownerId,
          name: input.name,
          createdAt: input.createdAt,
          lastRenamedAt: null,
          emptySince: null,
        },
      };
    });
  }

  /** Bind a reservation to the channel Discord just created. Idempotent. */
  async attach(id: string, channelId: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE temp_voice_channels SET channel_id = ?
       WHERE id = ? AND (channel_id IS NULL OR channel_id = ?)`,
    ).run(channelId, id, channelId);
    return result.changes > 0;
  }

  async getByChannel(guildId: string, channelId: string): Promise<TempVoiceRow | null> {
    const row = await this.db.prepare(
      `SELECT * FROM temp_voice_channels WHERE guild_id = ? AND channel_id = ?`,
    ).get(guildId, channelId);
    return row ? mapRow(row) : null;
  }

  async getById(id: string): Promise<TempVoiceRow | null> {
    const row = await this.db.prepare(`SELECT * FROM temp_voice_channels WHERE id = ?`).get(id);
    return row ? mapRow(row) : null;
  }

  /** Live channels only - reservations are not channels yet. */
  listLive(guildId: string): Promise<TempVoiceRow[]> {
    return this.db.prepare(
      `SELECT * FROM temp_voice_channels
       WHERE guild_id = ? AND channel_id IS NOT NULL ORDER BY created_at, id`,
    ).all(guildId).then((rows) => rows.map(mapRow));
  }

  /**
   * Reservations and live channels both count against a user's cap: a
   * reservation is a create already in flight.
   */
  async countForOwner(guildId: string, ownerId: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS total FROM temp_voice_channels WHERE guild_id = ? AND owner_id = ?`,
    ).get<{ total: number }>(guildId, ownerId);
    return Number(row?.total ?? 0);
  }

  async countForGuild(guildId: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS total FROM temp_voice_channels WHERE guild_id = ?`,
    ).get<{ total: number }>(guildId);
    return Number(row?.total ?? 0);
  }

  /** Reservations that never received a channel id, older than `before`. */
  listStaleReservations(guildId: string, before: string): Promise<TempVoiceRow[]> {
    return this.db.prepare(
      `SELECT * FROM temp_voice_channels
       WHERE guild_id = ? AND channel_id IS NULL AND created_at < ?`,
    ).all(guildId, before).then((rows) => rows.map(mapRow));
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM temp_voice_channels WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /**
   * One ownership worker per staging guild, including recovery, across processes.
   * Contenders refuse rather than pinning every pool connection behind a lock.
   *
   * This transaction holds ONLY the lock. Intent/finalization writes deliberately
   * use the ordinary store, on a second connection, so they commit before any
   * Discord mutation and survive an interrupted worker. Do not wrap this store
   * in a caller transaction: that would make the recovery journal uncommitted.
   */
  async withOwnershipLock<T>(guildId: string, fn: (assertHeld: () => Promise<void>) => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
    return this.db.transaction(async (tx) => {
      const lock = await tx.prepare(`SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS acquired`)
        .get<{ acquired: boolean }>(`tempvoice:ownership:${guildId}`);
      if (!lock?.acquired) return { acquired: false as const };
      const assertHeld = async () => { await tx.prepare('SELECT 1').get(); };
      return { acquired: true as const, value: await fn(assertHeld) };
    });
  }

  async beginOwnerChange(id: string, oldOwnerId: string, newOwnerId: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE temp_voice_channels SET pending_owner_id = ?
       WHERE id = ? AND owner_id = ? AND pending_owner_id IS NULL`,
    ).run(newOwnerId, id, oldOwnerId);
    return result.changes === 1;
  }

  async completeOwnerChange(id: string, oldOwnerId: string, newOwnerId: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE temp_voice_channels SET owner_id = ?, pending_owner_id = NULL
       WHERE id = ? AND owner_id = ? AND pending_owner_id = ?`,
    ).run(newOwnerId, id, oldOwnerId, newOwnerId);
    return result.changes === 1;
  }

  async setName(id: string, name: string, renamedAt: string): Promise<void> {
    await this.db.prepare(
      `UPDATE temp_voice_channels SET name = ?, last_renamed_at = ? WHERE id = ?`,
    ).run(name, renamedAt, id);
  }

  /** `null` clears the marker when a channel is occupied again. */
  async setEmptySince(id: string, emptySince: string | null): Promise<void> {
    await this.db.prepare(`UPDATE temp_voice_channels SET empty_since = ? WHERE id = ?`).run(emptySince, id);
  }

  async lastCreatedAt(guildId: string, userId: string): Promise<string | null> {
    const row = await this.db.prepare(
      `SELECT last_created_at FROM temp_voice_creates WHERE guild_id = ? AND user_id = ?`,
    ).get<{ last_created_at: unknown }>(guildId, userId);
    const value = row?.last_created_at;
    return value === null || value === undefined ? null : String(value);
  }

  async recordCreate(guildId: string, userId: string, at: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO temp_voice_creates (guild_id, user_id, last_created_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET last_created_at = excluded.last_created_at`,
    ).run(guildId, userId, at);
  }

  async audit(input: TempVoiceAuditInput, at: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO temp_voice_audit (id, guild_id, actor_id, channel_id, action, outcome, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), input.guildId, input.actorId, input.channelId,
      input.action, input.outcome, input.reason ?? null, at,
    );
  }
}
