/**
 * The harness self-test probe (TOG-6497).
 *
 * The one canned probe answers 200 with a gateway url against a real booted
 * mock, and a broken mock URL fails with the named `mock_unreachable` error -
 * never a fetch stack. The non-200 and missing-url cases answer against an
 * injected fetch so no socket is opened for them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { E2eSelftestError, runSelftestProbe } from '../src/e2e/selftest.ts';
import { startMockDiscord } from '../tools/mock-discord/server.ts';

test('the canned probe passes against a booted mock', async () => {
  const mock = await startMockDiscord();
  try {
    const result = await runSelftestProbe({ apiBase: mock.apiBase });
    assert.equal(result.probe, 'gateway-bot');
    assert.match(result.gatewayUrl, /^ws:\/\/127\.0\.0\.1:\d+\/gw$/);
  } finally {
    await mock.close();
  }
});

test('a broken mock URL fails with the named mock_unreachable error', async () => {
  // Port 1 is never listening: the refusal is deterministic, no race.
  await assert.rejects(
    () => runSelftestProbe({ apiBase: 'http://127.0.0.1:1/api' }),
    (err: unknown) =>
      err instanceof E2eSelftestError &&
      err.code === 'mock_unreachable' &&
      /never answered/.test(err.message),
  );
});

test('a non-200 answer fails with the named mock_probe_failed error', async () => {
  await assert.rejects(
    () =>
      runSelftestProbe({
        apiBase: 'http://127.0.0.1:9/api',
        fetchImpl: async () => new Response('nope', { status: 500 }),
      }),
    (err: unknown) =>
      err instanceof E2eSelftestError && err.code === 'mock_probe_failed',
  );
});

test('a 200 without a gateway url fails with the named mock_probe_failed error', async () => {
  await assert.rejects(
    () =>
      runSelftestProbe({
        apiBase: 'http://127.0.0.1:9/api',
        fetchImpl: async () => Response.json({ shards: 1 }),
      }),
    (err: unknown) =>
      err instanceof E2eSelftestError && err.code === 'mock_probe_failed',
  );
});
