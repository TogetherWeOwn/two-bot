/** Local mock-Discord process evidence, NOT staging or positive rota acceptance. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { startMockDiscord, type MockDiscord } from '../tools/mock-discord/server.ts';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';

// Refuse before openTestDb can create/drop a schema, not merely at bot boot.
const databaseUrl = new URL(TEST_PG_URL);
assert.equal(databaseUrl.hostname, '127.0.0.1', 'rota harness requires disposable loopback Postgres');
assert.ok(databaseUrl.port, 'explicit disposable Postgres port required');
assert.equal(databaseUrl.search, '', 'no connection option injection');
const ROOT = resolve(import.meta.dirname, '..');
const GUILD = '900000000000007000';
const PRIMARY = '900000000000007001';
const READERS = `${PRIMARY},900000000000007002,900000000000007003`;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
type Mode = 'notice-on' | 'notice-off' | 'master-off';
interface Witness {
  kind: 'witness';
  id: number;
  completed: Record<string, number>;
  classifications: Record<string, number>;
  failures: number;
}

async function until<T>(read: () => T | Promise<T>, what: string, timeout = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await sleep(50);
  }
  throw new Error(`timed out: ${what}`);
}

/**
 * Identify capability of the connection `src/index.ts` actually opens, by
 * intent name. Pinned as literals so a rename cannot move the boundary.
 */
const MAIN_INTENT_BITS = 34503;
const REDUCED_INTENT_BITS = 643;
const MESSAGE_CONTENT_BIT = 32768;
const GUILD_MODERATION_BIT = 4;
const GUILD_INVITES_BIT = 64;
const GUILD_MESSAGE_REACTIONS_BIT = 1024;
const GUILD_MEMBERS_BIT = 2;

function environment(mock: MockDiscord, db: TestDb, mode: Mode): NodeJS.ProcessEnv {
  // This opt-in test URL must identify a disposable local database. Never use
  // TWO_DATABASE_URL from the invoking shell or inherit its env/secret files.
  return {
    DISCORD_TOKEN: 'mock-token',
    DISCORD_API_BASE: mock.apiBase,
    DISCORD_GUILD_ID: GUILD,
    DISCORD_STAGING_GUILD_ID: GUILD,
    DISCORD_LANDING_CHANNEL_IDS: mock.textChannelId,
    DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID: mock.textChannelId,
    DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID: mock.voiceChannelId,
    TWO_ONBOARDING_MODE: 'session',
    TWO_COMMUNITY_HUMAN_CHANNEL_IDS: mock.textChannelId,
    TWO_COMMUNITY_STAGING_GUILD_IDS: GUILD,
    TWO_ONBOARDING_ROTA_MEASUREMENT: mode === 'master-off' ? '0' : '1',
    TWO_ONBOARDING_ROTA_NOTICE: mode === 'notice-off' ? '0' : '1',
    TWO_ONBOARDING_ROTA_PSEUDONYM_KEY: mode === 'master-off' ? 'bad' : 'synthetic-local-rota-key-not-a-secret-3878',
    TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID: mode === 'master-off' ? 'bad' : PRIMARY,
    TWO_ONBOARDING_ROTA_READER_IDS: mode === 'master-off' ? 'bad,bad' : READERS,
    DISCORD_STAFF_ALERT_CHANNEL_ID: mode === 'master-off' ? 'bad' : mock.textChannelId,
    TWO_DATABASE_URL: TEST_PG_URL,
    PGOPTIONS: `-c search_path=${db.schema}`,
    LOG_LEVEL: 'debug',
  };
}

