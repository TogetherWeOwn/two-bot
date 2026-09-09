/**
 * The backup format, and the two operations on it.
 *
 * Both `scripts/pg-backup.ts` and `scripts/pg-restore.ts` are thin wrappers
 * around this file, so the writer and the reader cannot drift apart, and so
 * the round trip can be tested without a shell.
 *
 * ## Why not pg_dump
 *
 * Because `postgresql-client` is not installed on the box, and a backup
 * procedure that only runs on a machine we do not have is not a backup
 * procedure. This is plain Node with no system dependency. If the client tools
 * land on the host, prefer them - see docs/RUNBOOK.md.
 *
 * ## The format
 *
 * Gzipped NDJSON. One JSON object per line, in three kinds:
 *
 *   {"kind":"manifest", version, createdAt, tables:[{name,columns,count}], ...}
 *   {"kind":"row", table, data:{...}}
 *   {"kind":"end", rows}
 *
 * The manifest comes first and carries the row count per table, taken inside
 * the same snapshot as the rows. That is what makes the restore verifiable:
 * "did every row the dump claimed to contain arrive" is a question with an
 * answer, rather than a hope. The trailing `end` line is how a truncated file
 * - the disk filled up mid-dump - is told apart from a complete one.
 *
 * Line-oriented on purpose: a corrupt row is one bad line, and the file can be
 * inspected with `zcat | head` when someone is trying to work out what is in a
 * backup at an unpleasant hour.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import type { Db } from './driver.ts';

/**
 * Everything the bot owns. The website's own tables are not ours to back up.
 *
 * The moderation tables are here because losing them is not cosmetic: a lost
 * scheduled unban is a tempban that became permanent, and a lost warn ledger
 * is a moderation history the staff cannot see (TOG-1659 High 5).
 */
export const DUMP_TABLES = [
  'events',
  'members',
  'invite_snapshots',
  'moderation_warnings',
  'moderation_scheduled_unbans',
  'moderation_audit',
  'moderation_lockdowns',
  'moderation_idempotency',
  'tickets',
  'ticket_transcripts',
  'automod_violations',
] as const;
export type DumpTable = (typeof DUMP_TABLES)[number];

/**
 * The only table names a restore will ever interpolate into SQL.
 *
 * `restore()` reads table names out of the backup file, and a backup file is
 * not a trusted input - it is bytes off a disk that someone else may have
 * written. Without this gate a crafted dump naming `website_users` would be
 * truncated-and-inserted like one of ours, which is exactly the boundary the
 * module header above promises to hold. Checked at parse time so a bad file is
 * refused before anything opens a transaction.
 */
function assertDumpTable(name: unknown, where: string): asserts name is DumpTable {
  if (typeof name !== 'string' || !(DUMP_TABLES as readonly string[]).includes(name)) {
    throw new Error(
      `${where}: ${JSON.stringify(name)} is not a table this backup format owns ` +
        `(expected one of ${DUMP_TABLES.join(', ')})`,
    );
  }
}

export const DUMP_VERSION = 1;

export interface DumpTableInfo {
  name: DumpTable;
  columns: string[];
  count: number;
}

export interface DumpManifest {
  kind: 'manifest';
  version: number;
  createdAt: string;
  tables: DumpTableInfo[];
  /** So a restore can put the id sequence back where it belongs. */
  eventsSequence: number;
  /** Which migrations the source had applied, for diagnosing an old backup. */
  schemaMigrations: string[];
}

/** Postgres caps a statement at 65535 bound parameters. Stay well under. */
function batchSizeFor(columnCount: number): number {
  return Math.max(1, Math.floor(60_000 / Math.max(1, columnCount)));
}

