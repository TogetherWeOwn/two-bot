import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import {
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  TWO_STAGING_GUILD_ID,
} from '../src/staging/spec.ts';

// Fixture-driven acceptance for scripts/self-role-panel.ts (TOG-5701).
//
// Every case runs the script as a subprocess against a loopback counting
// server: any network dial-out is a failure, so "does not touch live guild"
// is asserted, not assumed. The token is minted offline the same way
// unit.selfrolepanel-script.test.ts does (base64url app id + suffix) and the
// dry-run path returns before any fetch, so no credential ever leaves.

const run = promisify(execFile);
const CHANNEL = '111111111111111111';
const MESSAGE = '222222222222222222';
const tokenFor = (id: string) => `${Buffer.from(id).toString('base64url')}.mock.signature`;

const fixturePanels = JSON.stringify([{
  id: 'games',
  channelId: CHANNEL,
  messageId: MESSAGE,
  mode: 'button',
  exclusive: false,
  color: false,
  options: [
    { key: 'red', label: 'Red', roleId: '333333333333333333', permissions: '0' },
    { key: 'green', label: 'Green', roleId: '444444444444444444', permissions: '0' },
    { key: 'blue', label: 'Blue', roleId: '555555555555555555', permissions: '0' },
  ],
}]);

let server: Server;
let baseUrl = '';
let hits = 0;

before(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TWO_SELF_ROLE_PANELS: fixturePanels,
    DISCORD_STAGING_GUILD_ID: TWO_STAGING_GUILD_ID,
    DISCORD_STAGING_BOT_TOKEN: tokenFor(STAGING_BOT_APPLICATION_ID),
    SELF_ROLE_PANEL_API_BASE: baseUrl,
    ...extra,
  };
}

test('dry-run renders every configured role and touches no network', async () => {
  hits = 0;
  const { stdout } = await run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'games'], { env: env() });
  const body = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)) as {
    content: string;
    components: Array<{ components: Array<{ label: string; custom_id: string }> }>;
  };
  assert.equal(body.content, 'Choose any roles.');
  const buttons = body.components.flatMap((row) => row.components);
  assert.deepEqual(buttons.map((b) => b.label), ['Red', 'Green', 'Blue']);
  assert.deepEqual(
    buttons.map((b) => b.custom_id),
    ['two:self-role:games:red', 'two:self-role:games:green', 'two:self-role:games:blue'],
  );
  assert.match(stdout, /Dry run\. Nothing was posted/);
  assert.equal(hits, 0);
});

test('dry-run rejects invalid config before network', async () => {
  const cases = [
    { name: 'malformed JSON', panels: 'not json', match: /must be valid JSON/ },
    {
      name: 'empty options',
      panels: JSON.stringify([{ id: 'games', channelId: CHANNEL, messageId: MESSAGE, mode: 'button', options: [] }]),
      match: /options must be a non-empty array/,
    },
    {
      name: 'disallowed permission',
      panels: JSON.stringify([{
        id: 'games',
        channelId: CHANNEL,
        messageId: MESSAGE,
        mode: 'button',
        options: [{ key: 'admin', label: 'Admin', roleId: '333333333333333333', permissions: '8' }],
      }]),
      match: /disallowed permission Administrator/,
    },
  ];
  for (const { name, panels, match } of cases) {
    hits = 0;
    await assert.rejects(
      run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'games'], { env: env({ TWO_SELF_ROLE_PANELS: panels }) }),
      (err: unknown) => {
        assert.match(String((err as { stderr?: string }).stderr), match, name);
        return true;
      },
      name,
    );
    assert.equal(hits, 0, name);
  }
});

test('dry-run refuses the live guild id before network', async () => {
  hits = 0;
  await assert.rejects(
    run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'games'], { env: env({ DISCORD_STAGING_GUILD_ID: LIVE_GUILD_ID }) }),
    (err: unknown) => String((err as { stderr?: string }).stderr).includes('must be the TWO Staging guild'),
  );
  assert.equal(hits, 0);
});
