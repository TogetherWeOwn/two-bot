import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import {
  runHealthCheck, type HealthCheckRuntime, type RunbookHealthReport,
} from '../scripts/health-check.ts';
import type { MockDiscord } from '../tools/mock-discord/server.ts';

const databaseUrl = 'postgres://agent_test@agent-testdb/two_bot_test_tog10234';
const sleep = (ms: number) => ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

// Drive timers explicitly, never wait real seconds or boot a real process.
async function finish<T>(t: TestContext, work: Promise<T>, maxMs = 100_000): Promise<T> {
  let result: { value: T } | { error: unknown } | undefined;
  void work.then((value) => { result = { value }; }, (error) => { result = { error }; });
  const end = Date.now() + maxMs;
  while (Date.now() <= end) {
    await flush();
    if (result) {
      if ('error' in result) throw result.error;
      return result.value;
    }
    t.mock.timers.tick(50);
  }
  throw new Error('test driver exceeded its bound');
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kills: string[] = [];
  stopDelay = 0;
  refuseTerm = false;

  kill(signal: string): boolean {
    this.kills.push(signal);
    if (signal === 'SIGTERM' && this.refuseTerm) return true;
    const stop = () => { this.exitCode = 0; this.emit('exit', 0); };
    if (signal === 'SIGTERM' && this.stopDelay) setTimeout(stop, this.stopDelay);
    else stop();
    return true;
  }

  log(msg: string, fields: Record<string, unknown> = {}): void {
    this.stdout.write(JSON.stringify({ msg, ts: new Date().toISOString(), ...fields }) + '\n');
  }
}

interface Scenario {
  startupMs?: number;
  holdMs?: number;
  listeningMs?: number | null;
  readyLineMs?: number | null;
  gatewayMs?: number | 'hang';
  fetchMs?: number;
  readyFetchMs?: number;
  live?: 'unavailable' | 'hang' | 'ignore-abort' | 'body-hang' | 'wrong-first';
  crashFirst?: boolean;
  stopDelay?: number;
  refuseTerm?: boolean;
  portAfterStop?: 'hang' | 'answers' | 'body-error';
  closeHangs?: boolean;
  releaseHangs?: boolean;
}

