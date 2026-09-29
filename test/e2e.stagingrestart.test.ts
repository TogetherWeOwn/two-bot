/** Local mock-Discord containment evidence for TOG-3903, NOT staging or T1 execution.
 *
 * Proves the staging-restart containment boundary (src/index.ts +
 * src/staging/restartContainment.ts) without touching staging: the process
 * boots with the real rota observer/classifier/scheduler wired, notice
 * delivery is stopped before its first sweep, and every unrelated Discord
 * writer (command registry, welcomes/goodbyes/picker, interactions, jobs,
 * invite reads, audit sends) stays unregistered or contained. Only explicitly
 * allowlisted synthetic actors persist ordinary funnel rows; unknown actors
 * and wrong-guild input are dropped before the observer.
 *
 * Local mock/injected evidence ONLY. No fake successful mutation, no altered
 * observer/scheduler, no promptShown expectation (no welcome is ever sent).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { startMockDiscord, type MockDiscord } from '../tools/mock-discord/server.ts';
import { isAllowedTestDatabaseUrl } from '../scripts/test-db-guard.ts';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';
import { buildRestartEnvironment } from '../src/staging/restartPreparation.ts';

// Refuse before openTestDb can create/drop a schema, not merely at bot boot.
// TOG-9656: any isolated test host (agent-testdb, loopback, CI service), never
// production/staging — see scripts/test-db-guard.ts.
const databaseUrl = new URL(TEST_PG_URL);
assert.equal(isAllowedTestDatabaseUrl(TEST_PG_URL), true, 'staging-restart harness requires a disposable isolated test database');
assert.ok(databaseUrl.port, 'explicit disposable Postgres port required');
assert.equal(databaseUrl.search, '', 'no connection option injection');
assert.match(
  databaseUrl.pathname,
  /staging|test/i,
  'containment preflight requires a staging/test database name',
);
const ROOT = resolve(import.meta.dirname, '..');
// Effective staging token shape: base64(STAGING_BOT_APPLICATION_ID) plus two
// dot-separated segments. Only the first segment is ever parsed (spec.ts
// applicationIdFromToken); the secret-looking tail is fixture-shaped, inert,
// and never leaves loopback.
const STAGING_TOKEN =
  `${Buffer.from(STAGING_BOT_APPLICATION_ID).toString('base64')}.Gxxxxx.yyyyyyyyyy`;
assert.equal(
  STAGING_BOT_APPLICATION_ID,
  '1469137636663758888',
  'staging application binding drifted; fix the test, not the spec',
);
// Distinct fake staging URL: valid postgres shape, a target that can never
// equal the disposable harness database. Never dialed (preflight parses only);
// the egress guard permits just the mock API and TWO_DATABASE_URL ports.
const STAGING_DECOY_URL = 'postgres://127.0.0.1:1/staging_restart_decoy';
assert.notEqual(STAGING_DECOY_URL, TEST_PG_URL, 'decoy staging URL must differ from the harness database');
const SYNTHETIC = '1545644954272137311';
const SYNTHETIC_ACTORS = [SYNTHETIC, '1545644954272137312', '1545644954272137313'];
const UNBOUND = '1545644954272137322';
const WRONG_GUILD = '111111111111111111';
const PRIMARY = '1545644954272137333';
const READERS = '1545644954272137344,1545644954272137355';
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

function environment(mock: MockDiscord, db: TestDb, mode: Mode): NodeJS.ProcessEnv {
  // This opt-in test URL must identify a disposable local database. Never use
  // TWO_DATABASE_URL from the invoking shell or inherit its env/secret files.
  const env = buildRestartEnvironment({
    mode,
    discordToken: STAGING_TOKEN,
    databaseUrl: TEST_PG_URL,
    stagingDatabaseUrl: STAGING_DECOY_URL,
    schema: db.schema,
    syntheticActorIds: SYNTHETIC_ACTORS.join(','),
    textChannelId: mock.textChannelId,
    voiceChannelId: mock.voiceChannelId,
    // Master-off ignores stale rota dependencies, not independent safety gates.
    pseudonymKey: mode === 'master-off' ? 'bad' : 'synthetic-local-rota-key-not-a-secret-3878',
    primaryActorId: mode === 'master-off' ? 'bad' : PRIMARY,
    readerIds: mode === 'master-off' ? 'bad,bad' : READERS,
    noticeChannelId: mode === 'master-off' ? 'bad' : mock.textChannelId,
  });
  // Fixture-only override behind rotaProcessGuard, never a launcher input.
  return { ...env, DISCORD_API_BASE: mock.apiBase, LOG_LEVEL: 'debug' };
}

async function launch(db: TestDb, mode: Mode) {
  const mock = await startMockDiscord({ guildId: TWO_STAGING_GUILD_ID });
  const env = environment(mock, db, mode);
  const args = ['--require', './test/helpers/rotaProcessGuard.cjs',
    '--import', './test/helpers/rotaProcessWitness.ts',
    '--import', './test/helpers/stagingRestartRestProbe.ts', 'src/index.ts'];
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
  let restProbe: { refused: number; sdkRefused: string[] } | undefined;
  bot.on('message', (message: Witness | { kind: 'egress-refused' } |
    { kind: 'rest-probe'; refused: number; sdkRefused: string[] }) => {
    if (message.kind === 'egress-refused') refused++;
    else if (message.kind === 'witness') snapshots.set(message.id, message);
    else if (message.kind === 'rest-probe') restProbe = message;
  });
  const exited = new Promise<void>((res) => bot.once('close', () => res()));
  const running = () => {
    assert.ifError(spawnError);
    assert.equal(bot.exitCode, null, `bot exited early\n${log}`);
    assert.equal(bot.signalCode, null, `bot signalled early\n${log}`);
  };
  const snapshot = async () => {
    running();
    await until(() => { running(); return restProbe !== undefined; }, 'installed REST transport probe');
    assert.equal(restProbe!.refused, 8, 'all forbidden requests must refuse at the real entrypoint REST boundary');
    assert.deepEqual(restProbe!.sdkRefused, [
      'global-command-set', 'guild-command-set', 'designated-channel-send', 'unrelated-channel-send',
    ], 'public SDK writes must reject, not silently omit or fabricate success');
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
    assert.equal(bot.exitCode, 0, `child shutdown must be clean\n${log}`);
    assert.throws(() => process.kill(bot.pid!, 0), { code: 'ESRCH' }, 'no leaked child process');
  };
  return { mock, bot, snapshot, close, exited, running, output: () => log, refusals: () => refused };
}

function assertContainedObserver(witness: Witness) {
  for (const method of ['observer.join', 'observer.gateCleared', 'observer.message',
    'core.rulesAccepted', 'core.message']) {
    assert.ok(witness.completed[method] > 0, `missing completed contained observation: ${method}`);
  }
  // No welcome is ever sent under containment, so promptShown must never
  // complete on either the observer or the core. Assert the negative; a
  // fabricated promptShown observation would fail here, not pass silently.
  assert.equal(witness.completed['observer.promptShown'] ?? 0, 0, 'welcome never sent, no promptShown observed');
  assert.equal(witness.completed['core.promptShown'] ?? 0, 0, 'welcome never sent, no promptShown recorded');
  assert.equal(witness.failures, 0);
  assert.equal(witness.classifications.eligible_human ?? 0, 0, 'staging remains excluded');
  assert.ok((witness.classifications.staging ?? 0) >= 2, 'real core must reach staging classifier');
}

async function exerciseSynthetic(harness: Awaited<ReturnType<typeof launch>>, db: TestDb, actor: string) {
  const { mock } = harness;
  // The contained boot publishes no commands, so there is no PUT /commands to
  // gate on like e2e.rotaprocess does. Wait for discord.js READY instead:
  // gateway dispatches sent before READY are dropped, not queued.
  await until(() => {
    harness.running();
    return /"msg":"ready"/.test(harness.output());
  }, `gateway ready\n${harness.output()}`);
  const before = await db.db.prepare('SELECT COUNT(*) AS n FROM events').get<{ n: string }>();
  // A different allowlisted fixture each boot prevents prior rows from
  // satisfying a wait before this boot has actually processed the gateway input.
  mock.memberJoinPending(actor, 'synthetic-member');
  await until(async () => db.db.prepare('SELECT 1 FROM events WHERE event_type = ? AND member_id = ?')
    .get('member_join', actor), `ordinary join recorded\n${harness.output()}`);
  mock.memberAcceptRules(actor, 'synthetic-member');
  await until(async () => db.db.prepare('SELECT 1 FROM events WHERE event_type = ? AND member_id = ?')
    .get('gate_cleared', actor), `ordinary gate clear recorded\n${harness.output()}`);
  mock.message(actor);
  await until(async () => db.db.prepare('SELECT 1 FROM events WHERE event_type = ? AND member_id = ?')
    .get('first_message', actor), `ordinary message rung recorded\n${harness.output()}`);
  mock.memberRemove(actor, 'synthetic-member');
  await until(async () => db.db.prepare('SELECT 1 FROM events WHERE event_type = ? AND member_id = ?')
    .get('member_leave', actor), `ordinary leave recorded\n${harness.output()}`);
  const after = await db.db.prepare('SELECT COUNT(*) AS n FROM events').get<{ n: string }>();
  assert.equal(Number(after!.n) - Number(before!.n), 4, 'this boot recorded join, gate, message and leave');
  const witness = await harness.snapshot();
  assert.doesNotMatch(harness.output(), /onboarding_rota_observation_failed|unhandled_rejection/);
  return witness;
}

async function exerciseNegative(harness: Awaited<ReturnType<typeof launch>>) {
  const { mock } = harness;
  // Old picker/session interactions: no handler is registered under
  // containment, so even the allowlisted actor triggers no write.
  mock.selectGames(SYNTHETIC, 'synthetic-member', ['shooters']);
  mock.selectSession(SYNTHETIC, 'synthetic-member', ['looking-to-play']);
  // Stale slash commands must not even receive an ephemeral disabled reply.
  for (const [index, name] of ['rank', 'command-list'].entries()) {
    mock.dispatch('INTERACTION_CREATE', {
      id: String(1545644954272137400n + BigInt(index)),
      application_id: '900000000000000002', // mock gateway bot identity
      type: 2, token: 'mock-interaction-token', version: 1,
      entitlements: [], authorizing_integration_owners: {},
      app_permissions: '0', locale: 'en-US',
      guild_id: TWO_STAGING_GUILD_ID, channel_id: mock.textChannelId,
      channel: { id: mock.textChannelId, type: 0 },
      data: { id: String(1545644954272137500n + BigInt(index)), name, type: 1, options: [] },
      member: {
        user: { id: SYNTHETIC, username: 'synthetic-member', discriminator: '0001', bot: false },
        roles: [], permissions: '32', joined_at: new Date().toISOString(),
        deaf: false, mute: false, pending: false,
      },
    });
  }
  // Unbound actor lifecycle in the staging guild: dropped pre-observer.
  mock.memberJoinPending(UNBOUND, 'unbound-member');
  mock.memberAcceptRules(UNBOUND, 'unbound-member');
  mock.message(UNBOUND);
  mock.memberRemove(UNBOUND, 'unbound-member');
  // Wrong-guild lifecycle for the allowlisted actor: dropped pre-observer.
  mock.memberJoinPending(SYNTHETIC, 'synthetic-member', WRONG_GUILD);
  mock.memberAcceptRules(SYNTHETIC, 'synthetic-member', WRONG_GUILD);
  mock.memberRemove(SYNTHETIC, 'synthetic-member', WRONG_GUILD);
  // Let the gateway deliver everything, then drain the real observer queues
  // before asserting the negative.
  await sleep(1500);
  harness.running();
  return harness.snapshot();
}

async function assertNegativeScope(db: TestDb, mock: MockDiscord) {
  // Entire isolated schema, not just expected subjects: unexpected rows fail.
  const facts = await db.db.prepare('SELECT COUNT(*) AS n FROM community_facts').get<{ n: string }>();
  assert.equal(Number(facts!.n), 0, 'zero community facts across isolated schema');
  const audit = await db.db.prepare('SELECT COUNT(*) AS n FROM operational_audit_log').get<{ n: string }>();
  assert.equal(Number(audit!.n), 0, 'zero audit rows across isolated schema');
  // No welcome rows: the only proof needed is witness promptShown zeros plus
  // zero Discord mutations below. No welcome handler is registered.
  const unboundEvents = await db.db.prepare('SELECT COUNT(*) AS n FROM events WHERE member_id = ?')
    .get<{ n: string }>(UNBOUND);
  assert.equal(Number(unboundEvents!.n), 0, 'zero rows for nonallowlisted actor');
  const unboundMembers = await db.db.prepare('SELECT COUNT(*) AS n FROM members WHERE member_id = ?')
    .get<{ n: string }>(UNBOUND);
  assert.equal(Number(unboundMembers!.n), 0, 'zero member rows for nonallowlisted actor');
  const wrongGuild = await db.db.prepare('SELECT COUNT(*) AS n FROM events WHERE guild_id = ?')
    .get<{ n: string }>(WRONG_GUILD);
  assert.equal(Number(wrongGuild!.n), 0, 'zero rows for wrong guild');
  const synthetic = await db.db.prepare('SELECT COUNT(*) AS n FROM events WHERE member_id = ?')
    .get<{ n: string }>(SYNTHETIC);
  assert.ok(Number(synthetic!.n) > 0, 'synthetic actor persisted ordinary events');
  // Only the ordinary funnel lifecycle may ever appear: no welcome, notice,
  // automation, moderation, or backfill rows from any boot.
  const types = await db.db.prepare('SELECT DISTINCT event_type AS t FROM events').all<{ t: string }>();
  const allowed = new Set(['member_join', 'gate_cleared', 'first_message', 'second_message',
    'third_message', 'member_leave']);
  for (const row of types) {
    assert.ok(allowed.has(row.t), `unexpected event type in isolated schema: ${row.t}`);
  }
  // No command registry publication, no welcome, no notice, no invite write:
  // containment performs zero Discord mutations.
  assert.equal(mock.captured.length, 0, 'zero Discord mutations under containment');
}

/** TOG-4011 capability assertions, using the TOG-3903 bound containment fixture.
 * The ordinary rota process fixture cannot boot the containment flag: its guild
 * and credential are intentionally unbound and it expects forbidden welcomes.
 * Observe the actual socket, never a constructed ClientOptions object.
 */
