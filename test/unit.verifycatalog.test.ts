/**
 * TOG-6482: `scripts/verify-catalog.ts` acceptance test on fixtures.
 *
 * The gap: the script had zero test-file references, so a corrupted catalog
 * row (deleted role, retargeted channel, managed role) would only surface
 * against live Discord. This pins the verdict three ways, with no token, no
 * database and no live Discord:
 *
 *   valid snapshot built from the real catalog -> zero fails;
 *   each corruption of one row -> exactly the named FAIL code, exit 1;
 *   the real script as a subprocess against a loopback stub -> same verdict.
 *
 * The reviewer acceptance is literal: corrupt one catalog row in the fixture
 * (change any roleId, delete any channel) and the run names the failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  ALL_PICKS,
  GAME_HUB_CHANNEL_ID,
  GAME_PICKS,
  GATED_CATEGORIES,
} from '../src/onboarding/catalog.ts';
import {
  VERIFY_CATALOG_MEMBER_ROLE_ID,
  VIEW_CHANNEL,
  canView,
  verifyCatalogSnapshot,
  type CatalogSnapshot,
} from '../scripts/verify-catalog.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/verify-catalog.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

// Fixture guild, bot and bot role. Nothing here is a live id: the catalog rows
// under test keep their real ids (that is the point - the check must pass on
// the real catalog), while the guild, bot and channels around them are canned.
const GUILD = '100000000000000001';
const BOT_USER = '100000000000000002';
const BOT_ROLE = '100000000000000010';
const BOT_TOP = 105;

const VIEW = String(VIEW_CHANNEL);
const NO_VIEW = '0';

/** A guild snapshot in which the real catalog verifies clean. */
function validSnapshot(): CatalogSnapshot {
  const roles: CatalogSnapshot['roles'] = [
    { id: GUILD, name: '@everyone', position: 0, managed: false, permissions: NO_VIEW },
    { id: BOT_ROLE, name: 'Prospect', position: BOT_TOP, managed: false, permissions: NO_VIEW },
    { id: VERIFY_CATALOG_MEMBER_ROLE_ID, name: 'Member', position: 50, managed: false, permissions: NO_VIEW },
    ...ALL_PICKS.map((p) => ({
      id: p.roleId,
      name: p.roleName,
      position: 10,
      managed: false,
      permissions: NO_VIEW,
    })),
  ];

  const channels: CatalogSnapshot['channels'] = [
    {
      id: GAME_HUB_CHANNEL_ID,
      name: 'game-hub',
      type: 0,
      permission_overwrites: [{ id: GUILD, type: 0, allow: VIEW, deny: NO_VIEW }],
    },
    ...GAME_PICKS.filter((p) => p.primaryChannelId).map((p) => ({
      id: p.primaryChannelId!,
      name: `${p.key}-general`,
      type: 0,
      permission_overwrites: [
        { id: GUILD, type: 0, allow: NO_VIEW, deny: VIEW },
        { id: p.roleId, type: 0, allow: VIEW, deny: NO_VIEW },
      ],
    })),
    ...GATED_CATEGORIES.flatMap((cat) => [
      {
        id: cat.categoryId,
        name: cat.categoryName,
        type: 4,
        permission_overwrites: [{ id: cat.roleId, type: 0, allow: VIEW, deny: NO_VIEW }],
      },
      {
        id: `child-of-${cat.categoryId}`,
        name: `${cat.roleName}-room`,
        type: 0,
        parent_id: cat.categoryId,
        permission_overwrites: [{ id: cat.roleId, type: 0, allow: VIEW, deny: NO_VIEW }],
      },
    ]),
  ];

  return {
    guildId: GUILD,
    roles,
    channels,
    meId: BOT_USER,
    botMember: { roles: [BOT_ROLE] },
  };
}

const codes = (snap: CatalogSnapshot) => verifyCatalogSnapshot(snap).fails.map((f) => f.code);

test('valid catalog passes with no fails and no darks', () => {
  const report = verifyCatalogSnapshot(validSnapshot());
  assert.deepEqual(report.fails, [], 'the real catalog verifies clean on a matching guild');
  assert.deepEqual(report.darks, [], 'every primary is visible, so nothing falls back to the hub');
  assert.ok(report.passes.length > ALL_PICKS.length, 'roles, destinations and category grants all pass');
});

