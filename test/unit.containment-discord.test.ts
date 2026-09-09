import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainmentDiscord } from '../src/moderation/containmentDiscord.ts';

const GUILD = '1545644954272137297';
const BOT = '1469137636663758888';
const USER = '111111111111111111';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('quarantine removes only dangerous roles below Owen', async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ method: init?.method ?? 'GET', path });
    if (path === `/api/v10/guilds/${GUILD}/members/${USER}`) return json({ roles: ['safe', 'danger'] });
    if (path === `/api/v10/guilds/${GUILD}/members/${BOT}`) return json({ roles: ['owen'] });
    if (path === `/api/v10/guilds/${GUILD}/roles`) return json([
      { id: 'safe', position: 1, permissions: '2048' },
      { id: 'danger', position: 2, permissions: String(1n << 28n) },
      { id: 'owen', position: 10, permissions: String(1n << 28n) },
    ]);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return json({}, 404);
  };
  const discord = new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://localhost/api/v10', fetchImpl });
  const result = await discord.quarantine(GUILD, USER, 'incident');
  assert.deepEqual(result, { removedRoleIds: ['danger'], skippedRoleIds: [] });
  assert.deepEqual(requests.filter((request) => request.method === 'DELETE').map((request) => request.path), [
    `/api/v10/guilds/${GUILD}/members/${USER}/roles/danger`,
  ]);
});

test('quarantine refuses before writes when a dangerous role is not below Owen', async () => {
  let writes = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'DELETE') writes++;
    if (path === `/api/v10/guilds/${GUILD}/members/${USER}`) return json({ roles: ['danger'] });
    if (path === `/api/v10/guilds/${GUILD}/members/${BOT}`) return json({ roles: ['owen'] });
    if (path === `/api/v10/guilds/${GUILD}/roles`) return json([
      { id: 'danger', position: 10, permissions: String(1n << 3n) },
      { id: 'owen', position: 5, permissions: String(1n << 28n) },
    ]);
    return json({}, 404);
  };
  const discord = new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://localhost/api/v10', fetchImpl });
  await assert.rejects(() => discord.quarantine(GUILD, USER, 'incident'), /cannot safely remove every dangerous role/);
  assert.equal(writes, 0);
});
