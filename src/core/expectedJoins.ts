/**
 * Join attribution for one-click joins. docs/INTERNAL_ACTIONS.md §7.
 *
 * A `guild.add_member` join arrives through PUT /guilds/.../members/..., so no
 * invite code is consumed and the invite tracker files it `unknown`. This is
 * the note that fixes it: at the moment the bot makes the add call it records
 * "expect a join for this member id within 30 seconds, source `web:one_click`",
 * and the gateway guildMemberAdd handler consumes the note and stamps the
 * source. No token involved, no extra request, no new field from the caller.
 *
 * Deliberately in-memory. The add call and the gateway event are seconds apart
 * inside one process; if the bot dies between them the join is attributed
 * `unknown`, which is the honest fallback the tracker already has for a join
 * it did not witness properly. A durable note would buy nothing but a stale
 * row to sweep.
 */

/** §7 says 30 seconds, and the gateway usually delivers within one. */
const DEFAULT_TTL_SECONDS = 30;

export interface ExpectedJoinsOptions {
  ttlSeconds?: number;
  /** Injectable clock, milliseconds. Tests use it to age entries. */
  now?: () => number;
}

export class ExpectedJoins {
  private notes = new Map<string, { source: string; at: number }>();
  private ttlMs: number;
  private now: () => number;

  constructor(opts: ExpectedJoinsOptions = {}) {
    this.ttlMs = (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Note that a join for this member is about to happen. Call this BEFORE the
   * Discord call, not after: the gateway can deliver guildMemberAdd before the
   * REST response comes back, and a note taken afterwards would lose exactly
   * the joins it exists to attribute. A note for a call that then fails is
   * harmless - nobody joins, and it expires.
   */
  expect(guildId: string, memberId: string, source: string): void {
    this.sweep(this.now());
    this.notes.set(key(guildId, memberId), { source, at: this.now() });
  }

  /**
   * The source for a join, if one was expected, consuming the note. Null means
   * this join was not announced and attribution proceeds as normal. One join
   * consumes one note - a later rejoin by the same member is a new, ordinary
   * join.
   */
  consume(guildId: string, memberId: string): string | null {
    const t = this.now();
    this.sweep(t);
    const k = key(guildId, memberId);
    const note = this.notes.get(k);
    if (!note) return null;
    this.notes.delete(k);
    return t - note.at < this.ttlMs ? note.source : null;
  }

  get size(): number {
    return this.notes.size;
  }

  /**
   * Drop expired notes. Called on every operation, so the map is bounded by
   * the add_member rate over 30s - at that action's own 30/minute limit the
   * ceiling is a handful of entries.
   */
  private sweep(t: number): void {
    for (const [k, note] of this.notes) {
      if (t - note.at >= this.ttlMs) this.notes.delete(k);
    }
  }
}

function key(guildId: string, memberId: string): string {
  return `${guildId}:${memberId}`;
}

/** The one source value this mechanism stamps. docs/EVENTS.md. */
export const WEB_ONE_CLICK_SOURCE = 'web:one_click';