test('a deleted role fails closed as role_missing', () => {
  const snap = validSnapshot();
  const shooters = GAME_PICKS.find((p) => p.key === 'shooters')!;
  snap.roles = snap.roles.filter((r) => r.id !== shooters.roleId);
  const report = verifyCatalogSnapshot(snap);
  const fail = report.fails.find((f) => f.pick === 'shooters');
  assert.ok(fail, 'the corrupted row is named');
  assert.equal(fail!.code, 'role_missing');
  assert.match(fail!.message, /no longer exists/);
});

test('a tampered role id fails closed as role_missing, never matched by name', () => {
  // The reviewer acceptance: corrupt one catalog row in the fixture (here the
  // guild side drifts so the id no longer matches) and the named failure
  // appears. Matching by name would silently pass a retargeted role.
  const snap = validSnapshot();
  const role = snap.roles.find((r) => r.id === GAME_PICKS.find((p) => p.key === 'survival')!.roleId)!;
  role.id = '999999999999999999';
  assert.deepEqual(codes(snap), ['role_missing']);
});

test('an integration-managed role fails closed as role_managed', () => {
  const snap = validSnapshot();
  snap.roles.find((r) => r.id === GAME_PICKS.find((p) => p.key === 'horror')!.roleId)!.managed = true;
  assert.deepEqual(codes(snap), ['role_managed']);
});

test('a role at or above the bot fails closed as role_above_bot', () => {
  const snap = validSnapshot();
  snap.roles.find((r) => r.id === GAME_PICKS.find((p) => p.key === 'horror')!.roleId)!.position = BOT_TOP;
  assert.deepEqual(codes(snap), ['role_above_bot']);
});

test('a deleted destination fails closed as destination_missing', () => {
  const snap = validSnapshot();
  const target = GAME_PICKS.find((p) => p.key === 'shooters')!.primaryChannelId!;
  snap.channels = snap.channels.filter((c) => c.id !== target);
  const report = verifyCatalogSnapshot(snap);
  const fail = report.fails.find((f) => f.pick === 'shooters');
  assert.equal(fail?.code, 'destination_missing');
});

test('an unknown destination id fails closed instead of routing nowhere', () => {
  const snap = validSnapshot();
  const primary = snap.channels.find(
    (c) => c.id === GAME_PICKS.find((p) => p.key === 'shooters')!.primaryChannelId,
  )!;
  primary.id = '888888888888888888';
  const fail = verifyCatalogSnapshot(snap).fails.find((f) => f.pick === 'shooters');
  assert.equal(fail?.code, 'destination_missing');
});

test('primary and fallback both invisible fails closed as destination_invisible', () => {
  const snap = validSnapshot();
  // Strip the role grant from the shooters room and delete the hub: the pick
  // routes nowhere, which is a FAIL, not a silent hub fallback.
  const primary = snap.channels.find(
    (c) => c.id === GAME_PICKS.find((p) => p.key === 'shooters')!.primaryChannelId,
  )!;
  primary.permission_overwrites = [{ id: GUILD, type: 0, allow: NO_VIEW, deny: VIEW }];
  snap.channels = snap.channels.filter((c) => c.id !== GAME_HUB_CHANNEL_ID);
  const fail = verifyCatalogSnapshot(snap).fails.find((f) => f.pick === 'shooters');
  assert.equal(fail?.code, 'destination_invisible');
});

test('a dark primary with a visible hub is DARK, not FAIL', () => {
  const snap = validSnapshot();
  const primary = snap.channels.find(
    (c) => c.id === GAME_PICKS.find((p) => p.key === 'shooters')!.primaryChannelId,
  )!;
  primary.permission_overwrites = [{ id: GUILD, type: 0, allow: NO_VIEW, deny: VIEW }];
  const report = verifyCatalogSnapshot(snap);
  assert.ok(!report.fails.some((f) => f.pick === 'shooters'), 'the hub fallback keeps the flow working');
  assert.ok(report.darks.some((d) => d.startsWith('shooters:')), 'but the dark room is reported');
});

test('a missing gated category fails closed as category_missing', () => {
  const snap = validSnapshot();
  snap.channels = snap.channels.filter((c) => c.id !== GATED_CATEGORIES[0]!.categoryId);
  const fail = verifyCatalogSnapshot(snap).fails.find((f) => f.code === 'category_missing');
  assert.ok(fail, 'the missing category is named');
  assert.match(fail!.message, new RegExp(GATED_CATEGORIES[0]!.categoryName.slice(0, 8)));
});

