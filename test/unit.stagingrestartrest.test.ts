import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Events, REST } from 'discord.js';
import { createClient } from '../src/discord/client.ts';
import { startMockDiscord } from '../tools/mock-discord/server.ts';
import { stagingRestartWriteAttempts } from './helpers/stagingRestartWriteAttempts.ts';
import { createRestartFetch, restartRestBase } from '../src/staging/restartRest.ts';

const api = 'https://discord.com/api';
const base = `${api}/v10`;
const refusal = /^Error: Staging restart REST request refused\.$/;

test('public SDK writes reject under the guard but reach the loopback server without it',
  { timeout: 30_000 }, async () => {
    const mock = await startMockDiscord();
    const client = createClient(false, {});
    client.rest.options.api = mock.apiBase;
    client.rest.options.retries = 0;
    const ordinaryRequest = client.rest.options.makeRequest;
    try {
      const ready = once(client, Events.ClientReady);
      await client.login('inert-local-token');
      await ready;
      const attempts = stagingRestartWriteAttempts(client, mock.guildId, mock.textChannelId);
      client.rest.options.makeRequest = createRestartFetch(mock.apiBase);
      for (const attempt of Object.values(attempts)) await assert.rejects(attempt, refusal);
      assert.equal(mock.captured.length, 0, 'not even one write may reach the fixture server');

      // Counterfactual: these exact operations must reach HTTP without the guard.
      // The minimal mock has no command collection response, so registry response
      // parsing may reject AFTER its recorded PUT. Only wire reachability is claimed.
      client.rest.options.makeRequest = ordinaryRequest;
      await Promise.allSettled(Object.values(attempts).map((attempt) => attempt()));
      assert.equal(mock.captured.length, 4);
      const puts = mock.captured.filter((request) => request.method === 'PUT');
      assert.deepEqual(puts.map((request) => request.url).sort(), [
        `/api/v10/applications/${client.application!.id}/commands`,
        `/api/v10/applications/${client.application!.id}/guilds/${mock.guildId}/commands`,
      ].sort());
      const posts = mock.captured.filter((request) => request.method === 'POST');
      assert.equal(posts.length, 2);
      assert.ok(posts.some((request) => request.url === `/api/v10/channels/${mock.textChannelId}/messages`));
      assert.equal(new Set(posts.map((request) => request.url)).size, 2,
        'designated and unrelated channel writes must have distinct wire destinations');
    } finally {
      await client.destroy();
      await mock.close();
    }
  });

test('restart REST permits only canonical Discord or explicit loopback fixture bases', () => {
  assert.equal(restartRestBase(), base);
  assert.equal(restartRestBase('http://127.0.0.1:12345/api'), 'http://127.0.0.1:12345/api/v10');
  for (const value of [
    '', `${api}/`, `${api}?x`, `${api}#x`, 'https://discord.com:443/api',
    'https://DISCORD.com/api', 'https://user@discord.com/api', 'https://discord.com./api',
    'https://discord.com/x/../api', 'http://discord.com/api', 'https://example.invalid/api',
    'http://localhost:12345/api', 'http://127.0.0.1/api', 'http://127.0.0.1:80/api',
    'http://127.0.0.1:12345/x/../api', 'http://[::1]:12345/api',
  ]) assert.throws(() => createRestartFetch(value), refusal);
});

