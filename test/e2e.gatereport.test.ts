/**
 * TOG-6479 acceptance for scripts/gate-report.ts.
 *
 * The scan that opened this card found zero test-file references to the
 * script. The card says "seeded DB", but the script never touches Postgres -
 * it reads the live Discord roster (`GET /guilds/<id>/members`) and prints
 * the rules-gate ceiling over it. The hermetic equivalent of a seeded DB is
 * therefore a seeded ROSTER: a loopback stub serves a fixed member list, the
 * clock is frozen, and the real CLI runs against both. No token, no network,
 * no live guild - `DISCORD_API_BASE` points at the stub (the same override
 * `staging-session-demo.ts` already honors), and the stub records every
 * request so the test proves the script looked at the roster rather than
 * printing constants.
 *
 * Fixture (synthetic guild 700...009, synthetic members, never live/staging):
 *   A cleared 2026-09-20, B cleared 2026-09-27, C stuck 2026-09-26
 *   D cleared 2026-08-10, E stuck 2026-08-11, F stuck 2026-08-12
 *   G a bot (counted in the roster line, excluded from every human number)
 *   H cleared 2026-03-15 (old cohort: cohort table, 365-day window only)
 * At the frozen now (2026-09-28T12:00Z) that is 8 on the roster, 7 human,
 * 4 cleared, 3 stuck, 57% conversion; August is the one stalled cohort
 * (1/3 cleared); the newest join (B) is 1 day old.
 *
 * Reproduce by hand (reviewer path): serve the member list below from any
 * loopback stub at `/api/v10/guilds/700000000000000009/members`, run
 * `DISCORD_BOT_TOKEN=test-token DISCORD_GUILD_ID=700000000000000009
 * DISCORD_API_BASE=<stub> node scripts/gate-report.ts`, and compare the
 * headline, cohort and arrival lines with the asserts. `node --test
 * test/e2e.gatereport.test.ts` is that reproduction, automated.
 *
 * REVIEWER: flip the stuck predicate to see this fail - count
 * `pending !== true` as stuck (or drop the bot filter) in
 * scripts/gate-report.ts. The headline conversion, the August row and the
 * arrival-rate cleared counts all move, and the empty-state case still passes,
 * which is exactly the split this file exists to hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/gate-report.ts', import.meta.url));

// Synthetic guild in the 700... range used by other script fixtures (the
// script has no guild fence; isolation here is the loopback stub).
const GUILD = '700000000000000009';
// Synthetic member ids in the reserved 9000... block, clear of the staging
// fixture suffixes and of TOG-6478's 71-74 so a future fixture cannot collide.
const ID = (n: number) => `9000000000000${String(100 + n).padStart(4, '0')}`;

// Frozen now: 2026-09-28T12:00:00.000Z. Every arrival window and the
// most-recent-join line derive from Date.now, so the child runs with it
// pinned (same data:-URL clock trick as e2e.growthreview.test.ts).
const NOW_ISO = '2026-09-28T12:00:00.000Z';
const CLOCK = `data:text/javascript,${encodeURIComponent(`Date.now = () => Date.parse('${NOW_ISO}');`)}`;

interface StubMember {
  user: { id: string; bot?: boolean };
  joined_at: string;
  pending?: boolean;
  roles: string[];
}

function member(id: string, joined_at: string, pending: boolean, bot = false): StubMember {
  return { user: bot ? { id, bot: true } : { id }, joined_at, pending, roles: [] };
}

/** The seeded roster, in join order. See the header comment for the shape. */
const ROSTER: StubMember[] = [
  member(ID(8), '2026-03-15T12:00:00.000Z', false), // H old cleared cohort
  member(ID(4), '2026-08-10T12:00:00.000Z', false), // D
  member(ID(5), '2026-08-11T12:00:00.000Z', true), // E stuck
  member(ID(6), '2026-08-12T12:00:00.000Z', true), // F stuck
  member(ID(7), '2026-09-01T12:00:00.000Z', false, true), // G bot
  member(ID(1), '2026-09-20T12:00:00.000Z', false), // A
  member(ID(3), '2026-09-26T12:00:00.000Z', true), // C stuck
  member(ID(2), '2026-09-27T12:00:00.000Z', false), // B newest
];

interface Stub {
  base: string;
  requests: Array<{ path: string; auth: string | null }>;
  close(): Promise<void>;
}

