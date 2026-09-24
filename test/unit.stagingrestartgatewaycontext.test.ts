import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Encoding, type FetchingStrategyOptions, type IContextFetchingStrategy, type SessionInfo } from '@discordjs/ws';
import { createRestartGatewayContext, restartGatewayEndpoint } from '../src/staging/restartGatewayContext.ts';

const endpoint = 'wss://gateway.discord.gg';
const refusal = { message: 'Staging gateway context refused.' };
const valid: SessionInfo = { resumeURL: endpoint, sequence: 1, sessionId: 'fixture-session', shardId: 0, shardCount: 1 };
function fixture() {
  const options: FetchingStrategyOptions = {
    gatewayInformation: { url: endpoint, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 1000, max_concurrency: 1 } },
    token: 'inert', intents: 0, shardCount: 1, encoding: Encoding.JSON, version: '10', compression: null,
    initialPresence: null, largeThreshold: null, identifyProperties: { os: 'fixture', browser: 'fixture', device: 'fixture' },
    handshakeTimeout: 1000, helloTimeout: 1000, readyTimeout: 1000,
  };
  const reads: number[] = [];
  const writes: (SessionInfo | null)[] = [];
  const waits: [number, AbortSignal][] = [];
  let value: SessionInfo | null = null;
  const delegate: IContextFetchingStrategy = {
    options,
    retrieveSessionInfo(id) { reads.push(id); return value; },
    updateSessionInfo(_id, next) { writes.push(next); value = next; },
    async waitForIdentify(id, signal) { waits.push([id, signal]); signal.throwIfAborted(); },
  };
  return { delegate, options, reads, writes, waits, set: (next: SessionInfo | null) => { value = next; } };
}

test('gateway endpoint pins canonical Discord or an explicitly bound local fixture', () => {
  assert.equal(restartGatewayEndpoint(), endpoint);
  assert.equal(restartGatewayEndpoint('ws://127.0.0.1:12345/gw'), 'ws://127.0.0.1:12345/gw');
  for (const bad of [
    '', `${endpoint}/`, `${endpoint}:443`, `${endpoint}?x`, `${endpoint}#x`, 'wss://GATEWAY.discord.gg',
    'wss://gateway.discord.gg.evil.invalid', 'wss://user@gateway.discord.gg', 'ws://gateway.discord.gg',
    'ws://localhost:12345/gw', 'ws://[::1]:12345/gw', 'ws://127.0.0.1/gw', 'ws://127.0.0.1:80/gw',
    'ws://user@127.0.0.1:12345/gw', 'ws://127.0.0.1:12345/../gw', 'ws://127.0.0.1:12345/gw?x',
  ]) assert.throws(() => restartGatewayEndpoint(bad), refusal);
});

test('gateway context rejects unbound destinations and protocol/shard changes before delegates run', () => {
  for (const patch of [
    { shardCount: 2 }, { version: '9' }, { encoding: 'etf' },
    { gatewayInformation: { ...fixture().options.gatewayInformation, url: 'ws://127.0.0.1:12345/gw' } },
  ]) {
    const f = fixture();
    Object.assign(f.options, patch);
    assert.throws(() => createRestartGatewayContext(f.delegate), refusal);
    assert.deepEqual([f.reads, f.writes, f.waits], [[], [], []]);
  }
  const f = fixture();
  f.options.gatewayInformation.url = 'ws://127.0.0.1:12345/gw';
  assert.equal(createRestartGatewayContext(f.delegate, f.options.gatewayInformation.url).options.gatewayInformation.url,
    f.options.gatewayInformation.url);
});

test('gateway context snapshots options and valid sessions without changing protocol facts', async () => {
  const f = fixture();
  const context = createRestartGatewayContext(f.delegate);
  f.options.gatewayInformation.url = 'wss://untrusted.invalid';
  Object.assign(f.options, { shardCount: 5 });
  f.options.identifyProperties.browser = 'changed';
  assert.equal(context.options.gatewayInformation.url, endpoint);
  assert.equal(context.options.shardCount, 1);
  assert.equal(context.options.identifyProperties.browser, 'fixture');
  assert.throws(() => { context.options.gatewayInformation.url = 'wss://untrusted.invalid'; }, TypeError);
  assert.equal(await context.retrieveSessionInfo(0), null);
  const input = { ...valid };
  await context.updateSessionInfo(0, input);
  input.resumeURL = 'wss://untrusted.invalid';
  assert.deepEqual(f.writes, [valid]);
  const stored = await context.retrieveSessionInfo(0);
  assert.deepEqual(stored, valid);
  assert.notEqual(stored, input);
  assert.throws(() => { stored!.resumeURL = 'wss://untrusted.invalid'; }, TypeError);
  await context.updateSessionInfo(0, null);
  assert.equal(await context.retrieveSessionInfo(0), null);
});

