import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestDiscordJson } from '../src/discord/rateLimit.ts';

function response(status: number, body: unknown, headers: Record<string, string> = {}): StubResponse {
  return { status, body, headers };
}

type StubResponse = { status: number; body: unknown; headers?: Record<string, string> };

function requester(responses: StubResponse[], options: { maxRetries?: number; maxRetryAfterMs?: number } = {}) {
  const calls: Array<{ url: string; authorization: string | null; method: string; contentType: string | null }> = [];
  const sleeps: number[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get('authorization'),
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type'),
    });
    const current = responses[Math.min(index++, responses.length - 1)]!;
    return new Response(current.body === undefined ? null : JSON.stringify(current.body), {
      status: current.status,
      headers: { 'content-type': 'application/json', ...current.headers },
    });
  }) as typeof fetch;

  return {
    calls,
    sleeps,
    get: <T>(url = 'https://discord.test/channels/1/messages') =>
      requestDiscordJson<T>(url, {
        token: 'staging-token',
        fetchImpl,
        sleep: async (ms) => void sleeps.push(ms),
        ...options,
      }),
    post: <T>(url = 'https://discord.test/guilds/1/channels', body: unknown = { name: 'probe' }) =>
      requestDiscordJson<T>(url, {
        token: 'staging-token',
        method: 'POST',
        body,
        fetchImpl,
        sleep: async (ms) => void sleeps.push(ms),
        ...options,
      }),
  };
}

test('Discord GET obeys body retry_after, then returns the successful marker page', async () => {
  const request = requester([
    response(429, { retry_after: 1.5 }, { 'retry-after': '1' }),
    response(200, [{ id: 'marker-1' }]),
  ]);

  const result = await request.get<Array<{ id: string }>>();

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, [{ id: 'marker-1' }]);
  assert.deepEqual(request.sleeps, [1750]);
  assert.equal(request.calls.length, 2);
  assert.ok(request.calls.every((call) => call.authorization === 'Bot staging-token'));
});

test('Discord GET falls back to the retry-after header when the body has no delay', async () => {
  const request = requester([
    response(429, { message: 'rate limited' }, { 'retry-after': '2' }),
    response(200, []),
  ]);

  const result = await request.get<unknown[]>();

  assert.equal(result.status, 200);
  assert.deepEqual(request.sleeps, [2250]);
});

test('Discord GET clamps retry_after and returns 429 after the bounded retry budget', async () => {
  const request = requester([response(429, { retry_after: 86_400 })], {
    maxRetries: 2,
    maxRetryAfterMs: 30_000,
  });

  const result = await request.get();

  assert.equal(result.status, 429);
  assert.equal(request.calls.length, 3, 'one initial request plus two retries');
  assert.deepEqual(request.sleeps, [30_000, 30_000]);
});

test('Discord POST retries a 429 with its method, auth header and JSON body intact', async () => {
  const request = requester([
    response(429, { retry_after: 0.5 }, { 'retry-after': '1' }),
    response(201, { id: 'chan-1', name: 'probe' }),
  ]);

  const result = await request.post<{ id: string; name: string }>();

  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { id: 'chan-1', name: 'probe' });
  assert.deepEqual(request.sleeps, [750]);
  assert.equal(request.calls.length, 2);
  assert.ok(request.calls.every((call) => call.method === 'POST'));
  assert.ok(request.calls.every((call) => call.authorization === 'Bot staging-token'));
  assert.ok(request.calls.every((call) => call.contentType === 'application/json'));
});