async function columnsOf(db: Db, table: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ?
        ORDER BY ordinal_position`,
    )
    .all<{ column_name: string }>(table);
  return rows.map((r) => r.column_name);
}

async function countOf(db: Db, table: string): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** Stable read order, so two dumps of an unchanged database are comparable. */
function orderFor(table: DumpTable, columns: string[]): string {
  if (table === 'events') return 'id';
  if (table === 'members') return 'guild_id, member_id';
  if (table === 'invite_snapshots') return 'guild_id, code';
  if (table === 'moderation_warnings') return 'created_at, id';
  if (table === 'moderation_scheduled_unbans') return 'execute_at, request_id';
  if (table === 'moderation_audit') return 'created_at, request_id';
  if (table === 'moderation_lockdowns') return 'guild_id, channel_id';
  if (table === 'moderation_idempotency') return 'guild_id, idempotency_key';
  if (table === 'tickets') return 'created_at, id';
  if (table === 'ticket_transcripts') return 'created_at, ticket_id';
  if (table === 'automod_violations') return 'guild_id, user_id';
  return columns.slice(0, 1).join(', ');
}

/**
 * Write every bot-owned table to `outPath` as one consistent snapshot.
 *
 * Runs in a single REPEATABLE READ transaction: every table is read as of the
 * same instant, so the bot does not have to be stopped to take a backup. Without
 * it, a join landing between the `events` read and the `members` read would
 * produce a backup whose projection disagrees with its own event log.
 */
export async function dump(db: Db, outPath: string): Promise<DumpManifest> {
  if (db.kind !== 'postgres') throw new Error('dump() is Postgres-only');

  const gz = createGzip({ level: 9 });
  const written = pipeline(gz, createWriteStream(outPath));

  const write = async (obj: unknown): Promise<void> => {
    if (!gz.write(JSON.stringify(obj) + '\n')) await once(gz, 'drain');
  };

  let manifest: DumpManifest;
  let rows = 0;

  try {
    manifest = await db.transaction(async (tx) => {
      // Must be the first statement in the transaction, before any query.
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');

      const tables: DumpTableInfo[] = [];
      for (const name of DUMP_TABLES) {
        tables.push({ name, columns: await columnsOf(tx, name), count: await countOf(tx, name) });
      }

      const seq = await tx
        .prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM events`)
        .get<{ n: number }>();
      const applied = await tx
        .prepare(`SELECT id FROM schema_migrations ORDER BY id`)
        .all<{ id: string }>();

      const m: DumpManifest = {
        kind: 'manifest',
        version: DUMP_VERSION,
        createdAt: new Date().toISOString(),
        tables,
        eventsSequence: Number(seq?.n ?? 0),
        schemaMigrations: applied.map((r) => r.id),
      };
      await write(m);

      for (const t of tables) {
        if (t.columns.length === 0) continue;
        const quoted = t.columns.map((c) => `"${c}"`).join(', ');
        const order = orderFor(t.name, t.columns);
        const batch = batchSizeFor(t.columns.length);
        let offset = 0;
        for (;;) {
          const page = await tx
            .prepare(`SELECT ${quoted} FROM ${t.name} ORDER BY ${order} LIMIT ? OFFSET ?`)
            .all<Record<string, unknown>>(batch, offset);
          if (page.length === 0) break;
          for (const data of page) {
            await write({ kind: 'row', table: t.name, data });
            rows++;
          }
          offset += page.length;
        }
      }

      return m;
    });

    await write({ kind: 'end', rows });
  } finally {
    gz.end();
    await written;
  }

  return manifest;
}

export interface RestoreReport {
  manifest: DumpManifest;
  /** Rows actually in each table once the restore committed. */
  restored: Record<string, number>;
  /** Columns the dump had that the target does not. Empty is the happy path. */
  droppedColumns: Record<string, string[]>;
  ok: boolean;
}

export interface DumpContents {
  manifest: DumpManifest;
  /** Rows read off the file, keyed by table. */
  buffers: Map<string, Record<string, unknown>[]>;
  /** Total rows read, already checked against the file's own `end` marker. */
  rows: number;
}

/**
 * Read a dump and check that it is internally consistent, touching no database.
 *
 * Everything that can be known from the file alone is decided here: the format
 * version, that the table names are ours, that the end marker is present, and
 * that the row count matches what the writer declared. `restore()` calls this
 * first, so a bad file is rejected before a transaction opens - and
 * `pg-restore --dry-run` calls it *instead*, which is what makes the dry run a
 * real check of the backup rather than a check that a URL parses.
 */
