/**
 * TOG-10002: `scripts/levels-import-rewards-probe.ts` and
 * `scripts/levels-reward-role-apply.ts` idempotency proof on fixtures.
 *
 * The gap this closes (round-5 gap list C8): the probe had a "writes nothing"
 * test (test/e2e.levelrewardprobe.test.ts) and the apply path had a re-run
 * unit test plus single-run CLI coverage
 * (test/e2e.levelrewardroleapply.test.ts), but nothing proved a second CLI run
 * over the same state changes nothing. A future probe write path (caching the
 * report, "mark reviewed" flags), unstable output (timestamps of now,
 * unordered rows), or an apply path that grants without revoking would stay
 * green while every re-run drifted.
 *
 * So this seeds one small stored-reward state, runs each real script twice as
 * a subprocess, and asserts end to end:
 *
 *   probe: both runs exit 0 and print byte-identical reports (the planner
 *     sorts by level then role id, so any export permutation already
 *     converges - this pins that two runs converge too), the --report files
 *     are byte-identical, and the store (reward rows, audit rows, table
 *     list) is identical before the first run and after the second.
 *   apply: both runs exit 0 with the same Discord write sequence (grant then
 *     revoke, nothing else), the member ends as found, the reward config is
 *     untouched, and the human-readable output is identical modulo run
 *     identity (timestamps, run ids) - so the double-apply fixture diff is
 *     empty.
 *
 * Discord is a local HTTP server (DISCORD_API_BASE), as in
 * test/e2e.levelrewardroleapply.test.ts. Fixtures/scratch DB only. No live
 * Discord, no live guild writes.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { LevelingService } from '../src/leveling/service.ts';
import { MANAGE_ROLES_BIT } from '../src/leveling/rewardRoleApply.ts';
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const PROBE = new URL('../scripts/levels-import-rewards-probe.ts', import.meta.url).pathname;
const APPLY = new URL('../scripts/levels-reward-role-apply.ts', import.meta.url).pathname;
const EXPORT = new URL('./fixtures/mee6-export-role-rewards.json', import.meta.url).pathname;
const ROLES_FILE = new URL('./fixtures/mee6-guild-roles.json', import.meta.url).pathname;
const GUILD = TWO_STAGING_GUILD_ID;
const FIXTURE_BOT_ID = '900000000000000001';
const BOT_ROLE_ID = '900000000000000010';
const MEMBER = '900000000000000500';
const OTHER_ROLE = '900000000000000030';
const LEVEL_5_ROLE = '900000000000000020';
// Shaped like a staging bot token so checkStagingToken identifies it; built at
// runtime so no token-shaped literal sits in the repo.
const FAKE_TOKEN = `${Buffer.from(STAGING_BOT_APPLICATION_ID).toString('base64')}.fake.fake`;

interface FakeRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  permissions: string;
  tags?: { bot_id: string };
}

interface Request {
  method: string;
  path: string;
}

/** One guild's worth of Discord, reset per test. */
const discord = {
  roles: [] as FakeRole[],
  members: new Map<string, string[]>(),
  requests: [] as Request[],
};

function resetDiscord() {
  const fixture = JSON.parse(readFileSync(ROLES_FILE, 'utf8')) as { roles: Array<Omit<FakeRole, 'permissions'>> };
  discord.roles = fixture.roles.map((role) =>
    role.id === BOT_ROLE_ID
      ? { ...role, permissions: String(MANAGE_ROLES_BIT), tags: { bot_id: STAGING_BOT_APPLICATION_ID } }
      : { ...role, permissions: '0' },
  );
  discord.members = new Map([
    [STAGING_BOT_APPLICATION_ID, [BOT_ROLE_ID]],
    [MEMBER, [OTHER_ROLE]],
  ]);
  discord.requests = [];
}

