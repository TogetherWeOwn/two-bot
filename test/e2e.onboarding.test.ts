/**
 * End-to-end onboarding: the unmodified bot process, a real discord.js client,
 * a real websocket, and a member driven from "just joined" to "handed a link
 * to a game channel".
 *
 * This is the closest thing to the acceptance test in TWO-7 that does not need
 * a real Discord account. The bot is not stubbed - src/index.ts runs as its own
 * process and only DISCORD_API_BASE is redirected.
 *
 * The suite runs the same journey under three server configurations:
 *   - as the server is configured today (game rooms dark)   -> hub fallback
 *   - with view granted on the categories only              -> hub fallback
 *   - with view granted on the categories and the channels  -> the game channel
 *
 * The third case proves the fix is sufficient before we ask anyone to approve
 * it. The second proves the obvious-looking version of that fix is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  startMockDiscord,
  type Lighting,
  type MockDiscord,
} from '../tools/mock-discord/server.ts';
import { pickByKey, GAME_HUB_CHANNEL_ID } from '../src/onboarding/catalog.ts';
import { openDb, type Db } from '../src/store/db.ts';
import { openTestDb, usingPostgres, type TestDb } from './helpers/testDb.ts';

const ROOT = resolve(import.meta.dirname, '..');
const NEWBIE = '900000000000007777';

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

async function queryDb<T>(reader: Db, fn: (db: Db) => Promise<T>): Promise<T | null> {
  try {
    return await fn(reader);
  } catch {
    return null; // tables not created yet
  }
}

interface Harness {
  mock: MockDiscord;
  /** Test-owned connection to whatever datastore the bot was pointed at. */
  reader: Db;
  bot: ChildProcess;
  botLog: string[];
}

let harnessSeq = 0;

async function startHarness(
  t: { after: (fn: () => unknown) => void },
  opts: { lighting?: Lighting } = {},
): Promise<Harness> {
  const mock = await startMockDiscord(opts);
  const dir = mkdtempSync(join(tmpdir(), 'two-onb-'));
  const dbPath = join(dir, 'two.db');
  const botLog: string[] = [];

  // Each harness gets its own datastore. On Postgres that is a private schema
  // per harness, so the several bots this file starts never see each other.
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
      ...botDbEnv,
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
  // Let ClientReady finish its invite snapshot before we push events.
  await sleep(400);
  return { mock, reader, bot, botLog };
}

/** Messages the bot posted into a channel, in order. */
function postedMessages(mock: MockDiscord): { channelId: string; content: string }[] {
  return mock.captured
    .map((c) => ({ m: /\/api\/v10\/channels\/(\d+)\/messages$/.exec(c.url), c }))
    .filter(({ m, c }) => m && c.method === 'POST')
    .map(({ m, c }) => ({
      channelId: m![1],
      content: (c.body as { content?: string })?.content ?? '',
    }));
}

/**
 * The ephemeral reply text the bot sent back to the member.
 *
 * discord.js percent-encodes the `@` in `@original`, so the URL on the wire is
 * `/messages/%40original`. Matching both spellings.
 */
function ephemeralReplies(mock: MockDiscord): string[] {
  return mock.captured
    .filter((c) => /\/webhooks\/\d+\/[^/]+\/messages\/(@|%40)original/.test(c.url))
    .map((c) => (c.body as { content?: string })?.content ?? '');
}

