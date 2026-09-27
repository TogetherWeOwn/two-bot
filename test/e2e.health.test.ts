/**
 * End-to-end: the container health endpoint on the real bot process (TOG-13).
 *
 * unit.health.test.ts proves the handler's logic against fake probes. This
 * proves the thing that actually breaks a deploy: that src/index.ts wires the
 * real gateway and the real database into those probes, that TWO_HEALTH_PORT
 * turns it on, and that its absence leaves the bot with no open port at all.
 *
 * The bot under test is unmodified src/index.ts, connected to the mock gateway
 * exactly as e2e.funnel.test.ts does it. Without this test the Dockerfile's
 * HEALTHCHECK and the compose deploy gate are both unverified claims - and a
 * health check that never passes fails the deploy rather than the test suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockDiscord } from '../tools/mock-discord/server.ts';
import { openTestDb } from './helpers/testDb.ts';

const ROOT = resolve(import.meta.dirname, '..');
let harnessSequence = 0;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A port nobody is listening on, obtained by binding and immediately releasing. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/**
 * A port nobody is listening on RIGHT NOW, not just at release time.
 *
 * `freePort()` releases before returning, and this suite runs alongside
 * dozens of sibling files that all call `listen(0)` (mock Discord, internal
 * actions, health servers under test). Between the release and the bot's
 * bind, a sibling can claim the port - and a squatter that answers HTTP 200
 * (tools/mock-discord's GET fallback `json({})`) makes `/healthz` resolve
 * with `'{}'` instead of `'ok'`, or makes a must-refuse fetch succeed.
 * That is exactly the red-main signature of TOG-6137 (runs 36290702929,
 * 36291840893, 36295999723: `'{}' !== 'ok'` at line 111).
 *
 * So: take a free port, then fetch it. A refusal proves it is still free;
 * a success means a sibling grabbed it in the gap, and we draw again.
 * Bounded: three draws, then the last port stands and the test's own
 * assertions decide. This does not close the gap, it re-checks it - the
 * gap is inherent to bind-release-rebind across processes.
 */
async function unclaimedPort(attempts = 3): Promise<number> {
  let port = await freePort();
  for (let i = 1; i < attempts; i++) {
    const squatted = await fetch(`http://127.0.0.1:${port}/healthz`).then(
      () => true,
      () => false,
    );
    if (!squatted) return port;
    port = await freePort();
  }
  return port;
}

/**
 * Poll until `fn` resolves truthy. The bot needs a moment to open the socket.
 *
 * Returns NonNullable<T>: callers signal "not yet" by resolving null, and the
 * only way out of the loop is a truthy value, so narrowing it here saves every
 * call site a non-null assertion.
 */
async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err; // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`timed out; last error: ${String(last)}`);
}

