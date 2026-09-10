import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { openSqlite } from '../src/store/sqliteDriver.ts';
import { ModerationStore } from '../src/moderation/store.ts';

const run = promisify(execFile);
const OPEN_HELPER = new URL('./helpers/open-sqlite.ts', import.meta.url).pathname;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function legacyLevelingDb(): { path: string; raw: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), 'two-bot-leveling-upgrade-'));
  dirs.push(dir);
  const path = join(dir, 'two.db');
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE member_levels (
      guild_id    TEXT    NOT NULL,
      member_id   TEXT    NOT NULL,
      xp          INTEGER NOT NULL CHECK (xp >= 0),
      message_xp  INTEGER NOT NULL DEFAULT 0 CHECK (message_xp >= 0),
      voice_xp    INTEGER NOT NULL DEFAULT 0 CHECK (voice_xp >= 0),
      imported_xp INTEGER NOT NULL DEFAULT 0 CHECK (imported_xp >= 0),
      updated_at  TEXT    NOT NULL,
      PRIMARY KEY (guild_id, member_id),
      CHECK (xp = message_xp + voice_xp + imported_xp)
    );
    CREATE INDEX idx_member_levels_rank
      ON member_levels (guild_id, xp DESC, member_id ASC);
    CREATE TABLE level_import_runs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id          TEXT    NOT NULL,
      source            TEXT    NOT NULL CHECK (source = 'mee6'),
      source_rows       INTEGER NOT NULL,
      unique_members    INTEGER NOT NULL,
      inserted          INTEGER NOT NULL,
      updated           INTEGER NOT NULL,
      unchanged         INTEGER NOT NULL,
      duplicate_rows    INTEGER NOT NULL,
      total_imported_xp INTEGER NOT NULL,
      imported_at       TEXT    NOT NULL
    );
  `);
  return { path, raw };
}

test('existing SQLite leveling tables gain the XP ceiling without losing data', async () => {
  const { path, raw } = legacyLevelingDb();
  raw.prepare(`INSERT INTO member_levels VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    '1545644954272137297',
    '100000000000000001',
    60,
    15,
    5,
    40,
    '2026-09-09T00:00:00.000Z',
  );
  raw.prepare(`
    INSERT INTO level_import_runs
      (id, guild_id, source, source_rows, unique_members, inserted, updated,
       unchanged, duplicate_rows, total_imported_xp, imported_at)
    VALUES (?, ?, 'mee6', 1, 1, 1, 0, 0, 0, 40, ?)
  `).run(7, '1545644954272137297', '2026-09-09T00:00:00.000Z');
  raw.prepare(`
    INSERT INTO level_import_runs
      (id, guild_id, source, source_rows, unique_members, inserted, updated,
       unchanged, duplicate_rows, total_imported_xp, imported_at)
    VALUES (?, ?, 'mee6', 1, 1, 1, 0, 0, 0, 1, ?)
  `).run(100, '1545644954272137297', '2026-09-09T00:00:00.000Z');
  raw.prepare(`DELETE FROM level_import_runs WHERE id = 100`).run();
  raw.close();

  const db = await openSqlite(path);
  assert.deepEqual(
    {
      ...(await db.prepare(`SELECT xp, message_xp, voice_xp, imported_xp FROM member_levels`).get()),
    },
    { xp: 60, message_xp: 15, voice_xp: 5, imported_xp: 40 },
  );
  assert.equal(
    Number((await db.prepare(`SELECT COUNT(*) AS count FROM level_import_runs WHERE id = 7`).get<{ count: number }>())?.count),
    1,
  );
  assert.equal(
    Number((await db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '0011_leveling_xp_ceiling'`).get<{ count: number }>())?.count),
    1,
  );
  assert.equal(
    Number((await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_member_levels_rank'`).get<{ count: number }>())?.count),
    1,
  );

  for (const column of ['xp', 'message_xp', 'voice_xp', 'imported_xp']) {
    const values = { xp: 0, message_xp: 0, voice_xp: 0, imported_xp: 0, [column]: 9007199254740992 };
    await assert.rejects(
      db.prepare(`
        INSERT INTO member_levels
          (guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at)
        VALUES ('1545644954272137297', '100000000000000002',
          ${values.xp}, ${values.message_xp}, ${values.voice_xp}, ${values.imported_xp},
          '2026-09-09T00:00:00.000Z')
      `).run(),
      /CHECK constraint failed/,
      column,
    );
  }
  await assert.rejects(
    db.prepare(`
      INSERT INTO level_import_runs
        (guild_id, source, source_rows, unique_members, inserted, updated,
         unchanged, duplicate_rows, total_imported_xp, imported_at)
      VALUES ('1545644954272137297', 'mee6', 1, 1, 1, 0, 0, 0,
        9007199254740992, '2026-09-09T00:00:00.000Z')
    `).run(),
    /CHECK constraint failed/,
  );
  await db.prepare(`
    INSERT INTO level_import_runs
      (guild_id, source, source_rows, unique_members, inserted, updated,
       unchanged, duplicate_rows, total_imported_xp, imported_at)
    VALUES ('1545644954272137297', 'mee6', 1, 1, 1, 0, 0, 0, 1,
      '2026-09-09T00:00:00.000Z')
  `).run();
  assert.equal(
    Number((await db.prepare(`SELECT MAX(id) AS id FROM level_import_runs`).get<{ id: number }>())?.id),
    101,
  );
  await db.close();

  const reopened = await openSqlite(path);
  assert.equal(
    Number((await reopened.prepare(`SELECT COUNT(*) AS count FROM member_levels`).get<{ count: number }>())?.count),
    1,
  );
  await reopened.close();
});

