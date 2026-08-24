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

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const allowNonempty = args.has('--allow-nonempty');

/** Order matters only for readability; there are no FKs between these. */
const TABLES = ['events', 'members', 'invite_snapshots'] as const;
type Table = (typeof TABLES)[number];

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

const srcCounts = Object.fromEntries(TABLES.map((t) => [t, sourceCount(t)])) as Record<
  Table,
  number
>;

console.log(`source: ${sqlitePath}`);
for (const t of TABLES) console.log(`  ${t.padEnd(17)} ${srcCounts[t]}`);

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
  for (const t of TABLES) before[t] = await targetCount(dst, t);
  const occupied = TABLES.filter((t) => before[t] > 0);
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

  for (const t of TABLES) {
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
    const order = t === 'events' ? 'id' : shared.slice(0, 2).join(', ');
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
      for (const row of rows) for (const c of shared) params.push(row[c] ?? null);

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
    console.log(`  ${t.padEnd(17)} read ${copied}`);
  }

  // BIGSERIAL does not know about ids we inserted explicitly. Move it past the
  // high-water mark or the next insert collides.
  await dst.exec(
    `SELECT setval(pg_get_serial_sequence('events', 'id'),
                   GREATEST((SELECT COALESCE(MAX(id), 0) FROM events), 1),
                   (SELECT COUNT(*) FROM events) > 0)`,
  );

  console.log('\nverifying...');
  for (const t of TABLES) {
    const got = await targetCount(dst, t);
    const want = srcCounts[t] + (allowNonempty ? before[t] : 0);
    const ok = got === want;
    console.log(`  ${t.padEnd(17)} source ${srcCounts[t]}  target ${got}  ${ok ? 'ok' : 'MISMATCH'}`);
    if (!ok) failed = true;
  }

  // Counts can match while the contents differ. Compare the key set.
  const srcKeys = new Set(
    (src.prepare(`SELECT idempotency_key AS k FROM events`).all() as { k: string }[]).map(
      (r) => r.k,
    ),
  );
  const dstKeys = new Set(
    (await dst.prepare(`SELECT idempotency_key AS k FROM events`).all<{ k: string }>()).map(
      (r) => r.k,
    ),
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

  const seq = await dst
    .prepare(`SELECT last_value AS v FROM ${'events_id_seq'}`)
    .get<{ v: number }>()
    .catch(() => undefined);
  const maxId = await dst.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM events`).get<{ n: number }>();
  if (seq && Number(seq.v) < Number(maxId?.n ?? 0)) {
    failed = true;
    console.log(`  events id sequence  at ${seq.v}, below max id ${maxId?.n}  MISMATCH`);
  } else {
    console.log(`  events id sequence  ok`);
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
