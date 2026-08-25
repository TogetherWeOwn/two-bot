/**
 * The presence probe (TOG-469): collect the series, store it, never show it.
 *
 * Reads two numbers on a slow cadence and writes them to `presence_probe`:
 *
 *   approximate_presence_count - REST, guild-level aggregate, NO gateway intent
 *   bot floor                  - members with `user.bot` true, as a COUNT
 *
 * Read migration 0004 before changing anything here. The short version: this
 * is allowed to exist only because it needs no new intent, stores no
 * per-member row, and never reaches a page. If a change to this file breaks
 * one of those three, the change is wrong rather than the rule.
 *
 * Nothing in this module has a rendering path. It writes to a table the
 * website's role is REVOKEd from, and the only reader is
 * `scripts/presence-trend.ts`, which prints to a terminal.
 */
import type { Db } from '../store/db.ts';
import { DiscordRest, fetchAllMembers } from '../discord/rest.ts';
import { nowIso } from '../core/events.ts';
import { log } from '../core/log.ts';
import type { PresenceReading } from '../analytics/presence.ts';

/**
 * Hourly. This is a trend instrument, not a live counter.
 *
 * Explicitly NOT the 60s counter refresh in docs/WEBSITE_CONTRACT.md §5 - that
 * job feeds a page and this one must never share a code path with anything
 * that does. Presence moves over an evening; sampling it every minute would
 * buy nothing and put 60x the Discord calls behind a number nobody sees.
 */
export const PRESENCE_PROBE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How stale a bot floor may get before we re-list members.
 *
 * The roster changes a few times a year. Re-listing every member every hour
 * would page 100+ member objects through this process to re-derive a number
 * that did not move - a lot of per-member data touched for nothing. Once a day
 * is far more often than the floor actually drifts.
 */
export const BOT_FLOOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Only the field we read. Discord returns plenty more; we want none of it. */
export interface RawGuildCounts {
  approximate_presence_count?: number;
  approximate_member_count?: number;
}

/**
 * Read `approximate_presence_count`.
 *
 * `with_counts=true` is the whole trick: it makes this an aggregate on a REST
 * response rather than a stream of per-member status changes, which is the
 * difference between this instrument and the intent TOG-75 declined.
 *
 * Returns null when Discord did not answer with a usable number. Null means
 * "we did not read it", and the caller writes nothing - the same rule the
 * counter collectors follow (docs/WEBSITE_CONTRACT.md §3). Nothing here ever
 * writes a 0 to represent a failure.
 */
export async function fetchPresenceCount(
  rest: DiscordRest,
  guildId: string,
): Promise<number | null> {
  const guild = await rest.get<RawGuildCounts>(`/guilds/${guildId}?with_counts=true`);
  const n = guild?.approximate_presence_count;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

/**
 * Count members whose account is a bot.
 *
 * Returns a COUNT and nothing else. The member list necessarily passes through
 * this function - Discord has no endpoint that counts bots for us - but no id
 * is returned, stored, or logged, and the array is unreachable once this
 * returns. That containment is the reason this stays a function rather than
 * being inlined into the cycle below, and there is a test that a member id
 * never appears in the value it hands back.
 *
 * This uses the GuildMembers intent the bot ALREADY holds
 * (src/discord/client.ts:22-28). It adds nothing.
 */
export async function countBotFloor(rest: DiscordRest, guildId: string): Promise<number | null> {
  const members = await fetchAllMembers(rest, guildId);
  if (members.length === 0) return null; // an empty read is a failed read here
  let bots = 0;
  for (const m of members) if (m.user?.bot === true) bots++;
  return bots;
}

/** Insert one reading. `?` placeholders: valid in both drivers. See driver.ts. */
export async function recordReading(
  db: Db,
  guildId: string,
  reading: PresenceReading,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO presence_probe (guild_id, observed_at, approximate_presence_count, bot_floor)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, observed_at) DO NOTHING`,
    )
    .run(guildId, reading.observedAt, reading.presence, reading.botFloor);
}

/** The whole series for a guild, oldest first. */
export async function readSeries(db: Db, guildId: string): Promise<PresenceReading[]> {
  const rows = await db
    .prepare(
      `SELECT observed_at, approximate_presence_count, bot_floor
         FROM presence_probe
        WHERE guild_id = ?
        ORDER BY observed_at ASC`,
    )
    .all<{ observed_at: string; approximate_presence_count: number; bot_floor: number | null }>(
      guildId,
    );
  return rows.map((r) => ({
    observedAt: r.observed_at,
    presence: Number(r.approximate_presence_count),
    botFloor: r.bot_floor === null || r.bot_floor === undefined ? null : Number(r.bot_floor),
  }));
}

/** When we last actually observed a bot floor, or null if never. */
export async function lastBotFloorAt(db: Db, guildId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT MAX(observed_at) AS at FROM presence_probe
        WHERE guild_id = ? AND bot_floor IS NOT NULL`,
    )
    .get<{ at: string | null }>(guildId);
  return row?.at ?? null;
}