test('containment scopes the identify capability while the rota keeps observing', { timeout: 60_000 }, async () => {
  const db = await openTestDb(`staging_capability_${process.pid}`);
  try {
    const harness = await launch(db, 'notice-off');
    try {
      const witness = await exerciseSynthetic(harness, db, SYNTHETIC);
      assert.equal(harness.mock.identifies.length, 1, 'exactly one identify on the socket');
      const [identify] = harness.mock.identifies;
      assert.equal(identify.presenceStatus, 'invisible');
      assert.equal(identify.intents, 643);
      assert.notEqual(identify.intents, 34503);
      assert.equal(identify.intents! & 2, 2, 'GuildMembers must stay');
      for (const [name, bit] of [
        ['MessageContent', 32768], ['GuildModeration', 4],
        ['GuildInvites', 64], ['GuildMessageReactions', 1024],
      ] as const) assert.equal(identify.intents! & bit, 0, `${name} must be clear on the identify frame`);
      assertContainedObserver(witness);
      assert.match(harness.output(), /"reason":"notice off"/);
      assert.equal(witness.completed['delivery.runDue'] ?? 0, 0);
      await assertNegativeScope(db, harness.mock);
      assert.equal(harness.refusals(), 0, 'all traffic stayed on fixture endpoints');
    } finally { await harness.close(); }
    assert.doesNotMatch(harness.output(), /onboarding_rota_observation_failed|unhandled_rejection/);
  } finally { await db.cleanup(); }
});

