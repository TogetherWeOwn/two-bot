import type { Db } from '../store/db.ts';

export interface InviteState {
  code: string;
  uses: number;
  inviterId: string | null;
  channelId: string | null;
}

/**
 * Discord does not tell you which invite a member used. The standard trick is
 * to keep a snapshot of every invite's use count and, on a join, find the code
 * whose count went up. That is what this does.
 *
 * It is best-effort: two joins in the same instant through different invites
 * can be ambiguous, and joins through the vanity URL or Discovery show up as
 * no delta. We report those honestly as 'vanity'/'unknown' rather than guessing.
 */
export class InviteTracker {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Replace the stored snapshot for a guild and return the codes that grew. */
  async diffAndStore(guildId: string, current: InviteState[]): Promise<string[]> {
    const prev = new Map<string, number>();
    for (const row of await this.db
      .prepare(`SELECT code, uses FROM invite_snapshots WHERE guild_id = ?`)
      .all<{ code: string; uses: number }>(guildId)) {
      prev.set(row.code, Number(row.uses));
    }

    const grew: string[] = [];
    const now = new Date().toISOString();
    const seen = new Set<string>();

    for (const inv of current) {
      seen.add(inv.code);
      const before = prev.get(inv.code);
      if (before !== undefined && inv.uses > before) grew.push(inv.code);
      await this.db
        .prepare(
          `INSERT INTO invite_snapshots (guild_id, code, uses, inviter_id, channel_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, code) DO UPDATE SET
             uses = excluded.uses, inviter_id = excluded.inviter_id,
             channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
        )
        .run(guildId, inv.code, inv.uses, inv.inviterId, inv.channelId, now);
    }

    // Drop invites that no longer exist so a recreated code does not look like a jump.
    for (const code of prev.keys()) {
      if (!seen.has(code)) {
        await this.db
          .prepare(`DELETE FROM invite_snapshots WHERE guild_id = ? AND code = ?`)
          .run(guildId, code);
      }
    }

    return grew;
  }

  /** Attribution string for a join, given the codes that grew. */
  attribute(grew: string[], guildHasVanity: boolean): string {
    if (grew.length === 1) return `invite:${grew[0]}`;
    if (grew.length > 1) return `ambiguous:${grew.join('+')}`;
    return guildHasVanity ? 'vanity' : 'unknown';
  }

  async inviterFor(guildId: string, code: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT inviter_id FROM invite_snapshots WHERE guild_id = ? AND code = ?`)
      .get<{ inviter_id: string | null }>(guildId, code);
    return row?.inviter_id ?? null;
  }
}
