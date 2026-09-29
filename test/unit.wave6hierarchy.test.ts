/**
 * TOG-6486: `scripts/wave6-hierarchy-check.ts` (`npm run wave6:hierarchy`)
 * acceptance test on fixtures.
 *
 * The gap: the script had zero test-file references (scan 2026-09-27), so a
 * role dragged above the bot in the UI - the exact thing the script exists to
 * measure - would only surface against live Discord. This pins the verdict two
 * ways, with no token, no database and no live Discord:
 *
 *   compliant snapshot (every non-managed role below the bot top) -> PASS,
 *     exit 0;
 *   one target raised to the bot's top position -> exactly the named failure
 *     `hierarchy_blocked`, exit 1, with the flipped role named on stdout.
 *
 * The reviewer acceptance is literal: flip one fixture role to the bot's top
 * position and the run names the failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  HIERARCHY_BLOCKED,
  checkHierarchySnapshot,
  type HierarchyRole,
  type HierarchyVerdict,
} from '../scripts/wave6-hierarchy-check.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/wave6-hierarchy-check.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

// Fixture guild, bot and roles. Nothing here is a live id.
const GUILD = '100000000000000021';
const BOT_USER = '100000000000000022';
const BOT_TOP_ROLE = '100000000000000023';
const OWN_MANAGED_ROLE = '100000000000000024';
const BOT_TOP = 100;

/** A guild snapshot in which Wave 6 can complete: every target below the bot.
 *
 * The bot's top role is its own managed integration role ("Owen" @100): a
 * managed role is not a Wave 6 target, so it survives the wave. A non-managed
 * top would count as its own blocked target (position ties are out of reach),
 * which is exactly the live passing state after the TOG-1166 fix moved Owen
 * @1 -> @188. The bot also holds a lower non-managed role ("Coordinator" @50)
 * to pin that such roles stay targets - the wave deletes those too.
 */
function compliantRoles(): HierarchyRole[] {
  return [
    { id: GUILD, name: '@everyone', position: 0, managed: false },
    { id: OWN_MANAGED_ROLE, name: 'Owen', position: BOT_TOP, managed: true, tags: { bot_id: BOT_USER } },
    { id: BOT_TOP_ROLE, name: 'Coordinator', position: 50, managed: false },
    { id: '100000000000000031', name: 'Shooter Games', position: 10, managed: false },
    { id: '100000000000000032', name: 'Horror Games', position: 20, managed: false },
    { id: '100000000000000033', name: 'Some Integration', position: 200, managed: true },
  ];
}

const BOT_ROLES = [OWN_MANAGED_ROLE, BOT_TOP_ROLE];

function verdict(roles: HierarchyRole[]): HierarchyVerdict {
  const out = checkHierarchySnapshot(roles, BOT_USER, BOT_ROLES, GUILD);
  assert.ok(!('error' in out), 'the compliant bot holds roles, so there is no error');
  return out;
}

test('compliant hierarchy passes with every target reachable', () => {
  const v = verdict(compliantRoles());
  assert.equal(v.botTop.id, OWN_MANAGED_ROLE, 'after the TOG-1166 fix the bot top is its own managed role');
  assert.equal(v.targets.length, 3, '@everyone and the two managed roles are not targets');
  assert.equal(v.reachable.length, 3);
  assert.deepEqual(v.blocked, []);
  assert.equal(v.highest?.name, 'Coordinator', 'the lower non-managed bot role stays a target');
  assert.equal(v.ownRoleId, OWN_MANAGED_ROLE, 'the fix raises the surviving managed role');
});

test('a target raised to the bot top fails with the named code', () => {
  // The reviewer acceptance: flip one fixture role to the bot's top position
  // (a tie is out of reach - Discord requires strictly above) and the named
  // failure appears.
  const roles = compliantRoles();
  roles.find((r) => r.name === 'Horror Games')!.position = BOT_TOP;
  const v = verdict(roles);
  assert.equal(v.blocked.length, 1);
  assert.equal(v.blocked[0]!.name, 'Horror Games');
  assert.equal(v.reachable.length, 2);
  assert.equal(HIERARCHY_BLOCKED, 'hierarchy_blocked');
});

