/**
 * SQLite driver. TEMPORARY - this file is deleted once the Postgres path has
 * run in staging for a week (TWO-18). It exists only so we can roll back
 * without a deploy.
 *
 * It is synchronous underneath; the async wrapper is there purely to satisfy
 * the shared Db interface.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, RunResult, Statement } from './driver.ts';

const here = dirname(fileURLToPath(import.meta.url));

class SqliteDb implements Db {
  readonly kind = 'sqlite' as const;
  private raw: DatabaseSync;
  /** Nested transaction() calls must not emit a second BEGIN. */
  private depth: number;

  constructor(raw: DatabaseSync, depth = 0) {
    this.raw = raw;
    this.depth = depth;
  }

  prepare(sql: string): Statement {
    const raw = this.raw;
    return {
      async get<T>(...params: unknown[]): Promise<T | undefined> {
        return raw.prepare(sql).get(...(params as never[])) as T | undefined;
      },
      async all<T>(...params: unknown[]): Promise<T[]> {
        return raw.prepare(sql).all(...(params as never[])) as T[];
      },
      async run(...params: unknown[]): Promise<RunResult> {
        const info = raw.prepare(sql).run(...(params as never[]));
        return { changes: Number(info.changes) };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(this);
    const inner = new SqliteDb(this.raw, 1);
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = await fn(inner);
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* already unwound */
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}

/**
 * Add a nullable column to an existing database if it is not already there.
 *
 * `schema.sql` is all CREATE TABLE IF NOT EXISTS, which is a no-op against a
 * database that already has the table - so a column added to that file reaches
 * new databases and silently misses every existing one, including the live
 * `data/two.db`. Postgres has real migrations for this; the SQLite path
 * deliberately does not (migrations/README.md: not worth a second dialect for a
 * driver being deleted in TWO-70). This is the minimum that keeps the two
 * dialects agreeing until then.
 *
 * Additive and nullable only. Anything needing a default, a backfill or a
 * rewrite is a real migration and does not belong here.
 */
function ensureColumn(raw: DatabaseSync, table: string, column: string, type: string): void {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Mirrors migrations/0011_leveling_xp_ceiling.sql for existing SQLite files. */
function ensureLevelingXpCeiling(raw: DatabaseSync): void {
  const id = '0011_leveling_xp_ceiling';
  const applied = raw.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(id);
  if (applied) return;

  raw.exec('BEGIN IMMEDIATE');
  try {
    // Another opener may have completed the rebuild while this connection
    // waited for the write lock. Recheck inside the transaction.
    if (raw.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(id)) {
      raw.exec('COMMIT');
      return;
    }
    const importRunSequence = Number(
      (raw.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'level_import_runs'`).get() as
        | { seq: number }
        | undefined)?.seq ?? 0,
    );
    raw.exec(`
      CREATE TABLE member_levels_with_xp_ceiling (
        guild_id    TEXT    NOT NULL,
        member_id   TEXT    NOT NULL,
        xp          INTEGER NOT NULL CHECK (xp BETWEEN 0 AND 9007199254740991),
        message_xp  INTEGER NOT NULL DEFAULT 0 CHECK (message_xp BETWEEN 0 AND 9007199254740991),
        voice_xp    INTEGER NOT NULL DEFAULT 0 CHECK (voice_xp BETWEEN 0 AND 9007199254740991),
        imported_xp INTEGER NOT NULL DEFAULT 0 CHECK (imported_xp BETWEEN 0 AND 9007199254740991),
        updated_at  TEXT    NOT NULL,
        PRIMARY KEY (guild_id, member_id),
        CHECK (xp = message_xp + voice_xp + imported_xp)
      );
      INSERT INTO member_levels_with_xp_ceiling
        (guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at)
      SELECT guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at
        FROM member_levels;
      DROP TABLE member_levels;
      ALTER TABLE member_levels_with_xp_ceiling RENAME TO member_levels;
      CREATE INDEX idx_member_levels_rank
        ON member_levels (guild_id, xp DESC, member_id ASC);

      CREATE TABLE level_import_runs_with_xp_ceiling (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT    NOT NULL,
        source            TEXT    NOT NULL CHECK (source = 'mee6'),
        source_rows       INTEGER NOT NULL,
        unique_members    INTEGER NOT NULL,
        inserted          INTEGER NOT NULL,
        updated           INTEGER NOT NULL,
        unchanged         INTEGER NOT NULL,
        duplicate_rows    INTEGER NOT NULL,
        total_imported_xp INTEGER NOT NULL CHECK (total_imported_xp BETWEEN 0 AND 9007199254740991),
        imported_at       TEXT    NOT NULL
      );
      INSERT INTO level_import_runs_with_xp_ceiling
        (id, guild_id, source, source_rows, unique_members, inserted, updated,
         unchanged, duplicate_rows, total_imported_xp, imported_at)
      SELECT id, guild_id, source, source_rows, unique_members, inserted, updated,
             unchanged, duplicate_rows, total_imported_xp, imported_at
        FROM level_import_runs;
      DROP TABLE level_import_runs;
      ALTER TABLE level_import_runs_with_xp_ceiling RENAME TO level_import_runs;
    `);
    if (importRunSequence > 0) {
      raw.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'level_import_runs'`).run(
        importRunSequence,
      );
    }
    raw.prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`).run(
      id,
      new Date().toISOString(),
    );
    raw.exec('COMMIT');
  } catch (err) {
    try {
      raw.exec('ROLLBACK');
    } catch {
      /* already unwound */
    }
    throw err;
  }
}

/** Apply every additive self-role SQLite upgrade under one write lock. */
function ensureSelfRoleRecovery(raw: DatabaseSync): void {
  const id = '0022_self_role_committed_target';
  if (raw.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(id)) return;
  raw.exec('BEGIN IMMEDIATE');
  try {
    if (raw.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(id)) {
      raw.exec('COMMIT');
      return;
    }
    ensureColumn(raw, 'self_role_audit', 'attempted_added_role_ids', `TEXT NOT NULL DEFAULT '[]'`);
    ensureColumn(raw, 'self_role_audit', 'attempted_removed_role_ids', `TEXT NOT NULL DEFAULT '[]'`);
    ensureColumn(raw, 'self_role_audit', 'compensated_added_role_ids', `TEXT NOT NULL DEFAULT '[]'`);
    ensureColumn(raw, 'self_role_audit', 'compensated_removed_role_ids', `TEXT NOT NULL DEFAULT '[]'`);
    ensureColumn(raw, 'self_role_audit', 'unresolved_added_role_ids', `TEXT NOT NULL DEFAULT '[]'`);
    ensureColumn(raw, 'self_role_audit', 'unresolved_removed_role_ids', `TEXT NOT NULL DEFAULT '[]'`);
    ensureColumn(raw, 'self_role_audit', 'desired_role_ids', `TEXT NOT NULL DEFAULT '[]'`);
    ensureColumn(raw, 'self_role_audit', 'pre_mutation_role_ids', `TEXT NOT NULL DEFAULT '[]'`);
    ensureColumn(raw, 'self_role_audit', 'claim_token', 'TEXT');
    ensureColumn(raw, 'self_role_audit', 'claim_generation', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(raw, 'self_role_audit', 'processing_expires_at', 'TEXT');
    ensureColumn(raw, 'self_role_panel_claims', 'latest_event_id', 'TEXT');
    ensureColumn(raw, 'self_role_panel_claims', 'latest_option_key', 'TEXT');
    ensureColumn(raw, 'self_role_panel_claims', 'latest_event_order', 'TEXT');
    ensureColumn(raw, 'self_role_panel_claims', 'target_committed', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(raw, 'self_role_audit', 'event_order', 'TEXT');
    // Old builds could publish latest_option_key before the matching audit
    // committed. Tie the backfill to the exact successful latest event and its
    // persisted desired state. A successful empty desired set commits NULL;
    // an ambiguous lane stays uncommitted and is reseeded from Discord instead.
    raw.prepare(`UPDATE self_role_panel_claims AS claims
      SET target_committed = 1
      WHERE target_committed = 0
        AND latest_event_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM self_role_audit AS audit
           WHERE audit.event_id = claims.latest_event_id
             AND audit.guild_id = claims.guild_id
             AND audit.member_id = claims.member_id
             AND audit.panel_id = claims.panel_id
             AND CASE
               WHEN json_array_length(audit.desired_role_ids) = 0 THEN NULL
               WHEN json_array_length(audit.desired_role_ids) = 1 THEN audit.option_key
               ELSE '__invalid_multi_target__'
             END IS claims.latest_option_key
             AND audit.outcome IN ('assigned', 'removed', 'switched', 'already_held', 'already_absent')
        )`).run();
    raw.prepare(`UPDATE self_role_audit
      SET outcome = 'rejected', code = 'interrupted_before_recovery',
          reason = 'processing row predates persisted self-role intent'
      WHERE outcome = 'processing' AND processing_expires_at IS NULL`).run();
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_self_role_audit_processing_lease
      ON self_role_audit (outcome, processing_expires_at)`);
    raw.prepare(`INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`).run(
      id,
      new Date().toISOString(),
    );
    raw.exec('COMMIT');
  } catch (err) {
    try {
      raw.exec('ROLLBACK');
    } catch {
      /* already unwound */
    }
    throw err;
  }
}

/** Open a SQLite database. `:memory:` gives an ephemeral one. */
function reconcilePendingUnbans(raw: DatabaseSync): void {
  const duplicates = raw.prepare(
    `SELECT guild_id, user_id
       FROM moderation_scheduled_unbans
      WHERE state = 'pending'
      GROUP BY guild_id, user_id
     HAVING COUNT(*) > 1`,
  ).all() as Array<{ guild_id: string; user_id: string }>;
  const pending = raw.prepare(
    `SELECT request_id FROM moderation_scheduled_unbans
      WHERE guild_id = ? AND user_id = ? AND state = 'pending'
      ORDER BY execute_at DESC, created_at DESC, request_id DESC`,
  );
  const supersede = raw.prepare(
    `UPDATE moderation_scheduled_unbans
        SET state = 'superseded', completed_at = COALESCE(completed_at, ?)
      WHERE request_id = ?`,
  );
  const now = new Date().toISOString();
  for (const pair of duplicates) {
    const rows = pending.all(pair.guild_id, pair.user_id) as Array<{ request_id: string }>;
    for (const row of rows.slice(1)) supersede.run(now, row.request_id);
  }
}

/** Open a SQLite database. `:memory:` gives an ephemeral one. */

export async function openSqlite(path: string): Promise<Db> {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  // WAL lets a reader and a writer coexist, but two writers still collide, and
  // the default behaviour is to fail the statement instantly with
  // SQLITE_BUSY. That is how a backfill run dies half way through when the bot
  // happens to write a join at the same moment. Wait instead: these are short
  // transactions, so waiting costs milliseconds and losing the run costs
  // several minutes of re-scanning Discord.
  raw.exec('PRAGMA busy_timeout = 15000;');
  let schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  const pendingIndex = `CREATE UNIQUE INDEX IF NOT EXISTS uq_moderation_pending_unban
  ON moderation_scheduled_unbans (guild_id, user_id) WHERE state = 'pending';`;
  const selfRoleLeaseIndex = `CREATE INDEX IF NOT EXISTS idx_self_role_audit_processing_lease
  ON self_role_audit (outcome, processing_expires_at);`;
  // Old databases may contain duplicates that were legal before 0011, and the
  // self-role lease column may not exist yet. Defer both indexes until their
  // prerequisite data/column upgrades finish below.
  schema = schema.replace(pendingIndex, '').replace(selfRoleLeaseIndex, '');
  raw.exec(schema);
  // Mirrors migrations/0008_members_third_message_at.sql (TWO-95).
  ensureColumn(raw, 'members', 'third_message_at', 'TEXT');
  ensureLevelingXpCeiling(raw);
  // Existing SQLite databases already have the 0010 table, so schema.sql's
  // CREATE TABLE IF NOT EXISTS cannot add the 0011/0012 claim columns.
  ensureColumn(raw, 'moderation_scheduled_unbans', 'claimed_at', 'TEXT');
  ensureColumn(raw, 'moderation_scheduled_unbans', 'claim_token', 'TEXT');
  ensureColumn(raw, 'moderation_lockdowns', 'prior_exists', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(raw, 'scheduled_messages', 'claim_token', 'TEXT');
  ensureColumn(raw, 'scheduled_messages', 'claimed_at', 'TEXT');
  ensureColumn(raw, 'scheduled_messages', 'occurrence_nonce', 'TEXT');
  ensureColumn(raw, 'sticky_messages', 'claim_token', 'TEXT');
  ensureColumn(raw, 'sticky_messages', 'claimed_at', 'TEXT');
  reconcilePendingUnbans(raw);
  raw.exec(pendingIndex);
  // Mirrors migrations/0014_ticket_safety.sql for rollback databases that
  // created their ticket tables before the close-transition timestamp existed.
  ensureColumn(raw, 'tickets', 'closing_started_at', 'TEXT');
  ensureSelfRoleRecovery(raw);
  // schema.sql is the whole schema, so every migration whose tables it already
  // contains is recorded as applied. Adding a migration means adding its
  // tables above and its id here, or a database that is later moved to
  // Postgres will try to apply it a second time.
  const stamp = raw.prepare(`INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`);
  for (const id of [
    '0001_initial',
    '0002_internal_actions',
    '0008_members_third_message_at',
    '0010_leveling',
    '0011_leveling_xp_ceiling',
    '0010_moderation',
    '0011_moderation_durability',
    '0012_moderation_recovery',
    '0015_anti_nuke_containment',
    '0013_tickets',
    '0014_ticket_safety',
    '0015_automations',
    '0016_automation_claims',
    '0017_scheduled_occurrence_nonce',
    '0018_self_role_audit',
    '0019_self_role_recovery',
    '0020_self_role_ordering',
    '0021_self_role_event_order',
    '0022_self_role_committed_target',
  ]) {
    stamp.run(id, new Date().toISOString());
  }
  return new SqliteDb(raw);
}
