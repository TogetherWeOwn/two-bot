import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REST } from 'discord.js';
import { WebSocketManager, WebSocketShardEvents, type IShardingStrategy } from '@discordjs/ws';
import { startMockDiscord } from '../tools/mock-discord/server.ts';
import { restartGatewayStrategy } from '../src/staging/restartGatewayStrategy.ts';
import { createRestartFetch } from '../src/staging/restartRest.ts';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const token = 'local-fixture-not-a-credential';

test('real socket observes identify but rejects every application-originated gateway opcode', { timeout: 15_000 }, async () => {
  const mock = await startMockDiscord();
  const rest = new REST({ api: mock.apiBase, makeRequest: createRestartFetch(mock.apiBase), retries: 0 }).setToken(token);
  const manager = new WebSocketManager({ token, rest, intents: 0,
    buildStrategy: restartGatewayStrategy(() => true, `ws://127.0.0.1:${mock.port}/gw`) });
  try {
    await manager.connect();
    await mock.waitForReady();
    assert.equal(mock.gatewayOpcodes.filter((op) => op === 2).length, 1, 'real shard identify reached the capture');
    for (const op of [0, 1, 2, 3, 4, 6, 8, 31, 43, -1, 999]) {
      const payload = { op, d: {} } as Parameters<IShardingStrategy['send']>[1];
      await assert.rejects(async () => manager.send(0, payload), { message: 'Staging gateway outbound refused.' });
    }
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    manager.on(WebSocketShardEvents.Dispatch, ({ data }) => { if (data.t as string === 'BARRIER') finish(); });
    mock.dispatch('BARRIER', {});
    await barrier;
    assert.equal(mock.gatewayOpcodes.filter((op) => op === 2).length, 1);
    assert.ok(mock.gatewayOpcodes.every((op) => op === 1 || op === 2), 'only shard-internal protocol frames');
    assert.equal(mock.captured.length, 0);
  } finally {
    await manager.destroy();
    rest.clearHashSweeper(); rest.clearHandlerSweeper();
    await mock.close();
  }
});

test('an unbound initial endpoint is rejected before socket authentication', { timeout: 15_000 }, async () => {
  const mock = await startMockDiscord();
  const rest = new REST({ api: mock.apiBase, makeRequest: createRestartFetch(mock.apiBase), retries: 0 }).setToken(token);
  // No explicit fixture pin: REST's loopback gateway URL must not be trusted.
  const manager = new WebSocketManager({ token, rest, intents: 0, buildStrategy: restartGatewayStrategy(() => true) });
  try {
    await assert.rejects(manager.connect(), { message: 'Staging gateway context refused.' });
    assert.deepEqual(mock.gatewayOpcodes, []);
    assert.equal((await manager.fetchStatus()).size, 0);
  } finally {
    await manager.destroy();
    rest.clearHashSweeper(); rest.clearHandlerSweeper();
    await mock.close();
  }
});

test('a poisoned stored session refuses connect rather than falling back to identify', { timeout: 15_000 }, async () => {
  const mock = await startMockDiscord();
  const rest = new REST({ api: mock.apiBase, makeRequest: createRestartFetch(mock.apiBase), retries: 0 }).setToken(token);
  const manager = new WebSocketManager({ token, rest, intents: 0,
    retrieveSessionInfo: () => ({ resumeURL: 'ws://127.0.0.1:1/gw', sequence: 1, sessionId: 'fixture-session', shardCount: 1, shardId: 0 }),
    buildStrategy: restartGatewayStrategy(() => true, `ws://127.0.0.1:${mock.port}/gw`) });
  try {
    await assert.rejects(manager.connect(), { message: 'Staging gateway context refused.' });
    assert.deepEqual(mock.gatewayOpcodes, [], 'not even a fallback identify');
  } finally {
    await manager.destroy();
    rest.clearHashSweeper(); rest.clearHandlerSweeper();
    await mock.close();
  }
});

test('malicious READY fails the real shard before persistence/forwarding and cleanup remains possible', { timeout: 15_000 }, async () => {
  const child = fileURLToPath(new URL('./helpers/stagingRestartGatewayPoison.ts', import.meta.url));
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [child], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, timeout: 10_000,
    }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === 'number' ? error.code : null : 0, stdout, stderr }));
  });
  assert.equal(code, 1, 'poisoned context must fail loudly, not report success');
  assert.equal(stdout.trim(), 'poison refused; no stored destination or forwarded READY; cleanup complete');
  assert.equal(stderr, '');
});
