/**
 * TOG-5694: exploratory funnel-flow test - one member's whole journey through
 * the real bot process over the mock gateway socket.
 *
 * The existing e2e.funnel.test.ts proves the happy path (join -> first message
 * -> first voice, plus an unknown-attribution join). This file walks the paths
 * it skips, because that is where the funnel lies by omission:
 *
 *   1. leave: GUILD_MEMBER_REMOVE writes member_leave and sets left_at, and
 *      only for the member who left (TOG-5694 probe found leave coverage
 *      missing entirely - no gateway-level test asserted the row).
 *   2. rejoin: a second join re-opens the member (left_at cleared), and the
 *      once-per-member milestones keep their EARLIEST timestamps - a rejoin
 *      must not move first_message_at forward or inflate activation.
 *   3. rules gate: pending join -> no gate_cleared; rules accepted ->
 *      gate_cleared with source 'gateway', projected to gate_cleared_at.
 *      (Mirrors e2e.onboarding.test.ts's gate assertions, scoped to the
 *      funnel events this card owns.)
 *   4. voice leave: join -> message -> voice join -> voice leave writes
 *      voice_session_end with startKnown:true and a real duration, advancing
 *      last_active_at. No mock voiceLeave helper exists, so the frame is
 *      dispatched raw - a leave is VOICE_STATE_UPDATE with channel_id null.
 *   5. message ladder: three messages fill first/second/third_message in
 *      order; a fourth writes no new milestone row.
 *
 * Attribution `unknown` is covered by member B joining with no invite delta,
 * same mechanism as e2e.funnel.test.ts.
 *
 * Bugs found by the exploratory probe were filed as child cards of TOG-5694.
 * TOG-5981 (back-to-back voice frames for one member raced to
 * startKnown:false ends) is fixed by per-member serialization in the adapter
 * plus channel-scoped voice idempotency keys, covered by
 * unit.voiceburst.test.ts. That race is still deliberately NOT exercised
 * here: this suite settles between frames and pins the settled path green
 * regardless.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { startMockDiscord, type MockDiscord } from '../tools/mock-discord/server.ts';
import type { Db } from '../src/store/db.ts';
import { openTestDb, TEST_PG_URL } from './helpers/testDb.ts';

const ROOT = resolve(import.meta.dirname, '..');
// Distinct from e2e.funnel.test.ts's 900000000000001111/2222 so the two files
// can never collide even if schemas leak.
const MEMBER_A = '900000000000003333';
const MEMBER_B = '900000000000004444';

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


/** One member's voice state with no channel: the gateway's "they left" frame. */
function voiceLeaveFrame(mock: MockDiscord, memberId: string) {
  mock.dispatch('VOICE_STATE_UPDATE', {
    guild_id: mock.guildId,
    channel_id: null,
    user_id: memberId,
    member: {
      user: { id: memberId, username: 'member', discriminator: '0', global_name: 'member', avatar: null, bot: false, system: false, flags: 0 },
      roles: [],
      joined_at: new Date().toISOString(),
      deaf: false,
      mute: false,
      flags: 0,
    },
    session_id: 'mock-voice',
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_video: false,
    suppress: false,
    request_to_speak_timestamp: null,
  });
}

