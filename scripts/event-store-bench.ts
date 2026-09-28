/**
 * Event-store write-path benchmark + funnel-query index audit (TOG-5709).
 *
 *   TWO_DATABASE_URL=postgres://two:two@127.0.0.1:5432/two_test node scripts/event-store-bench.ts [members]
 *
 * Seeds N members with a realistic event mix through `EventStore.record` -
 * the only write path into the funnel log - then times the reads the funnel
 * report and the store actually issue, printing each timing plus the plan
 * shape that produced it.
 *
 * ISOLATION. Everything happens inside one schema named
 * `bench_<pid>_<timestamp>` that this script creates, migrates, and drops on
 * the way out. It never touches `public` or any other schema - but point it
 * at a throwaway database anyway (CI's `two_test`, a local cluster), never
 * production. Needs CREATE/DROP SCHEMA on the database.
 *
 * WHAT IT PROVES. Re-run before touching any index on `events` or `members`:
 * the printed before/after is the review evidence. Reference numbers
 * (2026-09-27, vendored embedded Postgres 18, 130k events / 30k members):
 * distinct-members 18.6ms -> 2.8ms with idx_events_type_member, everything
 * else unchanged. See migrations/0038_events_type_member.sql.
 */
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { MESSAGE_RUNGS, type EventType } from '../src/core/events.ts';

const spec = process.env.TWO_DATABASE_URL?.trim();
if (!spec) {
  console.error('event-store-bench: TWO_DATABASE_URL is not set. Point it at an isolated database, never production.');
  process.exit(2);
}
const N = Math.max(1, Number(process.argv[2] ?? 2000) || 2000);
if (!Number.isInteger(N) || N > 500_000) {
  console.error('event-store-bench: members must be an integer 1..500000.');
  process.exit(2);
}

const schema = `bench_${process.pid}_${Date.now().toString(36)}`;
const GUILD = 'bench-guild';
const db = await openDb(spec, { schema, applicationName: 'two-bot:bench' });
const store = new EventStore(db);

try {
  const base = Date.parse('2023-01-01T00:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  // --- write path: one realistic member lifecycle per member ----------------
  const t0 = Date.now();
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
      await store.record({ guildId: GUILD, memberId: m, eventType: e.type, occurredAt: iso(e.at), source: e.source });
      events++;
    }
  }
  const writeMs = Date.now() - t0;
  // Production autovacuum would have statistics and an all-visible heap by
  // the time anyone reads; a bulk seed has neither, so do both explicitly
  // for honest plans (without VACUUM every index-only scan pays heap
  // fetches and the planner prices it as a sort instead).
  await db.exec('VACUUM (ANALYZE) events');
  await db.exec('VACUUM (ANALYZE) members');

  // --- read path: the queries the funnel actually issues --------------------
  const since = iso(base + (N - 168) * 3600_000); // last 7 days of seeded joins
  const timed = async (label: string, sql: string, ...params: unknown[]) => {
    const a = Date.now();
    const rows = await db.prepare(sql).all(...params);
    return { label, ms: Date.now() - a, rows: rows.length };
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
  for (const r of reads) console.log(`    ${r.label.padEnd(31)} ${String(r.ms).padStart(6)}ms  (${r.rows} rows)`);
  console.log(`  plans:`);
  for (const [k, v] of Object.entries(plans)) console.log(`    ${k.padEnd(31)} ${v}`);
  console.log(`  events indexes:`);
  for (const i of indexSizes) console.log(`    ${i.indexname.padEnd(28)} ${i.size}`);
  console.log('');
} finally {
  await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
}
