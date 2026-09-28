/**
 * Event-store write-path benchmark + funnel/dashboard-query index audit
 * (TOG-5709, extended TOG-7207).
 *
 *   TWO_DATABASE_URL=postgres://two:two@127.0.0.1:5432/two_test node scripts/event-store-bench.ts [members]
 *
 * Seeds N members with a realistic event mix through `EventStore.record` -
 * the only write path into the funnel log - then times the reads the funnel
 * report (scripts/funnel.ts), the dashboard (scripts/dashboard.ts via
 * `buildDashboard`) and the store actually issue, printing each timing plus
 * the plan shape that produced it.
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
 *
 * TOG-7207 acceptance scale: N=10000 seeds 10k members / ~100k events and
 * every report query shape must complete in under 1s. Reference run
 * (2026-09-28, vendored embedded Postgres 18, 100124 events / 10000
 * members, ANALYZE'd): worst single read 29ms (dashboard members full
 * scan), dashboard build end-to-end 149ms, exit 0. Separately measured
 * against the same scale: funnel 400d end-to-end 0.33s, dashboard 12wk
 * 0.40s. No index or query change warranted; this script is the
 * reproducible proof. The script exits nonzero if any timed read breaches
 * the 1s budget, so the acceptance criterion is runnable, not just
 * documented.
 */
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { buildDashboard } from '../src/analytics/dashboard.ts';
import { MESSAGE_RUNGS, type EventType } from '../src/core/events.ts';

const spec = process.env.TWO_DATABASE_URL?.trim();
if (!spec) {
  console.error('event-store-bench: TWO_DATABASE_URL is not set. Point it at an isolated database, never production.');
  process.exit(2);
}
if (/prod/i.test(spec)) {
  console.error('event-store-bench: refusing a spec that looks like production.');
  process.exit(2);
}
const N = Math.max(1, Number(process.argv[2] ?? 2000) || 2000);
if (!Number.isInteger(N) || N > 500_000) {
  console.error('event-store-bench: members must be an integer 1..500000.');
  process.exit(2);
}
/** TOG-7207: the acceptance bar every timed read is held to. */
const BUDGET_MS = 1000;

const schema = `bench_${process.pid}_${Date.now().toString(36)}`;
const GUILD = 'bench-guild';
const db = await openDb(spec, { schema, applicationName: 'two-bot:bench' });
const store = new EventStore(db);

