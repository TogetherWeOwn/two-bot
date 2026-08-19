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

/** One join's attribution, as decided for a whole capture window. */
export interface JoinAttribution {
  /** `invite:CODE` / `ambiguous:a+b` / `vanity` / `unknown`. */
  source: string;
  /**
   * True only when THIS member provably came through THIS code. False means
   * the source is right in aggregate but the member<->code pairing is not
   * observable, so per-code join COUNTS may be quoted and per-member rates
   * (AM7/AM30) may not.
   */
  exact: boolean;
}

/**
 * Decide a source for every join in one capture window.
 *
 * The thing this exists to fix: `attribute()` below collapses the window to a
 * single string, so a window where code A gained 2 and code B gained 1 with 3
 * new members recorded three joins of `ambiguous:A+B`. But that window is
 * fully determined in aggregate - A produced 2 joins, B produced 1 - and "which
 * listing site produces joins" is exactly a per-code count. Throwing it away
 * forced the campaign to stagger launches two codes at a time; it does not any
 * more.
 *
 * The rules, in the order they are tried:
 *
 *   * Nothing moved -> vanity or unknown, as before. Nobody's source is proven.
 *   * The counters and the member list AGREE on how many people arrived -> hand
 *     each code as many joins as it gained. Exact per-code counts.
 *   * They DISAGREE -> somebody joined and left inside the window, or came via
 *     the vanity URL, so the arithmetic does not close and any split would be a
 *     guess dressed as a number. Fall back to the honest `ambiguous:a+b`.
 *
 * WHERE `exact` IS TRUE, AND WHY IT IS NARROWER THAN "ONE CODE MOVED"
 *
 * Only when one code moved AND the arithmetic closes. One code gaining 1 use
 * while two members appear means one of those two did NOT come through it - we
 * still stamp the code on both (unchanged behaviour, it is the best guess
 * available and the run prints the mismatch), but it is not proof, so it is not
 * flagged as proof.
 *
 * Order within a distribution is arbitrary by construction: joins are handed
 * out in sorted code order against joins in arrival order, and no claim is made
 * that member #1 is A's. That is precisely what `exact: false` records.
 */
export function attributeJoins(
  growth: ReadonlyMap<string, number>,
  joinCount: number,
  guildHasVanity: boolean,
): JoinAttribution[] {
  if (joinCount <= 0) return [];
  const fill = (source: string, exact: boolean): JoinAttribution[] =>
    Array.from({ length: joinCount }, () => ({ source, exact }));

  const codes = [...growth.keys()].sort();
  const total = [...growth.values()].reduce((a, b) => a + b, 0);
  const closes = total === joinCount;

  if (codes.length === 0) return fill(guildHasVanity ? 'vanity' : 'unknown', false);
  if (codes.length === 1) return fill(`invite:${codes[0]}`, closes);
  if (!closes) return fill(`ambiguous:${codes.join('+')}`, false);

  const out: JoinAttribution[] = [];
  for (const code of codes) {
    for (let i = 0; i < (growth.get(code) ?? 0); i++) {
      out.push({ source: `invite:${code}`, exact: false });
    }
  }
  return out;
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
