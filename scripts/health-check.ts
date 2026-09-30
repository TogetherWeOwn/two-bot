/**
 * Automated check for docs/RUNBOOK.md "Is it alive?" (TOG-5689).
 *
 *   TWO_DATABASE_URL=postgres://... node scripts/health-check.ts [--timeout-ms 90000]
 *
 * Boots the REAL bot process (unmodified src/index.ts) against the mock-Discord
 * harness (tools/mock-discord/), then exercises every documented "Is it alive?"
 * check that can run without a host and reports pass/fail/skip:
 *
 *   RUNNABLE AGAINST MOCK
 *   - the process stays up (it does not crash-loop at boot)
 *   - `health_listening` appears in the logs before the gateway is up
 *     (DEPLOY.md §6: health comes up before login so the platform sees an
 *     honest 503 rather than a refused connection while connecting)
 *   - GET /healthz answers 200 `ok` (liveness is dumb on purpose)
 *   - a `{"msg":"ready","user":"...","guilds":N}` line appears with N >= 1
 *     (RUNBOOK: "If you see `ready` you are connected to Discord")
 *   - GET /readyz answers 200 `ok` only once the gateway session exists
 *     (readiness carries the real signal; 503 `gateway_disconnected` before)
 *   - every bot log line is one JSON object with a string `msg`
 *     (RUNBOOK: "recent logs, one JSON object per line"; Node runtime
 *     warnings are tolerated and counted, never failed)
 *   - SIGTERM shuts the bot down and releases the port (what a container
 *     stop sends; a redeploy must not race the old process for the port)
 *
 *   SKIPPED (host-only, with the mock-side equivalent named)
 *   - `systemctl status two-bot` - no systemd under the mock harness;
 *     covered by process-stays-up + liveness-200.
 *   - `journalctl -u two-bot` tail/follow - no journal; covered by the
 *     captured stdio plus the one-JSON-object-per-line check.
 *
 * Repo-local only: mock token, mock gateway, loopback ports. Nothing reaches
 * Discord, no credentials, no production activation.
 *
 * Exit codes: 0 every runnable check passed, 1 a check failed,
 * 2 usage or environment error (matches the preflight/staging-verify shape).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startMockDiscord, type MockDiscord } from '../tools/mock-discord/server.ts';
import { assertTestDatabaseHost } from './test-db-guard.ts';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface HealthCheckResult {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface RunbookHealthReport {
  checks: HealthCheckResult[];
  passed: boolean;
}

export interface RunHealthCheckOptions {
  /** Isolated test Postgres URL the bot boots against. Never logged. */
  databaseUrl: string;
  /** Extra env for the bot child (e.g. PGOPTIONS to pin a test schema). */
  extraEnv?: Record<string, string>;
  /**
   * Total startup + retries + probe budget, ms. Default 90_000.
   * Shutdown has a separate 35s budget, followed by at most 5s of disposal.
   */
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A loopback port held bound until the child that will bind it has spawned.
 *
 * The old freePort() bound and released, and node --test runs files in
 * parallel, so a sibling bot or mock could claim the port in the gap between
 * our release and our child's bind (CI run 36369915601: every boot attempt
 * died at the stays-up check in ~7.9s total). Holding the socket bound until
 * after spawn() shrinks the race to the child's exec window - a sibling must
 * now freePort() in exactly those microseconds AND bind before our child.
 */
interface HeldPort {
  port: number;
  release(): Promise<void>;
}

async function holdPort(): Promise<HeldPort> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  return {
    port,
    release: () => new Promise<void>((r) => s.close(() => r())),
  };
}

/**
 * Release a held port, tolerating null. A free function (not `held?.release()`
 * inline): `held` is `null` on every loop back edge, so TS narrows the local
 * to `null` at the top of the loop and the inline optional chain looks up
 * `release` on `never` (TS2339). The parameter keeps its declared union.
 */
async function releaseHeld(h: HeldPort | null): Promise<void> {
  await h?.release().catch(() => {});
}