function send(res: import('node:http').ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

let server: Server;
let apiBase: string;
let harness: TestDb;
let dbEnv: Record<string, string>;
let dir: string;

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '').replace(/^\/api\/v10/, '');
    discord.requests.push({ method: req.method ?? '', path });
    if (req.headers.authorization !== `Bot ${FAKE_TOKEN}`) return send(res, 401, { message: '401: Unauthorized' });
    if (req.method === 'GET' && path === '/users/@me') return send(res, 200, { id: STAGING_BOT_APPLICATION_ID });
    const m = path.match(/^\/guilds\/(\d+)(\/roles|\/members\/(\d+)(?:\/roles\/(\d+))?)?$/);
    if (!m || m[1] !== GUILD) return send(res, 404, { message: 'Unknown Guild', code: 10004 });
    const [, , rest, memberId, roleId] = m;
    if (req.method === 'GET' && !rest) return send(res, 200, { id: GUILD, owner_id: '900000000000000999' });
    if (req.method === 'GET' && rest === '/roles') return send(res, 200, discord.roles);
    const roles = memberId ? discord.members.get(memberId) : undefined;
    if (!roles) return send(res, 404, { message: 'Unknown Member', code: 10007 });
    if (req.method === 'GET' && !roleId) return send(res, 200, { user: { id: memberId }, roles });
    if (req.method === 'PUT' && roleId) {
      if (!roles.includes(roleId)) roles.push(roleId);
      return send(res, 204);
    }
    if (req.method === 'DELETE' && roleId) {
      discord.members.set(memberId!, roles.filter((id) => id !== roleId));
      return send(res, 204);
    }
    return send(res, 405, { message: '405: Method Not Allowed' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v10`;

  harness = await openTestDb(import.meta.filename);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  dbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };
  dir = mkdtempSync(join(tmpdir(), 'two-bot-levels-idem-'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  await harness.cleanup();
});

beforeEach(async () => {
  resetDiscord();
  await harness.reset();
});

async function cli(
  script: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fullEnv: Record<string, string | undefined> = {
    ...process.env,
    CREDENTIALS_DIRECTORY: '',
    DISCORD_STAGING_BOT_TOKEN: FAKE_TOKEN,
    DISCORD_STAGING_GUILD_ID: GUILD,
    DISCORD_API_BASE: apiBase,
    ...dbEnv,
    ...env,
  };
  for (const [key, value] of Object.entries(fullEnv)) if (value === undefined) delete fullEnv[key];
  try {
    const result = await run('node', [script, ...args], { cwd: REPO, env: fullEnv as NodeJS.ProcessEnv });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Stored state with a delta worth reporting: level 5 moved, level 99 stored-only. */
async function seedStoredRewards(): Promise<void> {
  await new LevelingService(harness.db).replaceRoleRewards(GUILD, [
    { level: 5, roleId: '900000000000000024' },
    { level: 99, roleId: '900000000000000023' },
  ]);
}

/** Every reward row, every audit row that matters, and every table in the schema. */
async function snapshot() {
  const rewards = await harness.db
    .prepare(`SELECT guild_id, level, role_id FROM level_role_rewards ORDER BY guild_id, level`)
    .all();
  const audit = await harness.db
    .prepare(`SELECT guild_id, target_id, action, metadata_json FROM operational_audit_log ORDER BY entry_id`)
    .all();
  const tables = await harness.db
    .prepare(`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`)
    .all<{ tablename: string }>();
  return { rewards, audit, tables: tables.map((t) => t.tablename) };
}

function probeArgs(reportPath: string, opts: { noDb?: boolean } = {}): string[] {
  return [
    '--guild',
    GUILD,
    '--file',
    EXPORT,
    '--roles',
    ROLES_FILE,
    '--bot-id',
    FIXTURE_BOT_ID,
    ...(opts.noDb ? ['--no-db'] : []),
    '--report',
    reportPath,
  ];
}

/**
 * The apply script's only legitimate per-run differences: JSON log
 * timestamps, the run id carried in log fields and the audit line, and the
 * audit entry id derived from it. Everything else must be identical.
 */
function scrubApplyOutput(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => {
      if (line.startsWith('{')) {
        const row = JSON.parse(line) as Record<string, unknown>;
        delete row.ts;
        delete row.runId;
        return JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))));
      }
      return line.replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        '<runId>',
      );
    })
    .join('\n');
}

test(
  'double probe run prints byte-identical reports with the known fixture values',
  { timeout: 120_000 },
  async () => {
    await seedStoredRewards();
    const first = await cli(PROBE, probeArgs(join(dir, 'probe-first.json')));
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const second = await cli(PROBE, probeArgs(join(dir, 'probe-second.json')));
    assert.equal(second.code, 0, second.stdout + second.stderr);

    // Idempotent output: the second run over the same rows reads back the
    // same report, byte for byte - no run-time timestamps, no row-order
    // drift for a future write path to hide behind.
    assert.equal(second.stdout, first.stdout, 'second probe run output must equal the first');
    assert.equal(
      readFileSync(join(dir, 'probe-second.json'), 'utf8'),
      readFileSync(join(dir, 'probe-first.json'), 'utf8'),
      'the two --report files must be byte-identical',
    );
    assert.equal(
      readFileSync(join(dir, 'probe-first.json'), 'utf8'),
      `${first.stdout}`,
      'the --report file must match stdout exactly',
    );

    // The fixture's known values, so a passing test means the right report
    // and not two runs agreeing on a wrong one.
    const report = JSON.parse(first.stdout);
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.guildId, GUILD);
    assert.equal(report.counts.rewardsIn, 7);
    assert.equal(report.counts.mapped, 2);
    assert.equal(report.counts.unmapped, 5);
    assert.equal(report.counts.balances, true);
    assert.deepEqual(report.delta, {
      added: [{ level: 10, roleId: '900000000000000021' }],
      changed: [{ level: 5, from: '900000000000000024', to: '900000000000000020' }],
      removed: [{ level: 99, roleId: '900000000000000023' }],
      unchanged: [],
    });
  },
);

test(
  'double probe run writes nothing: the store is unchanged',
  { timeout: 120_000 },
  async () => {
    await seedStoredRewards();
    const before = await snapshot();
    assert.equal(before.rewards.length, 2, 'the fixture seeds exactly 2 reward rows');

    assert.equal((await cli(PROBE, probeArgs(join(dir, 'w1.json')))).code, 0);
    assert.deepEqual(await snapshot(), before, 'the first probe run must not write');

    assert.equal((await cli(PROBE, probeArgs(join(dir, 'w2.json')))).code, 0);
    assert.deepEqual(await snapshot(), before, 'the second probe run must not write either');
  },
);

test(
  'double apply run leaves the fixture as found: the double-apply diff is empty',
  { timeout: 120_000 },
  async () => {
    await seedStoredRewards();
    // The mapping artifact, produced by the real probe rather than written by
    // hand: the apply path reads what the probe writes, or this test fails.
    const reportPath = join(dir, 'apply-report.json');
    const probe = await cli(PROBE, probeArgs(reportPath, { noDb: true }));
    assert.equal(probe.code, 0, probe.stdout + probe.stderr);

    const before = await snapshot();
    const memberBefore = [...discord.members.get(MEMBER)!];

    const first = await cli(APPLY, ['--report', reportPath, '--member', MEMBER, '--apply']);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const firstWrites = discord.requests.filter((r) => r.method !== 'GET');
    assert.deepEqual(
      firstWrites.map((r) => `${r.method} ${r.path}`),
      [
        `PUT /guilds/${GUILD}/members/${MEMBER}/roles/${LEVEL_5_ROLE}`,
        `DELETE /guilds/${GUILD}/members/${MEMBER}/roles/${LEVEL_5_ROLE}`,
      ],
      'the first run grants exactly once, then revokes exactly once',
    );

    discord.requests = [];
    const second = await cli(APPLY, ['--report', reportPath, '--member', MEMBER, '--apply']);
    assert.equal(second.code, 0, second.stdout + second.stderr);
    const secondWrites = discord.requests.filter((r) => r.method !== 'GET');
    assert.deepEqual(
      secondWrites.map((r) => `${r.method} ${r.path}`),
      firstWrites.map((r) => `${r.method} ${r.path}`),
      'the second run performs the same write sequence, not a residue cleanup',
    );

    // The fixture diff: member roles, reward config and table list are
    // identical before the first run and after the second. The audit trail
    // legitimately grows by one row per run (it is the evidence), and both
    // rows carry the same operation metadata.
    assert.deepEqual([...discord.members.get(MEMBER)!], memberBefore, 'the member ends as found');
    const after = await snapshot();
    assert.deepEqual(after.rewards, before.rewards, 'the reward config is untouched');
    assert.deepEqual(after.tables, before.tables, 'no table appeared or vanished');
    assert.equal(after.audit.length, before.audit.length + 2, 'one audit row per run, nothing else');
    for (const row of after.audit.slice(before.audit.length)) {
      assert.deepEqual(JSON.parse((row as { metadata_json: string }).metadata_json), {
        level: 5,
        roleId: LEVEL_5_ROLE,
        roleName: 'Level 5',
        alreadyHeld: false,
        positiveReadback: true,
        negativeReadback: true,
        residueRestored: true,
      });
    }
  },
);

test(
  'double apply run output is deterministic modulo run identity',
  { timeout: 120_000 },
  async () => {
    const reportPath = join(dir, 'det-report.json');
    const probe = await cli(PROBE, probeArgs(reportPath, { noDb: true }));
    assert.equal(probe.code, 0, probe.stdout + probe.stderr);

    const first = await cli(APPLY, ['--report', reportPath, '--member', MEMBER, '--apply']);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const second = await cli(APPLY, ['--report', reportPath, '--member', MEMBER, '--apply']);
    assert.equal(second.code, 0, second.stdout + second.stderr);

    assert.equal(
      scrubApplyOutput(second.stdout),
      scrubApplyOutput(first.stdout),
      'the two runs must read identically once timestamps and run ids are set aside',
    );
    assert.match(first.stdout, /Positive readback: role "Level 5" present after grant/);
    assert.match(first.stdout, /Negative readback: role absent after revoke/);
  },
);
