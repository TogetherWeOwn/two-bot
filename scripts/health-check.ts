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
  /** Postgres URL the bot boots against. Never logged. */
  databaseUrl: string;
  /** Extra env for the bot child (e.g. PGOPTIONS to pin a test schema). */
  extraEnv?: Record<string, string>;
  /** Total budget for boot + probes, ms. Default 90_000. */
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
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
 * Poll until `fn` resolves truthy. Callers signal "not yet" with null; the
 * only way out is a truthy value or the deadline.
 */
async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = 'not yet observed';
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err; // not listening yet
    }
    await sleep(200);
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
export async function runHealthCheck(opts: RunHealthCheckOptions): Promise<RunbookHealthReport> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const checks: HealthCheckResult[] = [];
  const pass = (id: string, detail: string) => checks.push({ id, status: 'pass', detail });
  const fail = (id: string, detail: string) => checks.push({ id, status: 'fail', detail });

  let mock: MockDiscord | null = null;
  let bot: ChildProcess | null = null;
  // Raw child output only - never synthetic annotations, so the JSONL check
  // below asserts on exactly what the process wrote.
  const lines: BotLogLine[] = [];
  let pending = '';

  try {
    mock = await startMockDiscord();
    const port = await freePort();

    bot = spawn(process.execPath, ['src/index.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(opts.extraEnv ?? {}),
        DISCORD_TOKEN: 'mock.token.value',
        DISCORD_API_BASE: mock.apiBase,
        DISCORD_GUILD_ID: mock.guildId,
        TWO_DATABASE_URL: opts.databaseUrl,
        // The variable the container image sets. Bound to loopback so this
        // check never opens a port off the machine running it.
        TWO_HEALTH_PORT: String(port),
        TWO_HEALTH_BIND_HOST: '127.0.0.1',
        LOG_LEVEL: 'debug',
      },
    });
    const child = bot;
    const onData = (d: unknown) => {
      pending += String(d);
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const raw of parts) {
        if (raw.trim() === '') continue;
        lines.push(parseLine(raw));
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    let exited: number | null = null;
    child.on('exit', (code) => {
      exited = code;
    });

    const url = (p: string) => `http://127.0.0.1:${port}${p}`;
    const logTail = () => lines.map((l) => l.raw).join('\n');

    // 1. The process stays up through the whole check window. A boot crash is
    //    the thing `systemctl status` would have shown as anything but active.
    await sleep(1500);
    if (exited !== null) {
      fail('bot-process-stays-up', `bot exited with ${exited} seconds after start\n${logTail()}`);
      return { checks, passed: false };
    }
    pass('bot-process-stays-up', 'still running after boot');

    // 2 + 3. Liveness comes up first and does not wait for the gateway - that
    //    ordering is the entire reason index.ts starts health before login.
    const live = await waitFor(async () => {
      const res = await fetch(url('/healthz'));
      return res.ok ? res : null;
    }, timeoutMs).catch((e: unknown) => {
      fail('liveness-200-ok', `GET /healthz never answered 200: ${String(e)}\n${logTail()}`);
      return null;
    });
    if (live) {
      const body = (await live.text()).trim();
      if (live.status === 200 && body === 'ok') pass('liveness-200-ok', 'GET /healthz -> 200 ok');
      else fail('liveness-200-ok', `GET /healthz -> ${live.status} ${body}`);
    }

    // 4. The gateway session comes up against the mock, exactly as it would
    //    against Discord's own servers and TLS aside.
    await mock.waitForReady(Math.min(timeoutMs, 30_000)).catch((err: unknown) => {
      fail('gateway-ready', `mock gateway never saw IDENTIFY: ${String(err)}\n${logTail()}`);
    });
    if (checks.some((c) => c.id === 'gateway-ready' && c.status === 'fail')) {
      return { checks, passed: false };
    }
    pass('gateway-ready', 'mock gateway completed IDENTIFY and sent READY');

    // 5. The RUNBOOK line: {"msg":"ready","user":"...","guilds":1}. "If you see
    //    `ready` you are connected to Discord."
    const readyLine = await waitFor(async () => {
      const found = lines.find((l) => l.json?.msg === 'ready');
      return found ?? null;
    }, timeoutMs).catch((e: unknown) => {
      fail('ready-line', `no {"msg":"ready"} line appeared: ${String(e)}\n${logTail()}`);
      return null;
    });
    if (readyLine?.json) {
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
    const ready = await waitFor(async () => {
      const res = await fetch(url('/readyz'));
      return res.status === 200 ? res : null;
    }, timeoutMs).catch((e: unknown) => {
      fail('readiness-200-ok', `GET /readyz never answered 200: ${String(e)}\n${logTail()}`);
      return null;
    });
    if (ready) {
      const body = (await ready.text()).trim();
      if (body === 'ok') pass('readiness-200-ok', 'GET /readyz -> 200 ok (gateway connected, database answered)');
      else fail('readiness-200-ok', `GET /readyz -> 200 with unexpected body ${body}`);
    }

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
    child.kill('SIGTERM');
    const stopped = await waitFor(async () => (child.exitCode !== null ? true : null), 25_000).catch(
      () => false,
    );
    if (!stopped) {
      fail('clean-sigterm-shutdown', 'bot did not exit on SIGTERM within 25s');
      child.kill('SIGKILL');
    } else {
      pass('clean-sigterm-shutdown', `bot exited on SIGTERM (code ${child.exitCode})`);
      await assertPortReleased(url('/healthz'));
      pass('port-released', 'health port refused connections after shutdown');
    }

    // Host-only checks, explicitly skipped with the mock-side equivalent named.
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

    return { checks, passed: checks.every((c) => c.status !== 'fail') };
  } finally {
    if (bot && bot.exitCode === null) bot.kill('SIGKILL');
    await mock?.close().catch(() => {});
  }
}

async function assertPortReleased(healthUrl: string): Promise<void> {
  let released = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(healthUrl);
    } catch {
      released = true;
      break;
    }
    await sleep(200);
  }
  if (!released) throw new Error('health port still answered after shutdown');
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
    console.error('health-check: TWO_DATABASE_URL is not set. Point it at a Postgres database.');
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
