import type { Db } from '../store/db.ts';

export interface InviteState {
  code: string;
  uses: number;
  inviterId: string | null;
  channelId: string | null;
}

/**
 * How much each invite code was used between two readings of the counters.
 *
 * The live bot never needs this - it diffs one join at a time. The host-less
 * capture path (scripts/capture.ts) does, because a window can contain several
 * joins and we want to know whether the arithmetic adds up before we attribute
 * anything.
 *
 * Two cases that are easy to get wrong and are the reason this is a named,
 * tested function rather than three lines inline:
 *
 *   * A code absent from `prev` was created inside the window, so ALL of its
 *     uses are new. Treating it as delta 0 silently loses attribution for the
 *     newest invite - which is usually the one a growth push is using.
 *   * A code whose count went DOWN (deleted and recreated, or Discord resetting
 *     a temporary invite) is not negative growth. Clamp it out; never let it
 *     cancel a real increase somewhere else.
 */
export function inviteGrowth(
  prev: Map<string, number>,
  current: readonly InviteState[],
): Map<string, number> {
  const growth = new Map<string, number>();
  for (const inv of current) {
    const before = prev.get(inv.code);
    const delta = before === undefined ? inv.uses : inv.uses - before;
    if (delta > 0) growth.set(inv.code, delta);
  }
  return growth;
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
