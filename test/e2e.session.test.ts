/**
 * End-to-end session routing (TOG-1644): the unmodified bot process in
 * TWO_ONBOARDING_MODE=session, a real discord.js client over the mock gateway,
 * driven from "just joined behind the rules gate" to "routed to a room", then
 * out the other side to a goodbye.
 *
 * What this proves that the unit suite cannot:
 *   - the mode is selected by one env var and the legacy picker is NOT loaded
 *   - the welcome carries a working picker with exactly the accepted options
 *   - a selection produces an ephemeral ack and a channel_routed row
 *   - NO member-role write is ever attempted (the parity guarantee)
 *   - re-selection answers identically and records a second routing
 *   - an unknown key from a stale panel gets a retry message, not a crash
 *   - a leave posts a goodbye that pings nobody
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  startMockDiscord,
  type MockDiscord,
} from '../tools/mock-discord/server.ts';
import {
  LOOKING_TO_PLAY_CHANNEL_ID,
  LOBBY_VOICE_CHANNEL_ID,
} from '../src/onboarding/session.ts';
import { openDb, type Db } from '../src/store/db.ts';
import { openTestDb, usingPostgres, type TestDb } from './helpers/testDb.ts';

const ROOT = resolve(import.meta.dirname, '..');
const NEWBIE = '900000000000006666';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => Promise<T | undefined | null> | T | undefined | null,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function queryDb<T>(reader: Db, fn: (db: Db) => Promise<T> | T): Promise<T> {
  return fn(reader);
}

let harnessSeq = 0;

interface Harness {
  mock: MockDiscord;
  reader: Db;
  bot: ChildProcess;
  botLog: string[];
}

async function startHarness(
  t: { after: (fn: () => Promise<void>) => void },
  extraEnv: Record<string, string> = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'two-session-e2e-'));
  const dbPath = join(dir, 'two.db');
  const mock = await startMockDiscord({});

  let harness: TestDb | null = null;
  let reader: Db;
  let botDbEnv: Record<string, string>;
  if (usingPostgres) {
    harnessSeq++;
    harness = await openTestDb(`${import.meta.filename}_${harnessSeq}`);
    const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
    reader = harness.db;
    botDbEnv = {
      TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
      PGOPTIONS: `-c search_path=${schema}`,
    };
  } else {
    reader = await openDb(dbPath);
    botDbEnv = { TWO_DB_PATH: dbPath };
  }

  const botLog: string[] = [];
  const bot = spawn(process.execPath, ['src/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DISCORD_TOKEN: 'mock-token',
      DISCORD_BOT_TOKEN: 'mock-token',
      DISCORD_GUILD_ID: mock.guildId,
      DISCORD_API_BASE: mock.apiBase,
      DISCORD_LANDING_CHANNEL_IDS: mock.textChannelId,
      DISCORD_GOODBYE_CHANNEL_IDS: mock.textChannelId,
      DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID: LOOKING_TO_PLAY_CHANNEL_ID,
      DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID: LOBBY_VOICE_CHANNEL_ID,
      TWO_ONBOARDING_MODE: 'session',
      TWO_ONBOARDING_DRY_RUN: '0',
      TWO_SELF_ROLE_PANELS: '',
      TWO_DATABASE_URL: '',
      ...botDbEnv,
      ...extraEnv,
      LOG_LEVEL: 'debug',
    },
  });
  bot.stdout?.on('data', (d) => botLog.push(String(d)));
  bot.stderr?.on('data', (d) => botLog.push(String(d)));

  t.after(async () => {
    bot.kill('SIGKILL');
    await mock.close();
    if (harness) await harness.cleanup();
    else await reader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  try {
    await mock.waitForReady();
  } catch (err) {
    throw new Error(`bot never connected.\n--- bot output ---\n${botLog.join('')}`);
  }
  await sleep(400);
  return { mock, reader, bot, botLog };
}

function postedMessages(mock: MockDiscord): { channelId: string; content: string }[] {
  return mock.captured
    .map((c) => ({ m: /\/api\/v10\/channels\/(\d+)\/messages$/.exec(c.url), c }))
    .filter(({ m, c }) => m && c.method === 'POST')
    .map(({ m, c }) => ({
      channelId: m![1],
      content: (c.body as { content?: string })?.content ?? '',
    }));
}

function ephemeralReplies(mock: MockDiscord): string[] {
  return mock.captured
    .filter((c) => /\/webhooks\/\d+\/[^/]+\/messages\/(@|%40)original/.test(c.url))
    .map((c) => (c.body as { content?: string })?.content ?? '');
}

/**
 * Every shape a member-role write takes on the wire. There are two, and an
 * earlier revision of this helper only matched the first - which is why the
 * leveling reward path (TOG-2871/TOG-2872) reached `member.roles.add` with this
 * assertion still passing:
 *
 *   1. single   PUT/DELETE /guilds/{g}/members/{m}/roles/{r}  - roles.add(one)
 *   2. bulk     PATCH      /guilds/{g}/members/{m}   body.roles - roles.add([..])
 *
 * Shape 2 has no `/roles` in the path, so a URL-only regex never sees it. Match
 * the body as well or this guarantee is decorative.
 */
