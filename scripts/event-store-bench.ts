/**
 * Event-store write-path benchmark + funnel-query index audit (TOG-5709).
 *
 *   TWO_TEST_DATABASE_URL=postgres://agent_test@agent-testdb:5432/agent_test node scripts/event-store-bench.ts [members] [--check]
 *
 * --check pins the baseline workload (2000 members / 8667 events), prints
 * PASS/FAIL for every budget, and exits 1 on regression. CI runs it against
 * its Postgres service container. Use only agent-testdb or CI service
 * containers; the ambient TWO_DATABASE_URL is deliberately never read.
 *
 * Seeds N members with a realistic event mix through `EventStore.record` -
 * the only write path into the funnel log - then times the reads the funnel
 * report and the store actually issue, printing each timing plus the plan
 * shape that produced it.
 *
 * ISOLATION. Everything happens inside one schema named
 * `bench_<pid>_<timestamp>` that this script creates, migrates, and drops on
 * the way out. It never touches `public` or any other schema - but point it
 * at agent-testdb or CI's `two_test` service container, never
 * production. Needs CREATE/DROP SCHEMA on the database.
 *
 * WHAT IT PROVES. Re-run before touching any index on `events` or `members`:
 * the printed before/after is the review evidence. Reference numbers
 * (2026-09-27, vendored embedded Postgres 18, 130k events / 30k members):
 * distinct-members 18.6ms -> 2.8ms with idx_events_type_member, everything
 * else unchanged. See migrations/0038_events_type_member.sql.
 */
import { pathToFileURL } from 'node:url';
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { MESSAGE_RUNGS, type EventType } from '../src/core/events.ts';
import { assertTestDatabaseHost } from './test-db-guard.ts';

// Recorded 2026-09-30 on Node 24.21 / Postgres 17.11 / agent-testdb: median of three complete
// runs (write 0.247, 0.262, 0.246 ms/event), each read a median of seven warm
// samples. Refresh only with measured evidence, not to turn a regression green. Write budget is
// 3x baseline; reads have a 10ms floor for shared-runner scheduling noise.
export const BASELINE = {
  name: 'agent-testdb',
  runtime: {
    node: '24', postgres: '17', platform: 'linux', arch: 'x64',
    fsync: 'off', full_page_writes: 'off', synchronous_commit: 'off',
    wal_sync_method: 'fdatasync', shared_buffers: '512MB', max_wal_size: '1GB', checkpoint_timeout: '5min',
  },
  members: 2000,
  events: 8667,
  writeMsPerEvent: 0.247,
  reads: {
    'funnel count (type+time)': 0.061,
    'joiners DISTINCT (windowed)': 0.079,
    'stage DISTINCT (unwindowed)': 0.158,
    'member rung lookup': 0.049,
    'hasEvent probe': 0.069,
    'write series (recorded_at scan)': 0.892,
  },
};

// Durable CI calibration, not a relaxed agent-testdb limit. Median of three
// samples (1.674, 1.666, 1.654 ms/event) at CI merge 08cbb8be: identical src/,
// migrations and lockfile to green main 2d05db02 (run 36656673228).
// Node 24.21 / stock Postgres 17.11, settings on.
// Evidence: https://github.com/TogetherWeOwn/two-bot/actions/runs/36656843442/job/109702952854
// Keep the original fast profile; uncalibrated environments fail closed.
export const CI_BASELINE = {
  ...BASELINE,
  name: 'ci-postgres',
  runtime: {
    ...BASELINE.runtime,
    fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', shared_buffers: '128MB',
  },
  writeMsPerEvent: 1.666,
  reads: {
    'funnel count (type+time)': 0.343,
    'joiners DISTINCT (windowed)': 0.381,
    'stage DISTINCT (unwindowed)': 0.567,
    'member rung lookup': 0.328,
    'hasEvent probe': 0.300,
    'write series (recorded_at scan)': 1.978,
  },
};

export function baselineForEnvironment(environment: Record<string, string>, ci = false) {
  const actual: Record<string, string> = {
    ...environment,
    node: /^v?(\d+)\./.exec(environment.node ?? '')?.[1] ?? '',
    postgres: /^(\d+)\./.exec(environment.postgres ?? '')?.[1] ?? '',
  };
  const baseline = [BASELINE, CI_BASELINE].find((candidate) =>
    (!ci || candidate === CI_BASELINE) &&
    Object.entries(candidate.runtime).every(([key, expected]) => actual[key] === expected));
  if (!baseline) throw new Error('runtime does not match a recorded benchmark baseline; record comparable calibration before using --check');
  return baseline;
}

