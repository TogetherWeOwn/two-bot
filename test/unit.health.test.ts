/**
 * The container health endpoint (TOG-13). No token, no Discord, no database.
 *
 * The case worth testing is the cold start: a bot that is up but still
 * connecting must answer liveness 200 and readiness 503. Getting that backwards
 * makes the platform restart a bot that was seconds from being fine, on every
 * deploy, which is how a crash loop against Discord's identify budget starts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReadiness, startHealthServer, type HealthProbes } from '../src/core/health.ts';

/** Both probes healthy unless a test says otherwise. */
function probes(over: Partial<HealthProbes> = {}): HealthProbes {
  return {
    gatewayReady: () => true,
    databaseReady: async () => true,
    ...over,
  };
}

test('readiness passes when the gateway is up and the database answers', async () => {
  assert.deepEqual(await evaluateReadiness(probes()), { ready: true });
});

test('readiness names the gateway when it is not connected', async () => {
  const result = await evaluateReadiness(probes({ gatewayReady: () => false }));
  assert.deepEqual(result, { ready: false, reason: 'gateway_disconnected' });
});

test('readiness names the database when it does not answer', async () => {
  const result = await evaluateReadiness(probes({ databaseReady: async () => false }));
  assert.deepEqual(result, { ready: false, reason: 'database_unreachable' });
});

test('a disconnected gateway short-circuits the database probe', async () => {
  // On a cold start the database question is noise, and asking it once a second
  // puts pointless load on the pool while the bot is still connecting.
  let asked = false;
  const result = await evaluateReadiness(
    probes({
      gatewayReady: () => false,
      databaseReady: async () => {
        asked = true;
        return true;
      },
    }),
  );
  assert.equal(result.ready, false);
  assert.equal(asked, false, 'database must not be probed while the gateway is down');
});

test('a throwing database probe is not ready rather than an exception', async () => {
  // An exception escaping here would surface as a 500, which a platform reads
  // as "broken" rather than "not yet" - and those get answered differently.
  const result = await evaluateReadiness(
    probes({
      databaseReady: async () => {
        throw new Error('connection refused');
      },
    }),
  );
  assert.deepEqual(result, { ready: false, reason: 'database_unreachable' });
});

/** Bind an ephemeral port on loopback; returns the server and a fetch helper. */
async function serve(p: HealthProbes) {
  const server = await startHealthServer({ ...p, host: '127.0.0.1', port: 0 });
  const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);
  return { server, get };
}

test('liveness is 200 even while the gateway is still connecting', async () => {
  // The whole point of splitting the two endpoints.
  const { server, get } = await serve(probes({ gatewayReady: () => false }));
  try {
    const res = await get('/healthz');
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), 'ok');
  } finally {
    await server.close();
  }
});

test('readiness answers 503 with the reason, not 500', async () => {
  const { server, get } = await serve(probes({ gatewayReady: () => false }));
  try {
    const res = await get('/readyz');
    assert.equal(res.status, 503);
    assert.equal((await res.text()).trim(), 'gateway_disconnected');
  } finally {
    await server.close();
  }
});

test('readiness answers 200 when everything is up', async () => {
  const { server, get } = await serve(probes());
  try {
    const res = await get('/readyz');
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

test('unknown paths are 404 and other methods are 405', async () => {
  const { server, get } = await serve(probes());
  try {
    assert.equal((await get('/')).status, 404);
    assert.equal((await get('/metrics')).status, 404);
    const post = await fetch(`http://127.0.0.1:${server.port}/healthz`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await server.close();
  }
});

test('a query string does not defeat the route match', async () => {
  // Probes and proxies append cache-busters.
  const { server, get } = await serve(probes());
  try {
    assert.equal((await get('/healthz?t=1')).status, 200);
  } finally {
    await server.close();
  }
});

test('close releases the port', async () => {
  const { server } = await serve(probes());
  const port = server.port;
  await server.close();
  // Rebinding the same port proves the listener is gone; a leaked handle here
  // would hang the shutdown path in index.ts instead of failing a test.
  const again = await startHealthServer({ ...probes(), host: '127.0.0.1', port });
  assert.equal(again.port, port);
  await again.close();
});