test('an emptied gated category fails closed as category_empty', () => {
  const snap = validSnapshot();
  snap.channels = snap.channels.filter((c) => c.parent_id !== GATED_CATEGORIES[0]!.categoryId);
  const fail = verifyCatalogSnapshot(snap).fails.find((f) => f.code === 'category_empty');
  assert.ok(fail, 'a category with no channels in it is a FAIL');
});

test('granting view on the category alone does NOT make the channel visible', () => {
  // The trap docs/ROUTING.md exists for: Discord resolves from the channel's
  // own overwrites, so a categories-only fix looks right in the UI and changes
  // nothing. canView must not walk up to the parent.
  const snap = validSnapshot();
  const everyone = snap.roles.find((r) => r.id === GUILD)!;
  const channel = {
    id: '424242424242424242',
    name: 'shooters-general',
    type: 0,
    parent_id: GATED_CATEGORIES[1]!.categoryId,
    // @everyone denied, no role grant on the channel itself: the category
    // grant (applied server-side in the passing fixture) is not consulted.
    permission_overwrites: [{ id: GUILD, type: 0, allow: NO_VIEW, deny: VIEW }],
  };
  assert.equal(
    canView(channel, everyone, [GUILD, VERIFY_CATALOG_MEMBER_ROLE_ID, GATED_CATEGORIES[1]!.roleId], GUILD),
    false,
    'the category grant is cosmetic until the channel carries its own overwrite',
  );
});

test('extra unknown roles and channels in the snapshot are ignored', () => {
  const snap = validSnapshot();
  snap.roles.push({ id: '777777777777777777', name: 'Mystery', position: 1, managed: true, permissions: NO_VIEW });
  snap.channels.push({ id: '666666666666666666', name: 'mystery', type: 0 });
  assert.deepEqual(verifyCatalogSnapshot(snap).fails, [], 'the catalog is verified, not the whole server');
});

// --- the script actually consumes this verdict --------------------------------

interface Stub {
  base: string;
  hits: string[];
  close: () => Promise<void>;
}

async function stubDiscord(snap: CatalogSnapshot): Promise<Stub> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const body = (value: unknown) => {
      const text = JSON.stringify(value);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(text);
    };
    if (req.url === `/api/v10/guilds/${GUILD}/roles`) return body(snap.roles);
    if (req.url === `/api/v10/guilds/${GUILD}/channels`) return body(snap.channels);
    if (req.url === '/api/v10/users/@me') return body({ id: snap.meId });
    if (req.url === `/api/v10/guilds/${GUILD}/members/${snap.meId}`) return body(snap.botMember);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function cli(
  stub: Stub,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(process.execPath, [SCRIPT], {
      cwd: REPO,
      env: {
        ...process.env,
        DISCORD_BOT_TOKEN: 'stub-token',
        DISCORD_GUILD_ID: GUILD,
        VERIFY_CATALOG_API_BASE: stub.base,
        ...extraEnv,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('the real script exits 0 on the valid fixture over loopback', async (t) => {
  const stub = await stubDiscord(validSnapshot());
  t.after(() => stub.close());
  const out = await cli(stub);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /0 fail/);
  assert.ok(stub.hits.every((h) => h.includes('/api/v10/')), 'every read went to the stub');
  assert.ok(!JSON.stringify(stub.hits).includes('discord.com'), 'no live Discord host touched');
});

test('the real script exits 1 with the named code on a corrupted row', async (t) => {
  const snap = validSnapshot();
  const shooters = GAME_PICKS.find((p) => p.key === 'shooters')!;
  snap.roles = snap.roles.filter((r) => r.id !== shooters.roleId);
  const stub = await stubDiscord(snap);
  t.after(() => stub.close());
  const out = await cli(stub);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout, /FAIL  \[role_missing\] shooters/, 'the reviewer sees the named failure');
});

test('the API seam refuses a non-loopback host', async (t) => {
  const stub = await stubDiscord(validSnapshot());
  t.after(() => stub.close());
  const out = await cli(stub, { VERIFY_CATALOG_API_BASE: 'https://example.com/api/v10' });
  assert.equal(out.code, 2);
  assert.match(out.stderr + out.stdout, /loopback test server/);
  assert.deepEqual(stub.hits, [], 'refused before any request');
});

test('missing credentials exit 2 with guidance, not a stack trace', async (t) => {
  const stub = await stubDiscord(validSnapshot());
  t.after(() => stub.close());
  const out = await cli(stub, { DISCORD_BOT_TOKEN: '', DISCORD_TOKEN: '' });
  assert.equal(out.code, 2);
  assert.match(out.stderr + out.stdout, /need DISCORD_BOT_TOKEN/);
});