test('invalid incoming READY session never reaches persistence and permanently poisons this context', async () => {
  for (const patch of [
    { resumeURL: 'wss://untrusted.invalid' }, { resumeURL: 'ws://127.0.0.1:12345/gw' },
    { sequence: -1 }, { sequence: NaN }, { sequence: Infinity }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: '' }, { sessionId: 'a\nsecret' }, { sessionId: 'a'.repeat(129) },
    { shardId: 1 }, { shardCount: 2 }, { unexpected: 'private' },
  ]) {
    const f = fixture();
    const context = createRestartGatewayContext(f.delegate);
    await assert.rejects(context.updateSessionInfo(0, { ...valid, ...patch }), refusal);
    assert.equal(f.writes.length, 0);
    await assert.rejects(context.retrieveSessionInfo(0), refusal);
    await assert.rejects(context.updateSessionInfo(0, valid), refusal);
    await assert.rejects(context.waitForIdentify(0, new AbortController().signal), refusal);
    assert.deepEqual([f.reads, f.writes, f.waits], [[], [], []]);
  }
});

test('stored resume sessions and shard ids are revalidated before use', async () => {
  for (const patch of [{ resumeURL: 'wss://untrusted.invalid' }, { shardCount: 2 }, { sessionId: 'bad\n' }, { sequence: -1 }]) {
    const f = fixture(); f.set({ ...valid, ...patch });
    const context = createRestartGatewayContext(f.delegate);
    await assert.rejects(context.retrieveSessionInfo(0), refusal);
    f.set(valid);
    await assert.rejects(context.retrieveSessionInfo(0), refusal);
    assert.deepEqual(f.reads, [0]);
  }
  for (const id of [-1, 1, NaN, Infinity, 0.5]) {
    const f = fixture(); const context = createRestartGatewayContext(f.delegate);
    await assert.rejects(context.retrieveSessionInfo(id), refusal);
    assert.deepEqual(f.reads, []);
  }
});

test('an in-flight session read cannot escape a concurrent refusal', async () => {
  const f = fixture();
  let finish!: (value: SessionInfo) => void;
  f.delegate.retrieveSessionInfo = () => new Promise((resolve) => { finish = resolve; });
  const context = createRestartGatewayContext(f.delegate);
  const reading = context.retrieveSessionInfo(0);
  await assert.rejects(context.updateSessionInfo(0, { ...valid, resumeURL: 'wss://untrusted.invalid' }), refusal);
  finish(valid);
  await assert.rejects(reading, refusal);
});

test('context errors scrub delegate details, throttle aborts retain the public contract', async () => {
  const f = fixture();
  f.delegate.retrieveSessionInfo = () => { throw new Error('SECRET delegate details'); };
  await assert.rejects(createRestartGatewayContext(f.delegate).retrieveSessionInfo(0), refusal);
  const w = fixture();
  w.delegate.updateSessionInfo = () => { throw new Error('SECRET delegate details'); };
  await assert.rejects(createRestartGatewayContext(w.delegate).updateSessionInfo(0, valid), refusal);
  const t = fixture();
  t.delegate.waitForIdentify = async () => { throw new Error('SECRET delegate details'); };
  await assert.rejects(createRestartGatewayContext(t.delegate).waitForIdentify(0, new AbortController().signal), refusal);
  const a = fixture(); const context = createRestartGatewayContext(a.delegate);
  const controller = new AbortController();
  await context.waitForIdentify(0, controller.signal);
  assert.deepEqual(a.waits, [[0, controller.signal]]);
  controller.abort();
  await assert.rejects(context.waitForIdentify(0, controller.signal), { name: 'AbortError' });
});