test('a target above the bot top is blocked, and the highest names the fix line', () => {
  const roles = compliantRoles();
  roles.find((r) => r.name === 'Shooter Games')!.position = 150;
  const v = verdict(roles);
  assert.equal(v.blocked.length, 1);
  assert.equal(v.highest?.name, 'Shooter Games');
  assert.equal(v.highest?.position, 150);
});

test('@everyone and managed roles are never targets, however high', () => {
  const v = verdict(compliantRoles());
  assert.ok(!v.targets.some((r) => r.id === GUILD), '@everyone is not deletable');
  assert.ok(!v.targets.some((r) => r.managed), 'integration roles survive the wave');
});

test('nothing to delete passes with a null highest', () => {
  // Keep only @everyone and the managed roles: no targets, while the bot still
  // holds its own managed role (the missing non-managed bot role resolves to
  // nothing held, leaving Owen @100 as the top).
  const roles = compliantRoles().filter((r) => r.managed || r.id === GUILD);
  const v = verdict(roles);
  assert.deepEqual(v.targets, []);
  assert.deepEqual(v.blocked, []);
  assert.equal(v.highest, null);
});

test('a bot holding no roles fails closed instead of reporting a pass', () => {
  const out = checkHierarchySnapshot(compliantRoles(), BOT_USER, ['999999999999999999'], GUILD);
  assert.ok('error' in out, 'unknown role ids resolve to nothing held');
});

// --- the script actually consumes this verdict --------------------------------

interface Stub {
  base: string;
  hits: string[];
  close: () => Promise<void>;
}

async function stubDiscord(roles: HierarchyRole[]): Promise<Stub> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const body = (value: unknown) => {
      const text = JSON.stringify(value);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(text);
    };
    if (req.url === `/api/v10/guilds/${GUILD}/roles`) return body(roles);
    if (req.url === '/api/v10/users/@me') return body({ id: BOT_USER, username: 'FixtureBot' });
    if (req.url === `/api/v10/guilds/${GUILD}/members/${BOT_USER}`) return body({ roles: BOT_ROLES });
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
        DISCORD_TOKEN: 'stub-token',
        DISCORD_BOT_TOKEN: 'stub-token',
        DISCORD_GUILD_ID: GUILD,
        WAVE6_HIERARCHY_API_BASE: stub.base,
        ...extraEnv,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('the real script exits 0 on the compliant fixture over loopback', async (t) => {
  const stub = await stubDiscord(compliantRoles());
  t.after(() => stub.close());
  const out = await cli(stub);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /PASS -- every target is reachable/);
  assert.ok(stub.hits.every((h) => h.includes('/api/v10/')), 'every read went to the stub');
  assert.ok(!JSON.stringify(stub.hits).includes('discord.com'), 'no live Discord host touched');
});

test('the real script exits 1 with the named failure on the flipped fixture', async (t) => {
  const roles = compliantRoles();
  roles.find((r) => r.name === 'Horror Games')!.position = BOT_TOP;
  const stub = await stubDiscord(roles);
  t.after(() => stub.close());
  const out = await cli(stub);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(
    out.stdout,
    new RegExp(`FAIL\\s+\\[${HIERARCHY_BLOCKED}\\][^\\n]*Horror Games`),
    'the reviewer sees the named failure',
  );
});

test('the API seam refuses a non-loopback host', async (t) => {
  const stub = await stubDiscord(compliantRoles());
  t.after(() => stub.close());
  const out = await cli(stub, { WAVE6_HIERARCHY_API_BASE: 'https://example.com/api/v10' });
  assert.equal(out.code, 2);
  assert.match(out.stderr + out.stdout, /loopback test server/);
  assert.deepEqual(stub.hits, [], 'refused before any request');
});

test('missing credentials exit 2 with guidance, not a stack trace', async (t) => {
  const stub = await stubDiscord(compliantRoles());
  t.after(() => stub.close());
  const out = await cli(stub, { DISCORD_TOKEN: '', DISCORD_BOT_TOKEN: '' });
  assert.equal(out.code, 2);
  assert.match(out.stderr + out.stdout, /need DISCORD_TOKEN/);
});