export interface BenchMetrics {
  members: number;
  events: number;
  writeMs: number;
  reads: Array<{ label: string; ms: number }>;
}

export function checkBudgets(metrics: BenchMetrics, baseline = BASELINE) {
  // Calibrations are recorded to 0.001 ms/event; avoid a binary 4.997999...
  // ceiling rejecting the inclusive, mathematically exact 4.998 boundary.
  const writeLimit = Number((baseline.writeMsPerEvent * 3).toFixed(3));
  const checks = [
    { label: 'members', actual: metrics.members, baseline: baseline.members, limit: baseline.members, exact: true },
    { label: 'events', actual: metrics.events, baseline: baseline.events, limit: baseline.events, exact: true },
    { label: 'write ms/event', actual: metrics.writeMs / metrics.events, baseline: baseline.writeMsPerEvent, limit: writeLimit, exact: false },
    ...Object.entries(baseline.reads).map(([label, recorded]) => ({
      label, actual: metrics.reads.find((r) => r.label === label)?.ms ?? NaN,
      baseline: recorded, limit: Math.max(10, recorded * 3), exact: false,
    })),
  ];
  return checks.map((c) => ({
    ...c,
    pass: Number.isFinite(c.actual) && c.actual >= 0 && (c.exact ? c.actual === c.limit : c.actual <= c.limit),
  }));
}

export function reportBudgets(metrics: BenchMetrics, log: (line: string) => void = console.log, baseline = BASELINE): number {
  const checks = checkBudgets(metrics, baseline);
  log(`  baseline 2026-09-30 / Node 24 / ${baseline.name}; reads = median of 7 warm runs:`);
  for (const c of checks) {
    log(`    ${c.pass ? 'PASS' : 'FAIL'} ${c.label.padEnd(31)} actual=${c.actual.toFixed(3)} baseline=${c.baseline.toFixed(3)} limit=${c.limit.toFixed(3)}`);
  }
  const failures = checks.filter((c) => !c.pass);
  log(`  threshold result: ${failures.length ? 'FAIL' : 'PASS'} (${failures.length} budget violations)`);
  return failures.length ? 1 : 0;
}

export function parseArgs(args: string[]) {
  const check = args.includes('--check');
  const positional = args.filter((a) => a !== '--check');
  if (positional.length > 1 || args.filter((a) => a === '--check').length > 1) {
    throw new Error('usage: event-store-bench.ts [members] [--check]');
  }
  const members = Number(positional[0] ?? BASELINE.members);
  if (!Number.isInteger(members) || members < 1 || members > 500_000) {
    throw new Error('members must be an integer 1..500000.');
  }
  if (check && members !== BASELINE.members) {
    throw new Error(`--check requires the baseline workload: ${BASELINE.members} members.`);
  }
  return { members, check };
}

