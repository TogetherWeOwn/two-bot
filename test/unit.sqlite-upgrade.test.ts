import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite } from '../src/store/sqliteDriver.ts';

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
