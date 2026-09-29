/**
 * Presence-trend read-path benchmark + index audit (TOG-8322).
 *
 *   TWO_DATABASE_URL=postgres://agent_test@agent-testdb:5432/agent_test node scripts/presence-trend-bench.ts [guilds] [years]
 *
 * Seeds G guilds x Y years of hourly `presence_probe` rows - the floor
 * rescanned daily (every 24th row non-NULL), the way the collector writes it -
 * then runs the exact queries the trend path issues, printing each timing plus
 * the EXPLAIN (ANALYZE, BUFFERS) plan shape that produced it, BEFORE (the
 * covering index dropped) and AFTER (migration 0040's DDL re-applied).
 *
 * The timed reads call the shipped functions (`readSeries`, `lastBotFloorAt`
 * in src/jobs/presenceProbe.ts), so the query text under test is theirs, not
 * a copy: the windowed 14-day series behind `presence-trend.ts --days`, the
 * unwindowed full series (the no-`since` default), and the bot-floor MAX.
 *
 * ISOLATION. Everything happens inside one schema named
 * `bench_<pid>_<timestamp>` that this script creates, migrates, and drops on
 * the way out. It never touches `public` or any other schema - but point it
 * at a throwaway database anyway (agent-testdb's `agent_test`, CI's
 * `two_test`, a local cluster), never production. Needs CREATE/DROP SCHEMA
 * on the database.
 *
 * WHAT IT PROVES. Re-run before touching any index on `presence_probe`:
 * the printed before/after is the review evidence. Reference numbers
 * (2026-09-29, agent-testdb Postgres 17.11, 2 guilds x 2 years hourly =
 * ~35k rows, VACUUM ANALYZEd): windowed series Bitmap Heap Scan +
 * quicksort at 10 buffers, exec 0.114ms -> Index Only Scan with Heap
 * Fetches: 0 and no sort, 7 buffers, exec 0.038ms; full series Index Scan
 * at 292 buffers -> Index Only Scan with Heap Fetches: 0, 166 buffers;
 * floor MAX Index Scan Backward + heap Filter -> Index Only Scan Backward
 * with Heap Fetches: 0. See migrations/0040_presence_trend_covering.sql.
 *
 * This file seeds and reads `presence_probe` but never renders it: same
 * non-rendering status as test/unit.presenceprobecost.test.ts, which
 * test/unit.presenceprobe.test.ts allowlists.
 */
import { openDb } from '../src/store/db.ts';
import { readSeries, lastBotFloorAt } from '../src/jobs/presenceProbe.ts';

const spec = process.env.TWO_DATABASE_URL?.trim();
if (!spec) {
  console.error('presence-trend-bench: TWO_DATABASE_URL is not set. Point it at an isolated database, never production.');
  process.exit(2);
}
const GUILDS = Math.max(1, Number(process.argv[2] ?? 4) || 4);
const YEARS = Math.max(1, Number(process.argv[3] ?? 3) || 3);
if (!Number.isInteger(GUILDS) || GUILDS > 50 || !Number.isInteger(YEARS) || YEARS > 10) {
  console.error('presence-trend-bench: guilds must be an integer 1..50, years an integer 1..10.');
  process.exit(2);
}
if (/prod/i.test(spec)) {
  console.error('presence-trend-bench: refusing a spec that looks like production.');
  process.exit(2);
}

/** Migration 0040's DDL, verbatim. The AFTER state is the shipped schema. */
const COVERING_DDL = `CREATE INDEX IF NOT EXISTS idx_presence_probe_trend_covering
  ON presence_probe (guild_id, observed_at)
  INCLUDE (approximate_presence_count, bot_floor)`;

const schema = `bench_${process.pid}_${Date.now().toString(36)}`;
const GUILD = 'bench-guild-0';
const db = await openDb(spec, { schema, applicationName: 'two-bot:presence-trend-bench' });

