/**
 * The staging session demo is a write-capable operator script. These tests run
 * it as a process against a stub Discord API and prove two things: identity and
 * channel reads must succeed before the first POST, and the zero-role-write
 * proof it produces is falsifiable - including for the member the walk is
 * actually about, who joins after the baseline and leaves before the verify.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGING_BOT_APPLICATION_ID } from '../src/staging/spec.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/staging-session-demo.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const GUILD = '1545644954272137297';
const CHANNEL = '1546451669284552726';
const TOKEN = `${Buffer.from(STAGING_BOT_APPLICATION_ID).toString('base64')}.Gxxxxx.yyyyyyyyyy`;
const MEMBER_ROLE_UPDATE = 25;

interface AuditEntry {
  id: string;
  action_type: number;
  user_id?: string;
  target_id?: string;
}

interface StubOptions {
  userId?: string;
  channelGuildId?: string;
  channelName?: string;
  rolesStatus?: number;
  /** Mutable member->roles the stub reports, so a test can simulate a grant. */
  members?: Record<string, string[]>;
  membersStatus?: number;
  /** Mutable audit log, so a test can simulate a recorded role write. */
  audit?: AuditEntry[];
  auditStatus?: number;
}

interface Stub {
  base: string;
  writes: string[];
  deletes: string[];
  members: Record<string, string[]>;
  audit: AuditEntry[];
  close: () => Promise<void>;
}

