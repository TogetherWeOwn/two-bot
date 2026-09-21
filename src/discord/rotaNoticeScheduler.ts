/**
 * The rota fallback-notice ticker.
 *
 * Same shape as the automation scheduler and the feed poller: a handle with
 * stop(), an interval that never keeps the process alive (unref), a
 * non-overlapping guard so a slow Discord call never stacks a second sweep
 * behind it, and per-tick errors logged rather than thrown. No per-row
 * timers: a restart must not resurrect N setTimeouts, and a missed tick must
 * not lose a notice - the persisted first-action deadline plus the durable
 * audit claim row is the queue, and any due candidate is picked up by the
 * next tick. No dependency on the gateway observer queue.
 */
import { log } from '../core/log.ts';
import type { RotaNoticeDelivery, RotaNoticeOutcome } from './rotaNoticeDelivery.ts';

export const ROTA_NOTICE_TICK_MS = 60_000;

export interface RotaNoticeSchedulerHandle {
  stop(): void;
  /** Fire one sweep now, regardless of the interval. Tests and ops. */
  tick(): Promise<RotaNoticeOutcome[]>;
}

export function startRotaNoticeScheduler(
  delivery: RotaNoticeDelivery,
  opts: { intervalMs?: number; now?: () => string } = {},
): RotaNoticeSchedulerHandle {
  const intervalMs = opts.intervalMs ?? ROTA_NOTICE_TICK_MS;
  let running = false;

  const tick = async (): Promise<RotaNoticeOutcome[]> => {
    // Re-entrancy guard: a slow Discord call must not stack a second sweep
    // behind it. Ticks are cheap; skipping one is free.
    if (running) return [];
    running = true;
    try {
      const outcomes = await delivery.runDue(opts.now?.() ?? new Date().toISOString());
      const sent = outcomes.filter((o) => o.status === 'sent').length;
      if (sent > 0) log.info('rota_notices_sent', { count: sent });
      return outcomes;
    } catch {
      log.error('rota_notice_tick_failed', { classification: 'rota_notice_tick_failed' });
      return [];
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
