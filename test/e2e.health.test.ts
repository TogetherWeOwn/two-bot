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

test('health endpoints answer on the real bot process', { timeout: 90_000 }, async (t) => {
  const mock = await startMockDiscord();
  const port = await freePort();
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

  bot = spawn(process.execPath, ['src/index.ts'], {
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
  bot.stdout?.on('data', (d) => botLog.push(String(d)));
  bot.stderr?.on('data', (d) => botLog.push(String(d)));
  bot.on('exit', (code) => botLog.push(`__bot exited with ${code}__`));

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;

  // Liveness comes up first and does not wait for the gateway - that ordering
  // is the entire reason index.ts starts health before client.login.
  const live = await waitFor(async () => {
    const res = await fetch(url('/healthz'));
    return res.ok ? res : null;
  }).catch((e) => {
    throw new Error(`${String(e)}\n--- bot output ---\n${botLog.join('')}`);
  });
  assert.equal(live.status, 200);
  assert.equal((await live.text()).trim(), 'ok');

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
  bot.kill('SIGTERM');
  const exited = await waitFor(async () => (bot!.exitCode !== null ? true : null), 25_000).catch(
    () => false,
  );
  assert.ok(exited, `bot did not exit on SIGTERM\n--- bot output ---\n${botLog.join('')}`);
  await assert.rejects(fetch(url('/healthz')), 'port should be released after shutdown');
});

test('no health port means no listener at all', { timeout: 90_000 }, async (t) => {
  // The systemd deployment in deploy/ must keep working exactly as before, and
  // "exactly as before" means the bot opens no port unless asked.
  const mock = await startMockDiscord();
  const port = await freePort();
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

  // Fully booted, and still nothing listening on the probe port. The port
  // comes from freePort() (bind-and-release) and node --test runs files in
  // parallel, so a sibling bot or mock can claim it between release and probe
  // (run 36301673171: Missing expected rejection). A fetch that succeeds is a
  // squatter, never our bot - it opened nothing - so retry with a fresh port
  // rather than failing the run.
  const PROBE_ATTEMPTS = 3;
  let squatter = '';
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    const probePort = attempt === 1 ? port : await freePort();
    const res = await fetch(`http://127.0.0.1:${probePort}/healthz`).catch(() => null);
    if (!res) {
      squatter = '';
      break;
    }
    squatter = `${res.status} ${await res.text().catch(() => '')}`.trim().slice(0, 80);
  }
  assert.equal(squatter, '', `a listener answered the probe port on every attempt (last: ${squatter})`);
  assert.ok(
    !botLog.join('').includes('health_listening'),
    `health server must not start without TWO_HEALTH_PORT\n${botLog.join('')}`,
  );
});
