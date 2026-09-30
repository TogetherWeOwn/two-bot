/**
 * TOG-10212 P2-1 acceptance for scripts/capture.ts.
 *
 * The gateway is not the only live membership writer: a host-less capture run
 * reads the CURRENT Discord member list, so a captured join is present-tense
 * evidence, not a historical log import. A delayed removal stamped earlier
 * must not keep a rejoined member marked departed.
 *
 * Fixture (synthetic guild 700...010, synthetic member, never live/staging):
 *   Sep 29 join (invite:first), delayed Sep 30 01:00 leave observed at
 *   01:00:00.000001Z, invite snapshot rest-invite 1 use at 00:00. The loopback
 *   stub then serves invites (rest-invite 2 uses), the member list (the same
 *   member, joined_at Sep 30 00:30), and the guild (no vanity). The REAL
 *   `node scripts/capture.ts` runs against both, with DISCORD_API_BASE pointed
 *   at the stub and TWO_DATABASE_URL pinned to this file's scratch schema via
 *   the TOG-6492 URL-options trick. No token, no network, no live guild.
 *
 * Reproduce by hand (reviewer path): seed the three rows below into a scratch
 * DB, serve the three stub responses from loopback, run
 * `DISCORD_TOKEN=test-token DISCORD_GUILD_ID=<guild> DISCORD_API_BASE=<stub>
 * TWO_DATABASE_URL=<scratch> node scripts/capture.ts`, and compare
 * `SELECT joined_at, join_source, left_at FROM members` with the asserts.
 * `node --test test/e2e.capture.test.ts` is that reproduction, automated.
 *
 * REVIEWER: revert the per-page `membershipObservedAt` write in
 * scripts/capture.ts to a bare `store.record(e)`. The projection assert below
 * fails with left_at stuck at the delayed 01:00 removal while occurrence and
 * attribution stay right - exactly the reported P2.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';
import { EventStore } from '../src/store/eventStore.ts';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/capture.ts', import.meta.url));

const GUILD = '700000000000000010';
const MEMBER = '123456789012345678';
const TOKEN = 'offline-fixture-token';
const FIRST_JOIN = '2026-09-29T00:00:00.000Z';
const REJOIN = '2026-09-30T00:30:00.000Z';
const DELAYED_LEAVE = '2026-09-30T01:00:00.000Z';
const DELAYED_OBSERVED = '2026-09-30T01:00:00.000001Z';
const SINCE = '2026-09-30T00:00:00.000Z';

interface Stub {
  base: string;
  requests: Array<{ method: string; path: string; auth: string | null }>;
  close(): Promise<void>;
}

/** Loopback Discord: invites, paginated members, guild - nothing else. */
async function stubDiscord(): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? '',
      path: `${url.pathname}${url.search}`,
      auth: (req.headers.authorization as string) ?? null,
    });
    const send = (status: number, body?: unknown) => {
      if (body === undefined) return res.writeHead(status).end();
      const json = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      res.end(json);
    };
    if (req.method === 'GET' && url.pathname === `/api/v10/guilds/${GUILD}/invites`) {
      return send(200, [{ code: 'rest-invite', uses: 2 }]);
    }
    if (req.method === 'GET' && url.pathname === `/api/v10/guilds/${GUILD}/members`) {
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      const after = url.searchParams.get('after') ?? '0';
      const roster = [{ user: { id: MEMBER, bot: false }, joined_at: REJOIN }];
      return send(200, roster.filter((m) => m.user.id > after).slice(0, limit));
    }
    if (req.method === 'GET' && url.pathname === `/api/v10/guilds/${GUILD}`) {
      return send(200, { vanity_url_code: null });
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

let harness: TestDb;
/** Routes the real capture child at this file's scratch schema, and nowhere else. */
let childDbUrl: string;
let stub: Stub;

before(async () => {
  stub = await stubDiscord();
  harness = await openTestDb(import.meta.filename);
  const url = new URL(TEST_PG_URL);
  // URL options win over inherited PGOPTIONS (the TOG-6492 trick): the capture
  // child reads TWO_DATABASE_URL, so this is the one value that decides which
  // schema it writes to.
  url.searchParams.set('options', `-c search_path=${harness.schema}`);
  childDbUrl = url.toString();
});

after(async () => {
  if (typeof stub !== 'undefined' && stub) await stub.close();
  if (typeof harness !== 'undefined' && harness) await harness.cleanup();
});

beforeEach(async () => {
  await harness.reset();
  stub.requests.length = 0;
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function capture(): Promise<CliResult> {
  try {
    const result = await run('node', [SCRIPT], {
      cwd: REPO,
      env: {
        ...process.env,
        TWO_DATABASE_URL: childDbUrl,
        DISCORD_TOKEN: TOKEN,
        DISCORD_GUILD_ID: GUILD,
        DISCORD_API_BASE: stub.base,
      },
      timeout: 60_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('a captured current member reopens presence after a delayed removal', { timeout: 120_000 }, async () => {
  const store = new EventStore(harness.db);
  await store.record({
    guildId: GUILD, memberId: MEMBER, eventType: 'member_join',
    occurredAt: FIRST_JOIN, source: 'invite:first',
  });
  await store.record(
    { guildId: GUILD, memberId: MEMBER, eventType: 'member_leave', occurredAt: DELAYED_LEAVE, source: 'gateway' },
    { membershipObservedAt: DELAYED_OBSERVED },
  );
  await harness.db
    .prepare(`INSERT INTO invite_snapshots (guild_id, code, uses, updated_at) VALUES (?, ?, ?, ?)`)
    .run(GUILD, 'rest-invite', 1, SINCE);

  const result = await capture();
  assert.equal(result.code, 0, `capture failed:\n${result.stdout}\n${result.stderr}`);

  // The script read the roster through the stub, authenticated as the fixture
  // token - not discord.com, not a constant.
  const paths = stub.requests.map((r) => r.path);
  assert.ok(paths.some((p) => p === `/api/v10/guilds/${GUILD}/invites`), `no invite read: ${JSON.stringify(paths)}`);
  assert.ok(
    paths.some((p) => p.startsWith(`/api/v10/guilds/${GUILD}/members?limit=1000&after=`)),
    `no member-list read: ${JSON.stringify(paths)}`,
  );
  assert.ok(paths.some((p) => p === `/api/v10/guilds/${GUILD}`), `no guild read: ${JSON.stringify(paths)}`);
  assert.ok(stub.requests.length >= 3, `expected at least the three fixture reads: ${JSON.stringify(paths)}`);
  for (const r of stub.requests) assert.equal(r.auth, `Bot ${TOKEN}`);

  // Presence reopens on the live observation; occurrence and attribution stay
  // Discord's own joined_at and the invite delta.
  const projection = await harness.db.prepare(
    `SELECT joined_at, join_source, left_at FROM members WHERE guild_id = ? AND member_id = ?`,
  ).get<{ joined_at: string; join_source: string; left_at: string | null }>(GUILD, MEMBER);
  assert.deepEqual(projection, { joined_at: REJOIN, join_source: 'invite:rest-invite', left_at: null });

  // Every historical event stays in the log: the first join, the delayed
  // removal, and the captured rejoin.
  const history = await harness.db.prepare(
    `SELECT event_type, occurred_at, source FROM events WHERE guild_id = ? AND member_id = ? ORDER BY occurred_at`,
  ).all<{ event_type: string; occurred_at: string; source: string }>(GUILD, MEMBER);
  assert.deepEqual(history, [
    { event_type: 'member_join', occurred_at: FIRST_JOIN, source: 'invite:first' },
    { event_type: 'member_join', occurred_at: REJOIN, source: 'invite:rest-invite' },
    { event_type: 'member_leave', occurred_at: DELAYED_LEAVE, source: 'gateway' },
  ]);
});

/**
 * TOG-10212 P2 regression (reviewer CHANGES at c0673dc1): a rejoin during a
 * REST capture stays present even when the window started earlier.
 *
 * Race: capture window opens at 10:00, a removal lands at 10:01, the member
 * rejoins at 10:01:30, and the roster is actually read at 10:02. The captured
 * join must carry the roster-observation instant (10:02), not the window
 * watermark (10:00) - otherwise the store selects the earlier removal despite
 * the roster proving a later rejoin. The child's wall clock is pinned at 10:00
 * and advanced to 10:02 by the stub at the actual roster read, so the race is
 * deterministic. Mirrors the reviewer's child-clock proof.
 */
test('a rejoin during REST capture keeps roster-observation time, not window start', { timeout: 120_000 }, async () => {
  const WINDOW_START = '2026-09-30T10:00:00.000Z';
  const MID_LEAVE = '2026-09-30T10:01:00.000Z';
  const MID_REJOIN = '2026-09-30T10:01:30.000Z';
  const ROSTER_READ = '2026-09-30T10:02:00.000Z';
  const store = new EventStore(harness.db);
  await store.record({
    guildId: GUILD, memberId: MEMBER, eventType: 'member_join',
    occurredAt: FIRST_JOIN, source: 'invite:first',
  });
  await store.record(
    { guildId: GUILD, memberId: MEMBER, eventType: 'member_leave', occurredAt: MID_LEAVE, source: 'gateway' },
    { membershipObservedAt: MID_LEAVE },
  );
  await harness.db
    .prepare(`INSERT INTO invite_snapshots (guild_id, code, uses, updated_at) VALUES (?, ?, ?, ?)`)
    .run(GUILD, 'mid-invite', 1, FIRST_JOIN);

  const clock = join(tmpdir(), `two-bot-capture-clock-${process.pid}.txt`);
  writeFileSync(clock, String(Date.parse(WINDOW_START)));
  const seen: string[] = [];
  const timed = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push(url.pathname);
    const send = (body: unknown) => {
      const json = JSON.stringify(body);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      res.end(json);
    };
    if (req.method === 'GET' && url.pathname === `/api/v10/guilds/${GUILD}/invites`) {
      return send([{ code: 'mid-invite', uses: 2 }]);
    }
    if (req.method === 'GET' && url.pathname === `/api/v10/guilds/${GUILD}/members`) {
      // The roster is observed NOW, mid-window: advance the child clock.
      writeFileSync(clock, String(Date.parse(ROSTER_READ)));
      return send([{ user: { id: MEMBER, bot: false }, joined_at: MID_REJOIN }]);
    }
    return send({ vanity_url_code: null });
  });
  await new Promise<void>((resolve) => timed.listen(0, '127.0.0.1', resolve));
  try {
    const port = (timed.address() as { port: number }).port;
    const url = new URL(TEST_PG_URL);
    url.searchParams.set('options', `-c search_path=${harness.schema}`);
    const pin = fileURLToPath(new URL('./helpers/pinned-clock.mjs', import.meta.url));
    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
      const result = await run(process.execPath, ['--import', pin, SCRIPT], {
        cwd: REPO,
        env: {
          ...process.env,
          TWO_DATABASE_URL: url.toString(),
          DISCORD_TOKEN: TOKEN,
          DISCORD_GUILD_ID: GUILD,
          DISCORD_API_BASE: `http://127.0.0.1:${port}/api/v10`,
          TWO_TEST_CLOCK_FILE: clock,
        },
        timeout: 60_000,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string };
      code = err.code ?? -1;
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
    assert.equal(code, 0, `capture failed:\n${stdout}\n${stderr}`);
    assert.ok(seen.includes(`/api/v10/guilds/${GUILD}/members`), `no roster read: ${JSON.stringify(seen)}`);

    const projection = await harness.db.prepare(
      `SELECT joined_at, join_source, left_at FROM members WHERE guild_id = ? AND member_id = ?`,
    ).get<{ joined_at: string; join_source: string; left_at: string | null }>(GUILD, MEMBER);
    assert.deepEqual(projection, { joined_at: MID_REJOIN, join_source: 'invite:mid-invite', left_at: null });

    const captured = await harness.db.prepare(
      `SELECT metadata FROM events WHERE guild_id = ? AND member_id = ? AND event_type = ? AND occurred_at = ?`,
    ).get<{ metadata: string }>(GUILD, MEMBER, 'member_join', MID_REJOIN);
    const meta = JSON.parse(captured!.metadata) as {
      membershipObservedAt?: string; window?: { from?: string; to?: string };
    };
    assert.equal(meta.membershipObservedAt, ROSTER_READ, 'presence carries the roster observation, not the window start');
    assert.equal(meta.window?.to, WINDOW_START, 'the window watermark still labels the window start');
  } finally {
    await new Promise<void>((resolve) => timed.close(() => resolve()));
    rmSync(clock, { force: true });
  }
});

/**
 * TOG-10212 P2 regression (reviewer CHANGES at 6c3391b7): a member who leaves
 * after their roster page was read stays departed even though the scan
 * finishes later.
 *
 * Race: capture window opens at 10:00, page one observes the target at
 * 10:00:30, the target leaves at 10:01 while the scan is still paging, and
 * page two completes at 10:02. The captured join must carry its own page's
 * observation (10:00:30), not scan completion (10:02) - otherwise the store
 * orders the stale page-one sighting after the real 10:01 removal and
 * wrongly clears it. A full 1000-row first page forces the second request;
 * the stub commits the actual leave before returning page two, so the race
 * is deterministic. Mirrors the reviewer's pagination proof.
 *
 * REVIEWER: revert the per-page `observedAt` write in scripts/capture.ts to
 * a single scan-completion stamp. The projection assert below fails with
 * left_at cleared to null - exactly the reported P2.
 */
test('a leave after its roster page keeps the member departed after scan completion', { timeout: 120_000 }, async () => {
  const WINDOW_START = '2026-09-30T10:00:00.000Z';
  const PAGE_ONE = '2026-09-30T10:00:30.000Z';
  const LEFT = '2026-09-30T10:01:00.000Z';
  const FINISHED = '2026-09-30T10:02:00.000Z';
  const store = new EventStore(harness.db);
  await store.record({
    guildId: GUILD, memberId: MEMBER, eventType: 'member_join',
    occurredAt: FIRST_JOIN, source: 'invite:first',
  });
  await harness.db
    .prepare(`INSERT INTO invite_snapshots (guild_id, code, uses, updated_at) VALUES (?, ?, ?, ?)`)
    .run(GUILD, 'page-invite', 1, FIRST_JOIN);

  const clock = join(tmpdir(), `two-bot-capture-page-clock-${process.pid}.txt`);
  writeFileSync(clock, String(Date.parse(WINDOW_START)));
  const seen: string[] = [];
  let stubError: unknown;
  const paged = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      seen.push(`${url.pathname}${url.search}`);
      const send = (body: unknown) => {
        const json = JSON.stringify(body);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
        res.end(json);
      };
      if (req.method === 'GET' && url.pathname === `/api/v10/guilds/${GUILD}/invites`) {
        return send([{ code: 'page-invite', uses: 2 }]);
      }
      if (req.method === 'GET' && url.pathname === `/api/v10/guilds/${GUILD}/members`) {
        if ((url.searchParams.get('after') ?? '0') === '0') {
          writeFileSync(clock, String(Date.parse(PAGE_ONE)));
          // A full page containing the target forces another request.
          // Fillers joined before the window and emit no membership rows.
          return send([
            { user: { id: MEMBER, bot: false }, joined_at: REJOIN },
            ...Array.from({ length: 999 }, (_, i) => ({
              user: { id: String(BigInt(MEMBER) + BigInt(i + 1)), bot: false },
              joined_at: FIRST_JOIN,
            })),
          ]);
        }
        // Target leaves AFTER page one was observed, while the scan is still
        // paging. The actual gateway store write commits before page two ends.
        await store.record(
          { guildId: GUILD, memberId: MEMBER, eventType: 'member_leave', occurredAt: LEFT, source: 'gateway' },
          { membershipObservedAt: LEFT },
        );
        writeFileSync(clock, String(Date.parse(FINISHED)));
        return send([]);
      }
      return send({ vanity_url_code: null });
    } catch (error) {
      stubError = error;
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => paged.listen(0, '127.0.0.1', resolve));
  try {
    const port = (paged.address() as { port: number }).port;
    const url = new URL(TEST_PG_URL);
    url.searchParams.set('options', `-c search_path=${harness.schema}`);
    const pin = fileURLToPath(new URL('./helpers/pinned-clock.mjs', import.meta.url));
    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
      const result = await run(process.execPath, ['--import', pin, SCRIPT], {
        cwd: REPO,
        env: {
          ...process.env,
          TWO_DATABASE_URL: url.toString(),
          DISCORD_TOKEN: TOKEN,
          DISCORD_GUILD_ID: GUILD,
          DISCORD_API_BASE: `http://127.0.0.1:${port}/api/v10`,
          TWO_TEST_CLOCK_FILE: clock,
        },
        timeout: 60_000,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string };
      code = err.code ?? -1;
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
    assert.equal(code, 0, `capture failed:\n${stdout}\n${stderr}`);
    assert.equal(stubError, undefined);
    assert.equal(seen.filter((p) => p.includes('/members?')).length, 2, `expected two roster pages: ${JSON.stringify(seen)}`);

    const projection = await harness.db.prepare(
      `SELECT joined_at, join_source, left_at FROM members WHERE guild_id = ? AND member_id = ?`,
    ).get<{ joined_at: string; join_source: string; left_at: string | null }>(GUILD, MEMBER);
    assert.deepEqual(projection, { joined_at: REJOIN, join_source: 'invite:page-invite', left_at: LEFT });

    const captured = await harness.db.prepare(
      `SELECT metadata FROM events WHERE guild_id = ? AND member_id = ? AND event_type = ? AND occurred_at = ?`,
    ).get<{ metadata: string }>(GUILD, MEMBER, 'member_join', REJOIN);
    const meta = JSON.parse(captured!.metadata) as { membershipObservedAt?: string };
    assert.equal(meta.membershipObservedAt, PAGE_ONE, 'presence carries the page observation, not scan completion');
  } finally {
    await new Promise<void>((resolve) => paged.close(() => resolve()));
    rmSync(clock, { force: true });
  }
});
