import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/store/sqliteDriver.ts';
import { ModerationStore } from '../src/moderation/store.ts';

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
