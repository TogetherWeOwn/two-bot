import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/store/sqliteDriver.ts';
import { ModerationStore } from '../src/moderation/store.ts';

test('opening a pre-durability SQLite database adds scheduled-unban claim columns', async () => {
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
  raw.close();

  const db = await openSqlite(path);
  const columns = await db.prepare(`PRAGMA table_info(moderation_scheduled_unbans)`).all<{ name: string }>();
  assert.ok(columns.some((column) => column.name === 'claimed_at'));
  assert.ok(columns.some((column) => column.name === 'claim_token'));
  const store = new ModerationStore(db, () => Date.parse('2026-09-09T00:00:00.000Z'));
  assert.deepEqual(await store.claimDueUnbans(), []);
  await db.close();
  await rm(dir, { recursive: true, force: true });
});
