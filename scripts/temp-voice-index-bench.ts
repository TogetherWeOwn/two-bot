/**
 * Temp-voice index audit + EXPLAIN harness (TOG-6476).
 *
 *   TWO_DATABASE_URL=postgres://two:two@127.0.0.1:5432/two_test node scripts/temp-voice-index-bench.ts [guilds]
 *
 * Follow-up to TOG-5709 (event-store benchmark + index migration):
 * migrations/0036_temp_voice.sql and 0037_temp_voice_owner_transition.sql
 * landed after that review and add temp-voice tables (incl. ownership
 * journal writes on every transition). This script seeds a realistic
 * multi-guild scratch state through `TempVoiceStore` itself - the only write
 * path - then runs EXPLAIN on the temp-voice hot paths:
 *
 *   - lookup-by-guild/channel (getByChannel: every voice-state event,
 *     control resolve, delete path, owner recovery)
 *   - owner-transition writes (beginOwnerChange / completeOwnerChange,
 *     both PK-anchored UPDATEs)
 *   - ownership journal insert (audit owner_change row on an interrupted
 *     transition) and the guild-time audit read
 *   - sweep/reconcile scans (listLive, listStaleReservations, cap counts)
 *
 * ISOLATION. Everything happens inside one schema named
 * `benchtv_<pid>_<timestamp>` that this script creates, migrates, and drops
 * on the way out. It never touches `public` or any other schema - but point
 * it at a throwaway database anyway (CI's `two_test`, a local cluster),
 * never production. Needs CREATE/DROP SCHEMA on the database. No live
 * Discord, no live guild writes: every id is synthetic.
 *
 * WHAT IT PROVES. Re-run before touching any index on `temp_voice_channels`,
 * `temp_voice_creates` or `temp_voice_audit`: the printed plans are the
 * review evidence. Reference run (2026-09-27, Postgres 17, 100 guilds x 40
 * channels, ANALYZE'd): every hot path rides an index, no migration needed.
 * See TOG-6476.
 */
import { openDb } from '../src/store/db.ts';
import { TempVoiceStore } from '../src/tempVoice/store.ts';

const spec = process.env.TWO_DATABASE_URL?.trim() ?? process.env.DATABASE_URL?.trim() ?? '';
if (!spec) {
  console.error('temp-voice-index-bench: set TWO_DATABASE_URL (or DATABASE_URL) to an isolated database, never production.');
  process.exit(2);
}
const GUILDS = Math.max(1, Number(process.argv[2] ?? 100) || 100);
if (!Number.isInteger(GUILDS) || GUILDS > 5000) {
  console.error('temp-voice-index-bench: guilds must be an integer 1..5000.');
  process.exit(2);
}
if (/prod/i.test(spec)) {
  console.error('temp-voice-index-bench: refusing a spec that looks like production.');
  process.exit(2);
}

const PER_GUILD = 40; // mirrors maxPerGuild default: a full guild
const schema = `benchtv_${process.pid}_${Date.now().toString(36)}`;
const db = await openDb(spec, { schema, applicationName: 'two-bot:temp-voice-bench' });
const store = new TempVoiceStore(db);

const iso = (ms: number) => new Date(ms).toISOString();
const base = Date.parse('2026-06-01T00:00:00.000Z');

