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
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  /** Append this entry when the invite DELETE arrives - i.e. after the scan. */
  injectOnRevoke: AuditEntry | null;
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
    injectOnRevoke: null as AuditEntry | null,
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
      // The script reads every action type in one request now; honour an
      // explicit action_type anyway so a regression back to per-type paging
      // fails on the assertions rather than silently reading nothing.
      const actionType = params.get('action_type');
      const after = params.get('after');
      const entries = audit
        .filter((e) => (actionType === null ? true : e.action_type === Number(actionType)))
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
      // Revocation is the first call the script makes AFTER the audit scan has
      // returned, so appending here is the exact "published just too late"
      // sequence both TOG-2963 and TOG-2964 used to defeat the old fence.
      if (state.injectOnRevoke) {
        audit.push(state.injectOnRevoke);
        state.injectOnRevoke = null;
      }
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
    get injectOnRevoke() {
      return state.injectOnRevoke;
    },
    set injectOnRevoke(e: AuditEntry | null) {
      state.injectOnRevoke = e;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Invite revocation asserted on its own, whatever else the run may DELETE. */
function inviteDeletes(stub: Stub): string[] {
  return stub.deletes.filter((p) => p.startsWith('/api/v10/invites/'));
}

/** The receipt --verify leaves in place of the bearer URL once Discord confirms. */
function inviteReceipt(dir: string): string {
  return readFileSync(join(dir, 'invite.txt'), 'utf8');
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
test('a member role grant fails the run', async () => {
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

test('an untouched guild passes, reported as observed rather than proven', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.equal(verify.code, 0, `clean verify should pass: ${verify.stderr}`);
    assert.match(verify.stdout, /NONE OBSERVED across MEMBER_ROLE_UPDATE/);
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
    assert.deepEqual(inviteDeletes(stub), ['/api/v10/invites/invite-code'], 'verify must revoke the invite');
    // The bearer URL is replaced by a receipt, not deleted: a missing file is
    // indistinguishable from one an operator removed, and that state now fails.
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 200 at /);
    assert.doesNotMatch(inviteReceipt(dir), /discord\.gg/, 'the receipt must not keep the bearer URL');
    assert.equal(statSync(invitePath).mode & 0o077, 0, 'the receipt stays owner-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2926 P1: a role write that publishes while the scan is running must be
 * caught, not stepped over. Injecting on the scan's own request models a write
 * that lands in the log just as it is being read.
 */
test('a role write published as the audit scan runs still fails the run', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);

    stub.auditRequests = 0;
    stub.injectAfterAuditRequests = 1;
    stub.injectEntry = {
      id: '900000000000000077',
      action_type: MEMBER_ROLE_UPDATE,
      user_id: STAGING_BOT_APPLICATION_ID,
      target_id: '900000000000000043',
    };

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'a role write in the scanned window must fail the run');
    assert.match(verify.stderr, /audit log records role writes/);
    assert.match(verify.stderr, /900000000000000043/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2963/TOG-2964 P1, and the reason this script no longer claims a proof.
 *
 * Both reviewers defeated the fence with the same sequence: let the scan return
 * clean, then publish an older-id role write immediately afterwards. There is no
 * defence against it - Discord documents audit entry ORDERING but no publication
 * completeness, so a scan can only ever report what had been published when it
 * ran, and no fence or re-read changes that.
 *
 * So this test asserts honesty rather than detection. The entry is published
 * strictly after the scan (on the invite DELETE), the run legitimately does not
 * see it, and what must hold is that the output does not tell a reader it proved
 * absence. If anyone reintroduces a "proven"/"NONE across" claim, this fails.
 */
test('a role write published after the scan is not claimed to have been ruled out', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const late: AuditEntry = {
      id: '900000000000000009',
      action_type: MEMBER_ROLE_UPDATE,
      user_id: STAGING_BOT_APPLICATION_ID,
      target_id: '900000000000000044',
    };
    stub.injectOnRevoke = late;

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    // The entry really did get published, and the run really did not see it.
    assert.ok(stub.audit.includes(late), 'the late entry must actually have been published');
    assert.equal(verify.code, 0, verify.stderr);
    // "NOT PROVEN" is the wording we want, so the guard is against an
    // AFFIRMATIVE claim: `proven` not preceded by `NOT `, the old `NONE across`
    // line, and any talk of a proof or a closed window.
    assert.doesNotMatch(
      verify.stdout,
      /(?<!NOT )\bproven\b/i,
      'a scan that cannot establish absence must not word its result as if it had',
    );
    assert.doesNotMatch(verify.stdout, /NONE across|\bproof\b|window closed/i, 'no revived proof wording');
    assert.match(verify.stdout, /OBSERVED, NOT PROVEN/);
    assert.match(verify.stdout, /NONE OBSERVED across MEMBER_ROLE_UPDATE/);
    assert.match(
      verify.stdout,
      /no publication-completeness guarantee/,
      'the output must say why a clean scan is not a proof',
    );
    assert.match(
      verify.stdout,
      /guarantee is in the code/,
      'and must point at what does carry the guarantee',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2964 P2: a receipt is evidence, so it has to be the exact line this script
 * writes with a status that means gone. The reviewer replaced invite.txt with
 * `revoked invite-code HTTP 500 ...`; the old `/(\d{3})/` matcher accepted it,
 * reported "already revoked (HTTP 500)", and sent no DELETE - certifying a live
 * invite. The code in such a line is still live, so it must be retried.
 */
test('a receipt whose status does not mean gone is retried, not believed', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    writeFileSync(join(dir, 'invite.txt'), 'revoked invite-code HTTP 500 at 2026-09-16T00:00:00.000Z\n');

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.deepEqual(
      inviteDeletes(stub),
      ['/api/v10/invites/invite-code'],
      'a non-gone status must send the DELETE it claimed to have sent',
    );
    assert.equal(verify.code, 0, verify.stderr);
    assert.doesNotMatch(verify.stdout, /already revoked \(HTTP 500\)/);
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 200 at /, 'and leaves a real receipt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/** Anything that is neither a canonical receipt nor an invite URL fails closed. */
test('a receipt-shaped line that this script would not have written fails closed', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    // Trailing prose: the old matcher was multiline and unanchored, so a line
    // like this anywhere in the file short-circuited revocation.
    writeFileSync(join(dir, 'invite.txt'), 'notes\nrevoked invite-code HTTP 204 by hand\n');

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'an unrecognised handle must not read as a clean revocation');
    assert.deepEqual(inviteDeletes(stub), [], 'there is no code it can trust enough to DELETE');
    assert.match(verify.stdout + verify.stderr, /does not hold a usable invite handle or a revocation receipt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2949/TOG-2950 P1: a scan is one request covering every action type, so
 * there is no interval in which an entry of an already-scanned type can land
 * unseen. Per-type paging made a scan four requests with three such gaps.
 */
test('one audit scan is a single request across every action type', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    stub.auditRequests = 0;
    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.equal(verify.code, 0, verify.stderr);
    // Two scans of one request each. Four action types per scan would be 8.
    assert.ok(
      stub.auditRequests <= 4,
      `a scan must not fan out per action type; saw ${stub.auditRequests} requests for two scans`,
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
    assert.deepEqual(inviteDeletes(stub), ['/api/v10/invites/invite-code'], 'it must still have tried');
    assert.match(
      inviteReceipt(dir),
      /^https:\/\/discord\.gg\/invite-code$/m,
      'the bearer URL is the only retry handle; it must survive a failed DELETE unreplaced',
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
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 404 at /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2949/TOG-2950 P1: the fail-open handle. `revokeInvite` returned ok when
 * it could not read invite.txt, so deleting the file made --verify exit 0
 * having sent no DELETE at all - while the invite the baseline created was
 * still live. "I cannot find the handle" is the state we know least about; it
 * is not a confirmed revocation.
 */
test('a missing invite handle is an unconfirmed revocation, not a clean one', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    rmSync(join(dir, 'invite.txt'));

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'a lost handle must not exit 0');
    assert.match(verify.stderr, /revocation is unconfirmed/);
    assert.deepEqual(inviteDeletes(stub), [], 'precondition: there was no handle to DELETE with');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/** Same fail-open, reached by corrupting the handle rather than removing it. */
test('an unparseable invite handle is an unconfirmed revocation', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    writeFileSync(join(dir, 'invite.txt'), '\n');

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0);
    assert.match(verify.stderr, /does not hold a usable invite handle/);
    assert.deepEqual(inviteDeletes(stub), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2950 P1: cleanup has to be wrapped around the whole verify path. The
 * baseline parse used to run before it, so corrupting snapshot.json failed the
 * run with zero DELETE requests and left the bearer invite live - the reviewer
 * reproduced exactly this.
 */
test('a corrupted baseline still revokes the invite', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    writeFileSync(join(dir, 'snapshot.json'), '{ not json');

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'an unusable baseline must fail');
    assert.match(verify.stderr, /No baseline at/);
    assert.deepEqual(
      inviteDeletes(stub),
      ['/api/v10/invites/invite-code'],
      'a failed baseline parse must not leave a live bearer invite behind',
    );
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 200 at /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * The receipt is what makes a repeat --verify honest: it distinguishes "already
 * revoked, here is the status Discord returned" from "the handle is gone".
 */
test('a second verify reads the receipt instead of re-deleting or failing', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    assert.equal((await runScript(stub, { dir, args: ['--verify'] })).code, 0);
    assert.deepEqual(inviteDeletes(stub), ['/api/v10/invites/invite-code']);

    const again = await runScript(stub, { dir, args: ['--verify'] });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /already revoked \(HTTP 200\)/);
    assert.deepEqual(inviteDeletes(stub), ['/api/v10/invites/invite-code'], 'it must not DELETE twice');
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
      inviteDeletes(stub),
      ['/api/v10/invites/invite-code'],
      'a failed proof must not leave a live bearer invite behind',
    );
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 200 at /);
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

/**
 * The parent check reads `lstat` as well as `stat`, so that a symlink sitting
 * on the path cannot present a reassuring root-owned target. A symlink we own
 * is not that attack, and must not be refused - otherwise the guard would be
 * unusable anywhere `$TMPDIR` is itself a link (macOS, some CI images).
 *
 * The foreign-owned case needs a second uid to plant the link, so it is not
 * reachable from this suite; this test pins the half that is.
 */
test('a symlinked parent the running user owns is still usable', async () => {
  const stub = await stubDiscord();
  const real = mkdtempSync(join(tmpdir(), 'two-staging-parent-'));
  const link = `${real}-link`;
  try {
    symlinkSync(real, link);
    const dir = join(link, 'artifacts');
    const result = await runScript(stub, { dir });
    assert.equal(result.code, 0, result.stderr);
    assert.match(inviteReceipt(join(real, 'artifacts')), /^https:\/\/discord\.gg\/invite-code$/m);
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
