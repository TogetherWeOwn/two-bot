/**
 * TOG-2795: what the documented rollback for the live activation actually does.
 *
 * The activation card's Rollback section, and the runbook derived from it, name
 * two levers. Neither had an integration test, and both behave differently from
 * how the prose reads:
 *
 *   - `TWO_ONBOARDING_DRY_RUN=1` does not stop a session welcome. That is
 *     already covered by e2e.session's dry-run test; it is asserted again here
 *     only so the three levers can be compared in one place.
 *   - `TWO_ONBOARDING_MODE=legacy` is not a kill switch at all. On the live env
 *     shape - where DISCORD_ANCHOR_WELCOME_CHANNEL_ID is set - it *re-arms* the
 *     role-writing half of onboarding that session mode exists to remove.
 *
 * The lever that does stop a welcome without re-arming a role write is clearing
 * DISCORD_LANDING_CHANNEL_IDS while staying in session mode. That is the one
 * the runbook must name, and it is the first test below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockDiscord, type MockDiscord } from '../tools/mock-discord/server.ts';
import {
  LOOKING_TO_PLAY_CHANNEL_ID,
  LOBBY_VOICE_CHANNEL_ID,
} from '../src/onboarding/session.ts';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';

const ROOT = resolve(import.meta.dirname, '..');
const NEWBIE = '900000000000008888';

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

let harnessSeq = 0;

interface Harness {
  mock: MockDiscord;
  bot: ChildProcess;
  botLog: string[];
}

/**
 * The live production env shape, not a minimal one. The anchor channel being
 * set is the whole point: it is what makes `MODE=legacy` select a role-writing
 * branch rather than the "onboarding_disabled" one people assume.
 */
