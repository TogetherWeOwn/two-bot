import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuildConfigDiscordApi } from '../src/discord/guildConfigApi.ts';
import { createRestartFetch } from '../src/staging/restartRest.ts';
import type { GuildConfigEmoji } from '../src/redesign/guildConfig.ts';

const refusal = /^Error: Staging restart REST request refused\.$/;

function apiWithGuard(transport?: typeof fetch): { api: GuildConfigDiscordApi; calls: string[] } {
  const calls: string[] = [];
  const spy = (async (input: unknown, init?: unknown) => {
    calls.push(typeof input === 'string' ? input : String(input));
    return transport
      ? transport(input as string, init as RequestInit)
      : new Response('{}', { status: 200 });
  }) as typeof fetch;
  const guarded = createRestartFetch(undefined, spy) as unknown as typeof fetch;
  const api = new GuildConfigDiscordApi({
    token: 'inert',
    applicationId: '111111111111111111',
    guildId: '222222222222222222',
    fetchImpl: guarded,
  });
  return { api, calls };
}

const emoji: GuildConfigEmoji = {
  id: '333333333333333333',
  name: 'owen',
  roles: [],
  require_colons: true,
  managed: false,
  animated: false,
  available: true,
};

test('guild config write is refused before the delegate is reached', async () => {
  const { api, calls } = apiWithGuard();
  await assert.rejects(api.write('POST', '/guilds/222222222222222222/channels', { name: 'x' }), refusal);
  await assert.rejects(api.request('PATCH', '/guilds/222222222222222222/roles/444444444444444444', {}), refusal);
  await assert.rejects(api.request('DELETE', '/guilds/222222222222222222/emojis/333333333333333333'), refusal);
  assert.equal(calls.length, 0, 'refusals must not reach the transport');
  assert.equal(api.writes, 0);
});

test('guild config CDN read is refused before the delegate is reached', async () => {
  const { api, calls } = apiWithGuard();
  await assert.rejects(api.captureEmojiImage(emoji), refusal);
  assert.equal(calls.length, 0, 'CDN reads are outside the canonical startup set');
});

test('guild config capture works through a normal injected fetch', async () => {
  const seen: string[] = [];
  const stub = (async (input: unknown) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith('/emojis/333333333333333333.png')) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    const bodies: Record<string, unknown> = {
      '/guilds/222222222222222222': { id: '222222222222222222', owner_id: '111111111111111111' },
      '/guilds/222222222222222222/roles': [],
      '/guilds/222222222222222222/channels': [],
      '/guilds/222222222222222222/emojis': [{ ...emoji }],
    };
    const path = url.replace('https://discord.com/api/v10', '');
    return new Response(JSON.stringify(bodies[path] ?? null), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const api = new GuildConfigDiscordApi({
    token: 'inert',
    applicationId: '111111111111111111',
    guildId: '222222222222222222',
    fetchImpl: stub,
  });
  const snapshot = await api.capture();
  assert.equal(snapshot.guildId, '222222222222222222');
  assert.equal(snapshot.emojis.length, 1);
  assert.match(snapshot.emojis[0]?.image ?? '', /^data:image\/png;base64,/);
  assert.ok(seen.length >= 5, 'API reads plus the CDN read all use the injected transport');
});

test('guild config without fetchImpl reads global fetch at call time', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ id: '111111111111111111' }), { status: 200 });
  }) as typeof fetch;
  try {
    const api = new GuildConfigDiscordApi({
      token: 'inert',
      applicationId: '111111111111111111',
      guildId: '222222222222222222',
    });
    const result = await api.request<{ id: string }>('GET', '/users/@me');
    assert.equal(result.status, 200);
    assert.equal(result.body?.id, '111111111111111111');
    assert.deepEqual(seen, ['https://discord.com/api/v10/users/@me']);
  } finally {
    globalThis.fetch = original;
  }
});
