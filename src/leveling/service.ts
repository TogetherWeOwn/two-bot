import type { Db } from '../store/driver.ts';

export const MESSAGE_XP = 15;
export const MESSAGE_COOLDOWN_SECONDS = 60;
export const VOICE_XP_PER_MINUTE = 5;
export const VOICE_COOLDOWN_SECONDS = 60;
export const MAX_STORED_XP = Number.MAX_SAFE_INTEGER;

export type XpSource = 'message' | 'voice';

class XpCeilingReached extends Error {}

export interface LevelProfile {
  guildId: string;
  memberId: string;
  xp: number;
  level: number;
  messageXp: number;
  voiceXp: number;
  importedXp: number;
  rank: number;
  memberCount: number;
  nextLevelXp: number;
}

export interface LeaderboardEntry {
  memberId: string;
  xp: number;
  level: number;
  rank: number;
}

export interface LevelRoleReward {
  level: number;
  roleId: string;
}

export interface XpAward {
  awarded: number;
  totalXp: number;
  level: number;
  previousLevel: number;
  leveledUp: boolean;
}

export interface Mee6ImportRow {
  memberId: string;
  xp: number;
  level?: number;
}

export interface ImportSummary {
  sourceRows: number;
  uniqueMembers: number;
  inserted: number;
  updated: number;
  unchanged: number;
  duplicateRows: number;
  totalImportedXp: number;
}

export function totalXpForLevel(level: number): number {
  if (!Number.isInteger(level) || level < 0) throw new Error('level must be a non-negative integer');
  return Math.floor((5 / 6) * level * (2 * level * level + 27 * level + 91));
}

export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp < 0) throw new Error('xp must be a non-negative number');
  let low = 0;
  let high = 1;
  while (totalXpForLevel(high) <= xp) high *= 2;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (totalXpForLevel(mid) <= xp) low = mid;
    else high = mid;
  }
  return low;
}

function clampXp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_STORED_XP) {
    throw new Error(`xp must be an integer between 0 and ${MAX_STORED_XP}`);
  }
  return value;
}

function isoOrThrow(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('occurredAt must be an ISO-8601 timestamp');
  return new Date(ms).toISOString();
}