test('health endpoints answer on the real bot process', { timeout: 120_000 }, async (t) => {
  const mock = await startMockDiscord();
  let bot: ChildProcess | null = null;
  const botLog: string[] = [];

  const harness = await openTestDb(`${import.meta.filename}_${++harnessSequence}`);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  const botDbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };

  t.after(async () => {
    bot?.kill('SIGKILL');
    await mock.close();
    await harness.cleanup();
  });

  // Returns the child (rather than assigning the outer `bot`) so narrowing
  // follows the assignment: an outer assignment hidden in a closure would
  // leave `bot` narrowed to `null` past this point.
  const spawnBot = (port: number): ChildProcess => {
    botLog.length = 0;
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DISCORD_TOKEN: 'mock.token.value',
        DISCORD_API_BASE: mock.apiBase,
        DISCORD_GUILD_ID: mock.guildId,
        ...botDbEnv,
        // The variable the container image sets. Bound to loopback here so the
        // test never opens a port off the machine running it.
        TWO_HEALTH_PORT: String(port),
        TWO_HEALTH_BIND_HOST: '127.0.0.1',
        LOG_LEVEL: 'debug',
      },
    });
    child.stdout?.on('data', (d) => botLog.push(String(d)));
    child.stderr?.on('data', (d) => botLog.push(String(d)));
    child.on('exit', (code) => botLog.push(`__bot exited with ${code}__`));
    return child;
  };

  // A sibling suite can claim the port between freePort()'s release and the
  // bot's bind (TOG-6137). The squatter answers `/healthz` itself - the mock
  // fallback's `'{}'` - while the bot dies on EADDRINUSE. A wrong body or an
  // addr-in-use line therefore means "draw again", not "the bot is broken".
  // The body check is exact: our health server only ever sends `ok` here.
  let port = 0;
  let live: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    bot?.kill('SIGKILL');
    port = await unclaimedPort();
    bot = spawnBot(port);
    const url = `http://127.0.0.1:${port}/healthz`;
    live = await waitFor(
      async () => {
        const res = await fetch(url);
        return res.ok ? res : null;
      },
      25_000,
    ).catch(() => null);
    if (live) {
      if ((await live.text()).trim() === 'ok') break;
      live = null; // squatter answered; draw again
    }
    if (attempt === 3) {
      throw new Error(
        `health server never answered 'ok' after 3 ports\n--- bot output ---\n${botLog.join('')}`,
      );
    }
  }

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;

  // Liveness comes up first and does not wait for the gateway - that ordering
  // is the entire reason index.ts starts health before client.login.
  assert.ok(live, 'unreachable: the retry loop above either breaks with ok or throws');
  assert.equal(live.status, 200);

  await mock.waitForReady().catch((err) => {
    throw new Error(`${String(err)}\n--- bot output ---\n${botLog.join('')}`);
  });

  // Readiness needs the gateway session AND a database that answers. This is
  // the check Coolify gates the deploy on, so it has to go green against the
  // real wiring, not a stub.
  const ready = await waitFor(async () => {
    const res = await fetch(url('/readyz'));
    return res.status === 200 ? res : null;
  }).catch((e) => {
    throw new Error(`${String(e)}\n--- bot output ---\n${botLog.join('')}`);
  });
  assert.equal((await ready.text()).trim(), 'ok');

  assert.equal((await fetch(url('/nope'))).status, 404);

  // SIGTERM is what a container stop sends. The bot must close the port rather
  // than be killed holding it - otherwise a redeploy's new container races the
  // old one for the port and the deploy fails intermittently.
  const stopping = bot;
  assert.ok(stopping, 'unreachable: the retry loop above either breaks with a bot or throws');
  stopping.kill('SIGTERM');
  const exited = await waitFor(async () => (stopping.exitCode !== null ? true : null), 25_000).catch(
    () => false,
  );
  assert.ok(exited, `bot did not exit on SIGTERM\n--- bot output ---\n${botLog.join('')}`);
  await assert.rejects(fetch(url('/healthz')), 'port should be released after shutdown');
});

test('no health port means no listener at all', { timeout: 120_000 }, async (t) => {
  // The systemd deployment in deploy/ must keep working exactly as before, and
  // "exactly as before" means the bot opens no port unless asked.
  const mock = await startMockDiscord();
  let bot: ChildProcess | null = null;
  const botLog: string[] = [];

  const harness = await openTestDb(`${import.meta.filename}_${++harnessSequence}`);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  const botDbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };

  t.after(async () => {
    bot?.kill('SIGKILL');
    await mock.close();
    await harness.cleanup();
  });

  const env = { ...process.env, ...botDbEnv } as Record<string, string>;
  delete env.TWO_HEALTH_PORT;

  // Same squatter race as the test above (TOG-6137): the port can be claimed
  // by a sibling suite between freePort()'s release and our fetch, and then
  // the fetch succeeds even though OUR bot opened nothing. Pre-check the
  // port before booting the bot, and draw again (bounded) if it answers.
  // The health_listening assertion below stays the real proof: it reads the
  // bot's own log, which no squatter can forge.
  let port = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    port = await unclaimedPort();
    bot = spawn(process.execPath, ['src/index.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        DISCORD_TOKEN: 'mock.token.value',
        DISCORD_API_BASE: mock.apiBase,
        DISCORD_GUILD_ID: mock.guildId,
        LOG_LEVEL: 'debug',
      },
    });
    bot.stdout?.on('data', (d) => botLog.push(String(d)));
    bot.stderr?.on('data', (d) => botLog.push(String(d)));

    await mock.waitForReady().catch((err) => {
      throw new Error(`${String(err)}\n--- bot output ---\n${botLog.join('')}`);
    });

    // Fully booted, and still nothing listening on the port it would have used.
    const squatted = await fetch(`http://127.0.0.1:${port}/healthz`).then(
      () => true,
      () => false,
    );
    if (!squatted) break;
    bot.kill('SIGKILL');
    bot = null;
    botLog.length = 0;
    if (attempt === 3) {
      throw new Error(
        `port ${port} answered HTTP three times in a row with TWO_HEALTH_PORT unset; ` +
          `sibling suites keep claiming the probe port, not the bot\n--- bot output ---\n${botLog.join('')}`,
      );
    }
  }

  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/healthz`),
    'port should refuse with TWO_HEALTH_PORT unset',
  );
  assert.ok(
    !botLog.join('').includes('health_listening'),
    `health server must not start without TWO_HEALTH_PORT\n${botLog.join('')}`,
  );
  bot?.kill('SIGKILL');
  bot = null;
});
