import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomodStore } from '../src/automod/store.ts';
import { openDb } from '../src/store/db.ts';
import { openTestDb, TEST_PG_URL, usingPostgres } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('SQLite migration preserves automod replay history', { skip: !usingPostgres && 'needs TWO_TEST_DATABASE_URL' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'two-migrate-data-'));
  const sqlitePath = join(dir, 'two.db');
  const source = await openDb(sqlitePath);
  const target = await openTestDb(import.meta.filename);

  try {
    await source
      .prepare(
        `INSERT INTO automod_violations
           (guild_id, user_id, violation_count, last_filter, last_message_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('guild', 'user', 3, 'bad_words', 'message-3', '2026-09-09T10:03:00.000Z');
    for (let i = 1; i <= 3; i++) {
      await source
        .prepare(
          `INSERT INTO automod_processed_messages (guild_id, message_id, user_id, processed_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('guild', `message-${i}`, 'user', `2026-09-09T10:0${i}:00.000Z`);
    }
    for (const row of [
      { memberId: 'selected', eventId: 'selected-red', optionKey: 'red', desired: '["role-red"]', outcome: 'assigned' },
      { memberId: 'empty', eventId: 'accepted-clear', optionKey: null, desired: '[]', outcome: 'removed' },
      { memberId: 'rejected', eventId: 'rejected-blue', optionKey: 'blue', desired: '["role-blue"]', outcome: 'rejected' },
    ]) {
      await source.prepare(
        `INSERT INTO self_role_audit
           (event_id, event_order, guild_id, panel_id, member_id, source_id, option_key,
            role_id, source, operation, outcome, added_role_ids, removed_role_ids,
            desired_role_ids, created_at)
         VALUES (?, '1', 'guild', 'colors', ?, 'panel-message', ?, NULL, 'button',
                 'replace', ?, '[]', '[]', ?, '2026-09-09T10:00:00.000Z')`,
      ).run(row.eventId, row.memberId, row.optionKey, row.outcome, row.desired);
      await source.prepare(
        `INSERT INTO self_role_panel_claims
           (guild_id, member_id, panel_id, claim_token, claim_generation,
            processing_expires_at, latest_event_id, latest_option_key, latest_event_order,
            target_committed)
         VALUES ('guild', ?, 'colors', 'released', 1, '2026-09-09T10:00:00.000Z', ?, ?, '1', 1)`,
      ).run(row.memberId, row.eventId, row.optionKey);
    }
    await source.close();

    const targetUrl = new URL(TEST_PG_URL);
    targetUrl.searchParams.set('options', `-csearch_path=${target.schema}`);
    const result = await run(process.execPath, ['scripts/migrate-sqlite-to-postgres.ts'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TWO_SQLITE_PATH: sqlitePath,
        TWO_DATABASE_URL: targetUrl.toString(),
      },
    });
    assert.match(result.stdout, /automod_processed_messages\s+source 3\s+target 3\s+ok/u);
    assert.match(result.stdout, /MIGRATION VERIFIED/u);

    const processed = await target.db
      .prepare(`SELECT message_id FROM automod_processed_messages ORDER BY message_id`)
      .all<{ message_id: string }>();
    assert.deepEqual(processed.map((row) => row.message_id), ['message-1', 'message-2', 'message-3']);

    const claims = await target.db.prepare(
      `SELECT member_id, latest_option_key, target_committed
         FROM self_role_panel_claims ORDER BY member_id`,
    ).all<{ member_id: string; latest_option_key: string | null; target_committed: boolean }>();
    assert.deepEqual(claims, [
      { member_id: 'empty', latest_option_key: null, target_committed: true },
      { member_id: 'rejected', latest_option_key: 'blue', target_committed: false },
      { member_id: 'selected', latest_option_key: 'red', target_committed: true },
    ]);

    const store = new AutomodStore(target.db);
    assert.equal(
      await store.recordViolation('guild', 'user', 'bad_words', 'message-1'),
      3,
      'a delayed replay of a migrated message advanced the sanction ladder',
    );
  } finally {
    await source.close().catch(() => undefined);
    await target.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