try {
  // --- seed through the store: the only write path --------------------------
  // Most rows live (channel attached), ~5% in-flight reservations
  // (channel_id NULL), ~2% stuck mid owner-transition (pending_owner_id set,
  // with a pending owner_change journal row, exactly what applyOwnerChange
  // writes on an interrupted grant).
  const t0 = Date.now();
  let channels = 0;
  let audits = 0;
  const probe = { guild: '', channel: '' };
  for (let g = 0; g < GUILDS; g++) {
    const guild = `bench-guild-${g}`;
    for (let c = 0; c < PER_GUILD; c++) {
      const owner = `user-${g}-${c % 10}`;
      const at = iso(base + (g * PER_GUILD + c) * 60_000);
      const res = await store.reserveIfUnderCaps({
        guildId: guild,
        generatorId: `gen-${g}`,
        categoryId: `cat-${g}`,
        ownerId: owner,
        name: `room-${c}`,
        createdAt: at,
        maxPerUser: 1000,
        maxPerGuild: 1000,
        cooldownSeconds: 0,
      });
      if (!res.ok) throw new Error(`bench seed refused: ${res.reason} (guild ${g} channel ${c})`);
      const channel = `chan-${g}-${c}`;
      if (c % 20 === 19) {
        // In-flight reservation: never attached, dropped by boot reconcile.
        await store.audit({ guildId: guild, actorId: owner, channelId: null, action: 'create', outcome: 'ok' }, at);
        audits++;
        continue;
      }
      await store.attach(res.row.id, channel);
      channels++;
      await store.audit({ guildId: guild, actorId: owner, channelId: channel, action: 'create', outcome: 'ok' }, at);
      audits++;
      if (c % 50 === 49) {
        // Interrupted transition: intent persisted, journal row written.
        await store.beginOwnerChange(res.row.id, owner, `user-${g}-next`);
        await store.audit(
          { guildId: guild, actorId: null, channelId: channel, action: 'owner_change', outcome: 'pending', reason: 'bench seed: interrupted grant' },
          at,
        );
        audits++;
      }
      if (g === 0 && c === 0) probe.guild = guild;
      if (g === 0 && c === 1) probe.channel = channel;
    }
  }
  const writeMs = Date.now() - t0;
  // Production autovacuum would have statistics by the time anyone reads; a
  // bulk seed has none, so ANALYZE explicitly for honest plans (same reason
  // as scripts/event-store-bench.ts from TOG-5709).
  await db.exec('VACUUM (ANALYZE) temp_voice_channels');
  await db.exec('VACUUM (ANALYZE) temp_voice_creates');
  await db.exec('VACUUM (ANALYZE) temp_voice_audit');

  // --- read path: the exact predicates the store issues ---------------------
  const timed = async (label: string, sql: string, ...params: unknown[]) => {
    const a = Date.now();
    const rows = await db.prepare(sql).all(...params);
    return { label, ms: Date.now() - a, rows: rows.length };
  };
  const G = probe.guild;
  const C = probe.channel;
  const reads = [
    await timed('lookup by guild+channel', `SELECT * FROM temp_voice_channels WHERE guild_id = ? AND channel_id = ?`, G, C),
    await timed('cap count per owner', `SELECT COUNT(*) AS total FROM temp_voice_channels WHERE guild_id = ? AND owner_id = ?`, G, `user-0-1`),
    await timed('cap count per guild', `SELECT COUNT(*) AS total FROM temp_voice_channels WHERE guild_id = ?`, G),
    await timed('cooldown lookup', `SELECT last_created_at FROM temp_voice_creates WHERE guild_id = ? AND user_id = ?`, G, `user-0-1`),
    await timed('sweep scan (live)', `SELECT * FROM temp_voice_channels WHERE guild_id = ? AND channel_id IS NOT NULL ORDER BY created_at, id`, G),
    await timed('reconcile scan (stale reservations)', `SELECT * FROM temp_voice_channels WHERE guild_id = ? AND channel_id IS NULL AND created_at < ?`, G, iso(base + 10_000_000_000)),
    await timed('audit guild+time', `SELECT * FROM temp_voice_audit WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50`, G),
  ];

  // --- plan shapes: which index (if any) each hot path rides ----------------
  // Literals inlined so the printed plan is self-describing; the predicates
  // match the store's prepared statements above exactly.
  const explain = async (sql: string) =>
    (await db.prepare(`EXPLAIN ${sql}`).all<Record<string, string>>())
      .map((r) => r['QUERY PLAN'])
      .filter((l) => /Scan|Sort|Aggregate|Index|Bitmap|Limit/.test(l))
      .slice(0, 4)
      .join(' > ');
  const plans: Array<[string, string]> = [
    ['lookup by guild+channel', await explain(`SELECT * FROM temp_voice_channels WHERE guild_id = '${G}' AND channel_id = '${C}'`)],
    ['owner-transition begin (UPDATE by id)', await explain(`UPDATE temp_voice_channels SET pending_owner_id = 'x' WHERE id = 'no-such-id' AND owner_id = 'y' AND pending_owner_id IS NULL`)],
    ['owner-transition complete (UPDATE by id)', await explain(`UPDATE temp_voice_channels SET owner_id = 'x', pending_owner_id = NULL WHERE id = 'no-such-id' AND owner_id = 'y' AND pending_owner_id = 'x'`)],
    ['cap count per owner', await explain(`SELECT COUNT(*) FROM temp_voice_channels WHERE guild_id = '${G}' AND owner_id = 'user-0-1'`)],
    ['cap count per guild', await explain(`SELECT COUNT(*) FROM temp_voice_channels WHERE guild_id = '${G}'`)],
    ['cooldown lookup', await explain(`SELECT last_created_at FROM temp_voice_creates WHERE guild_id = '${G}' AND user_id = 'user-0-1'`)],
    ['sweep scan (live)', await explain(`SELECT * FROM temp_voice_channels WHERE guild_id = '${G}' AND channel_id IS NOT NULL ORDER BY created_at, id`)],
    ['reconcile scan (stale reservations)', await explain(`SELECT * FROM temp_voice_channels WHERE guild_id = '${G}' AND channel_id IS NULL AND created_at < '${iso(base)}'`)],
    ['audit guild+time', await explain(`SELECT * FROM temp_voice_audit WHERE guild_id = '${G}' ORDER BY created_at DESC LIMIT 50`)],
  ];

  const indexSizes = await db
    .prepare(
      `SELECT indexrelname AS indexname, pg_size_pretty(pg_relation_size(indexrelid)) AS size
         FROM pg_stat_user_indexes WHERE schemaname = current_schema()
           AND relname IN ('temp_voice_channels', 'temp_voice_creates', 'temp_voice_audit')
         ORDER BY 1`,
    )
    .all<{ indexname: string; size: string }>();

  // --- report ----------------------------------------------------------------
  console.log(`\ntemp-voice index bench - ${GUILDS} guilds x ${PER_GUILD} rows, ${channels} live channels, ${audits} audit rows, schema ${schema}\n`);
  console.log(`  write path  ${String(channels + audits).padStart(7)} rows in ${(writeMs / 1000).toFixed(1)}s`);
  console.log(`  reads:`);
  for (const r of reads) console.log(`    ${r.label.padEnd(33)} ${String(r.ms).padStart(6)}ms  (${r.rows} rows)`);
  console.log(`  plans:`);
  let missing = 0;
  for (const [k, v] of plans) {
    const seq = /Seq Scan on temp_voice/.test(v);
    if (seq) missing++;
    console.log(`    ${seq ? 'SEQ!!' : 'idx  '} ${k.padEnd(33)} ${v}`);
  }
  console.log(`  temp-voice indexes:`);
  for (const i of indexSizes) console.log(`    ${i.indexname.padEnd(36)} ${i.size}`);
  console.log('');
  console.log(missing === 0 ? 'VERDICT: INDEXED - every hot path rides an index, no migration needed.' : `VERDICT: MISSING - ${missing} hot path(s) fall back to a sequential scan.`);
  console.log('');
  if (missing !== 0) process.exitCode = 1;
} finally {
  await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
}
