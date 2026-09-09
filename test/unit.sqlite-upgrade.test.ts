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


test('opening a pre-delivery SQLite audit database adds columns before the delivery index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'two-bot-audit-upgrade-'));
  const path = join(dir, 'two.db');
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE operational_audit_log (
      entry_id TEXT PRIMARY KEY, event_kind TEXT NOT NULL, guild_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL, actor_id TEXT, target_id TEXT, source_channel_id TEXT,
      destination_channel_id TEXT, message_id TEXT, action TEXT, metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  raw.close();

  const db = await openSqlite(path);
  const columns = await db.prepare(`PRAGMA table_info(operational_audit_log)`).all<{ name: string }>();
  assert.ok(columns.some((column) => column.name === 'delivery_state'));
  assert.ok(columns.some((column) => column.name === 'delivery_claim_token'));
  const indexes = await db.prepare(`PRAGMA index_list(operational_audit_log)`).all<{ name: string }>();
  assert.ok(indexes.some((index) => index.name === 'idx_operational_audit_delivery'));
  await db.close();
  await rm(dir, { recursive: true, force: true });
});
