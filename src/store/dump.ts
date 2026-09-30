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
import { rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import type { Db } from './driver.ts';

/**
 * Everything the bot owns. The website's own tables are not ours to back up -
 * and there are none in this database: the website reads the `web_v1` contract
 * views, so every CREATE TABLE in migrations/ is a bot-owned table and every
 * one of them is listed here. That is the invariant, and
 * test/unit.dumpcover.test.ts holds it: if a migration adds a table without
 * adding it here, the suite fails.
 *
 * The moderation tables are here because losing them is not cosmetic: a lost
 * scheduled unban is a tempban that became permanent, and a lost warn ledger
 * is a moderation history the staff cannot see (TOG-1659 High 5). The same
 * reasoning covers the rest - a lost leveling ledger, scorecard run, guild
 * setting or pending feed delivery is staff-visible state silently rewound
 * (TOG-9074).
 *
 * Deliberate exclusions (the complete list):
 * - `schema_migrations` is not dumped. Its contents travel in the manifest's
 *   `schemaMigrations` field instead, which is what diagnoses an old backup.
 *   Dumping it would also restore it, and a restore must never mark a
 *   half-migrated target as fully migrated.
 *
 * Order matters: parents come before children (`tickets` before
 * `ticket_transcripts`, `lfg_posts` before `lfg_roles` before `lfg_signups`,
 * `feed_relays` before `feed_deliveries`, `rank_ladder` before the tables that
 * reference it), because restore inserts in manifest order and the foreign
 * keys are enforced on the way in. The drift test checks this too.
 */
export const DUMP_TABLES = [
  'events',
  'members',
  'invite_snapshots',
  'operational_audit_log',
  'moderation_warnings',
  'moderation_scheduled_unbans',
  'moderation_audit',
  'moderation_lockdowns',
  'moderation_idempotency',
  'containment_events',
  'containment_incidents',
  'join_risk_flags',
  'automation_commands',
  'scheduled_messages',
  'sticky_messages',
  'automation_audit_log',
  'tickets',
  'ticket_transcripts',
  'automod_violations',
  'automod_processed_messages',
  'self_role_audit',
  'self_role_panel_claims',
  // Web-contract collectors (TOG-9074): counters, ranks, scheduled events,
  // raid exclusions, the presence instrument, and the contract version row.
  'guild_counters',
  'counter_snapshots',
  'rank_ladder',
  'member_ranks',
  'rank_snapshots',
  'scheduled_events',
  'member_exclusions',
  'presence_probe',
  'web_contract_meta',
  // Leveling (TOG-9074).
  'xp_awards',
  'member_levels',
  'xp_cooldowns',
  'level_role_rewards',
  'level_import_runs',
  // Community scorecard (TOG-9074).
  'community_facts',
  'community_stream_heartbeats',
  'community_scorecard_runs',
  'community_scorecard_alerts',
  // Guild settings and its append-only audit trail (TOG-9074).
  'guild_settings',
  'guild_settings_audit',
  // RSVP, LFG and feed relays (TOG-1649, TOG-9074).
  'event_rsvps',
  'lfg_posts',
  'lfg_roles',
  'lfg_signups',
  'feed_relays',
  'feed_deliveries',
  // Temporary voice (TOG-9074).
  'temp_voice_channels',
  'temp_voice_creates',
  'temp_voice_audit',
  // Announcements audit, invite campaigns, audit kill switch (TOG-9074).
  'announcements_audit_log',
  'invite_campaigns',
  'audit_kill_switch',
  // Internal-actions API state (TOG-9074): in-flight claims and nonces are
  // short-lived, but a backup that silently drops them is a backup that lies
  // about what it holds. Restoring a stale in-flight claim is safe - the
  // claim-staleness check treats a corpse holder as releasable.
  'internal_action_log',
  'internal_discord_events',
  'internal_idempotency',
  'internal_nonces',
] as const;
export type DumpTable = (typeof DUMP_TABLES)[number];

/**
 * The tables whose `id` is a BIGSERIAL sequence that a restore must put back.
 *
 * `events` was the only one until TOG-9074; every added BIGSERIAL table needs
 * the same setval treatment or the first write after a restore collides with
 * a restored row. `audit_kill_switch.id` is deliberately absent: it is an
 * app-assigned INTEGER (always 1), not a sequence.
 */
export const SERIAL_TABLES = [
  'events',
  'xp_awards',
  'level_import_runs',
  'community_facts',
  'community_scorecard_runs',
  'guild_settings_audit',
] as const satisfies readonly DumpTable[];

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

export const DUMP_VERSION = 4;

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
  /**
   * High-water mark per BIGSERIAL table, so a restore can put each id
   * sequence back where it belongs. `eventsSequence` is the v3-era field,
   * carried forward so v4 manifests stay structurally comparable; there is
   * no v3 read path (`inspect()` refuses any version != 4, pinned in
   * test/unit.dumpread.test.ts), and v4 restores use `sequences`.
   */
  eventsSequence: number;
  sequences: Partial<Record<DumpTable, number>>;
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
  if (table === 'operational_audit_log') return 'entry_id';
  if (table === 'moderation_warnings') return 'created_at, id';
  if (table === 'moderation_scheduled_unbans') return 'execute_at, request_id';
  if (table === 'moderation_audit') return 'created_at, request_id';
  if (table === 'moderation_lockdowns') return 'guild_id, channel_id';
  if (table === 'moderation_idempotency') return 'guild_id, idempotency_key';
  if (table === 'containment_events') return 'occurred_at, audit_entry_id';
  if (table === 'containment_incidents') return 'started_at, id';
  if (table === 'join_risk_flags') return 'joined_at, event_id';
  if (table === 'automation_commands') return 'guild_id, name';
  if (table === 'scheduled_messages') return 'guild_id, id';
  if (table === 'sticky_messages') return 'guild_id, channel_id';
  if (table === 'automation_audit_log') return 'created_at, id';
  if (table === 'tickets') return 'created_at, id';
  if (table === 'ticket_transcripts') return 'created_at, ticket_id';
  if (table === 'automod_violations') return 'guild_id, user_id';
  if (table === 'automod_processed_messages') return 'guild_id, message_id';
  if (table === 'self_role_audit') return 'created_at, event_id';
  if (table === 'self_role_panel_claims') return 'guild_id, member_id, panel_id';
  if (table === 'guild_counters') return 'guild_id';
  if (table === 'counter_snapshots') return 'guild_id';
  if (table === 'rank_ladder') return 'rank_order, rank_key';
  if (table === 'member_ranks') return 'guild_id, member_id';
  if (table === 'rank_snapshots') return 'guild_id, rank_key';
  if (table === 'scheduled_events') return 'guild_id, event_id';
  if (table === 'member_exclusions') return 'guild_id, member_id';
  if (table === 'presence_probe') return 'guild_id, observed_at';
  if (table === 'web_contract_meta') return 'singleton';
  if (table === 'xp_awards') return 'id';
  if (table === 'member_levels') return 'guild_id, member_id';
  if (table === 'xp_cooldowns') return 'guild_id, member_id, source';
  if (table === 'level_role_rewards') return 'guild_id, level';
  if (table === 'level_import_runs') return 'id';
  if (table === 'community_facts') return 'id';
  if (table === 'community_stream_heartbeats') return 'guild_id, stream';
  if (table === 'community_scorecard_runs') return 'id';
  if (table === 'community_scorecard_alerts') return 'guild_id, alert_key';
  if (table === 'guild_settings') return 'guild_id, key';
  if (table === 'guild_settings_audit') return 'id';
  if (table === 'event_rsvps') return 'guild_id, event_id, user_id';
  if (table === 'lfg_posts') return 'id';
  if (table === 'lfg_roles') return 'lfg_id, role_key';
  if (table === 'lfg_signups') return 'lfg_id, user_id';
  if (table === 'feed_relays') return 'id';
  if (table === 'feed_deliveries') return 'feed_id, item_key';
  if (table === 'temp_voice_channels') return 'id';
  if (table === 'temp_voice_creates') return 'guild_id, user_id';
  if (table === 'temp_voice_audit') return 'id';
  if (table === 'announcements_audit_log') return 'id';
  if (table === 'invite_campaigns') return 'slug';
  if (table === 'audit_kill_switch') return 'id';
  if (table === 'internal_action_log') return 'request_id';
  if (table === 'internal_discord_events') return 'guild_id, event_key';
  if (table === 'internal_idempotency') return 'key_id, idempotency_key';
  if (table === 'internal_nonces') return 'key_id, nonce';
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
  // Same directory makes publication an atomic rename. The trailing .tmp keeps
  // even an abandoned partial file out of restore-drill and retention selectors.
  const tempPath = `${outPath}.${randomUUID()}.tmp`;
  const gz = createGzip({ level: 9 });
  const written = pipeline(gz, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
  // The output can fail while a database read is pending. Observe it immediately;
  // awaiting the original promise below still propagates the stream failure.
  void written.catch(() => {});

  const write = async (obj: unknown): Promise<void> => {
    if (gz.destroyed) await written;
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

      // High-water mark per BIGSERIAL table, read in the same snapshot as
      // the rows. A table the source has not migrated to yet has no sequence
      // to read; it contributes nothing, and the restore creates nothing.
      const sequences: Partial<Record<DumpTable, number>> = {};
      for (const name of SERIAL_TABLES) {
        const cols = tables.find((t) => t.name === name)?.columns ?? [];
        if (!cols.includes('id')) continue;
        const seq = await tx
          .prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ${name}`)
          .get<{ n: number }>();
        sequences[name] = Number(seq?.n ?? 0);
      }
      const applied = await tx
        .prepare(`SELECT id FROM schema_migrations ORDER BY id`)
        .all<{ id: string }>();

      const m: DumpManifest = {
        kind: 'manifest',
        version: DUMP_VERSION,
        createdAt: new Date().toISOString(),
        tables,
        eventsSequence: sequences.events ?? 0,
        sequences,
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
    gz.end();
    await written;
    await rename(tempPath, outPath);
  } catch (error) {
    gz.destroy();
    // Wait for the output to close before removing it, including open failures.
    await written.catch(() => {});
    await rm(tempPath, { force: true });
    throw error;
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
    if (sawEnd) throw new Error('dump contains data after its end marker');
    if (obj.kind === 'manifest') {
      if (manifest) throw new Error('dump contains more than one manifest');
      if (obj.version !== DUMP_VERSION) {
        throw new Error(`dump version ${obj.version}, this build reads ${DUMP_VERSION}`);
      }
      manifest = validateManifest(obj);
    } else if (obj.kind === 'row') {
      if (!manifest) throw new Error('dump row appears before the manifest');
      assertDumpTable(obj.table, 'row');
      if (!manifest.tables.some((table) => table.name === obj.table)) {
        throw new Error(`row table ${obj.table} is not declared in the manifest`);
      }
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

  let readRows = 0;
  for (const table of manifest.tables) {
    const actual = buffers.get(table.name)?.length ?? 0;
    if (actual !== table.count) {
      throw new Error(`${table.name}: manifest declares ${table.count} rows, file contains ${actual}`);
    }
    readRows += actual;
  }
  if (readRows !== declaredRows) {
    throw new Error(`dump declares ${declaredRows} rows, file contains ${readRows}`);
  }

  return { manifest, buffers, rows: readRows };
}

function validateManifest(obj: Record<string, unknown>): DumpManifest {
  if (!Array.isArray(obj.tables)) throw new Error('manifest has no table list');
  const names = new Set<DumpTable>();
  for (const table of obj.tables) {
    if (!table || typeof table !== 'object') throw new Error('manifest table is not an object');
    const row = table as Record<string, unknown>;
    assertDumpTable(row.name, 'manifest table');
    if (names.has(row.name)) throw new Error(`manifest table ${row.name} is duplicated`);
    names.add(row.name);
    if (!Array.isArray(row.columns) || row.columns.some((column) => typeof column !== 'string')) {
      throw new Error(`manifest table ${row.name} has an invalid column list`);
    }
    if (new Set(row.columns).size !== row.columns.length) {
      throw new Error(`manifest table ${row.name} has duplicate columns`);
    }
    if (!Number.isSafeInteger(row.count) || Number(row.count) < 0) {
      throw new Error(`manifest table ${row.name} has an invalid row count`);
    }
  }
  const missing = DUMP_TABLES.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`manifest is missing tables: ${missing.join(', ')}`);
  return obj as unknown as DumpManifest;
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

    // Put every id sequence back past the restored high-water mark, or the
    // first write after the restore collides with a row we just put back.
    // The value is GREATEST(manifest mark, actual restored max): a manifest
    // that understates the rows must not wedge the sequence below them.
    const seqMarks =
      (manifest.sequences as Partial<Record<string, number>> | undefined) ?? {};
    for (const name of SERIAL_TABLES) {
      assertDumpTable(name, 'sequence table');
      const target = await columnsOf(tx, name);
      if (!target.includes('id')) continue;
      const mark = Number(seqMarks[name] ?? (name === 'events' ? manifest.eventsSequence : 0) ?? 0);
      await tx.exec(
        `SELECT setval(pg_get_serial_sequence('${name}', 'id'),
                       GREATEST(${Number.isSafeInteger(mark) && mark >= 0 ? mark : 0},
                                (SELECT COALESCE(MAX(id), 0) FROM ${name}), 1),
                       (SELECT COUNT(*) FROM ${name}) > 0)`,
      );
    }
  });

  const restored: Record<string, number> = {};
  let ok = true;
  for (const t of manifest.tables) {
    restored[t.name] = await countOf(db, t.name);
    if (restored[t.name] !== t.count) ok = false;
  }

  return { manifest, restored, droppedColumns, ok };
}