async function main() {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`event-store-bench: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const spec = process.env.TWO_TEST_DATABASE_URL?.trim();
  if (!spec) {
    console.error('event-store-bench: TWO_TEST_DATABASE_URL is not set. Use agent-testdb or a CI service container, never production/staging.');
    process.exitCode = 2;
    return;
  }
  const N = options.members;
  const schema = `bench_${process.pid}_${Date.now().toString(36)}`;
  const GUILD = 'bench-guild';
  // TOG-8324: the allowlist also refuses ?host=/?port= retargeting, which
  // node-postgres promotes over the URL hostname. Assert on the raw spec
  // before openDb connects or migrates, so a forbidden host never reaches a
  // socket. The guard throws with the offending label; keep exit 2 semantics.
  try {
    assertTestDatabaseHost(spec);
  } catch (err) {
    console.error(`event-store-bench: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const db = await openDb(spec, { schema, applicationName: 'two-bot:bench' });
  const store = new EventStore(db);

  try {
    // Read-only, allowlisted settings make calibration/CI differences visible.
    // Never log the connection URL or weaken durability to match a baseline.
    const environment = await db.prepare(`SELECT
      current_setting('server_version') AS postgres,
      current_setting('fsync') AS fsync,
      current_setting('full_page_writes') AS full_page_writes,
      current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('wal_sync_method') AS wal_sync_method,
      current_setting('shared_buffers') AS shared_buffers,
      current_setting('max_wal_size') AS max_wal_size,
      current_setting('checkpoint_timeout') AS checkpoint_timeout`).get<Record<string, string>>();
    if (!environment) throw new Error('benchmark runtime settings were not returned');
    const runtime = { node: process.version, platform: process.platform, arch: process.arch, ...environment };
    console.log(`  runtime: ${JSON.stringify(runtime)}`);
    const baseline = options.check ? baselineForEnvironment(runtime, process.env.CI === 'true') : BASELINE;
    if (options.check) console.log(`  calibration profile: ${baseline.name}`);

    const base = Date.parse('2023-01-01T00:00:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();

    // --- write path: one realistic member lifecycle per member ----------------
    // https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html#performancenow
    // TOG-8324: record() dedupes on the idempotency key, so attempting a seed
    // twice inserts nothing new. Count only inserted rows; the stored-row
    // check below refuses a silent-dedup run that would benchmark a no-op.
    const t0 = performance.now();
    let events = 0;
    for (let i = 0; i < N; i++) {
      const m = `m${i}`;
      const j = base + i * 3600_000; // hourly joins: a multi-year log, like the real one
      const batch: Array<{ type: EventType; at: number; source: string }> = [
        { type: 'member_join', at: j, source: 'invite:x' },
        { type: 'gate_cleared', at: j + 60_000, source: 'live' },
        { type: 'first_message', at: j + 3600_000, source: 'channel:c1' },
      ];
      if (i % 2 === 0) {
        batch.push({ type: 'second_message', at: j + 3700_000, source: 'channel:c1' });
        batch.push({ type: 'third_message', at: j + 3800_000, source: 'channel:c1' });
      }
      if (i % 3 === 0) batch.push({ type: 'first_voice_session', at: j + 7200_000, source: 'voice:v1' });
      for (const e of batch) {
        const res = await store.record({ guildId: GUILD, memberId: m, eventType: e.type, occurredAt: iso(e.at), source: e.source });
        if (res.inserted) events++;
      }
    }
    const writeMs = performance.now() - t0;
    // Production autovacuum would have statistics and an all-visible heap by
    // the time anyone reads; a bulk seed has neither, so do both explicitly
    // for honest plans (without VACUUM every index-only scan pays heap
    // fetches and the planner prices it as a sort instead).
    await db.exec('VACUUM (ANALYZE) events');
    await db.exec('VACUUM (ANALYZE) members');

    // TOG-8324: the budget compares stored rows, not attempted calls. A
    // no-op record() (mocked store, deduped seed, wrong guild filter) passes
    // every timing budget and exits 0 on an empty table, so verify the
    // persisted counts outside the write timing before reporting. This is a
    // setup error (exit 2), not a measured regression (exit 1).
    const storedEvents = Number((await db.prepare(`SELECT COUNT(*) AS n FROM events WHERE guild_id = ?`).get<{ n: number | string }>(GUILD))?.n ?? -1);
    const storedMembers = Number((await db.prepare(`SELECT COUNT(*) AS n FROM members WHERE guild_id = ?`).get<{ n: number | string }>(GUILD))?.n ?? -1);
    if (storedEvents !== events || storedMembers !== N) {
      console.error(
        `event-store-bench: stored-row mismatch: events table has ${storedEvents} rows for ${GUILD} ` +
        `(seeded ${events}), members table has ${storedMembers} (seeded ${N}). Refusing to benchmark an ` +
        'unexpected store state; check for a mocked record(), a deduped seed, or a guild filter mismatch.',
      );
      process.exitCode = 2;
      return;
    }

    // --- read path: the queries the funnel actually issues --------------------
    const since = iso(base + (N - 168) * 3600_000); // last 7 days of seeded joins
    const timed = async (label: string, sql: string, ...params: unknown[]) => {
      const statement = db.prepare(sql);
      await statement.all(...params); // warm cache; measure seven runs, not one scheduling pause
      const samples: number[] = [];
      let rowCount = 0;
      for (let i = 0; i < 7; i++) {
        const a = performance.now();
        const rows = await statement.all(...params);
        samples.push(performance.now() - a);
        rowCount = rows.length;
      }
      samples.sort((a, b) => a - b);
      return { label, ms: samples[3], rows: rowCount };
    };
    const reads = [
      await timed('funnel count (type+time)', `SELECT COUNT(*) AS n FROM events WHERE event_type = ? AND occurred_at >= ?`, 'member_join' as EventType, since),
      await timed('joiners DISTINCT (windowed)', `SELECT COUNT(DISTINCT member_id) AS n FROM events WHERE event_type = ? AND occurred_at >= ?`, 'member_join' as EventType, since),
      await timed('stage DISTINCT (unwindowed)', `SELECT COUNT(DISTINCT member_id) AS n FROM events WHERE event_type = ? AND member_id IS NOT NULL`, 'first_message' as EventType),
      await timed('member rung lookup', `SELECT event_type, occurred_at FROM events WHERE guild_id = ? AND member_id = ? AND event_type IN (?, ?, ?)`, GUILD, 'm7', ...MESSAGE_RUNGS),
      await timed('hasEvent probe', `SELECT 1 AS x FROM events WHERE guild_id = ? AND member_id = ? AND event_type = ? LIMIT 1`, GUILD, 'm9', 'first_voice_session' as EventType),
      await timed('write series (recorded_at scan)', `SELECT recorded_at AS at FROM events WHERE occurred_at >= ? ORDER BY recorded_at`, since),
    ];

    // --- plan shapes: which index (if any) each read rides --------------------
    const explain = async (sql: string) =>
      (await db.prepare(`EXPLAIN ${sql}`).all<Record<string, string>>())
        .map((r) => r['QUERY PLAN'])
        .filter((l) => /Scan|Sort|Aggregate/.test(l))
        .slice(0, 3)
        .join(' > ');
    const plans: Record<string, string> = {
      'stage DISTINCT (unwindowed)': await explain(`SELECT COUNT(DISTINCT member_id) FROM events WHERE event_type = 'first_message' AND member_id IS NOT NULL`),
      'member rung lookup': await explain(`SELECT event_type, occurred_at FROM events WHERE guild_id = '${GUILD}' AND member_id = 'm7' AND event_type IN ('first_message','second_message','third_message')`),
      'write series (recorded_at scan)': await explain(`SELECT recorded_at FROM events WHERE occurred_at >= '${since}' ORDER BY recorded_at`),
    };

    const indexSizes = await db
      .prepare(
        `SELECT indexrelname AS indexname, pg_size_pretty(pg_relation_size(indexrelid)) AS size
           FROM pg_stat_user_indexes WHERE schemaname = current_schema() AND relname = 'events'
           ORDER BY 1`,
      )
      .all<{ indexname: string; size: string }>();

    // --- report ----------------------------------------------------------------
    console.log(`\nevent-store bench - ${N} members, ${events} events, schema ${schema}\n`);
    console.log(`  write path  ${String(events).padStart(7)} events in ${(writeMs / 1000).toFixed(1)}s  ${(events / (writeMs / 1000)).toFixed(0)} events/s  ${(writeMs / events).toFixed(2)} ms/event`);
    console.log(`  reads:`);
    for (const r of reads) console.log(`    ${r.label.padEnd(31)} ${r.ms.toFixed(3).padStart(8)}ms  (${r.rows} rows)`);
    console.log(`  plans:`);
    for (const [k, v] of Object.entries(plans)) console.log(`    ${k.padEnd(31)} ${v}`);
    console.log(`  events indexes:`);
    for (const i of indexSizes) console.log(`    ${i.indexname.padEnd(28)} ${i.size}`);
    if (options.check) {
      process.exitCode = reportBudgets({ members: N, events, writeMs, reads }, console.log, baseline);
    } else {
      console.log(`  exploratory run; use --check with ${BASELINE.members} members for baseline PASS/FAIL.`);
    }
    console.log('');
  } finally {
    try {
      await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await db.close();
    }
  }
}

// pathToFileURL keeps direct invocation working on all Node 24 releases.
// https://nodejs.org/docs/latest-v24.x/api/url.html#urlpathtofileurlpath-options
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    console.error(`event-store-bench: ${(err as Error).message}`);
    process.exitCode = 2; // runtime/setup failure, not a measured budget breach
  }
}
