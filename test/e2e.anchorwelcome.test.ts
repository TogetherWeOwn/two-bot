/**
 * The routed Sunday Squad welcome, end to end: the unmodified bot process, a
 * real discord.js client, a real websocket, and a member driven from "arrived
 * behind the rules gate" to "greeted in the room they landed in".
 *
 * The unit tests in unit.anchorevent.test.ts prove the dates and the strings.
 * This file proves the wiring around them, which is the part they cannot see:
 * that the message goes to the anchor channel and not the old landing channel,
 * that it is a bare message with nothing appended, that both funnel events are
 * written, and that the once-per-member guard survives a second rules-clear.
 *
 * TOG-93 is blocked on a live token (TOG-13). This is the closest thing to the
 * acceptance test that does not need one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockDiscord, type MockDiscord } from '../tools/mock-discord/server.ts';
import { openDb, type Db } from '../src/store/db.ts';
import { openTestDb, usingPostgres, type TestDb } from './helpers/testDb.ts';

const ROOT = resolve(import.meta.dirname, '..');
const NEWBIE = '900000000000005555';
const OTHER = '900000000000006666';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  mock: MockDiscord;
  reader: Db;
  bot: ChildProcess;
  botLog: string[];
  /** Where the anchor welcome was told to post. */
  anchorChannelId: string;
}

let harnessSeq = 0;

async function startHarness(t: { after: (fn: () => unknown) => void }): Promise<Harness> {
  const mock = await startMockDiscord({ lighting: 'dark' });
  const dir = mkdtempSync(join(tmpdir(), 'two-anchor-'));
  const dbPath = join(dir, 'two.db');
  const botLog: string[] = [];

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

  // The landing channel is still configured. That is the point: with the anchor
  // channel set, the picker's own welcome must NOT also fire, and the only way
  // to see that is to leave the old config in place and watch it stay quiet.
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
      DISCORD_ANCHOR_WELCOME_CHANNEL_ID: mock.voiceChannelId,
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
  } catch {
    throw new Error(`bot never connected.\n--- bot output ---\n${botLog.join('')}`);
  }
  await sleep(400);
  return { mock, reader, bot, botLog, anchorChannelId: mock.voiceChannelId };
}

interface Posted {
  channelId: string;
  content: string;
  body: Record<string, unknown>;
}

function postedMessages(mock: MockDiscord): Posted[] {
  return mock.captured
    .map((c) => ({ m: /\/api\/v10\/channels\/(\d+)\/messages$/.exec(c.url), c }))
    .filter(({ m, c }) => m && c.method === 'POST')
    .map(({ m, c }) => ({
      channelId: m![1],
      content: (c.body as { content?: string })?.content ?? '',
      body: (c.body ?? {}) as Record<string, unknown>,
    }));
}

async function countEvents(reader: Db, type: string): Promise<number> {
  try {
    const row = await reader
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = '${type}'`)
      .get<{ n: number }>();
    return Number(row?.n ?? 0);
  } catch {
    return 0; // tables not created yet
  }
}

test('the welcome lands in the anchor room, once, and says the one thing', { timeout: 90_000 }, async (t) => {
  const { mock, reader, botLog, anchorChannelId } = await startHarness(t);

  mock.memberJoinPending(NEWBIE, 'newbie');
  await sleep(1000);
  assert.equal(
    postedMessages(mock).length,
    0,
    `greeted a member who cannot click anything yet.\n${botLog.join('')}`,
  );

  mock.memberAcceptRules(NEWBIE, 'newbie');
  await sleep(1500);

  const posts = postedMessages(mock);
  assert.equal(posts.length, 1, `expected exactly one message.\n${JSON.stringify(posts, null, 2)}`);

  const post = posts[0];
  assert.equal(post.channelId, anchorChannelId, 'welcome did not go to the anchor room');
  assert.notEqual(post.channelId, mock.textChannelId, 'welcome went to the old landing channel');

  // Nothing appended. TOG-93 is explicit about this.
  assert.ok(
    !post.body.components || (post.body.components as unknown[]).length === 0,
    'something was attached to the welcome',
  );
  assert.ok(!post.body.embeds || (post.body.embeds as unknown[]).length === 0);

  assert.ok(post.content.includes('Sunday Squad'), post.content);
  assert.ok(post.content.includes(`<@${NEWBIE}>`), 'the member is not mentioned');
  assert.match(post.content, /<t:\d{10}:R>/, 'no relative timestamp');
  // A computed date, not a written one - the whole point of item 1.
  assert.doesNotMatch(post.content, /\b20(2[6-9]|3\d)\b/, 'a literal year reached the message');

  assert.equal(await countEvents(reader, 'onboarding_prompted'), 1);
  assert.equal(await countEvents(reader, 'channel_routed'), 1);
});

test('a second rules-clear does not greet the same member twice', { timeout: 90_000 }, async (t) => {
  const { mock, reader } = await startHarness(t);

  mock.memberJoinPending(NEWBIE, 'newbie');
  await sleep(600);
  mock.memberAcceptRules(NEWBIE, 'newbie');
  await sleep(1500);
  // A replayed gateway event, a reconnect, or a member who is re-screened.
  mock.memberJoinPending(NEWBIE, 'newbie');
  await sleep(400);
  mock.memberAcceptRules(NEWBIE, 'newbie');
  await sleep(1500);

  assert.equal(postedMessages(mock).length, 1, 'welcomed the same member twice');
  assert.equal(await countEvents(reader, 'onboarding_prompted'), 1);
});

test('a second member gets their own welcome', { timeout: 90_000 }, async (t) => {
  const { mock, reader } = await startHarness(t);

  for (const [id, name] of [[NEWBIE, 'newbie'], [OTHER, 'other']] as const) {
    mock.memberJoinPending(id, name);
    await sleep(400);
    mock.memberAcceptRules(id, name);
    await sleep(1200);
  }

  const posts = postedMessages(mock);
  assert.equal(posts.length, 2);
  assert.ok(posts[0].content.includes(`<@${NEWBIE}>`));
  assert.ok(posts[1].content.includes(`<@${OTHER}>`));
  // Same event, so the same timestamp - the date is a property of the series,
  // not of who happened to arrive.
  const stamps = posts.map((p) => /<t:(\d+):R>/.exec(p.content)?.[1]);
  assert.equal(stamps[0], stamps[1]);

  assert.equal(await countEvents(reader, 'onboarding_prompted'), 2);
  assert.equal(await countEvents(reader, 'channel_routed'), 2);
});

test('the bot never opens a DM to deliver this', { timeout: 90_000 }, async (t) => {
  const { mock } = await startHarness(t);

  mock.memberJoinPending(NEWBIE, 'newbie');
  await sleep(400);
  mock.memberAcceptRules(NEWBIE, 'newbie');
  await sleep(1500);

  const dmAttempts = mock.captured.filter(
    (c) => c.method === 'POST' && /\/users\/@me\/channels$/.test(c.url),
  );
  assert.equal(dmAttempts.length, 0, 'the bot tried to open a DM channel');
});