test(
  'a pending member is not welcomed until they accept the rules',
  { timeout: 90_000 },
  async (t) => {
    const { mock, reader, botLog } = await startHarness(t);

    mock.memberJoinPending(NEWBIE, 'newbie');
    await sleep(1200);

    assert.equal(
      postedMessages(mock).length,
      0,
      `welcomed a member who cannot click anything yet.\n${botLog.join('')}`,
    );

    const prompted = await queryDb(reader, (db) =>
      db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'onboarding_prompted'`)
        .get(),
    ) as { n: number } | null;
    assert.equal(Number(prompted?.n ?? 0), 0);
  },
);

test(
  'join -> rules accepted -> picker -> routed, with the categories dark',
  { timeout: 90_000 },
  async (t) => {
    const { mock, reader, botLog } = await startHarness(t);

    // 1. Arrives behind the gate, then accepts the rules.
    mock.memberJoinPending(NEWBIE, 'newbie');
    await sleep(300);
    mock.memberAcceptRules(NEWBIE, 'newbie');

    // 2. The welcome lands in the landing channel, mentioning them.
    const welcome = await waitFor(
      () => postedMessages(mock).find((p) => p.channelId === mock.textChannelId),
      `a welcome post in the landing channel.\n${botLog.join('')}`,
    );
    assert.match(welcome.content, new RegExp(`<@${NEWBIE}>`), 'welcome must mention the member');

    await waitFor(
      () =>
        queryDb(reader, (db) =>
          db
            .prepare(
              `SELECT 1 AS x FROM events WHERE event_type='onboarding_prompted' AND member_id=?`,
            )
            .get(NEWBIE),
        ),
      'onboarding_prompted recorded',
    );

    // 3. They pick Shooters.
    mock.selectGames(NEWBIE, 'newbie', ['shooters']);

    await waitFor(
      () =>
        queryDb(reader, (db) =>
          db
            .prepare(`SELECT 1 AS x FROM events WHERE event_type='channel_routed' AND member_id=?`)
            .get(NEWBIE),
        ),
      `channel_routed recorded.\n${botLog.join('')}`,
    );

    // 4. The role was actually granted.
    const roleWrites = mock.captured.filter(
      (c) => /\/guilds\/\d+\/members\/\d+/.test(c.url) && c.method !== 'GET',
    );
    const shooters = pickByKey('shooters')!;
    const grantedShooters = roleWrites.some(
      (c) =>
        c.url.endsWith(`/roles/${shooters.roleId}`) ||
        (Array.isArray((c.body as { roles?: string[] })?.roles) &&
          (c.body as { roles: string[] }).roles.includes(shooters.roleId)),
    );
    assert.ok(grantedShooters, `Shooter Games was never granted.\n${botLog.join('')}`);

    // 5. They were handed a link they can actually open. The dedicated channel
    //    is dark in this configuration, so it must be the hub.
    const reply = ephemeralReplies(mock).at(-1) ?? '';
    assert.match(reply, new RegExp(GAME_HUB_CHANNEL_ID), 'must fall back to the visible hub');
    assert.doesNotMatch(
      reply,
      new RegExp(shooters.primaryChannelId!),
      'must NOT link a channel the member cannot open',
    );

    // 6. The fallback is visible in the data, not just in the reply.
    const routed = await queryDb(reader, (db) =>
      db
        .prepare(
          `SELECT metadata FROM events WHERE event_type='channel_routed' AND member_id=? ORDER BY id DESC LIMIT 1`,
        )
        .get(NEWBIE),
    ) as { metadata: string } | null;
    assert.equal(JSON.parse(routed!.metadata).degraded, 1, 'the dark room must show up as degraded');
  },
);

test(
  'with the permission fix applied, the member lands in the real game channel',
  { timeout: 90_000 },
  async (t) => {
    const { mock, reader, botLog } = await startHarness(t, { lighting: 'lit' });

    mock.memberJoinPending(NEWBIE, 'newbie');
    await sleep(300);
    mock.memberAcceptRules(NEWBIE, 'newbie');
    await waitFor(
      () => postedMessages(mock).find((p) => p.channelId === mock.textChannelId),
      `a welcome post.\n${botLog.join('')}`,
    );

    const shooters = pickByKey('shooters')!;
    // The member now holds Shooter Games, which is what reveals the category.
    mock.selectGames(NEWBIE, 'newbie', ['shooters'], [
      '1078755185423286372',
      shooters.roleId,
    ]);

    await waitFor(
      () =>
        queryDb(reader, (db) =>
          db
            .prepare(`SELECT 1 AS x FROM events WHERE event_type='channel_routed' AND member_id=?`)
            .get(NEWBIE),
        ),
      `channel_routed recorded.\n${botLog.join('')}`,
    );

    const reply = ephemeralReplies(mock).at(-1) ?? '';
    assert.match(
      reply,
      new RegExp(shooters.primaryChannelId!),
      `must link #shooters-general once the category is lit.\nreply was: ${reply}\n${botLog.join('')}`,
    );

    const routed = await queryDb(reader, (db) =>
      db
        .prepare(
          `SELECT metadata FROM events WHERE event_type='channel_routed' AND member_id=? ORDER BY id DESC LIMIT 1`,
        )
        .get(NEWBIE),
    ) as { metadata: string } | null;
    assert.equal(JSON.parse(routed!.metadata).degraded, 0, 'nothing should be degraded now');
  },
);