async function launch(db: TestDb, mode: Mode, mutation = false, wrongGuild = false, containment?: string) {
  const mock = await startMockDiscord({ guildId: GUILD });
  const env = environment(mock, db, mode);
  if (wrongGuild) env.DISCORD_STAGING_GUILD_ID = '900000000000007999';
  if (containment !== undefined) env.TWO_STAGING_RESTART_CONTAINMENT = containment;
  const args = ['--require', './test/helpers/rotaProcessGuard.cjs'];
  if (mutation) args.push('--import', './test/helpers/rotaNoDispatchMutation.ts');
  args.push('--import', './test/helpers/rotaProcessWitness.ts', 'src/index.ts');
  let bot: ChildProcess;
  try {
    bot = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  } catch (error) {
    await mock.close();
    throw error;
  }
  let log = '';
  let refused = 0;
  let spawnError: Error | undefined;
  const snapshots = new Map<number, Witness>();
  let sequence = 0;
  bot.stdout!.on('data', (data) => { log += String(data); });
  bot.stderr!.on('data', (data) => { log += String(data); });
  bot.on('error', (error) => { spawnError = error; });
  bot.on('message', (message: Witness | { kind: 'egress-refused' }) => {
    if (message.kind === 'egress-refused') refused++;
    else if (message.kind === 'witness') snapshots.set(message.id, message);
  });
  const exited = new Promise<void>((res) => bot.once('close', () => res()));
  const running = () => {
    assert.ifError(spawnError);
    assert.equal(bot.exitCode, null, `bot exited early\n${log}`);
    assert.equal(bot.signalCode, null, `bot signalled early\n${log}`);
  };
  const snapshot = async () => {
    running();
    const id = ++sequence;
    bot.send({ command: 'snapshot', id });
    const result = await until(() => { running(); return snapshots.get(id); }, 'observer queue snapshot')
      .catch((error) => { throw new Error(`${String(error)}\n${log}`); });
    snapshots.delete(id);
    return result;
  };
  const close = async () => {
    if (bot.exitCode === null && bot.signalCode === null) bot.kill('SIGTERM');
    let forced = false;
    const timer = setTimeout(() => { forced = true; bot.kill('SIGKILL'); }, 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      await mock.close();
    }
    assert.equal(forced, false, `child required SIGKILL\n${log}`);
    if (!wrongGuild) assert.equal(bot.exitCode, 0, `child shutdown must be clean\n${log}`);
    assert.throws(() => process.kill(bot.pid!, 0), { code: 'ESRCH' }, 'no leaked child process');
  };
  return { mock, bot, snapshot, close, exited, running, output: () => log, refusals: () => refused };
}

function assertObserver(witness: Witness) {
  for (const method of ['observer.join', 'observer.gateCleared', 'observer.promptShown', 'observer.message',
    'core.rulesAccepted', 'core.promptShown', 'core.message']) {
    assert.ok(witness.completed[method] > 0, `missing completed rota consumption: ${method}`);
  }
  assert.equal(witness.failures, 0);
  assert.ok(witness.classifications.staging >= 3, 'real core must reach staging classifier');
  assert.equal(witness.classifications.eligible_human ?? 0, 0, 'staging remains excluded');
}

async function exercise(harness: Awaited<ReturnType<typeof launch>>, db: TestDb, member: string) {
  const { mock } = harness;
  await until(() => {
    harness.running();
    return mock.captured.find((r) => r.method === 'PUT' && /\/commands$/.test(r.url));
  }, `command publication\n${harness.output()}`);
  mock.memberJoinPending(member, 'synthetic-member');
  await until(async () => db.db.prepare('SELECT 1 FROM events WHERE event_type = ? AND member_id = ?')
    .get('member_join', member), 'ordinary join recorded');
  mock.memberAcceptRules(member, 'synthetic-member');
  await until(() => mock.captured.find((r) => r.method === 'POST' && /\/messages$/.test(r.url)), 'accepted roleless welcome');
  mock.message(member);
  await until(async () => db.db.prepare('SELECT 1 FROM events WHERE event_type = ? AND member_id = ?')
    .get('first_message', member), 'ordinary first message recorded');
  const witness = await harness.snapshot();
  assert.doesNotMatch(harness.output(), /onboarding_rota_observation_failed|unhandled_rejection/);
  return witness;
}

async function assertNegativeScope(db: TestDb, mock: MockDiscord, member: string) {
  // Entire isolated schema, not just expected subjects: unexpected rows fail.
  const facts = await db.db.prepare('SELECT COUNT(*) AS n FROM community_facts').get<{ n: string }>();
  assert.equal(Number(facts!.n), 0, 'zero community facts across isolated schema');
  const notices = await db.db.prepare("SELECT COUNT(*) AS n FROM operational_audit_log WHERE event_kind = 'rota_notice'")
    .get<{ n: string }>();
  assert.equal(Number(notices!.n), 0, 'zero rota notice audit rows across isolated schema');
  const posts = mock.captured.filter((r) => r.method === 'POST' && /\/messages$/.test(r.url));
  assert.equal(posts.length, 1, 'only one ordinary welcome, never a rota notice');
  assert.match((posts[0].body as { content: string }).content, new RegExp(`<@${member}>`));
  assert.match((posts[0].body as { content: string }).content, /what do you want to do right now/i);
  for (const request of mock.captured) {
    const publication = request.method === 'PUT' &&
      request.url === `/api/v10/applications/900000000000000002/guilds/${GUILD}/commands`;
    const welcome = request.method === 'POST' && request.url === `/api/v10/channels/${mock.textChannelId}/messages`;
    assert.ok(publication || welcome, `unexpected mutation: ${request.method} ${request.url}`);
  }
}