test('SQLite schema metadata records the self-role audit migration at its unique id', async () => {
  const db = await openSqlite(':memory:');
  assert.equal(
    Number((await db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '0018_self_role_audit'`).get<{ count: number }>())?.count),
    1,
  );
  assert.equal(
    Number((await db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '0019_self_role_recovery'`).get<{ count: number }>())?.count),
    1,
  );
  assert.equal(
    Number((await db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '0013_self_role_audit'`).get<{ count: number }>())?.count),
    0,
  );
  assert.equal(
    Number((await db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '0010_self_role_audit'`).get<{ count: number }>())?.count),
    0,
  );
  await db.close();
});

test('opening a baseline self-role SQLite database adds recovery columns and claims idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'two-bot-self-role-upgrade-'));
  const path = join(dir, 'two.db');
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE self_role_audit (
      event_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      option_key TEXT,
      role_id TEXT,
      source TEXT NOT NULL,
      operation TEXT NOT NULL,
      outcome TEXT NOT NULL,
      code TEXT,
      reason TEXT,
      added_role_ids TEXT NOT NULL,
      removed_role_ids TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO self_role_audit VALUES
      ('old-event', 'g', 'p', 'm', 's', 'red', 'r', 'button', 'add',
       'assigned', NULL, NULL, '["r"]', '[]', '2026-09-09T00:00:00.000Z');
    INSERT INTO self_role_audit VALUES
      ('interrupted-event', 'g', 'p', 'm', 's', 'blue', 'b', 'button', 'add',
       'processing', NULL, NULL, '[]', '[]', '2026-09-09T00:01:00.000Z');
  `);
  raw.close();

  const db = await openSqlite(path);
  const columns = await db.prepare(`PRAGMA table_info(self_role_audit)`).all<{ name: string }>();
  for (const name of [
    'attempted_added_role_ids', 'compensated_added_role_ids', 'desired_role_ids',
    'pre_mutation_role_ids', 'claim_token', 'claim_generation', 'processing_expires_at',
  ]) assert.ok(columns.some((column) => column.name === name), name);
  assert.equal(
    Number((await db.prepare(`SELECT COUNT(*) AS count FROM self_role_panel_claims`).get<{ count: number }>())?.count),
    0,
  );
  const preserved = await db.prepare(`SELECT outcome, added_role_ids FROM self_role_audit WHERE event_id = 'old-event'`).get();
  assert.deepEqual({ ...preserved }, { outcome: 'assigned', added_role_ids: '["r"]' });
  const interrupted = await db.prepare(
    `SELECT outcome, code FROM self_role_audit WHERE event_id = 'interrupted-event'`,
  ).get();
  assert.deepEqual({ ...interrupted }, {
    outcome: 'rejected',
    code: 'interrupted_before_recovery',
  });
  await db.close();

  const reopened = await openSqlite(path);
  assert.equal(
    Number((await reopened.prepare(`SELECT COUNT(*) AS count FROM self_role_audit`).get<{ count: number }>())?.count),
    2,
  );
  await reopened.close();
  await rm(dir, { recursive: true, force: true });
});

test('SQLite committed-target backfill requires the exact successful latest event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'two-bot-self-role-target-upgrade-'));
  const path = join(dir, 'two.db');
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT
    );
    CREATE TABLE self_role_audit (
      event_id TEXT PRIMARY KEY,
      event_order TEXT,
      guild_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      option_key TEXT,
      role_id TEXT,
      source TEXT NOT NULL,
      operation TEXT NOT NULL,
      outcome TEXT NOT NULL,
      code TEXT,
      reason TEXT,
      added_role_ids TEXT NOT NULL,
      removed_role_ids TEXT NOT NULL,
      attempted_added_role_ids TEXT NOT NULL DEFAULT '[]',
      attempted_removed_role_ids TEXT NOT NULL DEFAULT '[]',
      compensated_added_role_ids TEXT NOT NULL DEFAULT '[]',
      compensated_removed_role_ids TEXT NOT NULL DEFAULT '[]',
      unresolved_added_role_ids TEXT NOT NULL DEFAULT '[]',
      unresolved_removed_role_ids TEXT NOT NULL DEFAULT '[]',
      desired_role_ids TEXT NOT NULL DEFAULT '[]',
      pre_mutation_role_ids TEXT NOT NULL DEFAULT '[]',
      claim_token TEXT,
      claim_generation INTEGER NOT NULL DEFAULT 0,
      processing_expires_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE self_role_panel_claims (
      guild_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      claim_token TEXT NOT NULL,
      claim_generation INTEGER NOT NULL,
      processing_expires_at TEXT NOT NULL,
      latest_event_id TEXT,
      latest_option_key TEXT,
      latest_event_order TEXT,
      PRIMARY KEY (guild_id, member_id, panel_id)
    );
    INSERT INTO self_role_audit
      (event_id, event_order, guild_id, panel_id, member_id, source_id, option_key,
       role_id, source, operation, outcome, added_role_ids, removed_role_ids, created_at)
    VALUES
      ('accepted-red', '1', 'g', 'colors', 'safe', 's', 'red', 'r', 'button', 'add',
       'assigned', '["r"]', '[]', '2026-09-09T00:00:00.000Z'),
      ('accepted-red-old', '1', 'g', 'colors', 'ambiguous', 's', 'red', 'r', 'button', 'add',
       'assigned', '["r"]', '[]', '2026-09-09T00:00:00.000Z'),
      ('rejected-blue', '2', 'g', 'colors', 'ambiguous', 's', 'blue', 'b', 'button', 'add',
       'rejected', '[]', '[]', '2026-09-09T00:01:00.000Z');
    INSERT INTO self_role_panel_claims
      (guild_id, member_id, panel_id, claim_token, claim_generation, processing_expires_at,
       latest_event_id, latest_option_key, latest_event_order)
    VALUES
      ('g', 'safe', 'colors', 'released', 1, '2026-09-09T00:00:00.000Z',
       'accepted-red', 'red', '1'),
      ('g', 'ambiguous', 'colors', 'released', 2, '2026-09-09T00:01:00.000Z',
       'rejected-blue', 'blue', '2');
  `);
  raw.close();

  const db = await openSqlite(path);
  const rows = await db.prepare(
    `SELECT member_id, latest_option_key, target_committed
       FROM self_role_panel_claims ORDER BY member_id`,
  ).all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { member_id: 'ambiguous', latest_option_key: 'blue', target_committed: 0 },
    { member_id: 'safe', latest_option_key: 'red', target_committed: 1 },
  ]);
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