try {
  const end = Date.parse('2026-08-26T00:00:00.000Z');
  const start = end - YEARS * 365 * 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const lit = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}.000Z`;
  };

  // --- seed: hourly readings, floor rescanned daily, like the collector -----
  await db.exec(`
    INSERT INTO presence_probe (guild_id, observed_at, approximate_presence_count, bot_floor)
    SELECT 'bench-guild-' || (g - 1),
           to_char(gs, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           20 + ((extract(epoch FROM gs)::bigint / 3600 + g) % 15),
           CASE WHEN ((extract(epoch FROM gs)::bigint / 3600) % 24) = 0 THEN 23 ELSE NULL END
      FROM generate_series(1, ${GUILDS}) AS g,
           generate_series(timestamptz '${iso(start)}', timestamptz '${iso(end)}', interval '1 hour') AS gs
  `);
  const total = (
    await db.prepare('SELECT COUNT(*) AS n FROM presence_probe').get<{ n: number }>()
  )?.n;
  // Production autovacuum would have statistics and an all-visible heap by
  // the time anyone reads; a bulk seed has neither, so do both explicitly
  // for honest plans (without VACUUM every index-only scan pays heap
  // fetches and the planner prices it as a sort instead).
  await db.exec('VACUUM (ANALYZE) presence_probe');

  const since = lit(end - 14 * 86_400_000);

  // --- the reads, through the shipped functions -----------------------------
  const timed = async <T>(fn: () => Promise<T>, runs = 5): Promise<{ ms: number; out: T }> => {
    const ts: number[] = [];
    let out!: T;
    for (let i = 0; i < runs; i++) {
      const a = Date.now();
      out = await fn();
      ts.push(Date.now() - a);
    }
    ts.sort((x, y) => x - y);
    return { ms: ts[Math.floor(runs / 2)]!, out };
  };

  // --- plan shapes: which index (if any) each read rides --------------------
  const explain = async (sql: string) =>
    (await db.prepare(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ${sql}`).all<Record<string, string>>())
      .map((r) => r['QUERY PLAN'])
      .join('\n');

  const seriesSql = `SELECT observed_at, approximate_presence_count, bot_floor FROM presence_probe WHERE guild_id = '${GUILD}' AND observed_at >= '${since}' ORDER BY observed_at ASC`;
  const fullSql = `SELECT observed_at, approximate_presence_count, bot_floor FROM presence_probe WHERE guild_id = '${GUILD}' ORDER BY observed_at ASC`;
  const floorSql = `SELECT MAX(observed_at) AS at FROM presence_probe WHERE guild_id = '${GUILD}' AND bot_floor IS NOT NULL`;

  const measure = async (covering: boolean) => {
    if (covering) await db.exec(COVERING_DDL);
    else await db.exec('DROP INDEX IF EXISTS idx_presence_probe_trend_covering');
    await db.exec('VACUUM (ANALYZE) presence_probe');

    const windowed = await timed(() => readSeries(db, GUILD, { since }));
    const full = await timed(() => readSeries(db, GUILD));
    const floor = await timed(() => lastBotFloorAt(db, GUILD));
    return {
      windowed,
      full,
      floor,
      plans: {
        'windowed series': await explain(seriesSql),
        'full series': await explain(fullSql),
        'floor MAX': await explain(floorSql),
      },
    };
  };

  const before = await measure(false);
  const after = await measure(true);

  // Sanity: the window reads a slice, the floor lookup finds the daily rescan.
  if (!(before.windowed.out.length < before.full.out.length)) {
    throw new Error(`windowed (${before.windowed.out.length}) must read fewer rows than full (${before.full.out.length})`);
  }
  if (before.floor.out === null || after.floor.out === null) {
    throw new Error('the seeded series has a daily floor; lastBotFloorAt must find it');
  }

  const indexSizes = await db
    .prepare(
      `SELECT indexrelname AS indexname, pg_size_pretty(pg_relation_size(indexrelid)) AS size
         FROM pg_stat_user_indexes WHERE schemaname = current_schema() AND relname = 'presence_probe'
         ORDER BY 1`,
    )
    .all<{ indexname: string; size: string }>();

  // --- report ----------------------------------------------------------------
  const rows = (o: { out: unknown }) => (Array.isArray(o.out) ? o.out.length : String(o.out));
  console.log(`\npresence-trend bench - ${GUILDS} guilds x ${YEARS}y hourly, ${total} rows, schema ${schema}\n`);
  for (const [state, m] of [['BEFORE (no covering index)', before], ['AFTER (0040 covering index)', after]] as const) {
    console.log(`  ${state}`);
    console.log(`    windowed 14d series   ${String(m.windowed.ms).padStart(6)}ms  (${rows(m.windowed)} rows)`);
    console.log(`    full series           ${String(m.full.ms).padStart(6)}ms  (${rows(m.full)} rows)`);
    console.log(`    floor MAX             ${String(m.floor.ms).padStart(6)}ms  (${rows(m.floor)})`);
  }
  console.log(`  plans BEFORE:`);
  for (const [k, v] of Object.entries(before.plans)) {
    console.log(`    --- ${k} ---`);
    for (const line of v.split('\n')) console.log(`    ${line}`);
  }
  console.log(`  plans AFTER:`);
  for (const [k, v] of Object.entries(after.plans)) {
    console.log(`    --- ${k} ---`);
    for (const line of v.split('\n')) console.log(`    ${line}`);
  }
  console.log(`  presence_probe indexes:`);
  for (const i of indexSizes) console.log(`    ${i.indexname.padEnd(36)} ${i.size}`);
  console.log('');
} finally {
  await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
}