// Test seams exercise the real orchestration without a socket, DB or bot.
export interface HealthCheckRuntime {
  now: () => number;
  sleep: typeof sleep;
  fetch: typeof fetch;
  spawn: typeof spawn;
  startMockDiscord: typeof startMockDiscord;
  holdPort: typeof holdPort;
  random: () => number;
}

class DeadlineError extends Error {}

class Deadline {
  private end: number;
  private runtime: Pick<HealthCheckRuntime, 'now' | 'sleep'>;

  constructor(end: number, runtime: Pick<HealthCheckRuntime, 'now' | 'sleep'>) {
    this.end = end;
    this.runtime = runtime;
  }

  remaining(): number {
    return Math.max(0, this.end - this.runtime.now());
  }

  capped(ms: number): Deadline {
    return new Deadline(Math.min(this.end, this.runtime.now() + ms), this.runtime);
  }

  async run<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    disposeLate?: (value: T) => Promise<void>,
  ): Promise<T> {
    const remaining = this.remaining();
    if (remaining <= 0) throw new DeadlineError('deadline exhausted');
    const controller = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        const err = new DeadlineError('deadline exhausted');
        // Abort fetch AND body consumption, not just the polling loop.
        // https://nodejs.org/docs/latest-v24.x/api/globals.html#class-abortcontroller
        controller.abort(err);
        reject(err);
      }, remaining);
    });
    const work = Promise.resolve().then(() => fn(controller.signal)).then((value) => {
      if (expired || this.remaining() <= 0) {
        expired = true;
        void disposeLate?.(value).catch(() => {});
        throw new DeadlineError('deadline exhausted');
      }
      return value;
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async pause(ms: number): Promise<void> {
    await this.run(() => this.runtime.sleep(Math.min(ms, this.remaining())));
  }
}

/** Poll within an existing deadline; a phase cap never replenishes its parent. */
async function waitFor<T>(fn: (signal: AbortSignal) => Promise<T | null>, deadline: Deadline): Promise<T> {
  let last: unknown = 'not yet observed';
  while (deadline.remaining() > 0) {
    try {
      const v = await deadline.run(fn);
      if (v) return v;
    } catch (err) {
      last = err; // not listening yet
    }
    if (deadline.remaining() > 0) {
      await deadline.pause(200).catch((err) => { last = err; });
    }
  }
  throw new Error(`timed out; last: ${String(last)}`);
}

interface BotLogLine {
  raw: string;
  json: Record<string, unknown> | null;
}

/**
 * Node runtime warnings (`(node:PID) DeprecationWarning: ...`, `--trace`
 * hints, ExperimentalWarning banners) are written by the runtime, not by the
 * bot's logger, and appear in production journalctl too. They are noise for
 * the JSONL check, never signal.
 */
function isRuntimeWarningLine(raw: string): boolean {
  return (
    /^\(node:\d+\) \w*Warning/.test(raw) ||
    // The `(Use `node --trace-...`)` hint that follows a Node warning.
    raw.startsWith('(Use `node ') ||
    raw.startsWith('--trace-')
  );
}

function parseLine(raw: string): BotLogLine {
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    return { raw, json: json && typeof json === 'object' ? json : null };
  } catch {
    return { raw, json: null };
  }
}

/**
 * The RUNBOOK "Is it alive?" verdict against the mock harness. Starts its own
 * mock Discord and its own bot child; tears both down before returning, so a
 * test can assert on the report and an operator can read it.
 */
