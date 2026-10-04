/**
 * TOG-4444 acceptance for the half a unit test cannot reach: the CLI against
 * a Discord that answers over HTTP, the audit row it writes, and the absence
 * of every write it must not make.
 *
 * Discord is a local HTTP server (DISCORD_API_BASE) that keeps one guild's
 * roles and members and logs every request. "Zero live-guild writes" is then
 * an assertion over that request log, plus over the script's own
 * `level_reward_role_discord_call` log lines - the same lines the post-merge
 * staging run is evidenced from.
 *
 * The database refuses on our behalf, in the tog3481_no_writes pattern
 * (test/e2e.levelrewardprobe.test.ts): a trigger on level_role_rewards makes
 * any reward-config write a failing test, and a trigger on
 * operational_audit_log refuses a row for the live guild. The harness resets
 * with TRUNCATE, which does not fire row triggers, so both stay installed.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { LevelingService } from '../src/leveling/service.ts';
import { OperationalAuditStore } from '../src/audit/store.ts';
import { MANAGE_ROLES_BIT } from '../src/leveling/rewardRoleApply.ts';
import { LIVE_GUILD_ID, STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/levels-reward-role-apply.ts', import.meta.url).pathname;
const PROBE = new URL('../scripts/levels-import-rewards-probe.ts', import.meta.url).pathname;
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

/** One guild's worth of Discord, mutable per test. */
const discord = {
  roles: [] as FakeRole[],
  members: new Map<string, string[]>(),
  requests: [] as Request[],
};

function resetDiscord(opts: { botPosition?: number; botPermissions?: bigint } = {}) {
  const fixture = JSON.parse(readFileSync(ROLES_FILE, 'utf8')) as { roles: Array<Omit<FakeRole, 'permissions'>> };
  discord.roles = fixture.roles.map((role) =>
    role.id === BOT_ROLE_ID
      ? {
          ...role,
          position: opts.botPosition ?? role.position,
          permissions: String(opts.botPermissions ?? MANAGE_ROLES_BIT),
          tags: { bot_id: STAGING_BOT_APPLICATION_ID },
        }
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
let reportPath: string;

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
  dir = mkdtempSync(join(tmpdir(), 'two-bot-reward-apply-'));

  await harness.db.exec(`
    CREATE OR REPLACE FUNCTION ${schema}.tog4444_refuse_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'TOG-4444: % wrote to level_role_rewards', current_setting('application_name', true);
    END $$;
    DROP TRIGGER IF EXISTS tog4444_no_writes ON ${schema}.level_role_rewards;
    CREATE TRIGGER tog4444_no_writes
      BEFORE INSERT OR UPDATE OR DELETE ON ${schema}.level_role_rewards
      FOR EACH ROW EXECUTE FUNCTION ${schema}.tog4444_refuse_write();

    CREATE OR REPLACE FUNCTION ${schema}.tog4444_refuse_live_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.guild_id = '${LIVE_GUILD_ID}' THEN
        RAISE EXCEPTION 'TOG-4444: % recorded a live-guild audit row', current_setting('application_name', true);
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS tog4444_no_live_audit ON ${schema}.operational_audit_log;
    CREATE TRIGGER tog4444_no_live_audit
      BEFORE INSERT OR UPDATE ON ${schema}.operational_audit_log
      FOR EACH ROW EXECUTE FUNCTION ${schema}.tog4444_refuse_live_audit();
  `);

  // The mapping artifact, produced by the real probe rather than written by
  // hand: the apply path reads what the probe writes, or this test fails.
  reportPath = join(dir, 'probe-report.json');
  const probe = await run(
    'node',
    [PROBE, '--guild', GUILD, '--file', EXPORT, '--roles', ROLES_FILE, '--bot-id', FIXTURE_BOT_ID, '--no-db', '--report', reportPath],
    { cwd: REPO },
  );
  assert.equal(JSON.parse(probe.stdout).counts.mapped, 2);
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

async function cli(args: string[], env: Record<string, string | undefined> = {}) {
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
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env: fullEnv as NodeJS.ProcessEnv });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const writes = () => discord.requests.filter((r) => r.method !== 'GET');

async function auditRows() {
  return harness.db
    .prepare(
      `SELECT entry_id, guild_id, target_id, action, metadata_json FROM operational_audit_log ORDER BY entry_id`,
    )
    .all<{ entry_id: string; guild_id: string; target_id: string; action: string; metadata_json: string }>();
}

/** The script's own per-call log lines: the evidence the staging run posts. */
function loggedCalls(stdout: string): Array<{ method: string; path: string }> {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { msg: string; method: string; path: string })
    .filter((line) => line.msg === 'level_reward_role_discord_call');
}