function fixture(t: TestContext, scenario: Scenario = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const children: FakeChild[] = [];
  const mocks: Array<{ closed: number }> = [];
  const ports: Array<{ port: number; released: number }> = [];
  const signals: AbortSignal[] = [];
  const gatewayBudgets: number[] = [];
  const hang = (signal: AbortSignal, cooperate = true) => new Promise<never>((_, reject) => {
    if (cooperate) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const runtime: HealthCheckRuntime = {
    now: Date.now, sleep, random: () => 0,
    startMockDiscord: async () => {
      await sleep(scenario.startupMs ?? 0);
      const state = { closed: 0 };
      mocks.push(state);
      return {
        apiBase: 'http://127.0.0.1:40000/api', guildId: 'mock-guild',
        waitForReady: async (ms: number) => {
          gatewayBudgets.push(ms);
          if (scenario.gatewayMs === 'hang') await new Promise(() => {});
          else await sleep(scenario.gatewayMs ?? 0);
        },
        close: async () => {
          state.closed++;
          if (scenario.closeHangs) await new Promise(() => {});
        },
      } as unknown as MockDiscord;
    },
    holdPort: async () => {
      await sleep(scenario.holdMs ?? 0);
      const state = { port: 41000 + ports.length, released: 0 };
      ports.push(state);
      return {
        port: state.port,
        release: async () => {
          state.released++;
          if (scenario.releaseHangs) await new Promise(() => {});
        },
      };
    },
    spawn: (() => {
      const child = new FakeChild();
      children.push(child);
      child.stopDelay = scenario.stopDelay ?? 0;
      child.refuseTerm = scenario.refuseTerm ?? false;
      const port = ports.at(-1)!.port;
      if (scenario.crashFirst && children.length === 1) {
        setTimeout(() => {
          child.log('boot_failed', { error: 'EADDRINUSE' });
          child.exitCode = 1;
          child.emit('exit', 1);
        }, 100);
      } else {
        if (scenario.listeningMs !== null) {
          setTimeout(() => child.log('health_listening', { port }), scenario.listeningMs ?? 100);
        }
        if (scenario.readyLineMs !== null) {
          setTimeout(() => child.log('ready', { user: 'mock-user', guilds: 1 }), scenario.readyLineMs ?? 200);
        }
      }
      return child as unknown as ChildProcess;
    }) as typeof runtime.spawn,
    fetch: (async (url: string, init?: RequestInit) => {
      const signal = init!.signal!;
      signals.push(signal);
      const child = children.at(-1)!;
      if (child.exitCode !== null) {
        if (scenario.portAfterStop === 'hang') return hang(signal);
        if (scenario.portAfterStop === 'answers') return new Response('ok');
        // Headers received but the body is truncated: a server is still
        // listening, so this must never certify a released port.
        if (scenario.portAfterStop === 'body-error') {
          return {
            ok: true, status: 200,
            text: async () => { throw new TypeError('terminated: truncated HTTP body'); },
          } as unknown as Response;
        }
        throw new Error('ECONNREFUSED');
      }
      const live = url.endsWith('/healthz');
      if (live && (scenario.live === 'hang' || scenario.live === 'ignore-abort')) {
        return hang(signal, scenario.live !== 'ignore-abort');
      }
      if (live && scenario.live === 'body-hang') {
        return { ok: true, status: 200, text: () => hang(signal) } as unknown as Response;
      }
      await sleep(live ? scenario.fetchMs ?? 0 : scenario.readyFetchMs ?? 0);
      if (live && scenario.live === 'unavailable') return new Response('starting', { status: 503 });
      if (live && scenario.live === 'wrong-first' && children.length === 1) return new Response('{}');
      return new Response('ok');
    }) as typeof runtime.fetch,
  };
  const run = (timeoutMs: number) => runHealthCheck({ databaseUrl, timeoutMs }, runtime);
  const clean = () => {
    assert.ok(mocks.every((m) => m.closed > 0), 'every mock closed');
    assert.ok(ports.every((p) => p.released > 0), 'every holder released');
    for (const child of children) {
      assert.notEqual(child.exitCode, null, 'child stopped');
      assert.equal(child.listenerCount('exit'), 0);
      assert.equal(child.stdout.listenerCount('data'), 0);
      assert.equal(child.stderr.listenerCount('data'), 0);
    }
  };
  return { run, clean, children, mocks, ports, signals, gatewayBudgets };
}

function failure(report: RunbookHealthReport, id: string, attempts = true): void {
  assert.equal(report.passed, false);
  const failed = report.checks.find((c) => c.id === id && c.status === 'fail');
  assert.ok(failed, JSON.stringify(report));
  if (attempts) assert.match(failed.detail, /boot attempts:\nattempt 1\/8 port/);
  assert.deepEqual(report.checks.filter((c) => c.status === 'skip').map((c) => c.id), [
    'systemctl-status', 'journalctl-tail',
  ]);
}

for (const phase of ['liveness', 'ownership'] as const) {
  test(`stuck ${phase} exhausts one boot/probe deadline`, async (t) => {
    const f = fixture(t, phase === 'liveness' ? { live: 'unavailable' } : { listeningMs: null });
    const report = await finish(t, f.run(4_000));
    assert.equal(Date.now(), 4_000);
    failure(report, 'liveness-200-ok');
    if (phase === 'ownership') assert.match(report.checks.find((c) => c.status === 'fail')!.detail, /health_listening/);
    assert.equal(f.children.length, 1);
    f.clean();
  });
}

test('successful slow phases share the budget; readiness receives only the remainder', async (t) => {
  const f = fixture(t, {
    startupMs: 400, holdMs: 300, fetchMs: 800, listeningMs: 2_600,
    gatewayMs: 600, readyLineMs: 3_500, readyFetchMs: 1_000,
  });
  const report = await finish(t, f.run(5_000));
  assert.equal(Date.now(), 5_000);
  failure(report, 'readiness-200-ok');
  for (const id of ['liveness-200-ok', 'gateway-ready', 'ready-line']) {
    assert.equal(report.checks.find((c) => c.id === id)?.status, 'pass');
  }
  assert.deepEqual(f.gatewayBudgets, [1_600]);
  assert.equal(f.signals.at(-1)!.aborted, true);
  f.clean();
});

test('liveness retries spend remaining budget instead of replenishing 30s', async (t) => {
  const f = fixture(t, { live: 'hang' });
  const report = await finish(t, f.run(35_000));
  assert.equal(Date.now(), 35_000);
  failure(report, 'liveness-200-ok');
  assert.equal(f.children.length, 2);
  assert.equal(f.signals.length, 2);
  assert.ok(f.signals.every((s) => s.aborted));
  assert.match(report.checks.find((c) => c.status === 'fail')!.detail, /attempt 2\/8/);
  f.clean();
});

for (const live of ['hang', 'ignore-abort', 'body-hang'] as const) {
  test(`${live} fetch is bounded, signaled and cleaned up`, async (t) => {
    const f = fixture(t, { live });
    const report = await finish(t, f.run(4_000));
    assert.equal(Date.now(), 4_000);
    failure(report, 'liveness-200-ok');
    assert.equal(f.signals.length, 1);
    assert.equal(f.signals[0]!.aborted, true);
    f.clean();
  });
}

for (const scenario of [{ live: 'wrong-first' as const }, { crashFirst: true }]) {
  test(`port retry defenses survive ${JSON.stringify(scenario)}`, async (t) => {
    const f = fixture(t, { ...scenario, listeningMs: null });
    const report = await finish(t, f.run(6_000));
    assert.equal(Date.now(), 6_000);
    failure(report, 'liveness-200-ok');
    assert.equal(f.children.length, 2);
    assert.notEqual(f.ports[0]!.port, f.ports[1]!.port);
    assert.match(report.checks.find((c) => c.status === 'fail')!.detail, scenario.crashFirst ? /EADDRINUSE/ : /200 \{\}/);
    f.clean();
  });
}

for (const phase of ['mock', 'port'] as const) {
  test(`late ${phase} startup is bounded and its eventual resource released`, async (t) => {
    const f = fixture(t, phase === 'mock' ? { startupMs: 3_000 } : { holdMs: 3_000 });
    const report = await finish(t, f.run(2_000));
    assert.equal(Date.now(), 2_000);
    failure(report, 'boot-probe-budget');
    assert.equal(f.children.length, 0);
    t.mock.timers.tick(1_000);
    await flush();
    f.clean();
  });
}

for (const phase of ['gateway', 'ready-line'] as const) {
  test(`stuck ${phase} cannot receive a fresh timeout`, async (t) => {
    const f = fixture(t, phase === 'gateway' ? { gatewayMs: 'hang' } : { readyLineMs: null });
    const report = await finish(t, f.run(4_000));
    assert.equal(Date.now(), 4_000);
    failure(report, phase === 'gateway' ? 'gateway-ready' : 'ready-line');
    if (phase === 'gateway') assert.deepEqual(f.gatewayBudgets, [2_500]);
    f.clean();
  });
}

test('healthy path preserves every check and gives shutdown its separate budget', async (t) => {
  const f = fixture(t, { stopDelay: 1_000 });
  const report = await finish(t, f.run(2_000));
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(Date.now(), 2_500);
  assert.equal(report.checks.filter((c) => c.status === 'pass').length, 9);
  assert.equal(report.checks.filter((c) => c.status === 'skip').length, 2);
  f.clean();
});

test('SIGTERM timeout and final mock disposal are separately bounded', async (t) => {
  const f = fixture(t, { refuseTerm: true, closeHangs: true });
  const report = await finish(t, f.run(2_000));
  assert.equal(Date.now(), 31_500); // 1.5s boot + 25s SIGTERM + 5s disposal
  failure(report, 'clean-sigterm-shutdown', false);
  assert.ok(f.children[0]!.kills.includes('SIGKILL'));
  f.clean();
});

test('port-release fetch timeout is not mistaken for a refused connection', async (t) => {
  const f = fixture(t, { portAfterStop: 'hang' });
  const report = await finish(t, f.run(2_000));
  assert.equal(Date.now(), 11_500);
  failure(report, 'port-released', false);
  assert.equal(f.signals.at(-1)!.aborted, true);
  f.clean();
});

test('response-body failure after shutdown is not mistaken for a released port', async (t) => {
  const f = fixture(t, { portAfterStop: 'body-error' });
  const report = await finish(t, f.run(2_000));
  assert.equal(Date.now(), 11_500);
  failure(report, 'port-released', false);
  assert.ok(f.signals.length > 1, 'probe kept polling instead of certifying release on first headers');
  f.clean();
});

test('stalled holder release still kills child and closes mock after total deadline', async (t) => {
  const f = fixture(t, { releaseHangs: true });
  const report = await finish(t, f.run(2_000));
  assert.equal(Date.now(), 7_000); // 2s total + 5s disposal
  failure(report, 'boot-probe-budget');
  f.clean();
});

test('collision backoff is clipped and cannot start another child after expiry', async (t) => {
  const f = fixture(t, { crashFirst: true });
  const report = await finish(t, f.run(1_600));
  assert.equal(Date.now(), 1_600);
  failure(report, 'boot-probe-budget');
  assert.equal(f.children.length, 1);
  assert.match(report.checks.find((c) => c.status === 'fail')!.detail, /EADDRINUSE/);
  f.clean();
});

test('initial boot observation sleep is clipped to the shared deadline', async (t) => {
  const f = fixture(t);
  const report = await finish(t, f.run(500));
  assert.equal(Date.now(), 500);
  failure(report, 'boot-probe-budget');
  assert.equal(f.children.length, 1);
  f.clean();
});

test('invalid total budget is refused before any startup', async (t) => {
  const f = fixture(t);
  for (const timeout of [0, -1, Infinity, NaN]) {
    await assert.rejects(f.run(timeout), /positive finite/);
  }
  assert.equal(f.mocks.length, 0);
  assert.equal(f.ports.length, 0);
  assert.equal(f.children.length, 0);
});