export async function runHealthCheck(
  opts: RunHealthCheckOptions,
  dependencies: Partial<HealthCheckRuntime> = {},
): Promise<RunbookHealthReport> {
  // The child connects AND migrates. Refuse before any mock, port, or process
  // starts, including callers that bypass the CLI.
  const databaseUrl = assertTestDatabaseHost(opts.databaseUrl, 'TWO_DATABASE_URL');
  const timeoutMs = opts.timeoutMs ?? 90_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive finite number');
  }
  const runtime: HealthCheckRuntime = {
    now: () => performance.now(), sleep, fetch, spawn, startMockDiscord, holdPort,
    random: Math.random, ...dependencies,
  };
  const budget = new Deadline(runtime.now() + timeoutMs, runtime);
  const disposalBudget = () => new Deadline(runtime.now() + 5_000, runtime);
  const closeLateMock = (m: MockDiscord) => disposalBudget().run(() => m.close());
  const releaseLatePort = (h: HeldPort) => disposalBudget().run(() => h.release());
  const detachListeners: Array<() => void> = [];
  const detachChild = () => {
    for (const detach of detachListeners.splice(0)) detach();
  };
  const checks: HealthCheckResult[] = [];
  const pass = (id: string, detail: string) => checks.push({ id, status: 'pass', detail });
  const fail = (id: string, detail: string) => checks.push({ id, status: 'fail', detail });

  let mock: MockDiscord | null = null;
  let bot: ChildProcess | null = null;
  let child: ChildProcess | null = null;
  let exited: number | null = null;
  // Raw child output only - never synthetic annotations, so the JSONL check
  // below asserts on exactly what the process wrote.
  const lines: BotLogLine[] = [];
  let pending = '';
  const onData = (d: unknown) => {
    pending += String(d);
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const raw of parts) {
      if (raw.trim() === '') continue;
      lines.push(parseLine(raw));
    }
  };

  const pushSkips = () => {
    checks.push({
      id: 'systemctl-status',
      status: 'skip',
      detail: 'no systemd under the mock harness; covered by bot-process-stays-up + liveness-200-ok',
    });
    checks.push({
      id: 'journalctl-tail',
      status: 'skip',
      detail: 'no journal under the mock harness; covered by captured stdio + logs-jsonl',
    });
  };
  // Failure exit: the host-only skips are part of the report contract (the
  // acceptance on TOG-5689 requires them listed), so they ride along on red
  // reports too rather than only on green ones.
  const failReport = (): RunbookHealthReport => {
    pushSkips();
    return { checks, passed: false };
  };

  // The health port is racy by construction: node --test runs files in
  // parallel, so a sibling bot or mock can claim our port before our child
  // binds (CI signatures: EADDRINUSE crash, or a fetch landing on the wrong
  // server and reading '{}'). Three layers of defense:
  //
  //   1. The port stays BOUND by this process until our child has spawned -
  //      no bind-release gap for a sibling to slip into. A sibling can still
  //      win the spawn-to-bind window (the child needs ~a second to boot),
  //      so retries remain.
  //   2. Retry the boot phase only - once our health server answers, the port
  //      is ours. Eight attempts with jitter: run 36314095503 exhausted three
  //      consecutive squats, and run 36369915601 exhausted five. Retries cost
  //      nothing on a green path (first attempt boots straight through); the
  //      jitter decorrelates two siblings colliding repeatedly.
  //   3. Every attempt is recorded (port, outcome, exit tail) and the history
  //      rides along on the failure detail, so the next red run says whether
  //      it was EADDRINUSE every time or something else entirely.
  const BOOT_ATTEMPTS = 8;
  const attemptHistory: string[] = [];
  const recordAttempt = (msg: string) => {
    attemptHistory.push(msg);
  };
  const historyBlock = () => (attemptHistory.length ? `\nboot attempts:\n${attemptHistory.join('\n')}` : '');
  // Decorrelate colliding siblings: without jitter two processes that lose
  // the same race retry in lockstep and lose it together again.
  const backoff = (attempt: number) => budget.pause(250 * attempt + Math.floor(runtime.random() * 500));
  let attemptNumber = 0;
  let port = 0;
  let url = (p: string) => `http://127.0.0.1:${port}${p}`;
  let logTail = () => '';
  let bootOk = false;

  let held: HeldPort | null = null;
  try {
    for (let attempt = 1; attempt <= BOOT_ATTEMPTS && !bootOk; attempt++) {
      attemptNumber = attempt;
      // Fresh state per attempt so a collided try leaves no checks behind.
      checks.length = 0;
      lines.length = 0;
      pending = '';
      if (bot && bot.exitCode === null) bot.kill('SIGKILL');
      detachChild();
      bot = null;
      exited = null;
      if (mock) await budget.run(() => mock!.close());
      mock = null;
      // `releaseHeld` (not `held?.release()` inline): `held` is `null`
      // on every loop back edge, so TS narrows it to `null` here and the
      // inline optional chain looks up `release` on `never` (TS2339).
      await budget.run(() => releaseHeld(held));
      held = null;

      // Decorrelate from a sibling we just collided with: without this two
      // processes that lose the same race retry in lockstep and lose together.
      if (attempt > 1) await backoff(attempt);
      mock = await budget.run(() => runtime.startMockDiscord(), closeLateMock);
      // Bound by THIS process until our child exists: no bind-release gap for
      // a sibling to slip into. Released right after spawn so the child can
      // bind; the spawn-to-bind window (child boot, ~1s) stays racy, which is
      // what the retry budget and the attempt history below are for.
      held = await budget.run(() => runtime.holdPort(), releaseLatePort);
      port = held.port;
      url = (p: string) => `http://127.0.0.1:${port}${p}`;
      logTail = () => lines.map((l) => l.raw).join('\n');
      // The exit tail: EADDRINUSE (squatter) vs anything else decides whether
      // a retry is correct, so it is logged per attempt, not just on failure.
      const tailLines = (n = 8) => lines.map((l) => l.raw).slice(-n).join('\n');

      bot = runtime.spawn(process.execPath, ['src/index.ts'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(opts.extraEnv ?? {}),
          // Credentials take precedence over env; DISCORD_BOT_TOKEN also wins
          // over DISCORD_TOKEN. Neither inherited values nor extraEnv may
          // retarget this mock harness. Disable preloads/env files as well.
          CREDENTIALS_DIRECTORY: '',
          NODE_OPTIONS: '',
          DISCORD_BOT_TOKEN: 'mock.token.value',
          DISCORD_TOKEN: 'mock.token.value',
          DISCORD_API_BASE: mock.apiBase,
          DISCORD_GUILD_ID: mock.guildId,
          TWO_DATABASE_URL: databaseUrl,
          // The variable the container image sets. Bound to loopback so this
          // check never opens a port off the machine running it.
          TWO_HEALTH_PORT: String(port),
          TWO_HEALTH_BIND_HOST: '127.0.0.1',
          LOG_LEVEL: 'debug',
        },
      });
      await budget.run(() => held!.release());
      held = null;
      child = bot;
      exited = null;
      // Identity-guarded: a SIGKILLed previous attempt can still deliver
      // buffered exit/data events after the next attempt spawned. Only the
      // current child may write this attempt's `exited` and `lines`.
      const thisChild = child;
      const isCurrent = () => bot === thisChild;
      const onOutput = (d: unknown) => { if (isCurrent()) onData(d); };
      const onExit = (code: number | null) => { if (isCurrent()) exited = code; };
      thisChild.stdout?.on('data', onOutput);
      thisChild.stderr?.on('data', onOutput);
      thisChild.on('exit', onExit);
      detachListeners.push(() => {
        thisChild.stdout?.off('data', onOutput);
        thisChild.stderr?.off('data', onOutput);
        thisChild.off('exit', onExit);
      });

      // 1. The process stays up through the whole check window. A boot crash is
      //    the thing `systemctl status` would have shown as anything but active.
      //    An EADDRINUSE crash means a sibling bound our port in the
      //    spawn-to-bind window - retry with a fresh held port, and record
      //    the exit tail so the next red run says EADDRINUSE vs real crash.
      await budget.pause(1500);
      if (exited !== null) {
        const tail = logTail();
        const squat = /EADDRINUSE/.test(tail);
        recordAttempt(
          `attempt ${attempt}/${BOOT_ATTEMPTS} port ${port}: exited ${exited}${squat ? ' EADDRINUSE' : ' (non-port crash)'}\n${tailLines()}`,
        );
        if (squat && attempt < BOOT_ATTEMPTS) continue;
        fail(
          'bot-process-stays-up',
          `bot exited with ${exited} after start (attempt ${attempt}/${BOOT_ATTEMPTS}, port ${port})\n${tail}${historyBlock()}`,
        );
        return failReport();
      }
      pass('bot-process-stays-up', 'still running after boot');

      // 2 + 3. Liveness comes up first and does not wait for the gateway - that
      //    ordering is the entire reason index.ts starts health before login.
      //    Keep the phase cap, but every attempt consumes the SAME total budget.
      const live = await waitFor(async (signal) => {
        const res = await runtime.fetch(url('/healthz'), { signal });
        const body = (await res.text()).trim();
        return res.ok ? { status: res.status, body } : null;
      }, budget.capped(30_000)).catch(() => null);
      if (!live) {
        recordAttempt(`attempt ${attempt}/${BOOT_ATTEMPTS} port ${port}: /healthz never answered 200\n${tailLines()}`);
        if (attempt < BOOT_ATTEMPTS && budget.remaining() > 0) continue;
        fail(
          'liveness-200-ok',
          `GET /healthz never answered 200 after ${attempt} boot attempts (remaining budget ${budget.remaining()}ms)\n${logTail()}${historyBlock()}`,
        );
        return failReport();
      }
      {
        const body = live.body;
        if (live.status !== 200 || body !== 'ok') {
          // Wrong server on our port (a sibling's mock answers '{}', a stale
          // bot answers 503) - retry with a fresh port, don't fail the run.
          recordAttempt(
            `attempt ${attempt}/${BOOT_ATTEMPTS} port ${port}: /healthz -> ${live.status} ${body.slice(0, 80)}\n${tailLines()}`,
          );
          if (attempt < BOOT_ATTEMPTS && budget.remaining() > 0) continue;
          fail('liveness-200-ok', `GET /healthz -> ${live.status} ${body}${historyBlock()}`);
          return failReport();
        }
        // Ownership: a 200 ok proves *a* server answers, not that it is ours.
        // Only our own child logging health_listening for this port proves the
        // bind is ours - a sibling squatting on our port makes our child
        // crash with EADDRINUSE instead, which never logs that line.
        const ours = await waitFor(async () => {
          const found = lines.find(
            (l) => l.json?.msg === 'health_listening' && l.json?.port === port,
          );
          return found ?? null;
        }, budget.capped(15_000)).catch(() => null);
        if (!ours) {
          recordAttempt(`attempt ${attempt}/${BOOT_ATTEMPTS} port ${port}: 200 ok but no health_listening for our port\n${tailLines()}`);
          if (attempt < BOOT_ATTEMPTS && budget.remaining() > 0) continue;
          fail('liveness-200-ok', `our bot never logged health_listening for port ${port}\n${logTail()}${historyBlock()}`);
          return failReport();
        }
        pass('liveness-200-ok', 'GET /healthz -> 200 ok');
      }
      recordAttempt(`attempt ${attempt}/${BOOT_ATTEMPTS} port ${port}: bound, ours`);
      bootOk = true;
    }
    if (!bootOk || !child) {
      fail('liveness-200-ok', `no boot attempt bound the health port (${BOOT_ATTEMPTS} tries)${historyBlock()}`);
      return failReport();
    }
    const activeMock = mock;
    if (!activeMock) {
      fail('gateway-ready', 'mock harness missing after boot');
      return failReport();
    }

    // 4. The gateway session comes up against the mock, exactly as it would
    //    against Discord's own servers and TLS aside.
    const gatewayBudget = budget.capped(30_000);
    await gatewayBudget.run(() => activeMock.waitForReady(gatewayBudget.remaining())).catch((err: unknown) => {
      fail('gateway-ready', `mock gateway never saw IDENTIFY: ${String(err)}\n${logTail()}${historyBlock()}`);
    });
    if (checks.some((c) => c.id === 'gateway-ready' && c.status === 'fail')) {
      return failReport();
    }
    pass('gateway-ready', 'mock gateway completed IDENTIFY and sent READY');

    // 5. The RUNBOOK line: {"msg":"ready","user":"...","guilds":1}. "If you see
    //    `ready` you are connected to Discord."
    const readyLine = await waitFor(async () => {
      const found = lines.find((l) => l.json?.msg === 'ready');
      return found ?? null;
    }, budget).catch((e: unknown) => {
      fail('ready-line', `no {"msg":"ready"} line appeared: ${String(e)}\n${logTail()}${historyBlock()}`);
      return null;
    });
    if (!readyLine) return failReport();
    if (readyLine.json) {
      const user = readyLine.json.user;
      const guilds = readyLine.json.guilds;
      const readyTs = typeof readyLine.json.ts === 'string' ? Date.parse(readyLine.json.ts) : NaN;
      if (typeof user === 'string' && user.length > 0 && typeof guilds === 'number' && guilds >= 1) {
        pass('ready-line', `{"msg":"ready","user":"${user}","guilds":${guilds}}`);
      } else {
        fail('ready-line', `ready line has the wrong shape: ${readyLine.raw}`);
      }
      // 6. Health came up BEFORE the gateway login (DEPLOY.md §6). Both
      //    timestamps are the bot's own clock, so pipe buffering cannot fake
      //    or break the comparison.
      const listening = lines.find((l) => l.json?.msg === 'health_listening');
      const listeningTs =
        listening?.json && typeof listening.json.ts === 'string'
          ? Date.parse(listening.json.ts)
          : NaN;
      if (!listening) {
        fail('health-before-ready', 'no health_listening line in the logs');
      } else if (!Number.isFinite(listeningTs) || !Number.isFinite(readyTs)) {
        fail('health-before-ready', 'health_listening or ready line has no parseable ts');
      } else if (listeningTs <= readyTs) {
        pass('health-before-ready', 'health_listening precedes ready (honest 503 window, not refused connections)');
      } else {
        fail('health-before-ready', 'health_listening is dated after ready - the cold-start window is inverted');
      }
    }

    // 7. Readiness carries the real signal: gateway logged in AND the database
    //    answers. This is the check Coolify gates the deploy on.
    const ready = await waitFor(async (signal) => {
      const res = await runtime.fetch(url('/readyz'), { signal });
      const body = (await res.text()).trim();
      return res.status === 200 ? { body } : null;
    }, budget).catch((e: unknown) => {
      fail('readiness-200-ok', `GET /readyz never answered 200: ${String(e)}\n${logTail()}${historyBlock()}`);
      return null;
    });
    if (!ready) return failReport();
    if (ready.body === 'ok') pass('readiness-200-ok', 'GET /readyz -> 200 ok (gateway connected, database answered)');
    else fail('readiness-200-ok', `GET /readyz -> 200 with unexpected body ${ready.body}`);

    // 8. One JSON object per line, greppable, ready for a log shipper later.
    //    Only lines the child actually wrote are inspected. Node runtime
    //    warnings are tolerated and counted, not failed: discord.js prints a
    //    `ready` -> `clientReady` DeprecationWarning on stderr at every boot
    //    (it fires on emit, not on our listen - src already uses
    //    Events.ClientReady), so even production journalctl carries those two
    //    non-JSON lines. The bot's own logger (src/core/log.ts) is what this
    //    check pins.
    const noise = lines.filter((l) => isRuntimeWarningLine(l.raw));
    const botLines = lines.filter((l) => !isRuntimeWarningLine(l.raw));
    const bad = botLines.filter((l) => l.json === null || typeof l.json.msg !== 'string');
    if (bad.length === 0 && botLines.length > 0) {
      pass(
        'logs-jsonl',
        `${botLines.length} bot log lines, every one a JSON object with a string msg` +
          (noise.length ? ` (${noise.length} runtime warning line(s) tolerated)` : ''),
      );
    } else if (botLines.length === 0) {
      fail('logs-jsonl', 'captured no bot log output at all');
    } else {
      fail('logs-jsonl', `${bad.length} non-JSON bot line(s), first: ${bad[0]!.raw.slice(0, 200)}`);
    }

    // 9. SIGTERM is what a container stop sends. The bot must close the port
    //    rather than be killed holding it.
    const shutdownBudget = new Deadline(runtime.now() + 35_000, runtime);
    const activeChild = child;
    activeChild.kill('SIGTERM');
    const stopped = await waitFor(async () => (activeChild.exitCode !== null ? true : null), shutdownBudget.capped(25_000)).catch(
      () => false,
    );
    if (!stopped) {
      fail('clean-sigterm-shutdown', 'bot did not exit on SIGTERM within 25s');
      activeChild.kill('SIGKILL');
    } else {
      pass('clean-sigterm-shutdown', `bot exited on SIGTERM (code ${activeChild.exitCode})`);
      // assertPortReleased throws rather than returning false, so an uncaught
      // throw here would bubble out of runHealthCheck with no report at all -
      // and the host-only skips with it. Record it as the port-released
      // verdict instead; the skips ride along via failReport.
      try {
        await assertPortReleased(url('/healthz'), shutdownBudget.capped(10_000), runtime.fetch);
        pass('port-released', 'health port refused connections after shutdown');
      } catch (err: unknown) {
        fail('port-released', `health port still answered after shutdown: ${String(err)}`);
        return failReport();
      }
    }

    // Host-only checks, explicitly skipped with the mock-side equivalent named.
    pushSkips();

    return { checks, passed: checks.every((c) => c.status !== 'fail') };
  } catch (err) {
    if (!(err instanceof DeadlineError)) throw err;
    recordAttempt(`attempt ${attemptNumber}/${BOOT_ATTEMPTS} port ${port}: boot/probe stopped: ${String(err)}`);
    fail('boot-probe-budget', `${String(err)}\n${logTail()}${historyBlock()}`);
    return failReport();
  } finally {
    if (bot && bot.exitCode === null) bot.kill('SIGKILL');
    detachChild();
    // Disposal is separate from boot/probes, even when their budget ran out.
    // Start both releases so a stuck mock close cannot starve a held port.
    const cleanup = disposalBudget();
    await Promise.all([
      cleanup.run(async () => { await mock?.close(); }).catch(() => {}),
      cleanup.run(() => releaseHeld(held)).catch(() => {}),
    ]);
  }
}