async function startHarness(
  t: { after: (fn: () => Promise<void>) => void },
  extraEnv: Record<string, string> = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'two-rollback-e2e-'));
  const mock = await startMockDiscord({});

  harnessSeq++;
  const harness: TestDb = await openTestDb(`${import.meta.filename}_${harnessSeq}`);

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
      DISCORD_GOODBYE_CHANNEL_IDS: '',
      DISCORD_ANCHOR_WELCOME_CHANNEL_ID: mock.textChannelId,
      DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID: LOOKING_TO_PLAY_CHANNEL_ID,
      DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID: LOBBY_VOICE_CHANNEL_ID,
      TWO_ONBOARDING_MODE: 'session',
      TWO_ONBOARDING_DRY_RUN: '0',
      TWO_SELF_ROLE_PANELS: '',
      TWO_INTERNAL_ACTIONS: '1',
      TWO_INTERNAL_BIND_HOST: '127.0.0.1',
      TWO_INTERNAL_KEYS: 'web-test:L77XPGxDg_9l-DDqZP13czX8H0NPAzdEJqHVvuyiocE',
      TWO_DATABASE_URL: TEST_PG_URL,
      PGOPTIONS: `-c search_path=${harness.schema}`,
      ...extraEnv,
      LOG_LEVEL: 'debug',
    },
  });
  bot.stdout?.on('data', (d) => botLog.push(String(d)));
  bot.stderr?.on('data', (d) => botLog.push(String(d)));

  t.after(async () => {
    bot.kill('SIGKILL');
    await mock.close();
    await harness.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  try {
    await mock.waitForReady();
  } catch {
    throw new Error(`bot never connected.\n--- bot output ---\n${botLog.join('')}`);
  }
  await sleep(400);
  return { mock, bot, botLog };
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

/** Both wire shapes of a member-role write - see e2e.session for why bulk PATCH matters. */
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

/** The one boot line that says which role-writing verbs the HTTP listener accepts. */
function internalActions(botLog: string[]): string[] {
  const line = botLog
    .join('')
    .split('\n')
    .find((l) => l.includes('"msg":"internal_actions_listening"'));
  assert.ok(line, `no internal_actions_listening boot line.\n${botLog.join('')}`);
  return (JSON.parse(line!) as { enabled: string[] }).enabled;
}

test(
  'clearing DISCORD_LANDING_CHANNEL_IDS stops the welcome and writes no roles - the real kill switch',
  { timeout: 90_000 },
  async (t) => {
    const { mock, botLog } = await startHarness(t, { DISCORD_LANDING_CHANNEL_IDS: '' });

    // Still session mode: the roleless guarantee is structural, not a flag.
    await waitFor(
      () => (botLog.join('').includes('"msg":"session_onboarding_enabled"') ? true : undefined),
      'session_onboarding_enabled boot line',
    );
    assert.doesNotMatch(botLog.join(''), /"msg":"anchor_welcome_enabled"/);
    assert.doesNotMatch(botLog.join(''), /"msg":"onboarding_enabled"/);
    assert.deepEqual(
      internalActions(botLog).sort(),
      ['announcement.post', 'event.upsert'],
      'session mode must keep role.assign off the internal listener',
    );

    mock.memberJoinPending(NEWBIE, 'newbie');
    mock.memberAcceptRules(NEWBIE, 'newbie');

    // The refusal is logged, which is what makes the kill switch observable
    // rather than silent.
    await waitFor(
      () => (botLog.join('').includes('"msg":"session_welcome_no_channel"') ? true : undefined),
      `session_welcome_no_channel.\n${botLog.join('')}`,
    );
    await sleep(800);

    assert.equal(
      postedMessages(mock).length,
      0,
      `nothing may be posted with no landing channel. Saw: ${JSON.stringify(postedMessages(mock))}`,
    );
    assert.equal(roleWrites(mock).length, 0, 'and still no role write');
  },
);

test(
  'TWO_ONBOARDING_DRY_RUN=1 does NOT stop a session welcome - it is not a kill switch',
  { timeout: 90_000 },
  async (t) => {
    const { mock, botLog } = await startHarness(t, { TWO_ONBOARDING_DRY_RUN: '1' });

    await waitFor(
      () => (botLog.join('').includes('"msg":"session_onboarding_enabled"') ? true : undefined),
      'session_onboarding_enabled boot line',
    );

    mock.memberJoinPending(NEWBIE, 'newbie');
    mock.memberAcceptRules(NEWBIE, 'newbie');

    const welcome = await waitFor(
      () => postedMessages(mock).find((p) => p.content.includes(`<@${NEWBIE}>`)),
      `dry run still posts a welcome.\n${botLog.join('')}`,
    );
    assert.match(welcome.content, /what do you want to do right now/i);
    assert.match(botLog.join(''), /"msg":"session_welcome_dry_run"/);
    // It is safe in the only way that matters, which is why it is a mitigation
    // and not a stop: it still writes no roles.
    assert.equal(roleWrites(mock).length, 0, 'dry-run session mode writes no roles');
  },
);

test(
  'TWO_ONBOARDING_MODE=legacy re-arms the role-writing surface even at DRY_RUN=1',
  { timeout: 90_000 },
  async (t) => {
    const { mock, botLog } = await startHarness(t, {
      TWO_ONBOARDING_MODE: 'legacy',
      TWO_ONBOARDING_DRY_RUN: '1',
    });

    // The session handler is gone and the anchor branch owns the gate-clear
    // moment, because DISCORD_ANCHOR_WELCOME_CHANNEL_ID is set in production.
    await waitFor(
      () => (botLog.join('').includes('"msg":"anchor_welcome_enabled"') ? true : undefined),
      `anchor_welcome_enabled boot line.\n${botLog.join('')}`,
    );
    assert.doesNotMatch(botLog.join(''), /"msg":"session_onboarding_enabled"/);

    // The regression this test exists for: the HTTP listener accepts role.assign
    // again. TWO_ONBOARDING_DRY_RUN does not gate this - nothing does except the
    // mode.
    assert.ok(
      internalActions(botLog).includes('role.assign'),
      `legacy mode re-enables role.assign on the internal listener, got ${JSON.stringify(
        internalActions(botLog),
      )}`,
    );

    // Dry run does still suppress the anchor post and the picker's own writes,
    // so the damage is the re-armed surface, not an immediate mutation.
    mock.memberJoinPending(NEWBIE, 'newbie');
    mock.memberAcceptRules(NEWBIE, 'newbie');
    await sleep(1500);
    assert.equal(roleWrites(mock).length, 0, 'dry run still blocks the picker role write');
  },
);