test('real rota process restarts notice-on → notice-off → master-off, preserving staging exclusion',
  { timeout: 150_000 }, async () => {
    const db = await openTestDb(`rota_process_${process.pid}`);
    try {
      let i = 0;
      for (const mode of ['notice-on', 'notice-off', 'master-off'] as const) {
        const member = `90000000000000701${++i}`;
        const harness = await launch(db, mode);
        try {
          const witness = await exercise(harness, db, member);
          const published = harness.mock.captured.filter((r) => r.method === 'PUT' && /\/commands$/.test(r.url));
          assert.equal(published.length, 1, 'single command registry writer');
          const names = (published[0].body as { name: string }[]).map((command) => command.name);
          assert.equal(names.includes('rota-acknowledge'), mode !== 'master-off', 'ack publication follows master, not notice flag');
          if (mode === 'master-off') {
            assert.equal(Object.keys(witness.completed).length, 0, 'master off dispatches no rota work');
            assert.match(harness.output(), /"reason":"measurement off"/);
          } else {
            assertObserver(witness);
            if (mode === 'notice-on') {
              assert.match(harness.output(), /"msg":"rota_notice_delivery_enabled"/);
              // Observe a real default-interval sweep completing; don't call the
              // service ourselves or claim construction is scheduling evidence.
              await until(async () => (await harness.snapshot()).completed['delivery.runDue'], 'real 60-second notice sweep', 75_000);
            } else {
              assert.match(harness.output(), /"reason":"notice off"/);
              assert.equal(witness.completed['delivery.runDue'] ?? 0, 0);
            }
          }
          await assertNegativeScope(db, harness.mock, member);
          assert.equal(harness.refusals(), 0, 'all traffic stayed on fixture endpoints');
        } finally {
          await harness.close();
        }
        assert.doesNotMatch(harness.output(), /rota_notice_\w*failed|onboarding_rota_observation_failed|unhandled_rejection/);
        await assertNegativeScope(db, harness.mock, member);
        // Same schema survives each graceful shutdown; ordinary accepted
        // onboarding is intact even while rota measurement is fully off.
        const baseline = await db.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type IN ('member_join', 'first_message')")
          .get<{ n: string }>();
        assert.equal(Number(baseline!.n), i * 2);
      }
    } finally {
      await db.cleanup();
    }
  });

test('wrong staging guild binding refuses real boot before database or Discord use', { timeout: 30_000 }, async () => {
  const db = await openTestDb(`rota_wrong_guild_${process.pid}`);
  try {
    const harness = await launch(db, 'notice-off', false, true);
    try {
      await until(() => harness.bot.exitCode !== null, 'wrong binding stops boot');
      await harness.exited;
      assert.notEqual(harness.bot.exitCode, 0);
      assert.match(harness.output(), /Onboarding rota is staging-only/);
      assert.doesNotMatch(harness.output(), /datastore_open/);
      assert.equal(harness.mock.captured.length, 0);
    } finally { await harness.close(); }
  } finally { await db.cleanup(); }
});

/**
 * TOG-4011. The capability a contained restart asks Discord for, read off the
 * real Identify frame the real process sent over a real socket - not off the
 * constructed options, which is the assertion that would not have caught a
 * broken presence chain in discord.js.
 *
 * `identifies` is the fixture's capability census: intents and presence status
 * only. The token on that frame is never retained.
 */
