import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const run = promisify(execFile);
const CHANNEL = '111111111111111111';
const MESSAGE = '222222222222222222';
const tokenFor = (id: string) => `${Buffer.from(id).toString('base64url')}.mock.signature`;
const panels = JSON.stringify([{ id: 'colors', channelId: CHANNEL, messageId: MESSAGE, mode: 'button', exclusive: true, color: true, options: [{ key: 'red', label: 'Red', roleId: '333333333333333333', permissions: '0' }] }]);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, TWO_SELF_ROLE_PANELS: panels, DISCORD_STAGING_GUILD_ID: TWO_STAGING_GUILD_ID, DISCORD_STAGING_BOT_TOKEN: tokenFor(STAGING_BOT_APPLICATION_ID), ...extra };
}

test('self-role apply rejects an arbitrary non-live guild before network', async () => {
  await assert.rejects(
    run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'colors', '--apply'], { env: env({ DISCORD_STAGING_GUILD_ID: '1555555555555555555' }) }),
    (err: unknown) => String((err as { stderr?: string }).stderr).includes('must be the TWO Staging guild'),
  );
});

test('self-role apply rejects unknown token identity before network', async () => {
  await assert.rejects(
    run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'colors', '--apply'], { env: env({ DISCORD_STAGING_BOT_TOKEN: 'garbage' }) }),
    (err: unknown) => String((err as { stderr?: string }).stderr).includes('refusing application unknown'),
  );
});

test('self-role apply checks the channel guild before posting', async () => {
  let posts = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === `/channels/${CHANNEL}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ guild_id: '999999999999999999' }));
      return;
    }
    posts++;
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await assert.rejects(
      run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'colors', '--apply'], { env: env({ SELF_ROLE_PANEL_API_BASE: `http://127.0.0.1:${address.port}` }) }),
      (err: unknown) => String((err as { stderr?: string }).stderr).includes('expected ' + TWO_STAGING_GUILD_ID),
    );
    assert.equal(posts, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
