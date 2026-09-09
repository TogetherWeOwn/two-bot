/**
 * One-off: copy an existing SQLite funnel log into Postgres.
 *
 *   TWO_SQLITE_PATH=./data/two.db node scripts/migrate-sqlite-to-postgres.ts --dry-run
 *   TWO_SQLITE_PATH=./data/two.db node scripts/migrate-sqlite-to-postgres.ts
 *
 * Flags:
 *   --dry-run          read the source, print the counts, write nothing
 *   --allow-nonempty   proceed even though the target already has rows
 *
 * Reads TWO_SQLITE_PATH (default ./data/two.db) and TWO_DATABASE_URL.
 *
 * The only output that means success is `MIGRATION VERIFIED` on the last line
 * and exit 0. Anything else: do not start the bot against Postgres, and do not
 * delete the SQLite file. See docs/RUNBOOK.md.
 *
 * Two things this checks that a row count alone would not:
 *
 *  * Every `events.idempotency_key` in SQLite is present in Postgres. Counts
 *    can match while the contents differ - one row dropped and one row
 *    duplicated nets to zero. The key set is what actually protects us from
 *    double-counting a join later.
 *  * The `events` id sequence is moved past the highest copied id. Miss this
 *    and the first write after the migration collides with an existing row,
 *    which is a confusing way to find out at 2am.
 *
 * Stop the bot first. Nothing here takes a lock that would stop it writing
 * mid-copy, and a join recorded into SQLite after we have read that table is a
 * join that does not make it across.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { openDb, isPostgresSpec, type Db } from '../src/store/db.ts';
import { migrate } from '../src/store/migrate.ts';
import { migrationValue, migrationValuesMatch } from './migration-values.ts';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const allowNonempty = args.has('--allow-nonempty');

/**
 * Parent tables precede their FK dependants. Feature tables are optional in
 * old SQLite sources: report and skip a table that did not exist yet.
 */
const REQUIRED_TABLES = ['events', 'members', 'invite_snapshots'] as const;
const OPTIONAL_TABLES = [
  'moderation_warnings',
  'moderation_scheduled_unbans',
  'moderation_audit',
  'moderation_lockdowns',
  'moderation_idempotency',
  'containment_events',
  'containment_incidents',
  'join_risk_flags',
  'tickets',
  'ticket_transcripts',
  'automod_violations',
  'automod_processed_messages',
  'automation_commands',
  'scheduled_messages',
  'sticky_messages',
  'automation_audit_log',
  'self_role_audit',
] as const;
const TABLES = [...REQUIRED_TABLES, ...OPTIONAL_TABLES] as const;
type Table = (typeof TABLES)[number];

const PRIMARY_KEYS: Record<Table, readonly string[]> = {
  events: ['id'],
  members: ['guild_id', 'member_id'],
  invite_snapshots: ['guild_id', 'code'],
  moderation_warnings: ['id'],
  moderation_scheduled_unbans: ['guild_id', 'user_id', 'request_id'],
  moderation_audit: ['request_id'],
  moderation_lockdowns: ['channel_id'],
  moderation_idempotency: ['guild_id', 'idempotency_key'],
  containment_events: ['audit_entry_id'],
  containment_incidents: ['id'],
  join_risk_flags: ['event_id'],
  tickets: ['id'],
  ticket_transcripts: ['ticket_id'],
  automod_violations: ['guild_id', 'user_id'],
  automod_processed_messages: ['guild_id', 'message_id'],
  automation_commands: ['guild_id', 'name'],
  scheduled_messages: ['id'],
  sticky_messages: ['guild_id', 'channel_id'],
  automation_audit_log: ['id'],
  self_role_audit: ['event_id'],
};

const sqlitePath = process.env.TWO_SQLITE_PATH || process.env.TWO_DB_PATH || './data/two.db';
if (!existsSync(sqlitePath)) {
  console.error(`migrate-data: no SQLite database at ${sqlitePath}`);
  process.exit(1);
}

const src = new DatabaseSync(sqlitePath, { readOnly: true });