export class LevelingService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async awardMessage(
    guildId: string,
    memberId: string,
    occurredAt: string,
    channelId?: string,
  ): Promise<XpAward> {
    return this.award(guildId, memberId, 'message', MESSAGE_XP, occurredAt, channelId);
  }

  async awardVoice(
    guildId: string,
    memberId: string,
    durationSeconds: number,
    occurredAt: string,
    channelId?: string,
  ): Promise<XpAward> {
    // TOG-7512: a non-finite duration must award nothing. Math.floor(NaN) is
    // NaN, and NaN slips past the `amount <= 0` guard in award(), so without
    // this an unmeasurable session could write garbage XP.
    if (!Number.isFinite(durationSeconds)) return this.currentAward(guildId, memberId);
    const minutes = Math.floor(Math.max(0, durationSeconds) / 60);
    return this.award(
      guildId,
      memberId,
      'voice',
      minutes * VOICE_XP_PER_MINUTE,
      occurredAt,
      channelId,
    );
  }

  private async award(
    guildId: string,
    memberId: string,
    source: XpSource,
    amount: number,
    occurredAt: string,
    channelId?: string,
  ): Promise<XpAward> {
    const at = isoOrThrow(occurredAt);
    // TOG-7512: NaN slips past `amount <= 0` (every comparison on NaN is
    // false), so a non-finite amount must be refused explicitly - no write,
    // no cooldown claim, current totals back.
    if (!Number.isFinite(amount) || amount <= 0) return this.currentAward(guildId, memberId);
    const cooldownSeconds = source === 'message' ? MESSAGE_COOLDOWN_SECONDS : VOICE_COOLDOWN_SECONDS;

    try {
      return await this.db.transaction(async (tx) => {
        const before = await tx
          .prepare(`SELECT xp FROM member_levels WHERE guild_id = ? AND member_id = ?`)
          .get<{ xp: number }>(guildId, memberId);
        const previousXp = Number(before?.xp ?? 0);
        const previousLevel = levelForXp(previousXp);

        const claimed = await tx
          .prepare(
            `INSERT INTO xp_cooldowns (guild_id, member_id, source, last_awarded_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (guild_id, member_id, source) DO UPDATE
               SET last_awarded_at = excluded.last_awarded_at
             WHERE xp_cooldowns.last_awarded_at <= ?
             RETURNING last_awarded_at`,
          )
          .get<{ last_awarded_at: string }>(
            guildId,
            memberId,
            source,
            at,
            new Date(Date.parse(at) - cooldownSeconds * 1000).toISOString(),
          );

        if (!claimed) {
          return {
            awarded: 0,
            totalXp: previousXp,
            level: previousLevel,
            previousLevel,
            leveledUp: false,
          };
        }

        const messageXp = source === 'message' ? amount : 0;
        const voiceXp = source === 'voice' ? amount : 0;
        const row = await tx
          .prepare(
            `INSERT INTO member_levels
               (guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?)
             ON CONFLICT (guild_id, member_id) DO UPDATE SET
               xp = member_levels.xp + excluded.xp,
               message_xp = member_levels.message_xp + excluded.message_xp,
               voice_xp = member_levels.voice_xp + excluded.voice_xp,
               updated_at = excluded.updated_at
             WHERE member_levels.xp <= ?
             RETURNING xp`,
          )
          .get<{ xp: number }>(
            guildId,
            memberId,
            amount,
            messageXp,
            voiceXp,
            at,
            MAX_STORED_XP - amount,
          );
        if (!row) throw new XpCeilingReached();
        const totalXp = Number(row.xp);
        const level = levelForXp(totalXp);
        await tx
          .prepare(
            `INSERT INTO xp_awards
               (guild_id, member_id, source, xp, occurred_at, channel_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(guildId, memberId, source, amount, at, channelId ?? null);

        return {
          awarded: amount,
          totalXp,
          level,
          previousLevel,
          leveledUp: level > previousLevel,
        };
      });
    } catch (err) {
      if (!(err instanceof XpCeilingReached)) throw err;
      return this.currentAward(guildId, memberId);
    }
  }

  private async currentAward(guildId: string, memberId: string): Promise<XpAward> {
    const row = await this.db
      .prepare(`SELECT xp FROM member_levels WHERE guild_id = ? AND member_id = ?`)
      .get<{ xp: number }>(guildId, memberId);
    const totalXp = Number(row?.xp ?? 0);
    const level = levelForXp(totalXp);
    return { awarded: 0, totalXp, level, previousLevel: level, leveledUp: false };
  }

  async profile(guildId: string, memberId: string): Promise<LevelProfile> {
    const row = await this.db
      .prepare(
        `SELECT xp, message_xp, voice_xp, imported_xp
           FROM member_levels
          WHERE guild_id = ? AND member_id = ?`,
      )
      .get<{ xp: number; message_xp: number; voice_xp: number; imported_xp: number }>(
        guildId,
        memberId,
      );
    const xp = Number(row?.xp ?? 0);
    const ranked = await this.db
      .prepare(
        `SELECT COUNT(*) AS rank
           FROM member_levels
          WHERE guild_id = ?
            AND (xp > ? OR (xp = ? AND member_id < ?))`,
      )
      .get<{ rank: number }>(guildId, xp, xp, memberId);
    const total = await this.db
      .prepare(`SELECT COUNT(*) AS count FROM member_levels WHERE guild_id = ?`)
      .get<{ count: number }>(guildId);
    const level = levelForXp(xp);
    return {
      guildId,
      memberId,
      xp,
      level,
      messageXp: Number(row?.message_xp ?? 0),
      voiceXp: Number(row?.voice_xp ?? 0),
      importedXp: Number(row?.imported_xp ?? 0),
      rank: Number(ranked?.rank ?? 0) + 1,
      memberCount: Number(total?.count ?? 0),
      nextLevelXp: totalXpForLevel(level + 1),
    };
  }

  async leaderboard(guildId: string, limit = 10): Promise<LeaderboardEntry[]> {
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));
    const rows = await this.db
      .prepare(
        `SELECT member_id, xp
           FROM member_levels
          WHERE guild_id = ?
          ORDER BY xp DESC, member_id ASC
          LIMIT ?`,
      )
      .all<{ member_id: string; xp: number }>(guildId, safeLimit);
    return rows.map((row, index) => ({
      memberId: row.member_id,
      xp: Number(row.xp),
      level: levelForXp(Number(row.xp)),
      rank: index + 1,
    }));
  }

  async roleRewards(guildId: string): Promise<LevelRoleReward[]> {
    const rows = await this.db
      .prepare(
        `SELECT level, role_id
           FROM level_role_rewards
          WHERE guild_id = ?
          ORDER BY level ASC`,
      )
      .all<{ level: number; role_id: string }>(guildId);
    return rows.map((row) => ({ level: Number(row.level), roleId: row.role_id }));
  }

  async replaceRoleRewards(
    guildId: string,
    rewards: readonly LevelRoleReward[],
  ): Promise<void> {
    const normalized = new Map<number, string>();
    for (const reward of rewards) {
      if (!Number.isInteger(reward.level) || reward.level <= 0) {
        throw new Error('reward level must be a positive integer');
      }
      if (!/^\d{17,20}$/.test(reward.roleId)) {
        throw new Error(`invalid Discord role id: ${reward.roleId}`);
      }
      normalized.set(reward.level, reward.roleId);
    }
    await this.db.transaction(async (tx) => {
      await tx.prepare(`DELETE FROM level_role_rewards WHERE guild_id = ?`).run(guildId);
      for (const [level, roleId] of normalized) {
        await tx
          .prepare(
            `INSERT INTO level_role_rewards (guild_id, level, role_id)
             VALUES (?, ?, ?)`,
          )
          .run(guildId, level, roleId);
      }
    });
  }

  async importMee6(
    guildId: string,
    rows: readonly Mee6ImportRow[],
    importedAt = new Date().toISOString(),
  ): Promise<ImportSummary> {
    const at = isoOrThrow(importedAt);
    const byMember = new Map<string, number>();
    let duplicateRows = 0;
    for (const row of rows) {
      if (!/^\d{17,20}$/.test(row.memberId)) throw new Error(`invalid Discord member id: ${row.memberId}`);
      const xp = clampXp(row.xp);
      if (row.level !== undefined && levelForXp(xp) !== row.level) {
        throw new Error(`MEE6 row level does not match XP for member ${row.memberId}`);
      }
      if (byMember.has(row.memberId)) duplicateRows++;
      byMember.set(row.memberId, Math.max(byMember.get(row.memberId) ?? 0, xp));
    }

    return this.db.transaction(async (tx) => {
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let totalImportedXp = 0;

      for (const [memberId, xp] of byMember) {
        totalImportedXp += xp;
        if (!Number.isSafeInteger(totalImportedXp)) {
          throw new Error('total imported XP exceeds the safe integer range');
        }
        const created = await tx
          .prepare(
            `INSERT INTO member_levels
               (guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at)
             VALUES (?, ?, ?, 0, 0, ?, ?)
             ON CONFLICT (guild_id, member_id) DO NOTHING
             RETURNING member_id`,
          )
          .get<{ member_id: string }>(guildId, memberId, xp, xp, at);
        if (created) {
          inserted++;
          continue;
        }

        const changed = await tx
          .prepare(
            `UPDATE member_levels
                SET imported_xp = ?,
                    xp = message_xp + voice_xp + ?,
                    updated_at = ?
              WHERE guild_id = ? AND member_id = ?
                AND imported_xp <> ?
                AND message_xp + voice_xp <= ?
              RETURNING imported_xp`,
          )
          .get<{ imported_xp: number }>(
            xp,
            xp,
            at,
            guildId,
            memberId,
            xp,
            MAX_STORED_XP - xp,
          );
        if (changed) {
          updated++;
          continue;
        }

        const current = await tx
          .prepare(
            `SELECT imported_xp
               FROM member_levels
              WHERE guild_id = ? AND member_id = ?`,
          )
          .get<{ imported_xp: number }>(guildId, memberId);
        if (Number(current?.imported_xp) === xp) {
          unchanged++;
          continue;
        }
        throw new Error(`imported XP plus organic XP exceeds ${MAX_STORED_XP} for member ${memberId}`);
      }

      await tx
        .prepare(
          `INSERT INTO level_import_runs
             (guild_id, source, source_rows, unique_members, inserted, updated, unchanged,
              duplicate_rows, total_imported_xp, imported_at)
           VALUES (?, 'mee6', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          guildId,
          rows.length,
          byMember.size,
          inserted,
          updated,
          unchanged,
          duplicateRows,
          totalImportedXp,
          at,
        );

      return {
        sourceRows: rows.length,
        uniqueMembers: byMember.size,
        inserted,
        updated,
        unchanged,
        duplicateRows,
        totalImportedXp,
      };
    });
  }
}