try {
  // Anchored so the seed ends now: hourly joins span the last N hours, which
  // keeps both the seed-relative 7d window and the wall-clock 30d windows the
  // dashboard uses inside seeded history.
  const base = Date.now() - N * 3600_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  // --- write path: one realistic member lifecycle per member ----------------
  // Mix mirrors a live community: most clear the gate, ~2/3 reach the
  // onboarding picker, ~7/10 post, ~4/10 visit voice (1-3 visits each, each
  // a start+end pair with a measured duration; every 20th member carries an
  // unknown-start end, like a bot-down gap), ~15% leave, ~20% go inactive.
  // Clicks are memberless invite_click rows spread over the campaigns below.
  const joinSources = ['invite:CODE1', 'invite:CODE1', 'invite:CODE2', 'invite:CODE3', 'vanity', 'unknown'];
  const channels = ['channel:c1', 'channel:c2', 'channel:c3'];
  const t0 = Date.now();
  let events = 0;
  for (let i = 0; i < N; i++) {
    const m = `m${i}`;
    const j = base + i * 3600_000; // hourly joins: a multi-year log, like the real one
    const joinSource = joinSources[i % joinSources.length];
    const batch: Array<{ type: EventType; at: number; source: string; metadata?: Record<string, unknown>; token?: string }> = [
      { type: 'member_join', at: j, source: joinSource },
    ];
    if (i % 10 < 8) batch.push({ type: 'gate_cleared', at: j + 60_000, source: 'live' });
    if (i % 10 < 6) {
      batch.push({ type: 'onboarding_prompted', at: j + 6 * 60_000, source: 'job:onboarding' });
      batch.push({ type: 'game_roles_selected', at: j + 20 * 60_000, source: 'job:onboarding', metadata: { games: ['chess'] } });
      batch.push({ type: 'channel_routed', at: j + 21 * 60_000, source: 'job:onboarding' });
    }
    if (i % 10 < 7) {
      const ch = channels[i % channels.length];
      batch.push({ type: 'first_message', at: j + 3600_000, source: ch });
      if (i % 10 < 5) batch.push({ type: 'second_message', at: j + 3700_000, source: ch });
      if (i % 10 < 4) batch.push({ type: 'third_message', at: j + 3800_000, source: ch });
    }
    if (i % 10 < 4) {
      const visits = 1 + (i % 2 === 0 ? 1 : 0) + (i % 5 === 0 ? 1 : 0);
      for (let v = 0; v < visits; v++) {
        const vs = j + (v + 1) * 5 * 3600_000;
        const ch = `voice:v${(i + v) % 3}`;
        batch.push({ type: 'voice_session_start', at: vs, source: ch });
        const dur = 60 + ((i * 37 + v * 911) % 3540);
        batch.push({
          type: 'voice_session_end',
          at: vs + dur * 1000,
          source: ch,
          metadata: i % 20 === 0 ? { startKnown: false } : { startKnown: true, durationSeconds: dur },
        });
      }
      if (i % 10 < 2) batch.push({ type: 'first_voice_session', at: j + 5 * 3600_000, source: `voice:v${i % 3}` });
    }
    // Leave/inactive land ~45d after joining when that is in the past (later
    // joiners have not aged that far yet, so they stay active members).
    const laggedAt = j + 45 * 86_400_000;
    const aged = laggedAt <= Date.now();
    if (aged && i % 20 < 3) batch.push({ type: 'member_leave', at: laggedAt, source: 'unknown' });
    if (aged && i % 10 < 2) batch.push({ type: 'member_inactive', at: laggedAt, source: 'job:inactivity' });
    for (const e of batch) {
      await store.record({
        guildId: GUILD,
        memberId: m,
        eventType: e.type,
        occurredAt: iso(e.at),
        source: e.source,
        ...(e.metadata ? { metadata: e.metadata } : {}),
      });
      events++;
    }
  }
  // Campaigns behind the per-campaign section of scripts/funnel.ts, then
  // memberless clicks spread over them (TOG-7207: keeps total events ~10x
  // members so N=10000 reproduces the card's 10k/100k scale).
  await db.exec(
    `INSERT INTO invite_campaigns (slug, label, invite_code, created_at) VALUES
     ('reddit-sidebar', 'Reddit sidebar', 'CODE1', '${iso(base)}'),
     ('blog-footer', 'Blog footer', 'CODE2', '${iso(base)}'),
     ('partner-stream', 'Partner stream', 'CODE3', '${iso(base)}')
     ON CONFLICT (slug) DO NOTHING`,
  );
  const clickSources = ['invite:CODE1', 'invite:CODE2', 'invite:CODE3', 'unknown'];
  const clicks = Math.round(N * 2.9);
  for (let k = 0; k < clicks; k++) {
    const at = base + Math.floor((k * N * 3600_000) / clicks);
    await store.record({
      guildId: GUILD,
      memberId: null,
      eventType: 'invite_click',
      occurredAt: iso(at),
      source: clickSources[k % clickSources.length],
      dedupeToken: `bench-click-${k}`,
    });
    events++;
  }
  const writeMs = Date.now() - t0;
  // Production autovacuum would have statistics and an all-visible heap by
  // the time anyone reads; a bulk seed has neither, so do both explicitly
  // for honest plans (without VACUUM every index-only scan pays heap
  // fetches and the planner prices it as a sort instead).
  await db.exec('VACUUM (ANALYZE) events');
  await db.exec('VACUUM (ANALYZE) members');

  // --- read path: the queries the funnel and dashboard actually issue -------
  const since = iso(base + (N - 168) * 3600_000); // last 7 days of seeded joins
  const since30 = iso(Date.now() - 30 * 86_400_000);
  const timed = async (label: string, sql: string, ...params: unknown[]) => {
    const a = Date.now();
    const rows = await db.prepare(sql).all(...params);
    return { label, ms: Date.now() - a, rows: rows.length };
  };
  const reads = [
    await timed('funnel count (type+time)', `SELECT COUNT(*) AS n FROM events WHERE event_type = ? AND occurred_at >= ?`, 'member_join' as EventType, since),
    await timed('joiners DISTINCT (windowed)', `SELECT COUNT(DISTINCT member_id) AS n FROM events WHERE event_type = ? AND occurred_at >= ?`, 'member_join' as EventType, since),
    await timed('stage DISTINCT (unwindowed)', `SELECT COUNT(DISTINCT member_id) AS n FROM events WHERE event_type = ? AND member_id IS NOT NULL`, 'first_message' as EventType),
    await timed('member rung lookup', `SELECT event_type, occurred_at FROM events WHERE guild_id = ? AND member_id = ? AND event_type IN (?, ?, ?)`, GUILD, 'm1', ...MESSAGE_RUNGS),
    await timed('hasEvent probe', `SELECT 1 AS x FROM events WHERE guild_id = ? AND member_id = ? AND event_type = ? LIMIT 1`, GUILD, 'm1', 'first_voice_session' as EventType),
    await timed('write series (recorded_at scan)', `SELECT recorded_at AS at FROM events WHERE occurred_at >= ? ORDER BY recorded_at`, since),
    // TOG-7207: funnel.ts shapes beyond the store reads above.
    await timed('funnel stuck-at-gate', `SELECT COUNT(*) AS n FROM members WHERE NOT is_bot AND left_at IS NULL AND joined_at IS NOT NULL AND gate_cleared_at IS NULL`),
    await timed('funnel never-posted', `SELECT COUNT(*) AS n FROM members WHERE joined_at IS NOT NULL AND first_message_at IS NULL AND first_voice_at IS NULL AND left_at IS NULL AND NOT is_bot`),
    await timed('funnel by-source GROUP BY', `SELECT source, COUNT(*) AS n FROM events WHERE event_type='member_join' AND occurred_at >= ? GROUP BY source ORDER BY n DESC LIMIT 15`, since),
    await timed('funnel per-campaign correlated', `SELECT c.slug, (SELECT COUNT(*) FROM events e WHERE e.event_type='invite_click' AND e.occurred_at >= ? AND e.source = 'invite:' || c.invite_code) AS clicks, (SELECT COUNT(*) FROM events e WHERE e.event_type='member_join' AND e.occurred_at >= ? AND e.source = 'invite:' || c.invite_code) AS joins FROM invite_campaigns c ORDER BY clicks DESC, c.slug`, since, since),
    await timed('funnel retention cohort', `SELECT COUNT(*) AS n FROM members WHERE joined_at >= ? AND joined_at <= ? AND NOT is_bot`, since, iso(Date.now() - 1 * 86_400_000)),
    await timed('funnel click rows', `SELECT occurred_at, source, metadata FROM events WHERE event_type='invite_click' AND occurred_at >= ?`, since),
    // TOG-7207: dashboard.ts (buildDashboard) full-scan shapes. Rule 1 in
    // src/analytics/dashboard.ts: the DB is asked for rows, arithmetic stays
    // in JS - so these scans ARE the dashboard's read path.
    await timed('dashboard members scan', `SELECT member_id, joined_at, join_source, gate_cleared_at, first_message_at, first_voice_at, last_active_at, left_at FROM members WHERE NOT is_bot`),
    await timed('dashboard join events scan', `SELECT member_id, occurred_at, source FROM events WHERE event_type = 'member_join'`),
    await timed('dashboard voice ends scan', `SELECT metadata FROM events WHERE event_type = 'voice_session_end'`),
    await timed('dashboard gate events scan', `SELECT source, occurred_at, recorded_at FROM events WHERE event_type = 'gate_cleared'`),
    await timed('dashboard channel events', `SELECT source, occurred_at FROM events WHERE source LIKE 'channel:%' AND occurred_at >= ?`, since30),
    await timed('dashboard guild tail', `SELECT guild_id FROM events ORDER BY id DESC LIMIT 1`),
  ];
  // End to end: the whole dashboard build, queries + JS bucketing.
  const dashStart = Date.now();
  const dashboard = await buildDashboard(db, { weeks: 12 });
  const dashMs = Date.now() - dashStart;

  // --- plan shapes: which index (if any) each read rides --------------------
  const explain = async (sql: string) =>
    (await db.prepare(`EXPLAIN ${sql}`).all<Record<string, string>>())
      .map((r) => r['QUERY PLAN'])
      .filter((l) => /Scan|Sort|Aggregate/.test(l))
      .slice(0, 3)
      .join(' > ');
  const plans: Record<string, string> = {
    'stage DISTINCT (unwindowed)': await explain(`SELECT COUNT(DISTINCT member_id) FROM events WHERE event_type = 'first_message' AND member_id IS NOT NULL`),
    'member rung lookup': await explain(`SELECT event_type, occurred_at FROM events WHERE guild_id = '${GUILD}' AND member_id = 'm1' AND event_type IN ('first_message','second_message','third_message')`),
    'write series (recorded_at scan)': await explain(`SELECT recorded_at FROM events WHERE occurred_at >= '${since}' ORDER BY recorded_at`),
    'dashboard channel events': await explain(`SELECT source, occurred_at FROM events WHERE source LIKE 'channel:%' AND occurred_at >= '${since30}'`),
    'funnel stuck-at-gate': await explain(`SELECT COUNT(*) FROM members WHERE NOT is_bot AND left_at IS NULL AND joined_at IS NOT NULL AND gate_cleared_at IS NULL`),
    'funnel per-campaign subq': await explain(`SELECT COUNT(*) FROM events e WHERE e.event_type='member_join' AND e.occurred_at >= '${since}' AND e.source = 'invite:CODE1'`),
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
  console.log(`  reads (budget ${BUDGET_MS}ms each):`);
  let breaches = 0;
  for (const r of reads) {
    const over = r.ms > BUDGET_MS ? '  OVER BUDGET' : '';
    if (over) breaches++;
    console.log(`    ${r.label.padEnd(31)} ${String(r.ms).padStart(6)}ms  (${r.rows} rows)${over}`);
  }
  const dashOver = dashMs > BUDGET_MS ? '  OVER BUDGET' : '';
  if (dashOver) breaches++;
  console.log(`    ${'dashboard build (end-to-end)'.padEnd(31)} ${String(dashMs).padStart(6)}ms  (${dashboard.weeks.length} weeks, ${dashboard.cohorts.length} cohorts)${dashOver}`);
  console.log(`  plans:`);
  for (const [k, v] of Object.entries(plans)) console.log(`    ${k.padEnd(31)} ${v}`);
  console.log(`  events indexes:`);
  for (const i of indexSizes) console.log(`    ${i.indexname.padEnd(28)} ${i.size}`);
  console.log(breaches === 0 ? '' : `  ${breaches} READ(S) OVER BUDGET\n`);
  if (breaches > 0) process.exitCode = 1;
} finally {
  await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
}