test('concurrent SQLite opens perform the leveling rebuild once', async () => {
  const { path, raw } = legacyLevelingDb();
  raw.exec('PRAGMA journal_mode = WAL');
  raw.close();

  await Promise.all([
    run('node', [OPEN_HELPER, path]),
    run('node', [OPEN_HELPER, path]),
  ]);

  const checked = await openSqlite(path);
  assert.equal(
    Number((await checked.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '0011_leveling_xp_ceiling'`).get<{ count: number }>())?.count),
    1,
  );
  await checked.close();
});

test('unsafe legacy SQLite XP aborts the rebuild and leaves the old tables intact', async () => {
  const { path, raw } = legacyLevelingDb();
  raw.exec(`
    INSERT INTO member_levels
      (guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at)
    VALUES ('1545644954272137297', '100000000000000001',
      9007199254740992, 0, 0, 9007199254740992, '2026-09-09T00:00:00.000Z');
  `);
  raw.close();

  await assert.rejects(openSqlite(path), /CHECK constraint failed/);

  const unchanged = new DatabaseSync(path);
  assert.equal(
    Number(
      (unchanged.prepare(`SELECT COUNT(*) AS count FROM member_levels`).get() as
        | { count: number }
        | undefined)?.count,
    ),
    1,
  );
  assert.equal(
    Number(
      (unchanged.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '0011_leveling_xp_ceiling'`).get() as
        | { count: number }
        | undefined)?.count,
    ),
    0,
  );
  unchanged.close();
});

test('opening a pre-durability SQLite database adds claim columns and reconciles duplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'two-bot-sqlite-upgrade-'));
  const path = join(dir, 'two.db');
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE moderation_scheduled_unbans (
      request_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      execute_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  raw.prepare(`INSERT INTO moderation_scheduled_unbans VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'old', 'g', 'u', '2026-09-09T01:00:00.000Z', 'old', 'pending', '2026-09-09T00:00:00.000Z', null,
  );
  raw.prepare(`INSERT INTO moderation_scheduled_unbans VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'new', 'g', 'u', '2026-09-09T02:00:00.000Z', 'new', 'pending', '2026-09-09T00:30:00.000Z', null,
  );
  raw.close();

  const db = await openSqlite(path);
  const columns = await db.prepare(`PRAGMA table_info(moderation_scheduled_unbans)`).all<{ name: string }>();
  assert.ok(columns.some((column) => column.name === 'claimed_at'));
  assert.ok(columns.some((column) => column.name === 'claim_token'));
  const jobs = await db.prepare(`SELECT request_id, state FROM moderation_scheduled_unbans ORDER BY request_id`).all();
  assert.deepEqual(jobs.map((row) => ({ ...row })), [
    { request_id: 'new', state: 'pending' },
    { request_id: 'old', state: 'superseded' },
  ]);
  const store = new ModerationStore(db, () => Date.parse('2026-09-09T00:00:00.000Z'));
  assert.deepEqual(await store.claimDueUnbans(), []);
  await db.close();
  await rm(dir, { recursive: true, force: true });
});