test('--apply grants, reads back, records, revokes, reads back - and leaves the member as found', async () => {
  const result = await cli(['--report', reportPath, '--member', MEMBER, '--apply']);
  assert.equal(result.code, 0, result.stdout + result.stderr);

  assert.deepEqual(writes(), [
    { method: 'PUT', path: `/guilds/${GUILD}/members/${MEMBER}/roles/${LEVEL_5_ROLE}` },
    { method: 'DELETE', path: `/guilds/${GUILD}/members/${MEMBER}/roles/${LEVEL_5_ROLE}` },
  ]);
  assert.deepEqual(discord.members.get(MEMBER), [OTHER_ROLE]);
  assert.match(result.stdout, /Positive readback: role "Level 5" present after grant/);
  assert.match(result.stdout, /Negative readback: role absent after revoke/);

  const rows = await auditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].guild_id, GUILD);
  assert.equal(rows[0].target_id, MEMBER);
  assert.equal(rows[0].action, 'level_reward_role_exercised');
  assert.deepEqual(JSON.parse(rows[0].metadata_json), {
    level: 5,
    roleId: LEVEL_5_ROLE,
    roleName: 'Level 5',
    alreadyHeld: false,
    positiveReadback: true,
    negativeReadback: true,
    residueRestored: true,
  });

  // Zero live-guild traffic, by the server's log and by the script's own.
  assert.ok(discord.requests.every((r) => !r.path.includes(LIVE_GUILD_ID)));
  const logged = loggedCalls(result.stdout);
  assert.equal(logged.length, discord.requests.length);
  assert.ok(logged.every((c) => !c.path.includes(LIVE_GUILD_ID)));
  assert.ok(logged.filter((c) => c.method !== 'GET').every((c) => c.path.startsWith(`/guilds/${GUILD}/`)));
});

test('a re-run is safe: a role left on the member is revoked without a second grant', async () => {
  discord.members.set(MEMBER, [OTHER_ROLE, LEVEL_5_ROLE]);
  const first = await cli(['--report', reportPath, '--member', MEMBER, '--apply']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(writes().map((r) => r.method), ['DELETE']);
  assert.deepEqual(discord.members.get(MEMBER), [OTHER_ROLE]);

  const second = await cli(['--report', reportPath, '--member', MEMBER, '--apply']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.deepEqual(discord.members.get(MEMBER), [OTHER_ROLE]);
  const rows = await auditRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => JSON.parse(row.metadata_json).alreadyHeld).sort(),
    [false, true],
  );
});

test('without --apply it prints the plan and writes nothing anywhere', async () => {
  const result = await cli(['--report', reportPath, '--member', MEMBER], { TWO_DATABASE_URL: undefined });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /dry run - nothing is changed/);
  assert.deepEqual(writes(), []);
  assert.deepEqual(await auditRows(), []);
});

test(`the live guild ${LIVE_GUILD_ID} is refused before anything is opened`, async () => {
  const result = await cli(['--report', reportPath, '--member', MEMBER, '--apply'], {
    DISCORD_STAGING_GUILD_ID: LIVE_GUILD_ID,
    TWO_DATABASE_URL: '',
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, new RegExp(`Refusing live guild ${LIVE_GUILD_ID}`));
  assert.doesNotMatch(result.stderr, /TWO_DATABASE_URL/);
  assert.deepEqual(discord.requests, []);
});

test('a probe report for another guild is refused before Discord is contacted', async () => {
  const live = join(dir, 'live-report.json');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  writeFileSync(live, JSON.stringify({ ...report, guildId: LIVE_GUILD_ID }));
  const result = await cli(['--report', live, '--member', MEMBER, '--apply']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /not the TWO Staging guild/);
  assert.deepEqual(discord.requests, []);
});

test('a hierarchy gap fails closed with no write', async () => {
  // The bot's role dropped below "Level 5" (position 10) since the probe ran.
  resetDiscord({ botPosition: 5 });
  const result = await cli(['--report', reportPath, '--member', MEMBER, '--apply']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /at or above the bot's own role/);
  assert.deepEqual(writes(), []);
  assert.deepEqual(await auditRows(), []);
});

test('missing Manage Roles fails closed with no write', async () => {
  resetDiscord({ botPermissions: 0n });
  const result = await cli(['--report', reportPath, '--member', MEMBER, '--apply']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /lacks Manage Roles/);
  assert.deepEqual(writes(), []);
});

test('a member not in the guild is an error, and no member is created', async () => {
  const result = await cli(['--report', reportPath, '--member', '900000000000000501', '--apply']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /is not in the staging guild/);
  assert.deepEqual(writes(), []);
});

test('--apply with no audit database fails before the grant, not after it', async () => {
  const result = await cli(['--report', reportPath, '--member', MEMBER, '--apply'], {
    TWO_DATABASE_URL: '',
    TWO_STAGING_DATABASE_URL: '',
  });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /Nothing was written to Discord/);
  assert.deepEqual(writes(), []);
  assert.deepEqual(discord.members.get(MEMBER), [OTHER_ROLE]);
});

test('the guards themselves work, so the no-write assertions above mean something', async () => {
  await assert.rejects(
    () => new LevelingService(harness.db).replaceRoleRewards(GUILD, [{ level: 1, roleId: LEVEL_5_ROLE }]),
    /wrote to level_role_rewards/,
  );
  await assert.rejects(
    () =>
      new OperationalAuditStore(harness.db).record({
        entryId: 'tog-4444-guard-control',
        kind: 'member_update',
        channel: 'audit',
        guildId: LIVE_GUILD_ID,
        occurredAt: new Date().toISOString(),
      }),
    /recorded a live-guild audit row/,
  );
});