async function assertPortReleased(healthUrl: string, deadline: Deadline, fetchProbe: typeof fetch): Promise<void> {
  await waitFor(async (signal) => {
    try {
      const res = await fetchProbe(healthUrl, { signal });
      await res.text();
      return null;
    } catch (err) {
      // A canceled/hung request is NOT proof of a refused connection.
      if (signal.aborted) throw err;
      return true;
    }
  }, deadline);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const timeoutArg = process.argv.find((a) => a.startsWith('--timeout-ms='))?.slice('--timeout-ms='.length);
  const timeoutMs = timeoutArg !== undefined ? Number(timeoutArg) : 90_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error('health-check: --timeout-ms must be a positive number of milliseconds.');
    process.exit(2);
  }
  const databaseUrl = process.env.TWO_DATABASE_URL?.trim() ?? '';
  if (!databaseUrl) {
    console.error('health-check: TWO_DATABASE_URL is not set. Point it at an isolated test Postgres database.');
    process.exit(2);
  }

  try {
    assertTestDatabaseHost(databaseUrl, 'TWO_DATABASE_URL');
  } catch (err) {
    console.error(`health-check: ${(err as Error).message}`);
    process.exit(2);
  }

  const report = await runHealthCheck({ databaseUrl, timeoutMs });
  for (const c of report.checks) {
    console.log(`  ${c.status.toUpperCase().padEnd(4)}  ${c.id}  ${c.detail.split('\n')[0]}`);
  }
  const counts = (s: CheckStatus) => report.checks.filter((c) => c.status === s).length;
  console.log(`\nhealth-check: ${counts('pass')} pass, ${counts('fail')} fail, ${counts('skip')} skip`);
  console.log(report.passed ? 'HEALTH CHECK PASSED' : 'HEALTH CHECK FAILED');
  process.exit(report.passed ? 0 : 1);
}