test('restart REST rejects every mutation and unknown read before calling the transport', async () => {
  let calls = 0;
  const guarded = createRestartFetch(api, async () => { calls++; return new Response('{}'); });
  const paths = [
    '/applications/111111111111111111/commands',
    '/applications/111111111111111111/guilds/222222222222222222/commands/333333333333333333',
    '/channels/111111111111111111/messages', '/channels/111111111111111111/messages/222222222222222222',
    '/guilds/111111111111111111/members/222222222222222222/roles/333333333333333333',
    '/guilds/111111111111111111/members/222222222222222222',
    '/interactions/111111111111111111/inert/callback', '/webhooks/111111111111111111/inert',
    '/users/@me/channels', '/gateway/bot', '/users/@me',
  ];
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'get', '', null, 0, false, {}]) {
    for (const path of paths) await assert.rejects(guarded(`${base}${path}`, { method }), refusal);
  }
  for (const path of paths.slice(0, -2)) await assert.rejects(guarded(`${base}${path}`), refusal);
  for (const url of [
    `${base}/gateway/bot?x=1`, `${base}/gateway/bot#x`, `${base}/gateway/%62ot`,
    `${base}/gateway/./bot`, `${base}/x/../gateway/bot`, `${base}//gateway/bot`,
    `${base}/gateway/bot/`, `${base}/gateway/bot\n`,
    'https://discord.com:443/api/v10/gateway/bot', 'https://user@discord.com/api/v10/gateway/bot',
    'https://example.invalid/api/v10/gateway/bot',
  ]) await assert.rejects(guarded(url), refusal);
  await assert.rejects(guarded(new Request(`${base}/gateway/bot`)), refusal);
  await assert.rejects(guarded(new URL(`${base}/gateway/bot`)), refusal);
  for (const body of ['', '{}', new Uint8Array()]) {
    await assert.rejects(guarded(`${base}/gateway/bot`, { body }), refusal);
  }
  for (const name of ['Host', 'Cookie', 'X-HTTP-Method-Override', 'X-Method-Override']) {
    await assert.rejects(guarded(`${base}/gateway/bot`, { headers: { [name]: 'inert' } }), refusal);
  }
  assert.equal(calls, 0);
  assert.equal((await guarded(`${base}/gateway/bot`)).status, 200);
  assert.equal((await guarded(`${base}/users/@me`, { method: 'GET' })).status, 200);
  assert.equal(calls, 2, 'positive controls prove the delegate is reachable');
});

test('restart REST copies only safe options and redacts delegate failures', async () => {
  const controller = new AbortController();
  const guarded = createRestartFetch(api, async (input, init) => {
    assert.equal(input, `${base}/users/@me`);
    assert.deepEqual(Object.keys(init!).sort(), ['headers', 'method', 'redirect', 'signal']);
    assert.equal(init!.redirect, 'error');
    assert.equal(init!.signal, controller.signal);
    assert.equal(new Headers(init!.headers).get('authorization'), 'Bot inert');
    throw new Error('SECRET delegate details');
  });
  const options = {
    method: 'GET', headers: { authorization: 'Bot inert' }, signal: controller.signal,
    redirect: 'follow' as const, dispatcher: 'untrusted', agent: 'untrusted', credentials: 'include' as const,
  };
  await assert.rejects(guarded(`${base}/users/@me`, options), refusal);
  let cancelled = false;
  const redirect = createRestartFetch(api, async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status: 302, headers: { location: 'https://example.invalid' } }));
  await assert.rejects(redirect(`${base}/gateway/bot`), refusal);
  assert.equal(cancelled, true);
});

test('discord.js REST writes cannot reach local server; real reads work and redirects never follow', async () => {
  const requests: string[] = [];
  let redirect = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (redirect) {
      res.writeHead(302, { location: '/forbidden-target' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"inert"}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}/api`;
  const guarded = createRestartFetch(local);
  const rest = new REST({ api: local, version: '10', makeRequest: guarded, retries: 0 }).setToken('inert');
  try {
    assert.deepEqual(await rest.get('/users/@me'), { id: 'inert' });
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      for (const route of [
        '/applications/111111111111111111/commands', '/channels/111111111111111111/messages',
        '/guilds/111111111111111111/members/222222222222222222',
        '/guilds/111111111111111111/members/222222222222222222/roles/333333333333333333',
        '/interactions/111111111111111111/inert/callback', '/webhooks/111111111111111111/inert',
      ] as const) await assert.rejects(rest[method](route, { body: {} }), refusal);
    }
    await assert.rejects(rest.get('/guilds/111111111111111111/members'), refusal);
    await assert.rejects(guarded(`${local}/v10/channels/111111111111111111/messages`, { method: 'POST' }), refusal);
    assert.deepEqual(requests, ['GET /api/v10/users/@me']);
    redirect = true;
    await assert.rejects(rest.get('/gateway/bot'), refusal);
    assert.deepEqual(requests, ['GET /api/v10/users/@me', 'GET /api/v10/gateway/bot']);
  } finally {
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
