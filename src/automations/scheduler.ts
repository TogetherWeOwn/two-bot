/**
 * The scheduled-message ticker (TOG-1648).
 *
 * Polls the store on a fixed interval and fires whatever is due. No cron
 * parser, no per-row timers: a restart must not resurrect N setTimeouts, and
 * a missed tick must not lose a run - `next_run_at` is the queue, and any
 * row whose time has passed is picked up by the next tick.
 *
 * The same shape as startPresenceProbe / startCommunitySnapshots: a handle
 * with stop(), an interval that never keeps the process alive (unref), and
 * errors logged per tick rather than thrown, because a throwing interval
 * handler would take the process down on a transient database blip.
 */
import type { AutomationService } from './service.ts';
import { log } from '../core/log.ts';

export const SCHEDULER_TICK_MS = 15_000;

export interface SchedulerHandle {
  stop(): void;
  /** Fire one tick now, regardless of the interval. Tests and ops. */
  tick(): Promise<number>;
}

export function startScheduler(
  service: AutomationService,
  opts: { intervalMs?: number; now?: () => string } = {},
): SchedulerHandle {
  const intervalMs = opts.intervalMs ?? SCHEDULER_TICK_MS;
  let running = false;

  const tick = async (): Promise<number> => {
    // Re-entrancy guard: a slow Discord call must not stack a second sweep
    // behind it. Ticks are cheap; skipping one is free.
    if (running) return 0;
    running = true;
    try {
      const fired = await service.runDueScheduled(opts.now?.());
      if (fired > 0) log.info('scheduled_messages_fired', { count: fired });
      return fired;
    } catch (err) {
      log.error('scheduler_tick_failed', { err: String(err) });
      return 0;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
