/**
 * Join-burst detection.
 *
 * Three bot raids reached this server over fourteen months and nobody noticed
 * the last two for five months, because a join is invisible unless someone is
 * looking at the member list at the moment it happens. This watches the joins
 * as they arrive and says something the first time the rate stops looking like
 * people.
 *
 * It raises an alert. It does not kick, ban, prune, lock the server or change
 * a setting - see docs/RAID-RESPONSE.md for why that line is where it is.
 *
 * Framework-free on purpose: the same detector runs live on the gateway and is
 * replayed over recorded history by scripts/raid-list.ts, so the threshold we
 * ship is the threshold we can show would have caught all three past raids.
 */

export interface RaidWatchOptions {
  /** How wide the sliding window is. */
  windowSeconds?: number | (() => number);
  /**
   * Joins inside the window that constitute a burst.
   *
   * A function is read on every join rather than captured at construction,
   * which is what makes this key hot (TOG-3100): the settings store refreshes
   * its snapshot every 15s and the next join uses the new number, with no
   * restart. Passing a plain number keeps the old behaviour, which is what the
   * replay scan and every test want - a threshold that changed halfway through
   * a replay would make the result unreproducible.
   */
  threshold?: number | (() => number);
  /** Minimum gap between alerts for one ongoing burst, so a long raid is not a pager storm. */
  cooldownSeconds?: number;
  /** Cap on IDs carried in one alert. The rest are counted, not listed. */
  maxIds?: number;
}

export interface RaidAlert {
  guildId: string;
  /** Joins inside the window at the moment it tripped. */
  count: number;
  windowSeconds: number;
  /** ISO-8601 UTC of the oldest and newest join in the window. */
  firstJoinAt: string;
  lastJoinAt: string;
  /** How many seconds the burst actually spans. A raid is usually a fraction of the window. */
  spanSeconds: number;
  /** Members in the window, oldest first, capped at `maxIds`. */
  memberIds: string[];
  /** True when the window held more members than `memberIds` lists. */
  truncated: boolean;
  /** True when this burst has already alerted once and is still going. */
  repeat: boolean;
}

const DEFAULTS = {
  /**
   * Five joins in a minute.
   *
   * TWO retained roughly five real joins in the measured year, and the biggest
   * genuine day in nine years of history is well under this. Both small raids
   * put 15 accounts in under 11 seconds and the big one ran at ~18 a minute for
   * an hour, so
   * every raid on record trips this several times over while an ordinary week
   * never comes close. Verified against the recorded history by
   * `node scripts/raid-list.ts --scan`.
   */
  windowSeconds: 60,
  threshold: 5,
  cooldownSeconds: 900,
  maxIds: 50,
};

interface Recent {
  memberId: string;
  at: number;
}

/** A fixed number and a live reader, behind one signature. */
function liveNumber(v: number | (() => number) | undefined, fallback: number): () => number {
  if (typeof v === 'function') return v;
  const fixed = v ?? fallback;
  return () => fixed;
}

export class RaidWatch {
  private readonly readWindowSeconds: () => number;
  private readonly readThreshold: () => number;
  private readonly cooldownMs: number;
  private readonly maxIds: number;
  /** Per guild: joins still inside the window, oldest first. */
  private recent = new Map<string, Recent[]>();
  /** Per guild: when we last alerted, so an hour-long raid does not alert 1,015 times. */
  private lastAlertAt = new Map<string, number>();

  constructor(o: RaidWatchOptions = {}) {
    this.readWindowSeconds = liveNumber(o.windowSeconds, DEFAULTS.windowSeconds);
    this.readThreshold = liveNumber(o.threshold, DEFAULTS.threshold);
    this.cooldownMs = (o.cooldownSeconds ?? DEFAULTS.cooldownSeconds) * 1000;
    this.maxIds = o.maxIds ?? DEFAULTS.maxIds;
  }

  /**
   * Read once per join, not once per process.
   *
   * Both are read at the top of observe() and used consistently for the rest of
   * that call, so a poll landing mid-observe cannot make one join be judged
   * against two different windows.
   */
  private get windowMs(): number {
    return this.readWindowSeconds() * 1000;
  }