test('staging restart containment restarts notice-on -> notice-off -> master-off with zero mutations',
  { timeout: 300_000 }, async () => {
    const db = await openTestDb(`staging_restart_${process.pid}`);
    try {
      for (const [index, mode] of (['notice-on', 'notice-off', 'master-off'] as const).entries()) {
        const harness = await launch(db, mode);
        try {
          const witness = await exerciseSynthetic(harness, db, SYNTHETIC_ACTORS[index]);
          const negative = await exerciseNegative(harness);
          assert.match(harness.output(), /staging_restart_containment_armed/);
          assert.match(harness.output(), /onboarding_disabled/);
          assert.match(harness.output(), /staging restart containment/);
          if (mode === 'master-off') {
            assert.equal(Object.keys(negative.completed).length, 0, 'master off dispatches no rota work');
            assert.match(harness.output(), /"reason":"measurement off"/);
          } else {
            assertContainedObserver(witness);
            // Negative input reaches no observer chain: the post-negative
            // snapshot adds no completions and no eligible classifications.
            // delivery.runDue is excluded: a real 60s scheduler tick may land
            // between the two snapshots, and that tick itself is asserted below.
            for (const [method, count] of Object.entries(negative.completed)) {
              if (method === 'delivery.runDue') continue;
              assert.equal(count, witness.completed[method], `disallowed input completed ${method}`);
            }
            assert.equal(negative.classifications.eligible_human ?? 0, 0);
            if (mode === 'notice-on') {
              assert.match(harness.output(), /rota_notice_delivery_contained/);
              // Observe a real default-interval sweep completing; don't call
              // the service ourselves or claim construction is scheduling
              // evidence. Delivery stays stopped, so the sweep sends nothing.
              await until(async () => (await harness.snapshot()).completed['delivery.runDue'],
                'real 60-second contained notice sweep', 75_000);
            } else {
              assert.match(harness.output(), /"reason":"notice off"/);
              assert.equal(witness.completed['delivery.runDue'] ?? 0, 0);
            }
          }
          await assertNegativeScope(db, harness.mock);
          assert.equal(harness.refusals(), 0, 'all traffic stayed on fixture endpoints');
        } finally {
          await harness.close();
        }
        assert.doesNotMatch(harness.output(), /rota_notice_\w*failed|onboarding_rota_observation_failed|unhandled_rejection/);
        await assertNegativeScope(db, harness.mock);
        const census = await db.db.prepare('SELECT COUNT(*) AS n FROM events').get<{ n: string }>();
        assert.equal(Number(census!.n), (index + 1) * 4, 'negative inputs added no ordinary event rows');
      }
      // Same owned schema survives every graceful shutdown. Check all subjects
      // and guilds, including unexpected/null identities, rather than only counts.
      const subjects = await db.db.prepare(
        'SELECT DISTINCT guild_id, member_id FROM events ORDER BY member_id',
      ).all<{ guild_id: string; member_id: string }>();
      assert.deepEqual(subjects, SYNTHETIC_ACTORS.map((member_id) => ({
        guild_id: TWO_STAGING_GUILD_ID, member_id,
      })));
      const members = await db.db.prepare(
        'SELECT guild_id, member_id FROM members ORDER BY member_id',
      ).all<{ guild_id: string; member_id: string }>();
      assert.deepEqual(members, subjects, 'only bound synthetic actors persisted member rows');
    } finally {
      await db.cleanup();
    }
  });
