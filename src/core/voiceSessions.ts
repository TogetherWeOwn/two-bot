/**
 * Who is in a voice channel right now, so `voice_session_end` can carry a
 * duration (TOG-99).
 *
 * In memory on purpose. Discord serves no voice history over REST, so the only
 * thing that can tell us a session started is the gateway event we already saw.
 * A restart therefore loses every open session, and the honest thing to emit
 * afterwards is `durationSeconds: null` - not a duration measured from the
 * moment the process happened to come up, which would look like a real number
 * and be short by however long the bot was down.
 *
 * That is why the end event carries `startKnown`. A query that averages
 * durations must filter on it; a query that only counts sessions does not care.
 *
 * One entry per member per guild: Discord allows a member exactly one voice
 * channel at a time, so a move from A to B is an end for A then a start for B.
 */

export interface OpenSession {
  /** The channel the session is in - the one the END should be credited to. */
  channelId: string;
  /** ISO-8601 UTC. */
  startedAt: string;
}

function key(guildId: string, memberId: string): string {
  return `${guildId}:${memberId}`;
}

export class VoiceSessionTracker {
  // NB: explicit field, not a parameter property - Node's type-stripping
  // loader rejects those. Same constraint as EventStore. See docs/STACK.md.
  private open: Map<string, OpenSession>;

  constructor() {
    this.open = new Map();
  }

  /** Record that a member is now in voice. Replaces any session already open. */
  start(guildId: string, memberId: string, channelId: string, startedAt: string): void {
    this.open.set(key(guildId, memberId), { channelId, startedAt });
  }

  /**
   * Close the open session and return what we knew about it.
   * `null` means we never saw the start - the bot came up mid-session, or the
   * member was already in voice when we connected.
   */
  end(guildId: string, memberId: string): OpenSession | null {
    const k = key(guildId, memberId);
    const session = this.open.get(k) ?? null;
    this.open.delete(k);
    return session;
  }

  /** Whether we are holding an open session for this member. */
  isOpen(guildId: string, memberId: string): boolean {
    return this.open.has(key(guildId, memberId));
  }

  /** How many sessions we believe are open. Diagnostics and tests. */
  get openCount(): number {
    return this.open.size;
  }

  /** Drop everything. Used when the gateway reconnects and state is suspect. */
  clear(): void {
    this.open.clear();
  }
}
