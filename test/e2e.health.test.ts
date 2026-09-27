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

/** A port nobody is listening on, obtained by binding and immediately releasing.
 *
 * The release-then-rebind is inherently racy: this file runs inside one
 * `node --test` process alongside ~150 sibling files, and dozens of them bind
 * loopback ports (mock Discord servers, spawned bots, internal-actions
 * servers) in the gap between our close and our bind. Every caller below must
 * therefore treat a freed port as a hint and retry with a fresh one when the
 * bind loses the race — see PortStolenError.
 */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/**
 * The port was stolen, not broken: a sibling test server rebound our freed
 * port before our bot did. Retrying with a fresh port is correct; failing the
 * suite on someone else's socket is not. (Red mains 2026-09-27: runs
 * 36291840893/36290702929 fetched `{}` from a mock Discord catch-all that had
 * taken the port; run 36288799921 died with EADDRINUSE on it.)
 */
class PortStolenError extends Error {
  constructor(port: number, detail: string) {
    super(
      `loopback port ${port} was rebound by another test server (${detail}); retrying with a fresh port`,
    );
  }
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

  // Freed loopback ports are recycled fast on the shared CI host: between our
  // close and the bot's listen, a sibling file's mock Discord (whose catch-all
  // answers `{}`) or another spawned bot can take the port. The bot's /healthz
  // answers `ok`, so a wrong body or a bind failure means the port was stolen
  // and the attempt must be retried with a fresh port - never failed.
  let port = 0;
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const liveDeadline = Date.now() + 30_000;
  let attempt = 0;
  let live = false;
  while (!live && attempt < 4 && Date.now() < liveDeadline) {
    attempt += 1;
    botLog.length = 0;
    port = await freePort();
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

    // Liveness comes up first and does not wait for the gateway - that
    // ordering is the entire reason index.ts starts health before
    // client.login. The body is checked DURING the wait: `res.ok` alone also
    // matches a squatter mock server's 200 with `{}`.
    let foreignBody: string | null = null;
    while (Date.now() < liveDeadline) {
      if (bot.exitCode !== null) break;
      try {
        const res = await fetch(url('/healthz'));
        const ct = res.headers.get('content-type') ?? '';
        const text = (await res.text()).trim();
        if (res.ok && ct.includes('text/plain') && text === 'ok' && bot.exitCode === null) {
          live = true;
          break;
        }
        if (text !== '' && text !== 'ok') foreignBody = text.slice(0, 80);
      } catch {
        // Not listening yet - or our bot never got the port.
      }
      await sleep(200);
    }

    if (live && bot.exitCode === null) break;
    live = false;
    const output = botLog.join('');
    bot?.kill('SIGKILL');
    const stolen = /EADDRINUSE/.test(output) || foreignBody !== null;
    if (stolen && attempt < 4 && Date.now() < liveDeadline) {
      bot = null;
      await sleep(250);
      continue;
    }
    if (stolen) throw new PortStolenError(port, foreignBody ?? 'bot failed to bind (EADDRINUSE)');
    throw new Error(`bot did not answer /healthz with ok\n--- bot output ---\n${output}`);
  }
  assert.ok(live, `bot did not answer /healthz with ok\n--- bot output ---\n${botLog.join('')}`);
  // The loop only exits live with a spawned, unkilled bot; the retry path sets
  // bot back to null, so narrow it once for the steps below.
  assert.ok(bot !== null, 'liveness proved without a bot process; unreachable');

  await mock.waitForReady().catch((err) => {
    throw new Error(`${String(err)}\n--- bot output ---\n${botLog.join('')}`);
  });

  // Readiness needs the gateway session AND a database that answers. This is
  // the check Coolify gates the deploy on, so it has to go green against the
  // real wiring, not a stub. The body is checked for the same squatter reason
  // as liveness above: only our bot answers `ok`.
  // The body is consumed during the check (it is what distinguishes our bot
  // from a squatter), so the poll returns the verdict, not the Response.
  const readyBody = await waitFor(async (): Promise<string | null> => {
    const res = await fetch(url('/readyz'));
    if (res.status !== 200) return null;
    if (!(res.headers.get('content-type') ?? '').includes('text/plain')) return null;
    return (await res.text()).trim() === 'ok' ? 'ok' : null;
  }).catch((e) => {
    throw new Error(`${String(e)}\n--- bot output ---\n${botLog.join('')}`);
  });
  assert.equal(readyBody, 'ok');

  const nope = await fetch(url('/nope'));
  assert.equal(nope.status, 404);
  assert.equal((await nope.text()).trim(), 'not found');

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

  // Fully booted, and still nothing listening. A freed port proves nothing on
  // a host where sibling test servers rebind loopback ports in milliseconds
  // (red main 36290702929: a squatter answered this exact fetch, so "fetch
  // rejects" passed or failed on someone else's socket). Instead, re-bind the
  // candidate port ourselves: success means nobody - including our bot - is
  // listening on it, which is airtight at that instant. EADDRINUSE means a
  // third party won the race, so retry with a fresh port; the bot-log
  // assertion below is what actually pins the bot's behavior either way.
  const probeDeadline = Date.now() + 20_000;
  let nobodyListening = false;
  let probe = 0;
  while (!nobodyListening && Date.now() < probeDeadline) {
    probe += 1;
    const candidate = await freePort();
    const holder = createServer();
    const bound = await new Promise<boolean>((resolve) => {
      holder.once('error', () => resolve(false));
      holder.listen(candidate, '127.0.0.1', () => resolve(true));
    });
    if (bound) {
      await new Promise<void>((r) => holder.close(() => r()));
      nobodyListening = true;
    } else {
      await sleep(250);
    }
    assert.ok(probe < 10, 'loopback ports kept being stolen; giving up the probe');
  }
  assert.ok(nobodyListening, 'could not find an unbound loopback port to prove silence on');
  assert.ok(
    !botLog.join('').includes('health_listening'),
    `health server must not start without TWO_HEALTH_PORT\n${botLog.join('')}`,
  );
});