test(
  'granting view on the categories alone is NOT enough - members stay locked out',
  { timeout: 90_000 },
  async (t) => {
    // This is the fix we almost shipped. Discord resolves permissions from a
    // channel's own overwrites; a category grants nothing at runtime. In the
    // Discord UI the categories would look correctly configured and every
    // member would still be staring at a hub fallback.
    //
    // If someone "simplifies" apply-game-channel-access.ts back to categories
    // only, this test fails and the next one keeps passing - which is exactly
    // the signal we want.
    const { mock, reader, botLog } = await startHarness(t, { lighting: 'categories-only' });

    mock.memberJoinPending(NEWBIE, 'newbie');
    await sleep(300);
    mock.memberAcceptRules(NEWBIE, 'newbie');
    await waitFor(
      () => postedMessages(mock).find((p) => p.channelId === mock.textChannelId),
      `a welcome post.\n${botLog.join('')}`,
    );

    const shooters = pickByKey('shooters')!;
    mock.selectGames(NEWBIE, 'newbie', ['shooters'], ['1078755185423286372', shooters.roleId]);

    await waitFor(
      () =>
        queryDb(reader, (db) =>
          db
            .prepare(`SELECT 1 AS x FROM events WHERE event_type='channel_routed' AND member_id=?`)
            .get(NEWBIE),
        ),
      `channel_routed recorded.\n${botLog.join('')}`,
    );

    const reply = ephemeralReplies(mock).at(-1) ?? '';
    assert.doesNotMatch(
      reply,
      new RegExp(shooters.primaryChannelId!),
      'a category-only grant must not be mistaken for working access',
    );

    const routed = await queryDb(reader, (db) =>
      db
        .prepare(
          `SELECT metadata FROM events WHERE event_type='channel_routed' AND member_id=? ORDER BY id DESC LIMIT 1`,
        )
        .get(NEWBIE),
    ) as { metadata: string } | null;
    assert.equal(
      JSON.parse(routed!.metadata).degraded,
      1,
      'a category-only grant leaves the member degraded, and the numbers must say so',
    );
  },
);

test('the bot never opens a DM channel during onboarding', { timeout: 90_000 }, async (t) => {
  const { mock } = await startHarness(t);

  mock.memberJoinPending(NEWBIE, 'newbie');
  await sleep(300);
  mock.memberAcceptRules(NEWBIE, 'newbie');
  await sleep(1200);
  mock.selectGames(NEWBIE, 'newbie', ['shooters', 'horror']);
  await sleep(1500);

  // Creating a DM is POST /users/@me/channels. If that never happens, the bot
  // structurally cannot have sent a DM. This is the constraint from the issue.
  const dmAttempts = mock.captured.filter((c) => /\/users\/@me\/channels/.test(c.url));
  assert.deepEqual(dmAttempts, [], 'onboarding must stay in-server; no DMs without CEO sign-off');
});