function roleWrites(mock: MockDiscord) {
  return mock.captured.filter((c) => {
    if (c.method === 'GET') return false;
    if (/\/guilds\/\d+\/members\/\d+\/roles/.test(c.url)) return true;
    return (
      c.method === 'PATCH' &&
      /\/guilds\/\d+\/members\/\d+$/.test(c.url) &&
      Array.isArray((c.body as { roles?: unknown })?.roles)
    );
  });
}

test(
  'session mode: join -> gate clear -> welcome + picker -> selection -> routed, with zero role writes',
  { timeout: 90_000 },
  async (t) => {
    const { mock, reader, botLog } = await startHarness(t);

    // The mode line is the first thing to prove: session on, legacy off.
    await waitFor(
      () => (botLog.join('').includes('session_onboarding_enabled') ? true : undefined),
      'session_onboarding_enabled boot line',
    );
    // The legacy boot lines must NOT appear. (Match on the exact msg field:
    // "session_onboarding_enabled" contains "onboarding_enabled" as a substring.)
    assert.doesNotMatch(botLog.join(''), /"msg":"onboarding_enabled"/);
    assert.doesNotMatch(botLog.join(''), /"msg":"anchor_welcome_enabled"/);

    // 1. Arrives behind the gate; nothing is posted for them yet.
    mock.memberJoinPending(NEWBIE, 'newbie');
    await sleep(1200);
    assert.equal(postedMessages(mock).length, 0, 'welcomed a gated member');

    // 2. Rules accepted -> welcome with the session picker.
    mock.memberAcceptRules(NEWBIE, 'newbie');
    const welcome = await waitFor(
      () => postedMessages(mock).find((p) => p.content.includes(`<@${NEWBIE}>`)),
      `a welcome post.\n${botLog.join('')}`,
    );
    assert.match(welcome.content, /what do you want to do right now/i);
    // The picker travels with the welcome message body.
    const welcomeReq = mock.captured.find(
      (c) =>
        c.method === 'POST' &&
        /\/channels\/\d+\/messages$/.test(c.url) &&
        JSON.stringify(c.body).includes('What do you want to do right now?'),
    );
    assert.ok(welcomeReq, 'welcome must carry the picker component');
    const components = (welcomeReq!.body as { components?: unknown }).components;
    const picker = JSON.stringify(components);
    assert.match(picker, /Find people to play with/);
    assert.match(picker, /Join voice now/);
    assert.match(picker, /two:onboarding:session/);
    assert.doesNotMatch(picker, /two:onboarding:games/);

    // 3. Both options used: each acks its own destination.
    mock.selectSession(NEWBIE, 'newbie', ['find-players']);
    let reply = await waitFor(
      () => ephemeralReplies(mock).find((r) => r.includes('On it')),
      `an ack for find-players.\n${botLog.join('')}`,
    );
    assert.match(reply, new RegExp(`<#${LOOKING_TO_PLAY_CHANNEL_ID}>`));

    mock.selectSession(NEWBIE, 'newbie', ['join-voice']);
    await sleep(600); // let the find-players ack settle before reading "the last one"
    reply = await waitFor(
      () => ephemeralReplies(mock).filter((r) => r.includes('On it')).at(-1),
      `an ack for join-voice.\n${botLog.join('')}`,
    );
    assert.match(
      reply,
      new RegExp(`<#${LOBBY_VOICE_CHANNEL_ID}>`),
      `the second ack must be the Lobby, got: ${reply}`,
    );

    // 4. THE PARITY GUARANTEE: no role write was ever attempted.
    assert.equal(
      roleWrites(mock).length,
      0,
      `session mode must never write roles. Saw: ${JSON.stringify(roleWrites(mock))}`,
    );

    // 5. The funnel rows exist: prompted once, routed twice.
    const prompted = await queryDb(reader, (db) =>
      db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='onboarding_prompted' AND member_id=?`)
        .get(NEWBIE),
    ) as { n: number } | null;
    assert.equal(Number(prompted?.n ?? 0), 1, 'welcomed exactly once');

    const routed = await waitFor(
      () =>
        queryDb(reader, (db) =>
          db
            .prepare(`SELECT metadata FROM events WHERE event_type='channel_routed' AND member_id=? ORDER BY id`)
            .all(NEWBIE),
        ),
      `channel_routed rows.\n${botLog.join('')}`,
    ) as unknown as { metadata: string }[];
    assert.equal(routed.length, 2, 'one routing per selection');
    const metas = routed.map((r) => JSON.parse(r.metadata));
    assert.deepEqual(metas[0].picks, ['find-players']);
    assert.deepEqual(metas[1].picks, ['join-voice']);
    assert.equal(metas[0].source ?? 'ok', 'ok'); // placeholder, metadata has no source

    // 6. Idempotency: the same selection again acks identically, no role write.
    const acksBefore = ephemeralReplies(mock).filter((r) => r.includes('On it')).length;
    mock.selectSession(NEWBIE, 'newbie', ['find-players']);
    await waitFor(
      () =>
        ephemeralReplies(mock).filter((r) => r.includes('On it')).length > acksBefore
          ? true
          : undefined,
      `a second identical ack.\n${botLog.join('')}`,
    );
    const acks = ephemeralReplies(mock).filter((r) => r.includes('On it'));
    // The re-submitted key is find-players, so the last two acks that mention
    // the find-players destination must be byte-identical (the join-voice ack
    // in between is a different, legitimate destination).
    const findPlayersAcks = acks.filter((r) => r.includes(LOOKING_TO_PLAY_CHANNEL_ID));
    assert.equal(findPlayersAcks.length, 2, 'two find-players acks');
    assert.equal(
      findPlayersAcks[0],
      findPlayersAcks[1],
      'identical resubmission must ack identically',
    );
    assert.equal(roleWrites(mock).length, 0, 'still no role writes after re-selection');

    // 7. Stale/unknown selection: retry message, no crash, no routing row.
    const routedCountBefore = routed.length;
    mock.selectSession(NEWBIE, 'newbie', ['survival-games']);
    await waitFor(
      () => ephemeralReplies(mock).find((r) => /stale/i.test(r)),
      `a stale-selection retry message.\n${botLog.join('')}`,
    );
    const after = await queryDb(reader, (db) =>
      db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='channel_routed' AND member_id=?`)
        .get(NEWBIE),
    ) as { n: number } | null;
    assert.equal(
      Number(after?.n ?? 0),
      routedCountBefore + 1 + 0, // 2 prior + the idempotent re-select; the stale one adds none
    );

    // 8. Goodbye: member leaves, a goodbye is posted, and it pings nobody.
    mock.memberRemove(NEWBIE, 'newbie');
    const bye = await waitFor(
      () => postedMessages(mock).find((p) => /left the server/.test(p.content)),
      `a goodbye post.\n${botLog.join('')}`,
    );
    assert.match(bye.content, /\*\*newbie\*\*/);
    assert.doesNotMatch(bye.content, /<@/);
    assert.match(bye.content, /stay on the books/);
  },
);