export interface ProbeCycleDeps {
  db: Db;
  rest: DiscordRest;
  guildId: string;
  /** Injected so tests do not depend on the wall clock. */
  now?: () => string;
  botFloorMaxAgeMs?: number;
}

export interface ProbeCycleResult {
  /** False when Discord did not give us a usable presence count. */
  recorded: boolean;
  presence: number | null;
  botFloor: number | null;
  observedAt: string;
}

/**
 * One collection cycle.
 *
 * A failed presence read writes NOTHING - not a row with a null count, not a
 * zero. The series has to be readable as "these are the times we successfully
 * looked", or a gap in the collector becomes indistinguishable from a quiet
 * night, and a quiet night is exactly what this instrument is measuring.
 */
export async function runProbeCycle(deps: ProbeCycleDeps): Promise<ProbeCycleResult> {
  const now = deps.now ?? nowIso;
  const observedAt = now();
  const maxAge = deps.botFloorMaxAgeMs ?? BOT_FLOOR_MAX_AGE_MS;

  const presence = await fetchPresenceCount(deps.rest, deps.guildId);
  if (presence === null) {
    log.error('presence_probe_read_failed', { guildId: deps.guildId });
    return { recorded: false, presence: null, botFloor: null, observedAt };
  }

  // Rescan the floor only when the newest one we hold has aged out.
  let botFloor: number | null = null;
  const lastAt = await lastBotFloorAt(deps.db, deps.guildId);
  const stale = lastAt === null || new Date(observedAt).getTime() - new Date(lastAt).getTime() >= maxAge;
  if (stale) {
    botFloor = await countBotFloor(deps.rest, deps.guildId);
    if (botFloor === null) {
      // A failed member listing must not lose the presence reading we already
      // have. NULL here means "not rescanned", which is the normal state of
      // most rows anyway, so the series is unharmed.
      log.error('presence_probe_bot_floor_failed', { guildId: deps.guildId });
    }
  }

  await recordReading(deps.db, deps.guildId, { observedAt, presence, botFloor });

  // Aggregates only. There is no member id in this log line and there must
  // never be one - docs/PRIVACY.md.
  log.info('presence_probe_recorded', {
    guildId: deps.guildId,
    presence,
    botFloor: botFloor ?? 'unchanged',
  });

  return { recorded: true, presence, botFloor, observedAt };
}

export interface PresenceProbeHandle {
  stop(): void;
}

/**
 * Start the hourly probe. Returns a handle so shutdown can clear it.
 *
 * The interval is `unref`d: this must never be the reason the process stays
 * alive. It is a background instrument for an internal question, and it does
 * not get a vote on the bot's lifecycle.
 */
export function startPresenceProbe(deps: ProbeCycleDeps & { intervalMs?: number }): PresenceProbeHandle {
  const intervalMs = deps.intervalMs ?? PRESENCE_PROBE_INTERVAL_MS;

  const tick = () => {
    void runProbeCycle(deps).catch((err: unknown) => {
      log.error('presence_probe_failed', { err: String(err) });
    });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  // One reading at startup, so a restart does not blank an hour of the series.
  tick();

  log.info('presence_probe_enabled', {
    guildId: deps.guildId,
    intervalMs,
    published: false,
  });

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
