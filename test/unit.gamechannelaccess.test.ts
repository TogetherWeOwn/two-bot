/**
 * TOG-6495: `scripts/apply-game-channel-access.ts` dry-run acceptance on fixtures.
 *
 * The gap (scan 2026-09-27): the script edits channel access, had no npm entry
 * and zero test-file references. The npm entry (`channels:game-access`) has
 * since landed and is pinned by test/unit.scriptregistryhelp-batch1.test.ts;
 * what was still missing is proof the dry run changes nothing and plans the
 * right overwrites. This file is that proof, with no token, no database and
 * no live Discord:
 *
 *   dark fixture built from the real catalog -> 6 grants (3 categories + 3
 *   children), asserted entry by entry against the fixture;
 *   lit fixture -> every entry already granted, zero changes;
 *   categories-only fixture -> the trap: categories read granted, children
 *   still dark, so exactly the 3 child grants remain;
 *   the real script as a subprocess against a loopback stub -> exit 0, the
 *   expected plan on stdout, and zero API writes (one GET, no PUT/DELETE).
 *
 * The reviewer acceptance is literal: run the dry run against the stub and
 * see zero writes plus the expected plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GATED_CATEGORIES } from '../src/onboarding/catalog.ts';
import {
  computeAccessPlan,
  planChanges,
  VIEW_CHANNEL,
  type Channel,
} from '../scripts/apply-game-channel-access.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/apply-game-channel-access.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

// Fixture guild. Nothing here is a live guild id: the catalog rows under test
// keep their real ids (that is the point - the plan must target the real
// categories), while the guild around them is canned.
const GUILD = '100000000000000001';
const VIEW = String(VIEW_CHANNEL);
const NO_VIEW = '0';

const denyEveryone = (): Channel['permission_overwrites'] => [
  { id: GUILD, type: 0, allow: NO_VIEW, deny: VIEW },
];
const grantRole = (roleId: string): Channel['permission_overwrites'] => [
  { id: GUILD, type: 0, allow: NO_VIEW, deny: VIEW },
  { id: roleId, type: 0, allow: VIEW, deny: NO_VIEW },
];

/** One child per gated category, named after its game. */
function childFor(roleId: string): { id: string; name: string } {
  if (roleId === '1179233034713702511') return { id: '1178937094035492884', name: 'survival-general' };
  if (roleId === '1051272877871222915') return { id: '1179217198930202735', name: 'shooters-general' };
  return { id: '1118994447036850369', name: 'horror-general' };
}

/** Production today: three dark categories, three dark children. */
function darkChannels(): Channel[] {
  const cats: Channel[] = GATED_CATEGORIES.map((cat) => ({
    id: cat.categoryId,
    name: cat.categoryName,
    permission_overwrites: denyEveryone(),
  }));
  const kids: Channel[] = GATED_CATEGORIES.map((cat) => {
    const child = childFor(cat.roleId);
    return {
      id: child.id,
      name: child.name,
      parent_id: cat.categoryId,
      permission_overwrites: denyEveryone(),
    };
  });
  return [...cats, ...kids];
}

function litChannels(): Channel[] {
  return darkChannels().map((ch) => {
    const cat = GATED_CATEGORIES.find((c) => c.categoryId === ch.id)
      ?? GATED_CATEGORIES.find((c) => c.categoryId === ch.parent_id)!;
    return { ...ch, permission_overwrites: grantRole(cat.roleId) };
  });
}

function categoriesOnlyChannels(): Channel[] {
  return darkChannels().map((ch) => {
    const cat = GATED_CATEGORIES.find((c) => c.categoryId === ch.id);
    if (!cat) return ch; // children stay dark: the trap
    return { ...ch, permission_overwrites: grantRole(cat.roleId) };
  });
}

test('dark guild plans exactly six grants: each category and its child', () => {
  const plan = computeAccessPlan(darkChannels());
  assert.equal(plan.length, 6, '3 categories + 3 children');
  assert.deepEqual(planChanges(plan).length, 6);

  // Asserted entry by entry: every grant names the real category id, the real
  // role id and the location a reviewer would see in the CLI output.
  let i = 0;
  for (const cat of GATED_CATEGORIES) {
    const child = childFor(cat.roleId);
    assert.deepEqual(plan[i++], {
      action: 'grant',
      channelId: cat.categoryId,
      where: cat.categoryName,
      roleId: cat.roleId,
      roleName: cat.roleName,
    });
    assert.deepEqual(plan[i++], {
      action: 'grant',
      channelId: child.id,
      where: `  └ #${child.name}`,
      roleId: cat.roleId,
      roleName: cat.roleName,
    });
  }
});

