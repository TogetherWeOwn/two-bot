/**
 * End-to-end: spawn the real bot process, let it connect to the mock gateway
 * over a socket, push real dispatch frames at it, and assert rows land in the
 * datastore.
 *
 * The bot under test is unmodified src/index.ts. The only things injected are
 * DISCORD_API_BASE, which points discord.js at the mock instead of discord.com,
 * and an isolated Postgres schema.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { startMockDiscord } from '../tools/mock-discord/server.ts';
import type { Db } from '../src/store/db.ts';
import { openTestDb, TEST_PG_URL } from './helpers/testDb.ts';

const ROOT = resolve(import.meta.dirname, '..');
const MEMBER_A = '900000000000001111';
const MEMBER_B = '900000000000002222';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll the datastore until `fn` returns truthy or we run out of patience. */
async function waitFor<T>(reader: Db, fn: (db: Db) => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn(reader);
      if (v) return v;
    } catch (err) {
      last = err; // tables not created yet
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for db condition; last error: ${String(last)}`);
}

test('bot records the full funnel end to end over a gateway socket', { timeout: 90_000 }, async (t) => {
  const mock = await startMockDiscord();
  const harness = await openTestDb(import.meta.filename);
  const schema = harness.schema;
  let bot: ChildProcess | null = null;
  const botLog: string[] = [];

  t.after(async () => {
    bot?.kill('SIGKILL');
    await mock.close();
    await harness.cleanup();
  });

  bot = spawn(process.execPath, ['src/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DISCORD_TOKEN: 'mock.token.value',
      DISCORD_API_BASE: mock.apiBase,
      DISCORD_GUILD_ID: mock.guildId,
      TWO_DATABASE_URL: TEST_PG_URL,
      // The bot process needs to land in the same schema as the reader.
      PGOPTIONS: `-c search_path=${schema}`,
      LOG_LEVEL: 'debug',
    },
  });
  bot.stdout?.on('data', (d) => botLog.push(String(d)));
  bot.stderr?.on('data', (d) => botLog.push(String(d)));
  bot.on('exit', (code) => botLog.push(`__bot exited with ${code}__`));

  try {
    await mock.waitForReady();
  } catch (err) {
    throw new Error(`${String(err)}\n--- bot output ---\n${botLog.join('')}`);
  }

  // Give the ready handler time to take its first invite snapshot (uses = 5).
  await sleep(1200);

  // A real join: the invite's use count goes up, then the member-add arrives.
  mock.invites[0].uses = 6;
  mock.memberJoin(MEMBER_A, 'newcomer');

  const joinEvent = await waitFor(harness.db, (db) =>
    db
      .prepare(`SELECT * FROM events WHERE event_type = 'member_join' AND member_id = ?`)
      .get(MEMBER_A),
  ).catch((e) => {
    throw new Error(`${String(e)}\n--- bot output ---\n${botLog.join('')}`);
  }) as Record<string, unknown>;

  assert.equal(joinEvent.event_type, 'member_join');
  assert.equal(joinEvent.guild_id, mock.guildId);
  assert.equal(joinEvent.source, 'invite:twodev01', 'join should be attributed to the invite that grew');
  assert.ok(
    typeof joinEvent.occurred_at === 'string' && joinEvent.occurred_at.endsWith('Z'),
    'occurred_at is ISO-8601 UTC',
  );

  // First message, then a second message that must NOT create a second milestone.
  mock.message(MEMBER_A);
  const firstMsg = (await waitFor(harness.db, (db) =>
    db.prepare(`SELECT * FROM events WHERE event_type='first_message' AND member_id=?`).get(MEMBER_A),
  )) as Record<string, unknown>;
  // occurred_at must be the real send time. discord.js decodes this from the
  // message snowflake, so a bad id silently dates events to 1970 and every
  // time-windowed funnel query quietly undercounts.
  const age = Date.now() - Date.parse(firstMsg.occurred_at as string);
  assert.ok(age >= 0 && age < 5 * 60_000, `first_message occurred_at should be recent, got ${firstMsg.occurred_at}`);
  mock.message(MEMBER_A);
  await sleep(600);
  const msgCount = await db_count(
    harness.db,
    `SELECT COUNT(*) AS n FROM events WHERE event_type='first_message' AND member_id='${MEMBER_A}'`,
  );
  assert.equal(msgCount, 1, 'first_message must fire exactly once per member');

  // First voice session.
  mock.voiceJoin(MEMBER_A);
  const voice = (await waitFor(harness.db, (db) =>
    db.prepare(`SELECT * FROM events WHERE event_type='first_voice_session' AND member_id=?`).get(MEMBER_A),
  )) as Record<string, unknown>;
  assert.equal(voice.source, `channel:${mock.voiceChannelId}`);

  // A second member joining with no invite delta is honestly marked unknown.
  mock.memberJoin(MEMBER_B, 'lurker');
  const joinB = (await waitFor(harness.db, (db) =>
    db.prepare(`SELECT * FROM events WHERE event_type='member_join' AND member_id=?`).get(MEMBER_B),
  )) as Record<string, unknown>;
  assert.equal(joinB.source, 'unknown');

  // The members projection should now describe the funnel without touching events.
  const member = await db_row(
    harness.db,
    `SELECT * FROM members WHERE member_id='${MEMBER_A}'`,
  );
  assert.ok(member.joined_at, 'joined_at set');
  assert.ok(member.first_message_at, 'first_message_at set');
  assert.ok(member.first_voice_at, 'first_voice_at set');
  assert.equal(member.join_source, 'invite:twodev01');

  // MEMBER_B joined and never posted - this is the re-engagement list.
  const neverPosted = await db_row(
    harness.db,
    `SELECT COUNT(*) AS n FROM members WHERE first_message_at IS NULL AND first_voice_at IS NULL AND joined_at IS NOT NULL`,
  );
  assert.equal(Number(neverPosted.n), 1);
});

async function db_count(db: Db, sql: string): Promise<number> {
  const row = await db.prepare(sql).get<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function db_row(db: Db, sql: string): Promise<Record<string, unknown>> {
  return (await db.prepare(sql).get()) as Record<string, unknown>;
}
