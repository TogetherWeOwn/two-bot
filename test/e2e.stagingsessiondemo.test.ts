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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
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
  /** Status for DELETE /invites/{code}; 200 unless a test wants a failure. */
  inviteDeleteStatus?: number;
}

/**
 * Everything a test may need to change *between* the baseline run and the
 * --verify run lives here rather than being captured at construction: the two
 * runs are separate processes against the same stub, and the interesting cases
 * (a permission lost, an entry published mid-scan) only exist in that gap.
 */
interface Stub {
  base: string;
  writes: string[];
  deletes: string[];
  members: Record<string, string[]>;
  audit: AuditEntry[];
  /** GET /audit-logs requests served so far; reset it before a --verify run. */
  auditRequests: number;
  /** When set, append `injectEntry` once `auditRequests` reaches this count. */
  injectAfterAuditRequests: number | null;
  injectEntry: AuditEntry | null;
  auditStatus: number;
  inviteDeleteStatus: number;
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
  const state = {
    auditRequests: 0,
    injectAfterAuditRequests: null as number | null,
    injectEntry: null as AuditEntry | null,
    auditStatus: options.auditStatus ?? 200,
    inviteDeleteStatus: options.inviteDeleteStatus ?? 200,
  };
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
      if (state.auditStatus !== 200) {
        res.writeHead(state.auditStatus).end(JSON.stringify({ message: 'denied' }));
        return;
      }
      state.auditRequests += 1;
      // Publish an entry at an exact point in the scan sequence, which is how a
      // mid-scan write or a late-publishing entry looks from the script's side.
      if (state.injectEntry && state.auditRequests === state.injectAfterAuditRequests) {
        audit.push(state.injectEntry);
        state.injectEntry = null;
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
      res.writeHead(state.inviteDeleteStatus);
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
    get auditRequests() {
      return state.auditRequests;
    },
    set auditRequests(n: number) {
      state.auditRequests = n;
    },
    get injectAfterAuditRequests() {
      return state.injectAfterAuditRequests;
    },
    set injectAfterAuditRequests(n: number | null) {
      state.injectAfterAuditRequests = n;
    },
    get injectEntry() {
      return state.injectEntry;
    },
    set injectEntry(e: AuditEntry | null) {
      state.injectEntry = e;
    },
    get auditStatus() {
      return state.auditStatus;
    },
    set auditStatus(s: number) {
      state.auditStatus = s;
    },
    get inviteDeleteStatus() {
      return state.inviteDeleteStatus;
    },
    set inviteDeleteStatus(s: number) {
      state.inviteDeleteStatus = s;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface RunOptions {
  token?: string;
  args?: string[];
  dir?: string;
  /** Extra environment, applied last, so a test can point an artifact elsewhere. */
  env?: Record<string, string>;
}

function runScript(
  stub: Stub,
  { token = TOKEN, args = [], dir, env = {} }: RunOptions = {},
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
          // The stub publishes synchronously, so the quiesce delay only needs
          // to be non-zero for the re-read loop to be a real second pass.
          TWO_SESSION_DEMO_QUIESCE_MS: '5',
          ...env,
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

/**
 * TOG-2926 P1: the open-ended window. Scanning the four action types once,
 * sequentially, leaves a gap - an entry that publishes after its own type was
 * scanned is missed, and if the member has left, the snapshot cannot see it
 * either. Publish the entry at exactly that point: the last request of the
 * first full scan. Only a second scan can find it, so this test fails if the
 * re-read loop is ever collapsed back into a single pass.
 */
test('a role write published after the first audit scan still fails the proof', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);

    stub.auditRequests = 0;
    stub.injectAfterAuditRequests = 4; // the 4th and last request of scan #1
    stub.injectEntry = {
      id: '900000000000000077',
      action_type: MEMBER_ROLE_UPDATE,
      user_id: STAGING_BOT_APPLICATION_ID,
      target_id: '900000000000000043',
    };

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'a late-published role write must fail the proof');
    assert.match(verify.stderr, /audit log records role writes/);
    assert.match(verify.stderr, /900000000000000043/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * The passing side of the same property: a clean verify is only allowed to
 * report NONE after two agreeing full scans. Four action types per scan, so a
 * single-scan implementation would stop at 4 requests.
 */
test('a clean verify confirms the window with a second full audit scan', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    stub.auditRequests = 0;
    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.equal(verify.code, 0, verify.stderr);
    assert.ok(
      stub.auditRequests >= 8,
      `expected at least two full audit scans (8 requests), saw ${stub.auditRequests}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2925 P2: the old code deleted invite.txt and printed "revoked" whatever
 * Discord answered, so an HTTP 500 left a live invite with no handle to retry
 * against and an exit code of 0 saying it was gone.
 */
test('an unconfirmed invite revocation fails the run and keeps the retry handle', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    stub.inviteDeleteStatus = 500;

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'an unconfirmed revocation must not exit 0');
    assert.match(verify.stderr, /HTTP 500, which does not confirm deletion/);
    assert.deepEqual(stub.deletes, ['/api/v10/invites/invite-code'], 'it must still have tried');
    assert.equal(
      existsSync(join(dir, 'invite.txt')),
      true,
      'the invite file is the only retry handle; it must survive a failed DELETE',
    );
    assert.doesNotMatch(verify.stdout + verify.stderr, /discord\.gg|invite-code/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/** 404 means someone already revoked it, which is the outcome we wanted. */
test('an already-gone invite counts as revoked', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    stub.inviteDeleteStatus = 404;

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.equal(verify.code, 0, verify.stderr);
    assert.match(verify.stdout, /already gone \(HTTP 404\)/);
    assert.equal(existsSync(join(dir, 'invite.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2926 P2: revocation used to run after the proof reads, so any read
 * failure - the exact case where an operator stops reading output - left the
 * bearer invite live. A failed proof must still revoke, and must still fail.
 */
test('a proof that cannot read the audit log still revokes the invite', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    stub.auditStatus = 403;

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'an unreadable audit log must fail');
    assert.match(verify.stderr, /Could not read the audit log/);
    assert.deepEqual(
      stub.deletes,
      ['/api/v10/invites/invite-code'],
      'a failed proof must not leave a live bearer invite behind',
    );
    assert.equal(existsSync(join(dir, 'invite.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2926 P3: `mkdirSync(..., { mode: 0o700 })` applies its mode only when it
 * creates the directory, so a pre-existing `/tmp/two-session-demo` kept
 * whatever mode it had while the script claimed a 0700 boundary. The mode is
 * now measured on the open directory and tightened before anything is written.
 */
test('a group/world-readable artifact directory is tightened before anything is written', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    chmodSync(dir, 0o755);
    assert.equal(statSync(dir).mode & 0o077, 0o055, 'precondition: the directory starts readable');

    const result = await runScript(stub, { dir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(statSync(dir).mode & 0o077, 0, 'the artifact directory must end up 0700');
    assert.equal(statSync(join(dir, 'invite.txt')).mode & 0o077, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/** A symlink at the directory name redirects the whole 0700 boundary. */
test('a symlinked artifact directory aborts before any write', async () => {
  const stub = await stubDiscord();
  const real = mkdtempSync(join(tmpdir(), 'two-staging-real-'));
  const link = `${real}-link`;
  try {
    symlinkSync(real, link);
    const result = await runScript(stub, { dir: link });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /is a symlink/);
    assert.deepEqual(stub.writes, []);
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
    await stub.close();
  }
});

/** An artifact override pointing outside the validated directory skips it. */
test('an artifact path outside the private directory aborts before any write', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    const result = await runScript(stub, { dir, env: { TWO_SESSION_DEMO_INVITE: join(tmpdir(), 'loose-invite.txt') } });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outside the private directory/);
    assert.deepEqual(stub.writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});