test('lit guild plans zero changes: every entry already granted', () => {
  const plan = computeAccessPlan(litChannels());
  assert.deepEqual(planChanges(plan), [], 'nothing left to grant');
  assert.ok(plan.every((e) => e.action === 'skip-already'));
});

test('categories-only grant still plans the three child grants', () => {
  // The trap docs/ROUTING.md exists for: a category grant is cosmetic until
  // the channel carries its own overwrite. A plan that stopped at categories
  // would print 0 changes here and leave every member locked out.
  const plan = computeAccessPlan(categoriesOnlyChannels());
  const changes = planChanges(plan);
  assert.equal(changes.length, 3, 'the children still need their own overwrites');
  assert.ok(
    changes.every((e) => e.where.startsWith('  └ #')),
    'every remaining grant is on a child channel',
  );
  assert.deepEqual(
    changes.map((e) => e.channelId).sort(),
    GATED_CATEGORIES.map((cat) => childFor(cat.roleId).id).sort(),
  );
});

test('revert on a lit guild removes all six; on a dark guild removes nothing', () => {
  const litRevert = computeAccessPlan(litChannels(), { revert: true });
  assert.equal(planChanges(litRevert).length, 6);
  assert.ok(litRevert.every((e) => e.action === 'remove'));

  const darkRevert = computeAccessPlan(darkChannels(), { revert: true });
  assert.deepEqual(planChanges(darkRevert), [], 'nothing to remove');
  assert.ok(darkRevert.every((e) => e.action === 'skip-missing'));
});

test('a deleted category plans skip-no-category, never a grant', () => {
  const channels = darkChannels().filter((c) => c.id !== GATED_CATEGORIES[0]!.categoryId);
  const plan = computeAccessPlan(channels);
  const entry = plan.find((e) => e.channelId === GATED_CATEGORIES[0]!.categoryId)!;
  assert.equal(entry.action, 'skip-no-category');
  assert.deepEqual(planChanges(plan).length, 4, 'the other two categories still plan both grants');
});

// --- the script actually runs this plan -------------------------------------

interface Stub {
  base: string;
  hits: string[];
  close: () => Promise<void>;
}

async function stubDiscord(channels: Channel[]): Promise<Stub> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === `/api/v10/guilds/${GUILD}/channels`) {
      const text = JSON.stringify(channels);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(text);
      return;
    }
    // Any write that reaches the stub is a test failure made visible: answer
    // 200 so the script would continue, and the hits assertion below convicts.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
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
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(process.execPath, [SCRIPT, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        DISCORD_BOT_TOKEN: 'stub-token',
        DISCORD_GUILD_ID: GUILD,
        GAME_CHANNEL_ACCESS_API_BASE: stub.base,
        ...extraEnv,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('dry run on the dark fixture: exit 0, expected plan, zero API writes', async (t) => {
  const stub = await stubDiscord(darkChannels());
  t.after(() => stub.close());
  const out = await cli(stub);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /DRY RUN/);
  for (const cat of GATED_CATEGORIES) {
    assert.match(out.stdout, new RegExp(cat.roleName), `the plan names ${cat.roleName}`);
  }
  assert.match(out.stdout, /6 change\(s\) proposed\. Nothing was modified\./);
  const writes = stub.hits.filter((h) => !h.startsWith('GET '));
  assert.deepEqual(writes, [], `dry run must issue zero API writes; hits: ${stub.hits.join(', ')}`);
  assert.deepEqual(stub.hits, [`GET /api/v10/guilds/${GUILD}/channels`], 'the only read is the channel list');
  assert.ok(!out.stdout.includes('discord.com'), 'no live Discord host touched');
});

test('the API seam refuses a non-loopback host', async (t) => {
  const stub = await stubDiscord(darkChannels());
  t.after(() => stub.close());
  const out = await cli(stub, { GAME_CHANNEL_ACCESS_API_BASE: 'https://example.com/api/v10' });
  assert.equal(out.code, 2);
  assert.match(out.stderr + out.stdout, /loopback test server/);
  assert.deepEqual(stub.hits, [], 'refused before any request');
});

test('missing credentials exit 2 with guidance, not a stack trace', async (t) => {
  const stub = await stubDiscord(darkChannels());
  t.after(() => stub.close());
  const out = await cli(stub, { DISCORD_BOT_TOKEN: '', DISCORD_TOKEN: '' });
  assert.equal(out.code, 2);
  assert.match(out.stderr + out.stdout, /need DISCORD_BOT_TOKEN/);
});