test('exploratory funnel flow: gate, ladder, voice leave, leave and rejoin', { timeout: 120_000 }, async (t) => {
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
      PGOPTIONS: `-c search_path=${schema}`,
      LOG_LEVEL: 'debug',
    },
  });
  bot.stdout?.on('data', (d) => botLog.push(String(d)));
  bot.stderr?.on('data', (d) => botLog.push(String(d)));
  bot.on('exit', (code) => botLog.push(`__bot exited with ${code}__`));

  const fail = (what: string) => new Error(`${what}\n--- bot output ---\n${botLog.join('')}`);

  try {
    await mock.waitForReady();
  } catch (err) {
    throw new Error(`${String(err)}\n--- bot output ---\n${botLog.join('')}`);
  }
  await sleep(1200);

  // --- 1. join behind the gate: join recorded, clearing not ------------------
  mock.memberJoinPending(MEMBER_A, 'explorer');
  const joinRow = (await waitFor(harness.db, (db) =>
    db
      .prepare(`SELECT * FROM events WHERE event_type = 'member_join' AND member_id = ?`)
      .get(MEMBER_A),
  ).catch((e) => {
    throw fail(`member_join never recorded: ${String(e)}`);
  })) as Record<string, unknown>;
  assert.equal(joinRow.guild_id, mock.guildId);

  await sleep(800);
  const earlyGate = await harness.db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'gate_cleared' AND member_id = ?`)
    .get<{ n: number }>(MEMBER_A);
  assert.equal(
    Number(earlyGate?.n ?? 0),
    0,
    'a member still behind the rules gate must have no gate_cleared row',
  );

  // --- 2. rules accepted: gate_cleared lands, projected to the member --------
  mock.memberAcceptRules(MEMBER_A, 'explorer');
  const gate = (await waitFor(harness.db, (db) =>
    db.prepare(`SELECT * FROM events WHERE event_type = 'gate_cleared' AND member_id = ?`).get(MEMBER_A),
  ).catch((e) => {
    throw fail(`gate_cleared never recorded: ${String(e)}`);
  })) as Record<string, unknown>;
  assert.equal(gate.source, 'gateway', 'a live clearing is a real measurement, not a backfill');
  const gated = (await harness.db
    .prepare(`SELECT gate_cleared_at AS t FROM members WHERE member_id = ?`)
    .get<{ t: string | null }>(MEMBER_A)) as { t: string | null };
  assert.ok(gated?.t, 'members.gate_cleared_at must be set');

  // --- 3. message ladder: three messages, three rungs, then silence ----------
  mock.message(MEMBER_A);
  await waitFor(harness.db, (db) =>
    db.prepare(`SELECT 1 AS x FROM events WHERE event_type = 'first_message' AND member_id = ?`).get(MEMBER_A),
  ).catch((e) => {
    throw fail(`first_message never recorded: ${String(e)}`);
  });
  const firstAt = (
    (await harness.db
      .prepare(`SELECT first_message_at AS t FROM members WHERE member_id = ?`)
      .get<{ t: string }>(MEMBER_A)) as { t: string }
  ).t;
  assert.ok(firstAt, 'members.first_message_at set');

  mock.message(MEMBER_A);
  await waitFor(harness.db, (db) =>
    db.prepare(`SELECT 1 AS x FROM events WHERE event_type = 'second_message' AND member_id = ?`).get(MEMBER_A),
  ).catch((e) => {
    throw fail(`second_message never recorded: ${String(e)}`);
  });

  mock.message(MEMBER_A);
  await waitFor(harness.db, (db) =>
    db.prepare(`SELECT 1 AS x FROM events WHERE event_type = 'third_message' AND member_id = ?`).get(MEMBER_A),
  ).catch((e) => {
    throw fail(`third_message never recorded: ${String(e)}`);
  });

  mock.message(MEMBER_A);
  await sleep(800);
  const ladderCount = (
    (await harness.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
          WHERE member_id = ? AND event_type IN ('first_message', 'second_message', 'third_message')`,
      )
      .get<{ n: number }>(MEMBER_A)) as { n: number }
  ).n;
  assert.equal(Number(ladderCount), 3, 'a fourth message must not open a fourth rung');

  // --- 4. unknown attribution: a join with no invite delta -------------------
  mock.memberJoin(MEMBER_B, 'lurker');
  const joinB = (await waitFor(harness.db, (db) =>
    db.prepare(`SELECT * FROM events WHERE event_type = 'member_join' AND member_id = ?`).get(MEMBER_B),
  ).catch((e) => {
    throw fail(`member_join for B never recorded: ${String(e)}`);
  })) as Record<string, unknown>;
  assert.equal(joinB.source, 'unknown');

  // --- 5. voice join then leave: bounded session with a real duration --------
  mock.voiceJoin(MEMBER_A);
  await waitFor(harness.db, (db) =>
    db.prepare(`SELECT 1 AS x FROM events WHERE event_type = 'first_voice_session' AND member_id = ?`).get(MEMBER_A),
  ).catch((e) => {
    throw fail(`first_voice_session never recorded: ${String(e)}`);
  });
  // Settle before the leave: back-to-back frames on one member race (TOG-5981)
  // and this suite pins the settled path, not the race.
  await sleep(1200);
  voiceLeaveFrame(mock, MEMBER_A);
  const endRow = (await waitFor(harness.db, (db) =>
    db.prepare(`SELECT * FROM events WHERE event_type = 'voice_session_end' AND member_id = ?`).get(MEMBER_A),
  ).catch((e) => {
    throw fail(`voice_session_end never recorded: ${String(e)}`);
  })) as Record<string, unknown>;
  assert.equal(endRow.source, `channel:${mock.voiceChannelId}`);
  const endMeta = JSON.parse((endRow as { metadata: string }).metadata) as {
    startKnown: boolean;
    durationSeconds: number | null;
  };
  assert.equal(endMeta.startKnown, true, 'a settled session must know its start');
  assert.ok(
    typeof endMeta.durationSeconds === 'number' && endMeta.durationSeconds >= 0,
    `a settled session must carry a real duration, got ${endMeta.durationSeconds}`,
  );

  // --- 6. leave: the row, the projection, and nobody else's ------------------
  mock.memberRemove(MEMBER_A, 'explorer');
  await waitFor(harness.db, (db) =>
    db.prepare(`SELECT 1 AS x FROM events WHERE event_type = 'member_leave' AND member_id = ?`).get(MEMBER_A),
  ).catch((e) => {
    throw fail(`member_leave never recorded: ${String(e)}`);
  });
  const left = (await harness.db
    .prepare(`SELECT left_at AS t FROM members WHERE member_id = ?`)
    .get<{ t: string | null }>(MEMBER_A)) as { t: string | null };
  assert.ok(left?.t, 'members.left_at must be set on leave');
  const bLeft = (await harness.db
    .prepare(`SELECT left_at AS t FROM members WHERE member_id = ?`)
    .get<{ t: string | null }>(MEMBER_B)) as { t: string | null };
  assert.equal(bLeft?.t, null, "A's leave must not mark B as left");

  // --- 7. rejoin: member re-opens, milestones keep their earliest times ------
  // A rejoin is a repeatable member_join, so the second row is a COUNT of 2,
  // not a new milestone.
  mock.memberJoin(MEMBER_A, 'explorer');
  await waitFor(harness.db, (db) =>
    db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'member_join' AND member_id = ?`)
      .get<{ n: number }>(MEMBER_A)
      .then((r) => (Number(r?.n ?? 0) >= 2 ? r : null)),
  ).catch((e) => {
    throw fail(`second member_join never recorded: ${String(e)}`);
  });
  const reopened = (await harness.db
    .prepare(`SELECT left_at AS t, first_message_at AS f FROM members WHERE member_id = ?`)
    .get<{ t: string | null; f: string }>(MEMBER_A)) as { t: string | null; f: string };
  assert.equal(reopened?.t, null, 'a rejoin must clear left_at');
  assert.equal(
    reopened?.f,
    firstAt,
    'a rejoin must not move first_message_at - milestones keep their earliest time',
  );
  // Discord re-screens on rejoin, so the live path records a second clearing -
  // but conversion is "of the people who joined, how many got in", and counting
  // one person's two clearings as two would push it over 100%. The key is
  // once-per-member, so the second write dedupes. Settle first (review note on
  // TOG-6027): the rejoin's join handler and its gate write race, and asserting
  // immediately could pass before a (wrong) second clearing lands.
  await sleep(1200);
  const gateCount = (
    (await harness.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'gate_cleared' AND member_id = ?`)
      .get<{ n: number }>(MEMBER_A)) as { n: number }
  ).n;
  assert.equal(Number(gateCount), 1, 'a rejoin must not double-count gate_cleared');
});
