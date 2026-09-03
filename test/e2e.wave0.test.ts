/**
 * Wave 0 pre-flight, run for real against a stub Discord.
 *
 * The point of these cases is not that the script prints something. It is that
 * the three ways Wave 0 could quietly produce a WRONG artefact are each caught:
 *
 *   - an unreadable member list writing empty CSVs over data Wave 6 destroys
 *   - holder counts drifting from the audit and the run still exiting 0
 *   - the Wick whitelist being reported as checked when nothing checked it
 *
 * Wave 6 deletes 159 roles permanently, so a Wave 0 export that looks fine and
 * is empty is the most expensive failure this repo can have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = new URL('../scripts/wave0-export.ts', import.meta.url).pathname;
const REPO = new URL('..', import.meta.url).pathname;

const GUILD = '326474832151838730';
const OFFICER = '1078757544169848933';
const GAME_MASTER = '1078757266469175386';
const STAFF = '1087192823767515219';
const SYSOP = '508654771276873729';
const SHOOTER = '1051272877871222915';
const SURVIVAL = '1179233034713702511';
const HORROR = '1119666971584237679';

interface StubOpts {
  members?: unknown[];
  roles?: unknown[];
  channels?: unknown[];
  voice?: unknown[];
  memberStatus?: number;
}

/** A stand-in for the handful of GET endpoints Wave 0 touches. */
async function stubDiscord(o: StubOpts): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.includes('/members?')) {
      if (o.memberStatus && o.memberStatus !== 200) return send({ message: 'Missing Access' }, o.memberStatus);
      // Honour `after` so the pager terminates.
      return send(url.includes('after=0') ? (o.members ?? []) : []);
    }
    if (url.endsWith('/roles')) return send(o.roles ?? []);
    if (url.endsWith('/channels')) return send(o.channels ?? []);
    if (url.includes('/messages')) {
      return send(url.includes('before=') ? [] : (o.voice ?? []));
    }
    return send({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const member = (id: string, roles: string[], username = `u${id}`, bot = false) => ({
  user: { id, username, bot },
  nick: null,
  joined_at: '2024-01-01T00:00:00.000Z',
  roles,
});

const role = (id: string, name: string, permissions = '0') => ({ id, name, permissions });

/**
 * Holder counts exactly as data/server-audit-2026-08-19.json recorded them.
 *
 * Ids are built with BigInt on purpose: a snowflake is well past
 * Number.MAX_SAFE_INTEGER, so `900000000000000000 + n` silently yields the same
 * float for every member and collapses 48 distinct people into one. That is the
 * exact bug the distinct-humans assertion below exists to catch, and it caught
 * it here first.
 */
function membersMatchingAudit() {
  const out: ReturnType<typeof member>[] = [];
  let n = 0n;
  const add = (roleId: string, count: number) => {
    for (let i = 0; i < count; i++) out.push(member(String(900000000000000000n + n++), [roleId]));
  };
  add(SHOOTER, 27);
  add(SURVIVAL, 11);
  add(HORROR, 6);
  add(OFFICER, 3);
  add(GAME_MASTER, 1);
  add(STAFF, 6);
  add(SYSOP, 1);
  return out;
}

const ADMINISTRATOR = String(1n << 3n);

/**
 * §7 Wave 0.4 expects exactly fourteen roles holding ADMINISTRATOR or
 * MANAGE_CHANNELS, so the happy-path fixture has to carry fourteen of them or
 * the drift check fires correctly and the "clean run" case fails.
 */
const powerfulRoles = Array.from({ length: 13 }, (_, i) =>
  role(String(8000 + i), `Integration ${i}`, ADMINISTRATOR),
);

const auditRoles = [
  role(SHOOTER, 'Shooter Games'),
  role(SURVIVAL, 'Survival Games'),
  role(HORROR, 'Horror Games'),
  role(OFFICER, 'Officer'),
  role(GAME_MASTER, 'Game Master'),
  role(STAFF, 'Staff'),
  role(SYSOP, 'SySOp', ADMINISTRATOR), // 14th
  role('999', 'Wick'),
  ...powerfulRoles,
];

/**
 * #voice-log entries in the shape src/backfill/parse.ts already understands:
 * a titled embed with `ID: <snowflake>` in the footer. Spread across three
 * weeks so the weekly buckets have something to separate.
 *
 * Timestamps are anchored to a Monday, not to `now`. The exporter buckets by
 * ISO week (Monday-anchored), so "3, 4 and 5 days ago" lands in one bucket or
 * two depending on what weekday the suite happens to run - it produced three
 * buckets on a Monday and four on a Thursday, and this test failed every week
 * from Tuesday onward regardless of any change to the code under test. Offsets
 * from a Monday mean the buckets are the same on every day of the week.
 */
function voiceMessages() {
  // Monday of last week, midday UTC: comfortably in the past whatever day it
  // is now, and comfortably inside the 90-day window at its oldest offset.
  const d = new Date();
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) -
      (((d.getUTCDay() + 6) % 7) + 7) * 86_400_000,
  );
  const mk = (id: string, dayOffset: number, i: number) => ({
    id: String(1_000_000n + BigInt(i)),
    timestamp: new Date(monday.getTime() + dayOffset * 86_400_000).toISOString(),
    author: { id: '111', bot: true },
    embeds: [
      {
        title: 'Member joined voice channel',
        description: 'joined <#1175127344072118405>',
        footer: { text: `ID: ${id}` },
      },
    ],
  });
  return [
    mk('900000000000000001', 0, 0),
    mk('900000000000000002', 1, 1),
    mk('900000000000000001', 2, 2), // same person twice in one week
    mk('900000000000000003', -7, 3),
    mk('900000000000000004', -21, 4),
  ];
}