  private get threshold(): number {
    return this.readThreshold();
  }

  /**
   * Feed one join in. Returns an alert the moment the window is over the
   * threshold, or null.
   *
   * `at` is the join's own timestamp in ms. Gateway delivery can be late or
   * duplicated, so: a member already inside the window is ignored rather than
   * counted twice, and the window is pruned against the newest timestamp seen
   * rather than the clock, which keeps a replay of history honest.
   */
  observe(guildId: string, memberId: string, at: number): RaidAlert | null {
    // Read both once, here. They can change under us between calls now, and an
    // alert that pruned against one window but reported another would be a
    // quietly wrong number in the only message anyone reads during a raid.
    const windowMs = this.windowMs;
    const threshold = this.threshold;

    const list = this.recent.get(guildId) ?? [];
    if (list.some((r) => r.memberId === memberId)) return null;

    list.push({ memberId, at });
    list.sort((a, b) => a.at - b.at);
    const newest = list[list.length - 1].at;
    const cutoff = newest - windowMs;
    const live = list.filter((r) => r.at > cutoff);
    this.recent.set(guildId, live);

    if (live.length < threshold) return null;

    const last = this.lastAlertAt.get(guildId);
    const repeat = last !== undefined;
    if (last !== undefined && newest - last < this.cooldownMs) return null;
    this.lastAlertAt.set(guildId, newest);

    const ids = live.map((r) => r.memberId);
    return {
      guildId,
      count: live.length,
      windowSeconds: windowMs / 1000,
      firstJoinAt: new Date(live[0].at).toISOString(),
      lastJoinAt: new Date(newest).toISOString(),
      spanSeconds: Math.round((newest - live[0].at) / 1000),
      memberIds: ids.slice(0, this.maxIds),
      truncated: ids.length > this.maxIds,
      repeat,
    };
  }

  /** Joins currently inside the window for a guild. Used by tests and the scan. */
  windowSize(guildId: string): number {
    return this.recent.get(guildId)?.length ?? 0;
  }
}

/**
 * Replay recorded joins through the same detector.
 *
 * This is how we check a threshold before shipping it: run it over the joins
 * already in the database and see what it would have said. Input need not be
 * sorted.
 */
export function scanJoinsForBursts(
  joins: { guildId: string; memberId: string; occurredAt: string }[],
  opts: RaidWatchOptions = {},
): RaidAlert[] {
  const watch = new RaidWatch(opts);
  const alerts: RaidAlert[] = [];
  const ordered = [...joins].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (const j of ordered) {
    const at = Date.parse(j.occurredAt);
    if (Number.isNaN(at)) continue;
    const alert = watch.observe(j.guildId, j.memberId, at);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

/**
 * The staff-channel text.
 *
 * Written for whoever is on their phone at 21:16 on a Monday: what happened,
 * how sure we are, and the two things worth doing about it. It names no action
 * the bot has taken, because the bot takes none.
 */
export function formatRaidAlert(a: RaidAlert): string {
  const when = a.spanSeconds <= 1 ? 'within a second' : `in ${a.spanSeconds}s`;
  const head = a.repeat
    ? `**Join burst still going** - ${a.count} more joins ${when}.`
    : `**Join burst** - ${a.count} accounts joined ${when} (threshold: ${DEFAULTS.threshold} in ${a.windowSeconds}s).`;

  const ids = a.memberIds.map((id) => `\`${id}\``).join(' ');
  const more = a.truncated ? ` ...and ${a.count - a.memberIds.length} more` : '';

  return [
    head,
    `First ${a.firstJoinAt}, last ${a.lastJoinAt}.`,
    '',
    `IDs: ${ids}${more}`,
    '',
    'This is an alert only - the bot has kicked, banned and messaged nobody.',
    'Next: 1. Run `node scripts/roster.ts 1` to see which invite sent them.',
    '2. If it is a raid, Server Settings -> Safety Setup -> pause invites.',
  ].join('\n');
}