function sourceColumns(table: Table): string[] {
  return (src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}
function sourceCount(table: Table): number {
  return Number((src.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function sourceRows(table: Table, columns: readonly string[]): Record<string, unknown>[] {
  const quoted = columns.map((c) => `"${c}"`).join(', ');
  return src.prepare(`SELECT ${quoted} FROM ${table} ORDER BY ${PRIMARY_KEYS[table].join(', ')}`).all() as Record<string, unknown>[];
}

/** A feature table this old SQLite file never had. Copied as zero rows. */
const absentFromSource = new Set<Table>(
  TABLES.filter((t) => (src.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(t) as { name: string } | undefined) === undefined),
);
for (const t of absentFromSource) console.log(`  ${t}: not in source, skipped`);

const copyableTables = TABLES.filter((t) => !absentFromSource.has(t)) as Table[];
const srcCounts = Object.fromEntries(copyableTables.map((t) => [t, sourceCount(t)])) as Record<
  Table,
  number
>;

console.log(`source: ${sqlitePath}`);
for (const t of copyableTables) console.log(`  ${t.padEnd(26)} ${srcCounts[t]}`);

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  src.close();
  process.exit(0);
}

const url = process.env.TWO_DATABASE_URL?.trim();
if (!url || !isPostgresSpec(url)) {
  console.error('migrate-data: TWO_DATABASE_URL must be set to a Postgres URL.');
  src.close();
  process.exit(1);
}

const dst = await openDb(url, { skipMigrations: true, applicationName: 'two-bot-migrate' });

/** Columns the target actually has, so a schema the website extended still works. */
async function targetColumns(db: Db, table: Table): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ?
        ORDER BY ordinal_position`,
    )
    .all<{ column_name: string }>(table);
  return rows.map((r) => r.column_name);
}

async function targetCount(db: Db, table: Table): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>();
  return Number(r?.n ?? 0);
}

let failed = false;

try {
  // The target may be an empty database. Make the schema before looking at it.
  await migrate(dst);

  const before = {} as Record<Table, number>;
  for (const t of copyableTables) before[t] = await targetCount(dst, t);
  const occupied = copyableTables.filter((t) => before[t] > 0);
  if (occupied.length > 0 && !allowNonempty) {
    console.error(
      `\nmigrate-data: target already has rows (${occupied
        .map((t) => `${t}=${before[t]}`)
        .join(', ')}).`,
    );
    console.error('migrate-data: pass --allow-nonempty if that is genuinely what you want.');
    process.exit(1);
  }

  console.log(`\ntarget: ${url.replace(/\/\/[^@]*@/, '//***@')}`);

  for (const t of copyableTables) {
    const cols = sourceColumns(t).filter((c) => c !== 'rowid');
    const tCols = await targetColumns(dst, t);
    const shared = cols.filter((c) => tCols.includes(c));

    const droppedFromSource = cols.filter((c) => !tCols.includes(c));
    if (droppedFromSource.length > 0) {
      console.log(`  ${t}: source columns not in target, skipped: ${droppedFromSource.join(', ')}`);
    }
    if (shared.length === 0) {
      console.error(`migrate-data: ${t} has no columns in common between source and target.`);
      failed = true;
      continue;
    }

    // Deterministic read order so a re-run copies the same rows in the same
    // order, and so OFFSET means something.
    const order = PRIMARY_KEYS[t].join(', ');
    const quoted = shared.map((c) => `"${c}"`).join(', ');
    const placeholders = `(${shared.map(() => '?').join(', ')})`;
    // Postgres caps a statement at 65535 bound parameters.
    const batchSize = Math.max(1, Math.floor(60_000 / shared.length));

    let copied = 0;
    let offset = 0;
    for (;;) {
      const rows = src
        .prepare(`SELECT ${quoted} FROM ${t} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(batchSize, offset) as Record<string, unknown>[];
      if (rows.length === 0) break;

      const params: unknown[] = [];
      for (const row of rows) for (const c of shared) params.push(migrationValue(t, c, row[c]));

      // DO NOTHING so that a re-run after a partial failure is safe rather
      // than an error. The verification below is what proves it landed.
      await dst
        .prepare(
          `INSERT INTO ${t} (${quoted}) VALUES ${rows.map(() => placeholders).join(', ')}
           ON CONFLICT DO NOTHING`,
        )
        .run(...params);

      copied += rows.length;
      offset += rows.length;
    }
    console.log(`  ${t.padEnd(26)} read ${copied}`);
  }

  // BIGSERIAL does not know about ids we inserted explicitly. Move it past the
  // high-water mark or the next insert collides.
  await dst.exec(
    `SELECT setval(pg_get_serial_sequence('events', 'id'),
                   GREATEST((SELECT COALESCE(MAX(id), 0) FROM events), 1),
                   (SELECT COUNT(*) FROM events) > 0)`,
  );

  console.log('\nverifying...');
  for (const t of copyableTables) {
    const got = await targetCount(dst, t);

    // The copy uses ON CONFLICT DO NOTHING, so the target ends up holding the
    // *union* of what it already had and what the source has. How large that
    // union is depends on how much the two overlapped - and on the resume path
    // that --allow-nonempty exists for, the overlap is exactly the rows a
    // previous interrupted run already copied, which is not knowable from
    // counts. Adding the two together and demanding equality could only ever
    // hold when the overlap was empty, so a resumed migration could never
    // report success. Assert the bounds a union must satisfy instead; the
    // key-set comparison below is what actually proves nothing was lost.
    const low = Math.max(before[t], srcCounts[t]);
    const high = before[t] + srcCounts[t];
    const ok = got >= low && got <= high;
    const range = before[t] > 0 ? `  had ${before[t]}  expect ${low}..${high}` : '';
    console.log(
      `  ${t.padEnd(26)} source ${srcCounts[t]}  target ${got}${range}  ${ok ? 'ok' : 'MISMATCH'}`,
    );
    if (!ok) failed = true;
  }

  // Counts can match while the contents differ. Compare every source row by
  // primary key, including ticket state and transcript bodies.
  for (const t of copyableTables) {
    const srcCols = sourceColumns(t).filter((c) => c !== 'rowid');
    const dstCols = await targetColumns(dst, t);
    const shared = srcCols.filter((c) => dstCols.includes(c));
    const rows = sourceRows(t, shared);
    let mismatches = 0;
    const keyColumns = PRIMARY_KEYS[t];
    if (keyColumns.some((c) => !shared.includes(c))) {
      failed = true;
      console.log(`  ${t.padEnd(17)} primary key columns are not shared  MISMATCH`);
      continue;
    }
    for (const row of rows) {
      const target = await dst
        .prepare(`SELECT ${shared.map((c) => `"${c}"`).join(', ')} FROM ${t} WHERE ${keyColumns.map((c) => `"${c}" = ?`).join(' AND ')}`)
        .get<Record<string, unknown>>(...keyColumns.map((c) => row[c]));
      if (!target || shared.some((c) => !migrationValuesMatch(t, c, row[c], target[c]))) mismatches++;
    }
    if (mismatches > 0) {
      failed = true;
      console.log(`  ${t.padEnd(17)} ${mismatches} source row(s) missing or changed  MISMATCH`);
    } else {
      console.log(`  ${t.padEnd(17)} ${rows.length} source row(s) match by primary key  ok`);
    }
  }

  const srcKeys = new Set(
    (src.prepare(`SELECT idempotency_key AS k FROM events`).all() as { k: string }[]).map((r) => r.k),
  );
  const dstKeys = new Set(
    (await dst.prepare(`SELECT idempotency_key AS k FROM events`).all<{ k: string }>()).map((r) => r.k),
  );
  const missing = [...srcKeys].filter((k) => !dstKeys.has(k));
  if (missing.length > 0) {
    failed = true;
    console.log(`  idempotency keys  ${missing.length} MISSING from target`);
    for (const k of missing.slice(0, 10)) console.log(`    - ${k}`);
    if (missing.length > 10) console.log(`    ... and ${missing.length - 10} more`);
  } else {
    console.log(`  idempotency keys  ${srcKeys.size} present  ok`);
  }

  // Ask Postgres for the sequence's real name rather than assuming
  // `events_id_seq`, then read it. A check that cannot see the thing it is
  // checking has to fail: reporting `ok` because the read threw is how you get
  // told the migration is verified and then collide with an existing id on the
  // first write. Both failure modes below are failures.
  const maxId = await dst.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM events`).get<{ n: number }>();
  const seqName = await dst
    .prepare(`SELECT pg_get_serial_sequence('events', 'id') AS s`)
    .get<{ s: string | null }>()
    .catch((err) => {
      console.log(`  events id sequence  could not be resolved: ${String(err)}  FAILED`);
      return undefined;
    });

  if (!seqName?.s) {
    failed = true;
    if (seqName) console.log('  events id sequence  events.id has no sequence attached  FAILED');
  } else {
    // seqName.s is Postgres's own identifier for the sequence, not user input.
    const seq = await dst
      .prepare(`SELECT last_value AS v, is_called AS called FROM ${seqName.s}`)
      .get<{ v: number; called: boolean }>()
      .catch((err) => {
        console.log(`  events id sequence  could not be read: ${String(err)}  FAILED`);
        return undefined;
      });

    if (!seq) {
      failed = true;
    } else {
      // An uncalled sequence hands out last_value itself on the next nextval();
      // a called one hands out last_value + 1. The id we must stay clear of is
      // the highest one already in the table.
      const next = Number(seq.v) + (seq.called ? 1 : 0);
      const want = Number(maxId?.n ?? 0);
      if (next <= want) {
        failed = true;
        console.log(`  events id sequence  next id ${next}, not past max id ${want}  MISMATCH`);
      } else {
        console.log(`  events id sequence  next id ${next}, past max id ${want}  ok`);
      }
    }
  }
} catch (err) {
  failed = true;
  console.error(`\nmigrate-data: ${String(err)}`);
} finally {
  src.close();
  await dst.close();
}

if (failed) {
  console.error('\nMIGRATION FAILED - do not start the bot, do not delete the SQLite file.');
  process.exit(1);
}
console.log('\nMIGRATION VERIFIED');