export async function inspect(inPath: string): Promise<DumpContents> {
  let manifest: DumpManifest | null = null;
  let sawEnd = false;
  let declaredRows = 0;
  const buffers = new Map<string, Record<string, unknown>[]>();

  const rl = createInterface({
    input: createReadStream(inPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.kind === 'manifest') {
      if (obj.version !== DUMP_VERSION) {
        throw new Error(`dump version ${obj.version}, this build reads ${DUMP_VERSION}`);
      }
      if (!Array.isArray(obj.tables)) throw new Error('manifest has no table list');
      for (const t of obj.tables) assertDumpTable(t?.name, 'manifest table');
      manifest = obj as DumpManifest;
    } else if (obj.kind === 'row') {
      assertDumpTable(obj.table, 'row');
      let buf = buffers.get(obj.table);
      if (!buf) buffers.set(obj.table, (buf = []));
      buf.push(obj.data as Record<string, unknown>);
    } else if (obj.kind === 'end') {
      sawEnd = true;
      declaredRows = Number(obj.rows ?? 0);
    }
  }

  if (!manifest) throw new Error('no manifest: not a two-bot dump, or the file is truncated');
  // A dump that stops mid-file is the disk-full case. Refuse it rather than
  // restoring a prefix of the data and calling it a success.
  if (!sawEnd) throw new Error('dump has no end marker - it is truncated, treat it as lost');

  const readRows = [...buffers.values()].reduce((n, b) => n + b.length, 0);
  if (readRows !== declaredRows) {
    throw new Error(`dump declares ${declaredRows} rows, file contains ${readRows}`);
  }

  return { manifest, buffers, rows: readRows };
}

/**
 * Replace the contents of the bot-owned tables with a dump.
 *
 * Destructive by design: the tables are truncated first, so a restore produces
 * the database as it was, not a merge. It runs in one transaction, so a
 * failure part way through leaves the target exactly as it was rather than
 * half-wiped - which is the state you least want to discover during a
 * recovery.
 *
 * The caller is responsible for deciding that this database is a legitimate
 * target. See scripts/pg-restore.ts.
 */
export async function restore(db: Db, inPath: string): Promise<RestoreReport> {
  if (db.kind !== 'postgres') throw new Error('restore() is Postgres-only');

  const { manifest, buffers } = await inspect(inPath);
  const droppedColumns: Record<string, string[]> = {};

  await db.transaction(async (tx) => {
    // RESTART IDENTITY so the sequence does not carry over from whatever was
    // in the target before; it is set explicitly below.
    await tx.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);

    for (const t of manifest.tables) {
      // Re-checked at the point of interpolation, not just at parse time: this
      // is the line that builds SQL from file-supplied text, so the guarantee
      // belongs where a future edit can see it.
      assertDumpTable(t.name, 'manifest table');
      const rows = buffers.get(t.name) ?? [];
      if (rows.length === 0) continue;

      const target = await columnsOf(tx, t.name);
      const cols = t.columns.filter((c) => target.includes(c));
      const dropped = t.columns.filter((c) => !target.includes(c));
      if (dropped.length > 0) droppedColumns[t.name] = dropped;
      if (cols.length === 0) throw new Error(`${t.name}: no columns in common with the target`);

      const quoted = cols.map((c) => `"${c}"`).join(', ');
      const tuple = `(${cols.map(() => '?').join(', ')})`;
      const batch = batchSizeFor(cols.length);

      for (let i = 0; i < rows.length; i += batch) {
        const page = rows.slice(i, i + batch);
        const params: unknown[] = [];
        for (const row of page) for (const c of cols) params.push(row[c] ?? null);
        await tx
          .prepare(`INSERT INTO ${t.name} (${quoted}) VALUES ${page.map(() => tuple).join(', ')}`)
          .run(...params);
      }
    }

    // Put the id sequence back past the restored high-water mark, or the first
    // write after the restore collides with a row we just put back.
    await tx.exec(
      `SELECT setval(pg_get_serial_sequence('events', 'id'),
                     GREATEST((SELECT COALESCE(MAX(id), 0) FROM events), 1),
                     (SELECT COUNT(*) FROM events) > 0)`,
    );
  });

  const restored: Record<string, number> = {};
  let ok = true;
  for (const t of manifest.tables) {
    restored[t.name] = await countOf(db, t.name);
    if (restored[t.name] !== t.count) ok = false;
  }

  return { manifest, restored, droppedColumns, ok };
}