/** A minimal snapshot in the real file's shape, so the drift check has a base. */
function writeAudit(dir: string, holders: Record<string, number>) {
  const path = join(dir, 'audit.json');
  writeFileSync(
    path,
    JSON.stringify({
      roles: auditRoles.map((r) => ({
        role_id: r.id,
        name: r.name,
        members_holding: holders[r.id] ?? 0,
      })),
      channels: [],
      categories: [],
    }),
  );
  return path;
}

const AUDIT_HOLDERS = {
  [SHOOTER]: 27, [SURVIVAL]: 11, [HORROR]: 6,
  [OFFICER]: 3, [GAME_MASTER]: 1, [STAFF]: 6, [SYSOP]: 1,
};

async function runScript(env: Record<string, string>, outDir: string) {
  try {
    const { stdout } = await run('node', [SCRIPT, '--out', outDir], {
      cwd: REPO,
      env: { ...process.env, DISCORD_TOKEN: 'stub', DISCORD_GUILD_ID: GUILD, ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

test('wave0: exports both holder CSVs and matches the audit counts', async () => {
  const stub = await stubDiscord({
    members: [...membersMatchingAudit(), member('111', [], 'Wick', true)],
    roles: auditRoles,
    channels: [],
    voice: voiceMessages(),
  });
  const out = mkdtempSync(join(tmpdir(), 'wave0-'));
  const audit = writeAudit(out, AUDIT_HOLDERS);

  const { code, stdout } = await runScript(
    { WAVE0_API_BASE: stub.base, WAVE0_AUDIT_PATH: audit },
    out,
  );
  await stub.close();

  const game = readFileSync(join(out, 'game-role-holders.csv'), 'utf8').trim().split('\n');
  const bank = readFileSync(join(out, 'bankick-holders.csv'), 'utf8').trim().split('\n');

  // 27 + 11 + 6 = 44 holdings, plus a header row.
  assert.equal(game.length, 45, 'game CSV should carry 44 holder rows');
  // 3 + 1 + 6 + 1 = 11 holder-slots, plus a header row.
  assert.equal(bank.length, 12, 'ban/kick CSV should carry 11 holder rows');
  assert.match(game[0], /^role_id,role_name,user_id,username,nick,joined_at$/);
  assert.match(bank[0], /wave6_action$/);
  assert.match(bank[1], /DELETE|KEEP/);

  // Every one of these members holds exactly one role, so slots === people.
  assert.match(stdout, /11 holder-slots across the four roles/);
  assert.match(stdout, /\*\*11 distinct humans\*\*/);

  // The voice baseline: 4 distinct members over 3 weekly buckets, and the
  // member who appeared twice in one week is counted once.
  const voice = readFileSync(join(out, 'voice-baseline.csv'), 'utf8').trim().split('\n');
  assert.equal(voice[0], 'week_starting,unique_members_in_voice');
  assert.equal(voice.length, 4, '3 weekly buckets plus a header');
  assert.match(stdout, /4 distinct members appeared in voice at least once in 90d/);

  assert.match(stdout, /No drift against the snapshot/);
  assert.equal(code, 0, 'a clean run with no drift exits 0');
});

test('wave0: an unreadable member list aborts instead of writing empty CSVs', async () => {
  const stub = await stubDiscord({ memberStatus: 403, roles: auditRoles });
  const out = mkdtempSync(join(tmpdir(), 'wave0-'));
  const { code, stdout } = await runScript({ WAVE0_API_BASE: stub.base }, out);
  await stub.close();

  assert.equal(code, 3, 'missing Server Members intent must be fatal');
  assert.match(stdout, /Server Members privileged\s+intent/);
  assert.equal(
    existsSync(join(out, 'game-role-holders.csv')),
    false,
    'no CSV may be written from a member list we could not read',
  );
});

test('wave0: holder drift against the audit is reported and exits non-zero', async () => {
  // Two Shooter holders short of what the audit recorded.
  const members = membersMatchingAudit().filter(
    (m, i) => !(m.roles[0] === SHOOTER && i < 2),
  );
  const stub = await stubDiscord({ members, roles: auditRoles, channels: [] });
  const out = mkdtempSync(join(tmpdir(), 'wave0-'));
  const audit = writeAudit(out, AUDIT_HOLDERS);

  const { code, stdout } = await runScript(
    { WAVE0_API_BASE: stub.base, WAVE0_AUDIT_PATH: audit },
    out,
  );
  await stub.close();

  assert.match(stdout, /Shooter Games.*25 holders — DRIFT \(audit said 27\)/);
  assert.equal(code, 1, 'drift must not exit 0 — §7 stop rule');
});

test('wave0: the Wick whitelist is never reported as verified', async () => {
  const stub = await stubDiscord({
    members: membersMatchingAudit(),
    roles: auditRoles,
    channels: [],
    voice: voiceMessages(),
  });
  const out = mkdtempSync(join(tmpdir(), 'wave0-'));
  const audit = writeAudit(out, AUDIT_HOLDERS);
  const { stdout } = await runScript(
    { WAVE0_API_BASE: stub.base, WAVE0_AUDIT_PATH: audit },
    out,
  );
  await stub.close();

  assert.match(stdout, /UNVERIFIED/);
  assert.doesNotMatch(stdout, /whitelist.*(confirmed|verified as|passed)/i);
  const report = readFileSync(join(out, 'wave0-report.md'), 'utf8');
  assert.match(report, /Wave 1 must not start until a human has/);
});

test('wave0: an unreadable #voice-log is UNKNOWN, never a zero baseline', async () => {
  const stub = await stubDiscord({
    members: membersMatchingAudit(),
    roles: auditRoles,
    channels: [],
    voice: [],
  });
  const out = mkdtempSync(join(tmpdir(), 'wave0-'));
  const audit = writeAudit(out, AUDIT_HOLDERS);
  const { code, stdout } = await runScript(
    { WAVE0_API_BASE: stub.base, WAVE0_AUDIT_PATH: audit },
    out,
  );
  await stub.close();

  assert.match(stdout, /NOT a zero baseline/);
  assert.match(stdout, /Treat as UNKNOWN/);
  assert.equal(code, 1, 'an unestablished baseline is drift, not success');
  assert.equal(existsSync(join(out, 'voice-baseline.csv')), false);
});