async function stubDiscord(options: StubOptions = {}): Promise<Stub> {
  const writes: string[] = [];
  const deletes: string[] = [];
  const members: Record<string, string[]> = options.members ?? {
    '900000000000000001': ['400000000000000001'],
    '900000000000000002': [],
  };
  // One pre-existing entry, so the baseline cursor is a real id rather than '0'
  // and a test that adds nothing proves the cursor excludes history.
  const audit: AuditEntry[] = options.audit ?? [
    { id: '100000000000000001', action_type: MEMBER_ROLE_UPDATE, user_id: '5', target_id: '6' },
  ];
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    if (req.method === 'POST') writes.push(path);
    if (req.method === 'DELETE') deletes.push(path);
    res.setHeader('content-type', 'application/json');

    if (req.method === 'GET' && path === '/api/v10/users/@me') {
      res.end(JSON.stringify({ id: options.userId ?? STAGING_BOT_APPLICATION_ID }));
      return;
    }
    if (req.method === 'GET' && path === `/api/v10/channels/${CHANNEL}`) {
      res.end(
        JSON.stringify({
          id: CHANNEL,
          guild_id: options.channelGuildId ?? GUILD,
          name: options.channelName ?? 'welcome',
          type: 0,
        }),
      );
      return;
    }
    if (req.method === 'GET' && path === `/api/v10/guilds/${GUILD}/roles`) {
      res.writeHead(options.rolesStatus ?? 200);
      res.end(options.rolesStatus && options.rolesStatus !== 200 ? JSON.stringify({ message: 'denied' }) : '[]');
      return;
    }
    if (req.method === 'GET' && path.startsWith(`/api/v10/guilds/${GUILD}/audit-logs?`)) {
      if (options.auditStatus && options.auditStatus !== 200) {
        res.writeHead(options.auditStatus).end(JSON.stringify({ message: 'denied' }));
        return;
      }
      const params = new URL(`http://x${path.slice('/api/v10'.length)}`).searchParams;
      const actionType = Number(params.get('action_type'));
      const after = params.get('after');
      const entries = audit
        .filter((e) => e.action_type === actionType)
        .filter((e) => (after === null ? true : BigInt(e.id) > BigInt(after)));
      res.end(JSON.stringify({ audit_log_entries: entries }));
      return;
    }
    if (req.method === 'GET' && path.startsWith(`/api/v10/guilds/${GUILD}/members?`)) {
      if (options.membersStatus && options.membersStatus !== 200) {
        res.writeHead(options.membersStatus).end(JSON.stringify({ message: 'denied' }));
        return;
      }
      // `after` pagination: the stub's population fits in one page, so any
      // cursor past the first request returns empty and ends the loop.
      const after = new URL(`http://x${path.slice('/api/v10'.length)}`).searchParams.get('after');
      if (after && after !== '0') {
        res.end('[]');
        return;
      }
      res.end(
        JSON.stringify(
          Object.entries(members).map(([id, roles]) => ({ user: { id }, roles })),
        ),
      );
      return;
    }
    if (req.method === 'POST' && path === `/api/v10/channels/${CHANNEL}/messages`) {
      res.end(JSON.stringify({ id: 'message-1' }));
      return;
    }
    if (req.method === 'POST' && path === `/api/v10/channels/${CHANNEL}/invites`) {
      res.end(JSON.stringify({ code: 'invite-code' }));
      return;
    }
    if (req.method === 'DELETE' && path.startsWith('/api/v10/invites/')) {
      res.end(JSON.stringify({ code: path.split('/').pop() }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    writes,
    deletes,
    members,
    audit,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface RunOptions {
  token?: string;
  args?: string[];
  dir?: string;
}

function runScript(
  stub: Stub,
  { token = TOKEN, args = [], dir }: RunOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const work = dir ?? mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        cwd: REPO,
        env: {
          ...process.env,
          DISCORD_API_BASE: stub.base,
          DISCORD_STAGING_BOT_TOKEN: token,
          DISCORD_STAGING_GUILD_ID: GUILD,
          TWO_SESSION_DEMO_DIR: work,
          TWO_SESSION_DEMO_SNAPSHOT: join(work, 'snapshot.json'),
          TWO_SESSION_DEMO_INVITE: join(work, 'invite.txt'),
        },
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

test('wrong staging application aborts before any write', async () => {
  const stub = await stubDiscord({ userId: '123456789012345678' });
  try {
    const result = await runScript(stub);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Expected staging application/);
    assert.deepEqual(stub.writes, []);
  } finally {
    await stub.close();
  }
});

test('foreign channel aborts before any write', async () => {
  const stub = await stubDiscord({ channelGuildId: '999999999999999999' });
  try {
    const result = await runScript(stub);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Expected #welcome/);
    assert.deepEqual(stub.writes, []);
  } finally {
    await stub.close();
  }
});

test('failed role read aborts before any write', async () => {
  const stub = await stubDiscord({ rolesStatus: 403 });
  try {
    const result = await runScript(stub);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Could not read roles/);
    assert.deepEqual(stub.writes, []);
  } finally {
    await stub.close();
  }
});

test('failed member read aborts before any write', async () => {
  const stub = await stubDiscord({ membersStatus: 403 });
  try {
    const result = await runScript(stub);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Could not read members/);
    assert.deepEqual(stub.writes, []);
  } finally {
    await stub.close();
  }
});

/**
 * Fail closed. Without the audit log the script cannot see a role write to a
 * member who has since left, so it must refuse rather than fall back to the
 * snapshot alone and print a pass it has not earned.
 */
test('an unreadable audit log aborts instead of proving nothing', async () => {
  const stub = await stubDiscord({ auditStatus: 403 });
  try {
    const result = await runScript(stub);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Could not read the audit log/);
    assert.match(result.stderr, /cannot be proven/);
    assert.deepEqual(stub.writes, []);
  } finally {
    await stub.close();
  }
});

/**
 * TOG-2871/TOG-2872: the proof compared guild role *definitions*, which a
 * member-role grant never touches, so it printed "zero role delta" over a real
 * write. Simulate the grant the old proof missed; --verify must fail.
 */
test('a member role grant makes the zero-role proof fail', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    const baseline = await runScript(stub, { dir });
    assert.equal(baseline.code, 0, `baseline run failed: ${baseline.stderr}`);

    // Exactly what applyLevelRoles would do on the live guild.
    stub.members['900000000000000002'] = ['400000000000000009'];

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'a role grant must fail the proof');
    assert.match(verify.stderr, /Member roles changed/);
    assert.match(verify.stderr, /900000000000000002/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2886: the hole the snapshot cannot cover. The walked member joins after
 * the baseline and leaves before the verify, so they are in neither snapshot
 * and compare equal - while the audit log still holds the grant. This is the
 * exact scenario the runbook instructs the operator to perform, so it is the
 * one case the proof most has to catch.
 */
test('a role granted to a member who then leaves still fails the proof', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);

    // join -> grant -> leave: never in a snapshot, always in the audit log.
    stub.audit.push({
      id: '900000000000000099',
      action_type: MEMBER_ROLE_UPDATE,
      user_id: STAGING_BOT_APPLICATION_ID,
      target_id: '900000000000000042',
    });

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'a role write to a departed member must fail the proof');
    assert.match(verify.stderr, /audit log records role writes/);
    assert.match(verify.stderr, /900000000000000042/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('an untouched guild passes the zero-role proof', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.equal(verify.code, 0, `clean verify should pass: ${verify.stderr}`);
    assert.match(verify.stdout, /NONE across MEMBER_ROLE_UPDATE/);
    assert.match(verify.stdout, /IDENTICAL - zero role delta across 2 members/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('a baseline from another guild is refused rather than compared', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as { guildId: string };
    assert.equal(snapshot.guildId, GUILD);
    rmSync(join(dir, 'snapshot.json'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(dir, 'snapshot.json'),
      JSON.stringify({ ...snapshot, guildId: '999999999999999999' }),
    );

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0);
    assert.match(verify.stderr, /cannot cover this walk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('the demo invite is never printed, lands owner-only, and is revoked on verify', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    const result = await runScript(stub, { dir });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /discord\.gg|invite-code/,
      'the invite URL must not reach a transcript',
    );
    const invitePath = join(dir, 'invite.txt');
    assert.match(readFileSync(invitePath, 'utf8'), /^https:\/\/discord\.gg\/invite-code$/m);
    assert.equal(statSync(invitePath).mode & 0o077, 0, 'invite file must not be group/world readable');
    // The baseline is the guild's whole member->role map; same treatment.
    assert.equal(statSync(join(dir, 'snapshot.json')).mode & 0o077, 0, 'baseline must not be group/world readable');

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.equal(verify.code, 0, verify.stderr);
    assert.deepEqual(stub.deletes, ['/api/v10/invites/invite-code'], 'verify must revoke the invite');
    assert.equal(existsSync(invitePath), false, 'verify must remove the invite file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});
