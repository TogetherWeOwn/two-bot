import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Db, Statement } from '../src/store/db.ts';
import { log } from '../src/core/log.ts';
import { COMMUNITY_FACT_TYPES, type CommunityFactStore } from '../src/analytics/communityFacts.ts';
import type { CommunityScorecard } from '../src/analytics/communityScorecard.ts';
import { startCommunityScorecardJob } from '../src/jobs/communityScorecard.ts';

const START = '2026-08-31T00:00:00.000Z';
const END = '2026-09-07T00:00:00.000Z';

function fixture(t: TestContext, fail: 'coverage' | 'scoring' | 'always' | null = null) {
  let clock = new Date('2026-09-07T06:15:00.000Z');
  let tick!: () => void;
  let coverageCalls = 0;
  let scoringCalls = 0;
  let holdCoverage: Promise<void> | null = null;
  const coverage = new Map<string, { stream: string; covered_from: string; covered_through: string }>();
  const scorecards: CommunityScorecard[] = [];
  const errors: Record<string, unknown>[] = [];
  const completed: Record<string, unknown>[] = [];
  t.mock.method(log, 'info', (message: string, fields: Record<string, unknown>) => {
    if (message === 'community_scorecard_completed') completed.push(fields);
  });
  t.mock.method(log, 'error', (message: string, fields: Record<string, unknown>) => {
    assert.equal(message, 'community_scorecard_failed');
    errors.push(fields);
  });
  const timer = { unref() {} } as ReturnType<typeof setInterval>;
  t.mock.method(globalThis, 'setInterval', (callback: () => void, intervalMs: number) => {
    tick = callback;
    assert.equal(intervalMs, 60_000);
    return timer;
  });
  const clear = t.mock.method(globalThis, 'clearInterval', (value: unknown) => {
    assert.equal(value, timer);
  });
  const db: Db = {
    prepare(sql: string): Statement {
      return {
        async get<T>(...params: unknown[]): Promise<T | undefined> {
          if (sql.includes('MAX(id) AS watermark')) {
            scoringCalls++;
            if (fail === 'scoring' && scoringCalls === 1) throw new Error('transient scoring');
            return { watermark: 0 } as T;
          }
          if (sql.includes('SELECT scorecard_json')) {
            const existing = scorecards.find((card) => card.idempotencyKey === params[0]);
            return existing ? { scorecard_json: JSON.stringify(existing) } as T : undefined;
          }
          if (sql.includes('SELECT COUNT(*) AS n FROM community_scorecard_runs')) return { n: 0 } as T;
          throw new Error(`unexpected get: ${sql}`);
        },
        async all<T>(): Promise<T[]> {
          if (sql.includes('FROM community_stream_heartbeats')) return [...coverage.values()] as T[];
          if (sql.includes('FROM community_facts')) return [];
          throw new Error(`unexpected all: ${sql}`);
        },
        async run(...params: unknown[]) {
          assert.match(sql, /INSERT INTO community_scorecard_runs/);
          scorecards.push(JSON.parse(String(params[12])) as CommunityScorecard);
          return { changes: 1 };
        },
      };
    },
    async exec() { throw new Error('unexpected exec'); },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> { return fn(db); },
    async close() {},
  };
  const facts = {
    async markStreamCoverage(guildId: string, stream: string, from: string, through: string) {
      assert.equal(guildId, 'guild-a');
      coverageCalls++;
      if (fail === 'always' || (fail === 'coverage' && coverageCalls === 1)) {
        throw new Error('transient coverage');
      }
      if (holdCoverage) await holdCoverage;
      coverage.set(stream, { stream, covered_from: from, covered_through: through });
    },
  } as unknown as CommunityFactStore;
  return {
    start() {
      const handle = startCommunityScorecardJob({
        db, facts, guildId: 'guild-a', classifierVersion: 'community-test-v1',
        captureStartedAt: START, recommendationsEnabled: false, now: () => clock,
      });
      t.after(() => handle.stop());
      return handle;
    },
    at(iso: string) { clock = new Date(iso); },
    tick() { tick(); },
    hold(promise: Promise<void>) { holdCoverage = promise; },
    get coverageCalls() { return coverageCalls; },
    get scoringCalls() { return scoringCalls; },
    coverage, scorecards, errors, completed, clear,
  };
}