test('containment scopes the identify capability while the rota keeps observing', { timeout: 60_000 }, async () => {
  const db = await openTestDb(`rota_capability_${process.pid}`);
  try {
    const harness = await launch(db, 'notice-off', false, false, '1');
    try {
      const member = '900000000000007030';
      const witness = await exercise(harness, db, member);

      assert.equal(harness.mock.identifies.length, 1, 'exactly one identify on the socket');
      const [identify] = harness.mock.identifies;

      // Criterion 1: presence, and only the status field.
      assert.equal(identify.presenceStatus, 'invisible');

      // Criterion 2: the number, not a comment.
      assert.equal(identify.intents, REDUCED_INTENT_BITS);
      assert.notEqual(identify.intents, MAIN_INTENT_BITS);
      assert.equal(identify.intents! & GUILD_MEMBERS_BIT, GUILD_MEMBERS_BIT, 'GuildMembers must stay');
      for (const [name, bit] of [
        ['MessageContent', MESSAGE_CONTENT_BIT],
        ['GuildModeration', GUILD_MODERATION_BIT],
        ['GuildInvites', GUILD_INVITES_BIT],
        ['GuildMessageReactions', GUILD_MESSAGE_REACTIONS_BIT],
      ] as const) {
        assert.equal(identify.intents! & bit, 0, `${name} must be clear on the identify frame`);
      }

      // Criterion 4: the rota observer and the scheduler are still registered
      // and their events still fire - a narrower connection is not a quieter
      // measurement. Nothing is swallowed on the way.
      assertObserver(witness);
      assert.match(harness.output(), /"reason":"notice off"/);
      assert.equal(witness.completed['delivery.runDue'] ?? 0, 0);
      await assertNegativeScope(db, harness.mock, member);
      assert.equal(harness.refusals(), 0, 'all traffic stayed on fixture endpoints');
    } finally {
      await harness.close();
    }
    assert.doesNotMatch(harness.output(), /onboarding_rota_observation_failed|unhandled_rejection/);
  } finally {
    await db.cleanup();
  }
});

/**
 * The negative half. Without this the invisible/643 assertions above could be
 * passing for any reason at all - including the fixture reading a field that
 * was always there.
 */
test('without the exact flag the identify capability is unchanged from production', { timeout: 60_000 }, async () => {
  const db = await openTestDb(`rota_capability_off_${process.pid}`);
  try {
    // 'true' is the value most likely to be set by mistake. It must be inert.
    for (const [label, flag] of [['absent', undefined], ['"true"', 'true']] as const) {
      const harness = await launch(db, 'notice-off', false, false, flag);
      try {
        await until(() => {
          harness.running();
          return harness.mock.identifies.length > 0;
        }, `identify with the flag ${label}\n${harness.output()}`);
        const [identify] = harness.mock.identifies;
        assert.equal(identify.intents, MAIN_INTENT_BITS, `flag ${label} changed the intents`);
        assert.equal(identify.presenceStatus, 'online', `flag ${label} changed the presence`);
      } finally {
        await harness.close();
      }
    }
  } finally {
    await db.cleanup();
  }
});

/**
 * Criterion 4's other half: a refusal under containment fails loudly. The
 * staging-guild binding check is the refusal the rota already has; the flag
 * must not turn it into a silent drop or a fabricated success.
 */
test('a refusal under containment still exits nonzero before any Discord use', { timeout: 30_000 }, async () => {
  const db = await openTestDb(`rota_capability_refuse_${process.pid}`);
  try {
    const harness = await launch(db, 'notice-off', false, true, '1');
    try {
      await until(() => harness.bot.exitCode !== null, 'contained wrong binding stops boot');
      await harness.exited;
      assert.notEqual(harness.bot.exitCode, 0, 'a refusal must exit nonzero');
      assert.match(harness.output(), /Onboarding rota is staging-only/);
      assert.doesNotMatch(harness.output(), /datastore_open/);
      assert.equal(harness.mock.captured.length, 0);
      // Refused before login, so the scoped connection was never opened either.
      assert.equal(harness.mock.identifies.length, 0);
    } finally { await harness.close(); }
  } finally { await db.cleanup(); }
});

test('observer witness rejects dormant message dispatch despite green baseline funnel and zero facts', { timeout: 40_000 }, async () => {
  const db = await openTestDb(`rota_mutation_${process.pid}`);
  try {
    const harness = await launch(db, 'notice-off', true);
    try {
      const member = '900000000000007020';
      const witness = await exercise(harness, db, member);
      assert.match(harness.output(), /rota_test_mutation_applied/);
      await assertNegativeScope(db, harness.mock, member);
      assert.throws(() => assertObserver(witness), /missing completed rota consumption: observer.message/);
      assert.equal(witness.completed['observer.message'] ?? 0, 0);
    } finally { await harness.close(); }
  } finally { await db.cleanup(); }
});
