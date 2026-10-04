import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { proveGrantRevoke } from '../src/selfRoles/proof.ts';
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';
import type { SelfRolePanel } from '../src/selfRoles/types.ts';

// TOG-7183: `npm run self-role:panel` dry-run must prove the panel grants the
// configured role to a disposable test member and revokes it again, without
// touching the network or any live guild role. No database: the proof runs the
// same role planner the live dispatch uses against an in-memory role set.

const run = promisify(execFile);
const CHANNEL = '111111111111111111';
const MESSAGE = '222222222222222222';
const ROLE = '333333333333333333';
const tokenFor = (id: string) => `${Buffer.from(id).toString('base64url')}.mock.signature`;

function panelFor(mode: SelfRolePanel['mode']): SelfRolePanel {
  return {
    id: 'proof',
    channelId: CHANNEL,
    messageId: MESSAGE,
    mode,
    exclusive: false,
    color: false,
    options: [{ key: 'red', label: 'Red', roleId: ROLE, permissions: '0', emoji: '🔴' }],
  };
}

for (const mode of ['button', 'select', 'reaction'] as const) {
  test(`proveGrantRevoke grants then revokes in ${mode} mode`, () => {
    const lines = proveGrantRevoke(panelFor(mode));
    assert.equal(lines.length, 2);
    assert.match(lines[0], new RegExp(`^grant: disposable member \\S+ now holds role ${ROLE} \\("Red"\\)$`));
    assert.match(lines[1], new RegExp(`^revoke: disposable member \\S+ no longer holds role ${ROLE}$`));
  });
}

test('proveGrantRevoke covers the exclusive color panel shape', () => {
  const lines = proveGrantRevoke({ ...panelFor('button'), id: 'colors', exclusive: true, color: true });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^grant:/);
  assert.match(lines[1], /^revoke:/);
});

test('proveGrantRevoke fails closed on an empty panel', () => {
  assert.throws(() => proveGrantRevoke({ ...panelFor('button'), options: [] }), /has no options to prove/);
});

let server: Server;
let baseUrl = '';
let hits = 0;
// Same nonce-prefix scoping as unit.selfrolepanel-acceptance.test.ts (TOG-7982):
// only traffic aimed at our own base URL counts; stray loopback scans from
// sibling suites on the shared CI host are ignored.
const nonce = randomBytes(16).toString('hex');
const prefix = `/${nonce}`;

before(async () => {
  server = createServer((req, res) => {
    if ((req.url ?? '/').startsWith(`${prefix}/`) || req.url === prefix) hits++;
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TWO_SELF_ROLE_PANELS: JSON.stringify([panelFor('button')]),
    DISCORD_STAGING_GUILD_ID: TWO_STAGING_GUILD_ID,
    DISCORD_STAGING_BOT_TOKEN: tokenFor(STAGING_BOT_APPLICATION_ID),
    SELF_ROLE_PANEL_API_BASE: baseUrl,
    ...extra,
  };
}

test('dry-run prints grant+revoke and touches no network', async () => {
  hits = 0;
  const { stdout } = await run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'proof'], { env: env() });
  assert.match(stdout, new RegExp(`grant: disposable member \\S+ now holds role ${ROLE} \\("Red"\\)`));
  assert.match(stdout, new RegExp(`revoke: disposable member \\S+ no longer holds role ${ROLE}`));
  assert.match(stdout, /Dry run\. Nothing was posted/);
  assert.equal(hits, 0);
});