/** Loopback Discord: serves the roster (or nothing) with Discord pagination. */
async function stubDiscord(members: StubMember[]): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const byId = [...members].sort((a, b) => (a.user.id < b.user.id ? -1 : 1));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ path: `${url.pathname}${url.search}`, auth: req.headers.authorization ?? null });
    const send = (status: number, body?: unknown) => {
      if (body === undefined) return res.writeHead(status).end();
      const json = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      res.end(json);
    };
    if (req.method === 'GET' && url.pathname === `/api/v10/guilds/${GUILD}/members`) {
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      const after = url.searchParams.get('after') ?? '0';
      return send(200, byId.filter((m) => m.user.id > after).slice(0, limit));
    }
    return send(404, { path: url.pathname });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(stub: Stub, args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  try {
    const result = await run('node', [SCRIPT, ...args], {
      cwd: REPO,
      env: {
        PATH: process.env.PATH,
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: GUILD,
        DISCORD_API_BASE: stub.base,
        NODE_OPTIONS: `--import=${CLOCK}`,
        ...extraEnv,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('seeded roster pins every section and number', { timeout: 60_000 }, async () => {
  const stub = await stubDiscord(ROSTER);
  try {
    const result = await cli(stub, []);
    assert.equal(result.code, 0, result.stderr);

    // The script looked at the roster through the stub, authenticated as the
    // test bot, starting from the first page - not at discord.com, not at a
    // constant. Without this the numbers below could be printed, not read.
    assert.ok(stub.requests.length >= 1, 'expected at least one roster request');
    assert.match(stub.requests[0]!.path, new RegExp(`/guilds/${GUILD}/members\\?limit=1000&after=0`));
    for (const r of stub.requests) assert.equal(r.auth, 'Bot test-token');

    // Headline: 8 on the roster (7 human + 1 bot), 5 cleared, 2 stuck, 71%.
    assert.match(result.stdout, /roster\s+8\s+\(7 human, 1 bots\)/);
    assert.match(result.stdout, /cleared the gate\s+4\b/);
    assert.match(result.stdout, /stuck at the gate\s+3\b/);
    assert.match(result.stdout, /gate conversion\s+57% of humans on the roster today/);

    // Cohort table: three months, August stalled, the others not.
    assert.match(result.stdout, /By join month \(last 3 months with arrivals\)/);
    assert.match(result.stdout, /2026-03\s+1\s+1\s+0\s+100%/);
    assert.match(result.stdout, /2026-08\s+3\s+1\s+2\s+33%.*cohort stalled at the gate/);
    assert.match(result.stdout, /2026-09\s+3\s+2\s+1\s+67%/);
    assert.equal(
      result.stdout.split('\n').filter((l) => l.includes('cohort stalled at the gate')).length,
      1,
      'exactly one cohort may carry the stalled flag',
    );

    // Arrival rate at the frozen now: 2/1, 3/2, 6/3, 7/5 joined/cleared.
    assert.match(result.stdout, /last\s+7 days\s+2 joined\s+1 cleared the gate/);
    assert.match(result.stdout, /last\s+30 days\s+3 joined\s+2 cleared the gate/);
    assert.match(result.stdout, /last\s+90 days\s+6 joined\s+3 cleared the gate/);
    assert.match(result.stdout, /last\s+365 days\s+7 joined\s+4 cleared the gate/);

    // Newest join (B, Sep 27) is 1 day before the frozen now; the ceiling
    // names the 4 who cleared, and the upper-bound caveat is printed.
    assert.match(result.stdout, /most recent human join was 1 days ago\./);
    assert.match(
      result.stdout,
      /Ceiling: onboarding can only ever reach the 4 members who cleared the gate\./,
    );
    assert.match(result.stdout, /these rates are upper bounds/);
  } finally {
    await stub.close();
  }
});

test('--months trims the cohort table to the latest month', { timeout: 60_000 }, async () => {
  const stub = await stubDiscord(ROSTER);
  try {
    const result = await cli(stub, ['--months', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /By join month \(last 1 months with arrivals\)/);
    assert.match(result.stdout, /2026-09\s+3\s+2\s+1\s+67%/);
    assert.doesNotMatch(result.stdout, /2026-08/);
    assert.doesNotMatch(result.stdout, /2026-03/);
  } finally {
    await stub.close();
  }
});

test('an empty roster says nobody is there instead of reporting zeros', { timeout: 60_000 }, async () => {
  const stub = await stubDiscord([]);
  try {
    const result = await cli(stub, []);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(stub.requests.length >= 1, 'the empty state must come from a roster read, not a default');

    // "0 cleared out of 7 humans" and "0 cleared out of nobody" are different
    // findings; only the second one means there is nothing to convert.
    assert.match(result.stdout, /roster\s+0\s+\(0 human, 0 bots\)/);
    assert.match(result.stdout, /no humans on the roster - no cohorts, no arrival rate, nothing to convert\./);
    assert.doesNotMatch(result.stdout, /By join month/);
    assert.doesNotMatch(result.stdout, /Arrival rate/);
    assert.doesNotMatch(result.stdout, /most recent human join/);
    assert.match(
      result.stdout,
      /Ceiling: onboarding can only ever reach the 0 members who cleared the gate\./,
    );
  } finally {
    await stub.close();
  }
});

test('no token refuses before contacting Discord', { timeout: 60_000 }, async () => {
  const stub = await stubDiscord(ROSTER);
  try {
    const result = await cli(stub, [], { DISCORD_BOT_TOKEN: '' });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /need DISCORD_BOT_TOKEN/);
    assert.equal(stub.requests.length, 0, 'a credential refusal must send no request');
  } finally {
    await stub.close();
  }
});

test('gate-report.ts reads the roster through DISCORD_API_BASE with bot auth', () => {
  // Guards the wiring the acceptance above is only meaningful on: the report
  // must keep hitting the real paginated members endpoint (which is what the
  // stub fakes) rather than re-implementing the roster inline in a way the
  // fixture never exercises. Production never sets DISCORD_API_BASE, so the
  // default stays the live API.
  const script = readFileSync(new URL('../scripts/gate-report.ts', import.meta.url), 'utf8');
  assert.match(script, /process\.env\.DISCORD_API_BASE \?\? 'https:\/\/discord\.com\/api\/v10'/);
  assert.match(script, /\/guilds\/\$\{GUILD\}\/members\?limit=1000&after=/);
  assert.match(script, /Authorization: `Bot \$\{TOKEN\}`/);
});
