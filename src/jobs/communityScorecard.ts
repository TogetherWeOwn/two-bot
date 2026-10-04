import type { Db } from '../store/db.ts';
import { log } from '../core/log.ts';
import { previousClosedCommunityWeek, runPreviousClosedCommunityWeek } from '../analytics/communityScorecard.ts';
import { COMMUNITY_FACT_TYPES, type CommunityFactStore } from '../analytics/communityFacts.ts';

const MONDAY = 1;
const RUN_HOUR_UTC = 6;
const RUN_MINUTE_UTC = 15;
const MAX_WEEKLY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60_000;

export interface CommunityScorecardJobOptions {
  db: Db;
  guildId: string;
  classifierVersion: string;
  facts: CommunityFactStore;
  captureStartedAt: string;
  recommendationsEnabled?: boolean;
  correctionCycles?: number;
  intervalMs?: number;
  now?: () => Date;
}

export interface CommunityScorecardJobHandle {
  stop(): void;
}

export function isCommunityScorecardRunTime(now: Date): boolean {
  return now.getUTCDay() === MONDAY && now.getUTCHours() === RUN_HOUR_UTC && now.getUTCMinutes() >= RUN_MINUTE_UTC;
}

export function startCommunityScorecardJob(options: CommunityScorecardJobOptions): CommunityScorecardJobHandle {
  const intervalMs = options.intervalMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  let attemptedWeek: string | null = null;
  let attempts = 0;
  let completed = false;
  let nextAttemptAt = 0;
  let running = false;
  let stopped = false;

  const tick = () => {
    if (stopped || running) return;
    const at = now();
    if (!isCommunityScorecardRunTime(at)) return;
    const weekKey = at.toISOString().slice(0, 10);
    if (weekKey !== attemptedWeek) {
      attemptedWeek = weekKey;
      attempts = 0;
      completed = false;
      nextAttemptAt = 0;
    }
    if (completed || attempts >= MAX_WEEKLY_ATTEMPTS || at.getTime() < nextAttemptAt) return;
    // Reserve the attempt before yielding; only eligible interval ticks may retry.
    running = true;
    attempts++;
    nextAttemptAt = at.getTime() + RETRY_DELAY_MS;
    void Promise.resolve()
      .then(async () => {
        const week = previousClosedCommunityWeek(at);
        for (const stream of COMMUNITY_FACT_TYPES) {
          await options.facts.markStreamCoverage(
            options.guildId,
            stream,
            options.captureStartedAt,
            week.end,
          );
        }
        const result = await runPreviousClosedCommunityWeek(
          options.db,
          options.guildId,
          options.classifierVersion,
          {
            now: at,
            recommendationsEnabled: options.recommendationsEnabled,
            correctionCycles: options.correctionCycles,
          },
        );
        completed = true;
        log.info('community_scorecard_completed', {
          guildId: options.guildId,
          weekStart: result.scorecard.weekStart,
          coverageState: result.scorecard.coverageState,
          evidenceState: result.scorecard.evidenceState,
          intervention: result.scorecard.intervention.code,
          reused: result.reused,
          alertEmitted: result.alertEmitted,
        });
      })
      .catch((err: unknown) => {
        log.error('community_scorecard_failed', { guildId: options.guildId, err: String(err) });
      })
      .finally(() => { running = false; });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  log.info('community_scorecard_enabled', {
    guildId: options.guildId,
    schedule: 'Monday 06:15 UTC',
    recommendationsEnabled: options.recommendationsEnabled ?? true,
  });

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
