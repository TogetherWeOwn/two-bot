import type { Db } from '../store/db.ts';
import { DiscordRest } from '../discord/rest.ts';
import { nowIso } from '../core/events.ts';
import { log } from '../core/log.ts';

export const SCHEDULED_EVENTS_INTERVAL_MS = 10 * 60 * 1000;

export interface RawScheduledEvent {
  id?: string;
  name?: string;
  scheduled_start_time?: string;
  channel_id?: string | null;
  description?: string | null;
  status?: number;
}

interface ScheduledEvent {
  id: string;
  name: string;
  startsAt: string;
  channelId: string | null;
  description: string | null;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
}

export interface ScheduledEventsDeps {
  db: Db;
  rest: DiscordRest;
  guildId: string;
  now?: () => string;
}

export interface ScheduledEventsResult {
  recorded: boolean;
  reason?: 'discord_read_failed' | 'invalid_response';
  observedAt: string;
  eventCount: number | null;
}

const STATUS = new Map<number, ScheduledEvent['status']>([
  [1, 'scheduled'],
  [2, 'active'],
  [3, 'completed'],
  [4, 'cancelled'],
]);

function normalize(value: unknown): ScheduledEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const status = typeof raw.status === 'number' ? STATUS.get(raw.status) : undefined;
  if (
    typeof raw.id !== 'string' || raw.id.length === 0 ||
    typeof raw.name !== 'string' || raw.name.length === 0 ||
    typeof raw.scheduled_start_time !== 'string' || !Number.isFinite(Date.parse(raw.scheduled_start_time)) ||
    !status ||
    (raw.channel_id != null && typeof raw.channel_id !== 'string') ||
    (raw.description != null && typeof raw.description !== 'string')
  ) {
    return null;
  }

  return {
    id: raw.id,
    name: raw.name,
    startsAt: new Date(raw.scheduled_start_time).toISOString(),
    channelId: typeof raw.channel_id === 'string' ? raw.channel_id : null,
    description: typeof raw.description === 'string' ? raw.description : null,
    status,
  };
}

async function replaceEvents(
  db: Db,
  guildId: string,
  observedAt: string,
  events: ScheduledEvent[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.prepare(`DELETE FROM scheduled_events WHERE guild_id = ?`).run(guildId);
    for (const event of events) {
      await tx
        .prepare(
          `INSERT INTO scheduled_events
             (guild_id, event_id, name, starts_at, channel_id, description, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          guildId,
          event.id,
          event.name,
          event.startsAt,
          event.channelId,
          event.description,
          event.status,
          observedAt,
        );
    }
    await tx.prepare(`UPDATE web_contract_meta SET guild_id = ? WHERE singleton = TRUE`).run(guildId);
  });
}

export async function runScheduledEventsCycle(
  deps: ScheduledEventsDeps,
): Promise<ScheduledEventsResult> {
  const observedAt = (deps.now ?? nowIso)();
  const raw = await deps.rest.get<unknown>(
    `/guilds/${deps.guildId}/scheduled-events`,
  );
  if (!Array.isArray(raw)) {
    log.error('scheduled_events_skipped', { guildId: deps.guildId, reason: 'discord_read_failed' });
    return { recorded: false, reason: 'discord_read_failed', observedAt, eventCount: null };
  }

  const events = raw.map(normalize);
  if (events.some((event) => event === null)) {
    log.error('scheduled_events_skipped', { guildId: deps.guildId, reason: 'invalid_response' });
    return { recorded: false, reason: 'invalid_response', observedAt, eventCount: null };
  }

  await replaceEvents(deps.db, deps.guildId, observedAt, events as ScheduledEvent[]);
  log.info('scheduled_events_recorded', { guildId: deps.guildId, eventCount: events.length });
  return { recorded: true, observedAt, eventCount: events.length };
}

export interface ScheduledEventsHandle {
  stop(): void;
}

export function startScheduledEventsPoller(
  deps: ScheduledEventsDeps & { intervalMs?: number },
): ScheduledEventsHandle {
  const intervalMs = deps.intervalMs ?? SCHEDULED_EVENTS_INTERVAL_MS;
  let queue: Promise<unknown> = Promise.resolve();
  const tick = () => {
    queue = queue.then(() => runScheduledEventsCycle(deps)).catch((err: unknown) => {
      log.error('scheduled_events_failed', { err: String(err) });
    });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  log.info('scheduled_events_enabled', { guildId: deps.guildId, intervalMs });

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