// Drain the job's promise chain without real timers, a database or a network.
async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

for (const failure of ['coverage', 'scoring'] as const) {
  test(`retries the same closed week after transient ${failure} failure, then suppresses duplicates`, async (t) => {
    const f = fixture(t, failure);
    f.start();
    await flush();
    assert.equal(f.errors.length, 1);
    assert.match(String(f.errors[0].err), /transient/);
    assert.equal(f.scorecards.length, 0);
    const calls = f.coverageCalls;
    f.at('2026-09-07T06:19:59.999Z');
    f.tick();
    await flush();
    assert.equal(f.coverageCalls, calls);
    f.at('2026-09-07T06:20:00.000Z');
    f.tick();
    await flush();
    assert.equal(f.scorecards.length, 1);
    assert.equal(f.scorecards[0].weekStart, START);
    assert.equal(f.scorecards[0].weekEnd, END);
    assert.equal(f.scorecards[0].coverageState, 'complete');
    assert.equal(f.completed.length, 1);
    assert.equal(f.coverage.size, COMMUNITY_FACT_TYPES.length);
    const succeededCalls = f.coverageCalls;
    f.at('2026-09-07T06:59:00.000Z');
    f.tick();
    f.tick();
    await flush();
    assert.equal(f.coverageCalls, succeededCalls);
    assert.equal(f.scorecards.length, 1);
  });
}

test('permanent failures are limited to three spaced attempts; next Monday gets a fresh budget', async (t) => {
  const f = fixture(t, 'always');
  f.start();
  await flush();
  for (let minute = 15; minute <= 59; minute++) {
    f.at(`2026-09-07T06:${minute}:00.000Z`);
    f.tick();
    f.tick();
    await flush();
    assert.equal(f.coverageCalls, minute < 20 ? 1 : minute < 25 ? 2 : 3);
  }
  assert.equal(f.errors.length, 3);
  assert.equal(f.scoringCalls, 0);
  f.at('2026-09-14T06:15:00.000Z');
  f.tick();
  await flush();
  assert.equal(f.coverageCalls, 4);
});

test('retries do not catch up outside the existing Monday window', async (t) => {
  const f = fixture(t, 'coverage');
  f.at('2026-09-07T06:14:59.999Z');
  f.start();
  await flush();
  assert.equal(f.coverageCalls, 0);
  f.at('2026-09-07T06:59:00.000Z');
  f.tick();
  await flush();
  assert.equal(f.errors.length, 1);
  for (const at of ['2026-09-07T07:04:00.000Z', '2026-09-08T06:20:00.000Z', '2026-09-14T06:14:00.000Z']) {
    f.at(at);
    f.tick();
    await flush();
    assert.equal(f.coverageCalls, 1);
  }
  f.at('2026-09-14T06:15:00.000Z');
  f.tick();
  await flush();
  assert.equal(f.scorecards.length, 1);
  assert.equal(f.scorecards[0].weekStart, END);
  assert.equal(f.scorecards[0].weekEnd, '2026-09-14T00:00:00.000Z');
});

test('eligible ticks never overlap an in-flight run, even across weeks', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  f.hold(new Promise<void>((resolve) => { release = resolve; }));
  f.start();
  f.tick();
  await flush();
  assert.equal(f.coverageCalls, 1);
  f.at('2026-09-07T06:20:00.000Z');
  f.tick();
  f.at('2026-09-14T06:15:00.000Z');
  f.tick();
  await flush();
  assert.equal(f.coverageCalls, 1);
  assert.equal(f.scoringCalls, 0);
  release();
  await flush();
  assert.equal(f.scorecards.length, 1);
  assert.equal(f.scorecards[0].weekStart, START);
  f.tick();
  await flush();
  assert.equal(f.scorecards.length, 2);
  assert.equal(f.scorecards[1].weekStart, END);
});

test('stop clears the interval and cancels future retry ticks', async (t) => {
  const f = fixture(t, 'coverage');
  const handle = f.start();
  await flush();
  handle.stop();
  assert.equal(f.clear.mock.callCount(), 1);
  f.at('2026-09-07T06:20:00.000Z');
  f.tick();
  await flush();
  assert.equal(f.coverageCalls, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.scorecards.length, 0);
});