test(
  'session dry-run still posts the picker before recording the once-per-member welcome',
  { timeout: 90_000 },
  async (t) => {
    const { mock, reader, botLog } = await startHarness(t, { TWO_ONBOARDING_DRY_RUN: '1' });

    await waitFor(
      () => (botLog.join('').includes('session_onboarding_enabled') ? true : undefined),
      'session_onboarding_enabled boot line',
    );

    mock.memberJoinPending(NEWBIE, 'newbie');
    mock.memberAcceptRules(NEWBIE, 'newbie');
    const welcome = await waitFor(
      () => postedMessages(mock).find((p) => p.content.includes(`<@${NEWBIE}>`)),
      `a dry-run welcome post.\n${botLog.join('')}`,
    );
    assert.match(welcome.content, /what do you want to do right now/i);
    assert.equal(roleWrites(mock).length, 0, 'dry-run session mode must not write roles');

    // The recording happens *after* the post - that ordering is the thing under
    // test - so reading the row the instant the post is observed is a race this
    // suite loses under load. Poll for it, the same fix PR #104 applied to the
    // community scorecard job. Ordering is still proven: the welcome post was
    // already observed above, before this row could exist.
    const prompted = await waitFor(async () => {
      const row = (await queryDb(reader, (db) =>
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM events WHERE event_type='onboarding_prompted' AND member_id=?`,
          )
          .get<{ n: number }>(NEWBIE),
      )) as { n: number } | null;
      return row && Number(row.n) > 0 ? row : undefined;
    }, 'the onboarding_prompted row to be recorded');
    assert.equal(Number(prompted.n), 1, 'recorded exactly once, only after the picker was posted');
  },
);

test(
  'session mode ignores member and picker events from every other guild',
  { timeout: 90_000 },
  async (t) => {
    const { mock, reader, botLog } = await startHarness(t);
    const foreignGuildId = '999999999999999999';

    await waitFor(
      () => (botLog.join('').includes('session_onboarding_enabled') ? true : undefined),
      'session_onboarding_enabled boot line',
    );

    mock.memberJoinPending(NEWBIE, 'newbie', foreignGuildId);
    mock.memberAcceptRules(NEWBIE, 'newbie', foreignGuildId);
    mock.selectSession(NEWBIE, 'newbie', ['find-players'], foreignGuildId);
    mock.memberRemove(NEWBIE, 'newbie', foreignGuildId);
    await sleep(1200);

    assert.equal(postedMessages(mock).length, 0, 'foreign-guild member events must not post');
    assert.equal(ephemeralReplies(mock).length, 0, 'foreign-guild picker must not be acknowledged');
    assert.equal(roleWrites(mock).length, 0, 'foreign-guild events must never write roles');

    const rows = await queryDb(reader, (db) =>
      db.prepare(`SELECT COUNT(*) AS n FROM events WHERE member_id=?`).get(NEWBIE),
    ) as { n: number } | null;
    assert.equal(Number(rows?.n ?? 0), 0, 'foreign-guild events must not be recorded');
  },
);

/**
 * TOG-2871 / TOG-2872. A configured leveling reward used to reach
 * `member.roles.add` in session mode: the gateway always got the LevelingService,
 * and a level-up called applyLevelRoles regardless of onboarding mode. That is a
 * role write on ordinary member activity, which breaks the roleless-launch
 * guarantee a live guild is relying on.
 *
 * Seeding is what makes this reachable in one event. MESSAGE_COOLDOWN_SECONDS is
 * 60, so a member cannot chat their way to level 1 (100 XP at 15 XP/message)
 * inside a test - instead we park them at 95 XP and let a single message carry
 * them over the line.
 *
 * The XP assertion is not decoration: it is what distinguishes the real fix
 * (suppress the role write) from the lazy one (stop passing `leveling` in), and
 * it fails if someone "fixes" this by disabling leveling wholesale.
 */
test(
  'session mode grants no leveling reward role, but still awards the XP',
  { timeout: 90_000 },
  async (t) => {
    const LEVELER = '900000000000007777';
    const REWARD_ROLE = '300000000000000003';
    const { mock, reader, botLog } = await startHarness(t);

    await waitFor(
      () => (botLog.join('').includes('session_onboarding_enabled') ? true : undefined),
      'session_onboarding_enabled boot line',
    );

    await queryDb(reader, (db) =>
      db
        .prepare(`INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?, ?, ?)`)
        .run(mock.guildId, 1, REWARD_ROLE),
    );
    // 95 + MESSAGE_XP(15) = 110, over totalXpForLevel(1) = 100.
    await queryDb(reader, (db) =>
      db
        .prepare(
          `INSERT INTO member_levels (guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at)
           VALUES (?, ?, 95, 95, 0, 0, ?)`,
        )
        .run(mock.guildId, LEVELER, new Date().toISOString()),
    );

    mock.message(LEVELER);

    // Poll for the award, not merely for the row - the seeded row is already
    // there, so waiting on "a row exists" returns 95 instantly and never sees
    // the level-up at all.
    const levelled = await waitFor(async () => {
      const row = (await queryDb(reader, (db) =>
        db
          .prepare(`SELECT xp FROM member_levels WHERE guild_id=? AND member_id=?`)
          .get<{ xp: number }>(mock.guildId, LEVELER),
      )) as { xp: number } | null;
      return row && Number(row.xp) !== 95 ? row : undefined;
    }, `the message XP award to land\n--- bot output ---\n${botLog.join('')}`);
    assert.equal(
      Number(levelled.xp),
      110,
      'session mode must keep awarding XP - only the role write is suppressed',
    );

    // Give any role write that was going to happen time to be attempted.
    await sleep(800);
    assert.equal(
      roleWrites(mock).length,
      0,
      `a level-up with a configured reward must not write roles in session mode. Saw: ${JSON.stringify(roleWrites(mock))}`,
    );
  },
);

test('session mode refuses to start without DISCORD_GUILD_ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'two-session-missing-guild-'));
  const bot = spawn(process.execPath, ['src/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DISCORD_TOKEN: 'mock-token',
      DISCORD_BOT_TOKEN: 'mock-token',
      DISCORD_GUILD_ID: '',
      DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID: LOOKING_TO_PLAY_CHANNEL_ID,
      DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID: LOBBY_VOICE_CHANNEL_ID,
      TWO_ONBOARDING_MODE: 'session',
      TWO_SELF_ROLE_PANELS: '',
      TWO_DATABASE_URL: '',
      TWO_DB_PATH: join(dir, 'two.db'),
    },
  });
  let output = '';
  bot.stdout?.on('data', (d) => (output += String(d)));
  bot.stderr?.on('data', (d) => (output += String(d)));
  const code = await new Promise<number | null>((resolve) => bot.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });

  assert.notEqual(code, 0);
  assert.match(output, /session requires DISCORD_GUILD_ID/);
});

test('invalid onboarding modes fail closed before the bot can boot', async () => {
  for (const [index, mode] of ['sessions', 'SESSION', ' session '].entries()) {
    const dir = mkdtempSync(join(tmpdir(), `two-session-invalid-mode-${index}-`));
    const bot = spawn(process.execPath, ['src/index.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DISCORD_TOKEN: 'mock-token',
        DISCORD_BOT_TOKEN: 'mock-token',
        TWO_ONBOARDING_MODE: mode,
        TWO_SELF_ROLE_PANELS: '',
        TWO_DATABASE_URL: '',
        TWO_DB_PATH: join(dir, 'two.db'),
      },
    });
    let output = '';
    bot.stdout?.on('data', (d) => (output += String(d)));
    bot.stderr?.on('data', (d) => (output += String(d)));
    const code = await new Promise<number | null>((resolve) => bot.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });

    assert.notEqual(code, 0, `${JSON.stringify(mode)} must not boot`);
    assert.match(output, /TWO_ONBOARDING_MODE must be exactly "legacy" or "session"/);
  }
});

test('session mode refuses self-role panels instead of registering role writers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'two-session-self-roles-'));
  const panel = JSON.stringify([
    {
      id: 'colors',
      channelId: '111111111111111111',
      messageId: '222222222222222222',
      mode: 'button',
      options: [
        {
          key: 'red',
          label: 'Red',
          roleId: '333333333333333333',
          permissions: '0',
        },
      ],
    },
  ]);
  const bot = spawn(process.execPath, ['src/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DISCORD_TOKEN: 'mock-token',
      DISCORD_BOT_TOKEN: 'mock-token',
      DISCORD_GUILD_ID: '444444444444444444',
      DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID: LOOKING_TO_PLAY_CHANNEL_ID,
      DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID: LOBBY_VOICE_CHANNEL_ID,
      TWO_ONBOARDING_MODE: 'session',
      TWO_SELF_ROLE_PANELS: panel,
      TWO_DATABASE_URL: '',
      TWO_DB_PATH: join(dir, 'two.db'),
    },
  });
  let output = '';
  bot.stdout?.on('data', (d) => (output += String(d)));
  bot.stderr?.on('data', (d) => (output += String(d)));
  const code = await new Promise<number | null>((resolve) => bot.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });

  assert.notEqual(code, 0);
  assert.match(output, /session forbids TWO_SELF_ROLE_PANELS/);
});
