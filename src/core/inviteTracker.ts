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
 * Attribution-quality categories for the funnel report (TOG-5681).
 *
 * EVENTS.md documents `ambiguous:a+b` (several invites grew at once, genuinely
 * indistinguishable) and `unknown` (nothing grew and no vanity URL - Discovery,
 * or a join from while the bot was offline) as DIFFERENT facts with different
 * fixes. Rounding one into the other hides which problem to work on, so the
 * report keeps them in separate buckets and this module owns the split.
 */
export type AttributionCategory = 'ambiguous' | 'unknown' | 'other';

/** Which funnel-report bucket one join `source` string belongs in. */
export function attributionCategory(source: string): AttributionCategory {
  if (source === 'unknown') return 'unknown';
  if (source === 'ambiguous' || source.startsWith('ambiguous:')) return 'ambiguous';
  return 'other';
}

/** Counts of the two honest-failure buckets over grouped join rows. */
export function summarizeAttributionSplit(
  rows: readonly { source: string; n: number | string }[],
): { ambiguous: number; unknown: number } {
  let ambiguous = 0;
  let unknown = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (attributionCategory(r.source) === 'ambiguous') ambiguous += n;
    else if (attributionCategory(r.source) === 'unknown') unknown += n;
  }
  return { ambiguous, unknown };
}

// --- join-downtime unknown attribution (TOG-5719) ---------------------------
//
// EVENTS.md limit 3: joins that happen while the bot is down are attributed
// `unknown` - the member still gets counted but the invite delta is lost -
// with no accounting of how much of `unknown` that explains.
//
// What this DOES instead: it names each bot-down window (a gap in the bot's
// own append-only write series, `events.recorded_at` - every row is proof the
// bot was alive to write it, cf. src/core/voiceSessions.ts TOG-5683) and
// counts the `unknown` joins whose Discord timestamp (`occurred_at`) falls
// inside each window. A count, never a re-attribution: the rows stay
// `unknown`, and this says how many of them the outage explains.
//
// Pure functions over caller-supplied rows, deliberately - same reasoning as
// the voice blind-window reconcile. The funnel script feeds them the write
// timestamps and the join rows; the tests feed them fixtures.
//
// Window detection itself lives in src/core/voiceSessions.ts
// (`findBlindWindows`); this module owns only the join side so the reviewer
// verifies one gap function, not two. The type is re-declared here rather
// than imported so this module stays dependency-free and the shape stays
// pinned for the funnel contract.
//
// Two honesty rules shape the counting:
//   1. Only `unknown` counts. A join inside a window that still carries an
//      invite code (e.g. via the host-less capture path) was attributed
//      despite the gap and is not downtime-unknown. `ambiguous` and `vanity`
//      are different facts with different fixes and stay out.
//   2. The write series is coarse - a quiet stretch with no writes reads as a
//      gap - so this is an UPPER BOUND on outage-caused unknowns, not a
//      proof. The report says so.

/** One interval in which the bot was not writing. Shape-matches BlindWindow. */
export interface DowntimeWindow {
  /** ISO-8601 UTC of the last write before the gap. */
  start: string;
  /** ISO-8601 UTC of the first write after the gap. */
  end: string;
  /** `end` minus `start` in milliseconds. */
  gapMs: number;
}

/** A down window plus the unknown joins attributed to it. */
export interface DowntimeWindowCount extends DowntimeWindow {
  /** `member_join` rows with `source = 'unknown'` and `occurred_at` in-window. */
  downtimeUnknown: number;
}

/** The only two fields the downtime count needs from a join row. */
export interface DowntimeJoin {
  /** ISO-8601 UTC (Discord's timestamp, not when we wrote the row). */
  occurredAt: string;
  /** Attribution string, e.g. `unknown`, `invite:abc`, `ambiguous:x+y`. */
  source: string;
}

/**
 * Attribute each `unknown` join to the window containing its `occurred_at`.
 * Windows are half-open `[start, end)`: a join at exactly `end` was observed
 * by the write that closed the gap. Known-source, ambiguous and vanity joins
 * are ignored; malformed timestamps are skipped; joins outside every window
 * are left unattributed (they still come back in the unattributed remainder
 * the caller derives, so the numbers reconcile).
 */
export function countDowntimeUnknownJoins(
  windows: readonly DowntimeWindow[],
  joins: readonly DowntimeJoin[],
): DowntimeWindowCount[] {
  const counts: DowntimeWindowCount[] = windows.map((w) => ({ ...w, downtimeUnknown: 0 }));
  const bounds = counts.map((w) => ({ start: Date.parse(w.start), end: Date.parse(w.end) }));
  for (const j of joins) {
    if (j.source !== 'unknown') continue;
    const t = Date.parse(j.occurredAt);
    if (Number.isNaN(t)) continue;
    for (let i = 0; i < counts.length; i++) {
      const b = bounds[i];
      if (Number.isNaN(b.start) || Number.isNaN(b.end)) continue;
      if (b.start <= t && t < b.end) {
        counts[i].downtimeUnknown++;
        break;
      }
    }
  }
  return counts;
}

/** Total downtime-unknown joins across all windows. Always <= total unknown. */
export function totalDowntimeUnknown(counts: readonly DowntimeWindowCount[]): number {
  return counts.reduce((a, w) => a + w.downtimeUnknown, 0);
}

/** One line per window, each naming the window and its count. */
export function renderDowntimeReport(counts: readonly DowntimeWindowCount[]): string[] {
  if (counts.length === 0) {
    return ['  No bot-down windows in write history - nothing unknown that we can attribute to downtime.'];
  }
  return counts.map(
    (w) =>
      `  Down window ${w.start} -> ${w.end} ` +
      `(${(w.gapMs / 3_600_000).toFixed(1)}h gap): ` +
      `${w.downtimeUnknown} unknown join(s) in-window (still unknown, outage explains them)`,
  );
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
