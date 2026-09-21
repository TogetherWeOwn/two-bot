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
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
/** DELETE statuses the script treats as "the invite is gone", mirrored here. */
const INVITE_GONE_STATUSES = new Set([200, 204, 404]);

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
  /** Status for POST /channels/{id}/invites; 200 unless a test wants a failure. */
  inviteCreateStatus?: number;
  /**
   * TOG-3027: serve a distinct code per create, so a run that orphans another
   * run's invite is visible as a code that was created and never DELETEd. The
   * default stays `invite-code` because every earlier test asserts on that
   * exact path.
   */
  uniqueInviteCodes?: boolean;
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
  /** Invite codes this stub handed out, and the ones it has since seen DELETEd. */
  invitesCreated: string[];
  invitesDeleted: string[];
  /** Status the roles read is served with from now on; settable mid-run. */
  rolesStatus: number;
  /**
   * TOG-3027: park the NEXT `GET /guilds/{id}/roles` - the second request of
   * `preflightGuild()` - until the returned `release` is called. That holds one
   * baseline inside the window a concurrent baseline has to be refused in,
   * without depending on timing. `arrived` resolves when that run reaches it,
   * so the test knows the window is open rather than guessing. The status is
   * read at release, so setting `rolesStatus` first turns the parked run into a
   * failed one.
   */
  armRolesHold: () => { arrived: Promise<void>; release: () => void };
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
    rolesStatus: options.rolesStatus ?? 200,
    /** Set by armRolesHold; consumed by the next roles request that arrives. */
    rolesHold: null as { announce: () => void; held: Promise<void> } | null,
  };
  const invitesCreated: string[] = [];
  const invitesDeleted: string[] = [];
  const armRolesHold = (): { arrived: Promise<void>; release: () => void } => {
    let announce = (): void => {};
    const arrived = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.rolesHold = { announce, held };
    return { arrived, release };
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
      const answer = (): void => {
        res.writeHead(state.rolesStatus);
        res.end(state.rolesStatus === 200 ? '[]' : JSON.stringify({ message: 'denied' }));
      };
      // An armed hold parks this run here: announce that it arrived, then answer
      // only once the test releases it. One arming holds one request.
      const hold = state.rolesHold;
      if (hold) {
        state.rolesHold = null;
        hold.announce();
        void hold.held.then(answer);
        return;
      }
      answer();
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
      if (options.inviteCreateStatus && options.inviteCreateStatus !== 200) {
        res.writeHead(options.inviteCreateStatus).end(JSON.stringify({ message: 'denied' }));
        return;
      }
      const code = options.uniqueInviteCodes ? `invite-code-${invitesCreated.length + 1}` : 'invite-code';
      invitesCreated.push(code);
      res.end(JSON.stringify({ code }));
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
      const code = String(path.split('/').pop());
      if (INVITE_GONE_STATUSES.has(state.inviteDeleteStatus)) invitesDeleted.push(code);
      res.writeHead(state.inviteDeleteStatus);
      res.end(JSON.stringify({ code }));
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
    get rolesStatus() {
      return state.rolesStatus;
    },
    set rolesStatus(s: number) {
      state.rolesStatus = s;
    },
    invitesCreated,
    invitesDeleted,
    armRolesHold,
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

/** The run id the baseline minted, which is what binds the invite artifact to it. */
function baselineRunId(dir: string): string {
  const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as { demoRunId?: string };
  assert.match(String(snapshot.demoRunId), /^[0-9a-f-]{36}$/, 'the baseline must mint a run id');
  return snapshot.demoRunId!;
}

/**
 * Write an invite artifact by hand. `runId` defaults to the current baseline's,
 * so a test that only wants to vary the payload does not have to think about
 * the header; pass a foreign one to exercise the binding itself.
 */
function writeArtifact(dir: string, payload: string, runId = baselineRunId(dir)): void {
  writeFileSync(join(dir, 'invite.txt'), `run ${runId}\n${payload}\n`);
}

/**
 * TOG-2971 P2 / TOG-2972 P2: the retraction is only real if the script never
 * words a result as a proof - on ANY stream. The earlier guard read stdout
 * only, so the proof language that actually survived was the kind that lives on
 * error paths and prints to stderr. Every assertion here is about affirmative
 * claims: "NOT PROVEN" is the wording we want and must keep passing.
 */
function assertNoProofLanguage(text: string, context: string): void {
  assert.doesNotMatch(
    text,
    /(?<!NOT )\bproven\b/i,
    `${context}: a check that cannot establish absence must not word its result as if it had`,
  );
  assert.doesNotMatch(text, /\bproof\b|\bprove[sd]?\b/i, `${context}: no revived proof wording`);
  assert.doesNotMatch(text, /NONE across|window closed/i, `${context}: no revived closed-window wording`);
}

/**
 * TOG-2999 P2: the citation guard was vacuous. It string-matched the script's
 * own stdout, so it could only ever notice the script changing its mind - never
 * `src/index.ts` drifting underneath it. Inserting five blank lines at
 * `src/index.ts:90` left `:99` on a comment, `:449` blank and `:543` on a
 * comment, and the suite stayed green: the operator-facing message would have
 * gone on citing lines that no longer held what it said they did.
 *
 * Each entry is now checked twice - the script must still print the citation,
 * and the lines that citation names must still contain the code it claims. Only
 * the first of those can be satisfied by editing this file, so a shift in
 * `src/index.ts` fails here.
 */
const INDEX_CITATIONS: ReadonlyArray<{
  /** Exactly as the script prints it, so a reworded claim fails on stdout. */
  printed: string;
  /** The range that citation names, and the anchor that must sit inside it. */
  start: number;
  end: number;
  contains: RegExp;
  what: string;
}> = [
  {
    printed: 'src/index.ts:616-653',
    start: 616,
    end: 653,
    contains: /registerSessionWelcome\(client, \{/,
    what: 'exclusive session registration',
  },
  {
    printed: 'src/index.ts:712 and :373',
    start: 712,
    end: 712,
    contains: /actionsForOnboardingMode\(/,
    what: 'the internal role.assign call site',
  },
  {
    printed: 'src/index.ts:712 and :373',
    start: 373,
    end: 373,
    contains: /levelRoleWritesForOnboardingMode\(/,
    what: 'the leveling role-write call site',
  },
  {
    printed: 'src/index.ts:122-126, :135-140',
    start: 122,
    end: 126,
    contains: /forbids TWO_SELF_ROLE_PANELS/,
    what: 'the self-role panel boot guard',
  },
  {
    printed: 'src/index.ts:122-126, :135-140',
    start: 135,
    end: 140,
    contains: /forbids armed anti-nuke containment/,
    what: 'the armed containment boot guard',
  },
];

/** The other two paths that message names; a citation to a file that moved is stale too. */
const CITED_PATHS = ['src/onboarding/mode.ts', 'test/e2e.session.test.ts'];

function assertCitationsResolve(stdout: string): void {
  const lines = readFileSync(join(REPO, 'src/index.ts'), 'utf8').split('\n');
  for (const c of INDEX_CITATIONS) {
    assert.ok(
      c.printed.includes(String(c.start)),
      `${c.what}: this table's range must be one the script actually prints`,
    );
    assert.ok(stdout.includes(c.printed), `the output must still cite ${c.what} as ${c.printed}`);
    assert.match(
      lines.slice(c.start - 1, c.end).join('\n'),
      c.contains,
      `src/index.ts:${c.start}-${c.end} no longer holds ${c.what}, so the citation is stale`,
    );
  }
  for (const path of CITED_PATHS) {
    assert.ok(stdout.includes(path), `the output must still cite ${path}`);
    assert.ok(readFileSync(join(REPO, path), 'utf8').length > 0, `${path} is cited but not there`);
  }
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
 *
 * TOG-2971 P2: the reason it gives has to survive the retraction too. The old
 * message said the claim "cannot be proven without it", which tells an operator
 * the log WOULD prove it - the exact belief the header now spends forty lines
 * withdrawing. The honest reason is narrower: a falsifier that cannot read its
 * evidence has not run.
 */
test('an unreadable audit log aborts, and does not imply the log could have proven it', async () => {
  const stub = await stubDiscord({ auditStatus: 403 });
  try {
    const result = await runScript(stub);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Could not read the audit log/);
    assert.match(result.stderr, /falsifier and it could not read its evidence, so it has not run/);
    assertNoProofLanguage(result.stdout + result.stderr, 'the unreadable-audit-log path');
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
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 200 at /m);
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
    assertNoProofLanguage(verify.stdout + verify.stderr, 'a clean run that stepped over a late entry');
    assert.match(verify.stdout, /OBSERVED, NOT PROVEN/);
    assert.match(verify.stdout, /NONE OBSERVED across MEMBER_ROLE_UPDATE/);
    assert.match(
      verify.stdout,
      /no publication-completeness guarantee/,
      'the output must say why a clean scan does not establish absence',
    );
    assert.match(
      verify.stdout,
      /guarantee is in the code/,
      'and must point at what does carry the guarantee',
    );
    // TOG-2972 P1: the guarantee it points at is an application property, so the
    // citation has to reach the wiring and the boot guards, not stop at the two
    // pure helpers whose unit test cannot see either.
    // TOG-2999 P2: and each citation is checked against the file it names, not
    // only against the script's own stdout - see INDEX_CITATIONS.
    assertCitationsResolve(verify.stdout);
    // TOG-2972 P2: and must not imply it identified the running build.
    assert.match(verify.stdout, /does not identify which build the staging bot is serving/);
    assert.doesNotMatch(verify.stdout, /checks the deployed build/);
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
    writeArtifact(dir, 'revoked invite-code HTTP 500 at 2026-09-16T00:00:00.000Z');

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.deepEqual(
      inviteDeletes(stub),
      ['/api/v10/invites/invite-code'],
      'a non-gone status must send the DELETE it claimed to have sent',
    );
    assert.equal(verify.code, 0, verify.stderr);
    assert.doesNotMatch(verify.stdout, /already revoked \(HTTP 500\)/);
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 200 at /m, 'and leaves a real receipt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2971 P1, the reviewer's own repro. This receipt is CANONICAL - the exact
 * text the script writes, a real code, HTTP 200 - and it is still not evidence
 * about this walk, because it names a different baseline run. The old code
 * checked only shape and status, so it reported "already revoked" and sent zero
 * DELETEs while the invite this baseline created was live.
 *
 * This is reachable without anyone hand-editing a file: run the demo twice and
 * let the second baseline's handle write fail after its POST succeeds, and the
 * first run's terminal receipt is what --verify finds.
 */
test('a canonical HTTP 200 receipt from another run does not suppress revocation', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const foreignRun = '00000000-0000-4000-8000-000000000000';
    assert.notEqual(foreignRun, baselineRunId(dir), 'precondition: the receipt is from another run');
    writeArtifact(dir, 'revoked foreign-code HTTP 200 at 2026-09-16T00:00:00.000Z', foreignRun);

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'a receipt for another run must not read as a clean revocation');
    assert.doesNotMatch(verify.stdout, /already revoked/, 'and must not claim it did');
    assert.match(verify.stderr, /says nothing about the invite this baseline created/);
    assert.match(verify.stderr, new RegExp(foreignRun));
    // It cannot DELETE the live code either - that code is in no file. Being
    // loud about it is the whole remedy; silently exiting 0 was the defect.
    assert.deepEqual(inviteDeletes(stub), [], 'there is no live code it could have learned from this file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * The other half of TOG-2971 P1, reader side: what `--verify` does when it finds
 * the staged marker. A POST that succeeded while the handle write failed leaves
 * `pending` rather than the previous run's terminal receipt, and that has to
 * fail closed and name the run.
 *
 * TOG-2997 P3: the marker is hand-written here, so this covers only the reader.
 * That the baseline really writes it before the POST is proved by
 * 'the baseline stages the invite file before the invite exists', which fails
 * the create and looks at the disk.
 */
test('a staged-but-unrecorded invite fails closed on verify', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const runId = baselineRunId(dir);
    // Exactly the file the interrupted baseline would have left behind.
    writeArtifact(dir, 'pending', runId);

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(verify.code, 0, 'a staged-but-unrecorded invite must fail closed');
    assert.match(verify.stderr, /never recorded an invite code/);
    assert.match(verify.stderr, new RegExp(runId));
    assert.deepEqual(inviteDeletes(stub), [], 'there is no code to DELETE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2997 #1. The receipt payload's binding is covered above; the URL payload's
 * was not, and `if (!bound)` at the end of `revokeInvite` is the only thing
 * between a foreign-run handle with a readable baseline and exit 0 - the same
 * "reported ok for an invite it cannot identify" defect. Deleting is always
 * safe, so the DELETE must still go out; what must not happen is a clean exit.
 */
test('a URL handle from another run is revoked but not reported ok', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const foreignRun = '00000000-0000-4000-8000-000000000000';
    assert.notEqual(foreignRun, baselineRunId(dir), 'precondition: another run');
    writeArtifact(dir, 'https://discord.gg/invite-code', foreignRun);

    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.deepEqual(inviteDeletes(stub), ['/api/v10/invites/invite-code'], 'it must still try');
    assert.notEqual(verify.code, 0, 'an invite it cannot identify must not exit 0');
    assert.match(verify.stderr, /may still be live/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2997 #2. Re-stamping the receipt header with this baseline's run would
 * make the NEXT --verify read it as bound and report a clean revocation - the
 * same defect, one run later. The second --verify is what makes that visible.
 */
test('the receipt for an unbound revocation keeps that run id, not this one', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const foreignRun = '00000000-0000-4000-8000-000000000000';
    const mine = baselineRunId(dir);
    writeArtifact(dir, 'https://discord.gg/invite-code', foreignRun);

    await runScript(stub, { dir, args: ['--verify'] });
    assert.match(inviteReceipt(dir), new RegExp(`^run ${foreignRun}\n`));
    assert.doesNotMatch(inviteReceipt(dir), new RegExp(mine), 'must not be re-stamped');

    const second = await runScript(stub, { dir, args: ['--verify'] });
    assert.notEqual(second.code, 0, 'a re-stamped receipt would read as a clean revocation');
    assert.doesNotMatch(second.stdout, /already revoked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2997 #3: the ordering half of TOG-2971 P1, which nothing covered. Fail the
 * POST and the file on disk is the proof: present => staged first; absent => the
 * script only writes after a success, which is exactly the window the pending
 * marker exists to close.
 */
test('the baseline stages the invite file before the invite exists', async () => {
  const stub = await stubDiscord({ inviteCreateStatus: 500 });
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    const base = await runScript(stub, { dir });
    assert.notEqual(base.code, 0, 'a failed invite create must fail the baseline');
    assert.equal(
      inviteReceipt(dir),
      `run ${baselineRunId(dir)}\npending\n`,
      'the marker must already be on disk when the POST is attempted',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/** TOG-2999 P3: a failed create must not put the response body in a transcript. */
test('a failed invite create reports the status without the response body', async () => {
  const stub = await stubDiscord({ inviteCreateStatus: 500 });
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    const base = await runScript(stub, { dir });
    assert.notEqual(base.code, 0);
    assert.match(base.stderr, /Failed to create demo invite: HTTP 500/);
    assert.doesNotMatch(
      base.stdout + base.stderr,
      /denied/,
      'a create response can carry the invite code, so the body must not be printed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-2999 P1, the reviewer's repro: baseline, baseline again, --verify. The
 * second baseline used to overwrite the first run's bearer URL before anything
 * revoked it - and because the artifact and the snapshot were both replaced,
 * --verify bound run B's handle, DELETEd run B's code and exited 0 printing
 * `revoked demo invite (HTTP 200)`. Run A's invite stayed live for its full
 * max_age with nothing on disk naming it.
 *
 * The state the refused run must leave behind is the one it found: run A's
 * handle and run A's snapshot, so a --verify can still revoke exactly it.
 *
 * This is the sequential route - the one an operator actually hits. The same
 * orphan is reachable by starting the two baselines together, which this test
 * says nothing about; that is `a second baseline started inside the first run's
 * window cannot create a second invite` (TOG-3027) below.
 */
test('a second baseline refuses to overwrite the previous run handle', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const firstRun = baselineRunId(dir);
    const firstArtifact = inviteReceipt(dir);

    const second = await runScript(stub, { dir });
    assert.notEqual(second.code, 0, 'a live handle must stop a new baseline');
    assert.match(second.stderr, /still holds the invite handle for baseline run/);
    assert.match(second.stderr, new RegExp(firstRun));
    assert.equal(
      stub.writes.filter((p) => p.endsWith('/invites')).length,
      1,
      'the refused run must not create a second invite',
    );
    assert.equal(inviteReceipt(dir), firstArtifact, 'the only handle for the live invite must survive');
    assert.equal(baselineRunId(dir), firstRun, 'and the baseline that binds it must survive too');

    // The remedy the message names has to work: the first invite is still
    // revocable, cleanly, because both artifacts were left alone.
    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.equal(verify.code, 0, verify.stderr);
    assert.deepEqual(inviteDeletes(stub), ['/api/v10/invites/invite-code']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/** Same refusal from the staged marker: an unidentified invite may be live too. */
test('a baseline refuses to start on a staged marker from an interrupted run', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    writeArtifact(dir, 'pending');

    const second = await runScript(stub, { dir });
    assert.notEqual(second.code, 0, 'a staged marker must stop a new baseline');
    assert.match(second.stderr, /never recorded an invite code/);
    assert.equal(
      stub.writes.filter((p) => p.endsWith('/invites')).length,
      1,
      'the refused run must not create a second invite',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * The other side of that guard: a confirmed revocation is the one artifact state
 * that says nothing is live, so it must not wedge the script. Without this, the
 * fix above would make the demo a one-shot per directory.
 */
test('a baseline after a confirmed revocation starts normally', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const firstRun = baselineRunId(dir);
    assert.equal((await runScript(stub, { dir, args: ['--verify'] })).code, 0);
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 200 at /m);

    const second = await runScript(stub, { dir });
    assert.equal(second.code, 0, second.stderr);
    assert.notEqual(baselineRunId(dir), firstRun, 'the second baseline is its own run');
    assert.match(inviteReceipt(dir), /^https:\/\/discord\.gg\/invite-code$/m);
    assert.equal(
      stub.writes.filter((p) => p.endsWith('/invites')).length,
      2,
      'the second baseline must have created its own invite',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-3039, survivor 1 of 3: the baseline-side twin of `a receipt-shaped line
 * that this script would not have written fails closed`.
 *
 * Only a receipt whose status actually means gone frees the name - dropping the
 * status check leaves `if (receipt)`, which reads any receipt-shaped line as
 * "nothing is live here". A failed revocation is not something `--verify`
 * writes (it keeps the URL handle instead, see `a receipt whose status does not
 * mean gone is retried, not believed`), so this line arrives by hand: an
 * operator mid-cleanup, or the TOG-2964 P2 planted-line threat. Either way the
 * invite it names was never deleted.
 */
test('a baseline refuses a receipt whose status does not say the invite is gone', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    const firstRun = baselineRunId(dir);
    writeArtifact(dir, 'revoked invite-code HTTP 500 at 2026-09-16T00:00:00.000Z');
    const staleArtifact = inviteReceipt(dir);

    const second = await runScript(stub, { dir });
    assert.notEqual(second.code, 0, 'a revocation that never confirmed must stop a new baseline');
    assert.match(second.stderr, /still holds the invite handle for baseline run/);
    assert.match(second.stderr, new RegExp(firstRun));
    assert.equal(
      stub.writes.filter((p) => p.endsWith('/invites')).length,
      1,
      'the refused run must not create a second invite',
    );
    assert.equal(inviteReceipt(dir), staleArtifact, 'and the only handle for the unrevoked invite must survive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-3039, survivor 2 of 3: the docstring promises that "a present-but-
 * unreadable file included" refuses, and nothing checked it. A read that fails
 * for any reason other than ENOENT tells us the name is taken by something we
 * cannot judge, which is the loud state, not the free one.
 *
 * A symlink is how the existing directory-symlink tests reach an unreadable
 * path: `O_EXCL` still reports EEXIST for it, and the `O_NOFOLLOW` read then
 * fails ELOOP. Treating that as absent would not merely overwrite the file -
 * the run would POST for a second invite and only then die on its own
 * `O_NOFOLLOW` write, orphaning the invite it had just created.
 */
test('a baseline refuses an invite handle it cannot read', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    rmSync(join(dir, 'invite.txt'));
    symlinkSync('handle-somewhere-else.txt', join(dir, 'invite.txt'));

    const second = await runScript(stub, { dir });
    assert.notEqual(second.code, 0, 'an unreadable handle must stop a new baseline');
    assert.match(second.stderr, /exists but could not be read/);
    assert.match(second.stderr, /may name a demo invite that is still live/);
    assert.equal(
      stub.writes.filter((p) => p.endsWith('/invites')).length,
      1,
      'the refused run must not create a second invite',
    );
    assert.equal(
      readlinkSync(join(dir, 'invite.txt')),
      'handle-somewhere-else.txt',
      'and it must not have written through or replaced what it could not read',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * TOG-3039, survivor 3 of 3, and the one that is reachable without anybody
 * hand-editing anything: `writePrivate` opens `O_TRUNC` and then `writeSync`, so
 * a run killed between those two leaves a zero-length `invite.txt`. If that
 * happened at the write that replaces `pending` with the real URL, an invite is
 * live in the guild and its code is gone from disk - exactly the state where a
 * new baseline must not take the name.
 */
test('a baseline refuses a handle truncated by an interrupted write', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    writeFileSync(join(dir, 'invite.txt'), '');

    const second = await runScript(stub, { dir });
    assert.notEqual(second.code, 0, 'a truncated handle must stop a new baseline');
    assert.match(second.stderr, /does not hold a recognisable invite handle/);
    assert.equal(
      stub.writes.filter((p) => p.endsWith('/invites')).length,
      1,
      'the refused run must not create a second invite',
    );
    assert.equal(inviteReceipt(dir), '', 'and the truncated file is evidence to resolve, not to overwrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/** Invite codes the stub handed out that it never saw a successful DELETE for. */
function liveInvites(stub: Stub): string[] {
  return stub.invitesCreated.filter((code) => !stub.invitesDeleted.includes(code));
}

/**
 * A parked run holds an open request, and `stub.close()` waits for it - so a
 * failed assertion between `arrived` and `release` would hang the suite instead
 * of reporting. Release and drain unconditionally, whatever the body did.
 */
async function withHeldBaseline(
  stub: Stub,
  dir: string,
  body: (held: Promise<{ code: number; stdout: string; stderr: string }>, release: () => void) => Promise<void>,
): Promise<void> {
  const hold = stub.armRolesHold();
  const run = runScript(stub, { dir });
  try {
    await hold.arrived;
    await body(run, hold.release);
  } finally {
    hold.release();
    await run.catch(() => undefined);
  }
}

/**
 * TOG-3027, the reviewer's second repro: the sequential refusal above was real,
 * but the guard that produced it was check-then-act. It read the handle, and the
 * run then did `preflightGuild()`, `newestAuditId()` and a paginated member walk
 * before staging the `pending` marker. Nothing claimed the name across those
 * round trips, so two baselines started together both read "no file", both
 * proceeded, and the second overwrote the first's only handle - the same orphan,
 * reached by a different route, with `--verify` still exiting 0 over it.
 *
 * `arrived` is what makes this a race rather than a sleep: the first baseline is
 * parked inside that exact window, provably, before the second one starts.
 */
test('a second baseline started inside the first run\'s window cannot create a second invite', async () => {
  const stub = await stubDiscord({ uniqueInviteCodes: true });
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    await withHeldBaseline(stub, dir, async (first, release) => {
      // The first baseline is now past the guard and has not reached the create.
      // Under the old check-then-act guard this is where the second run read "no
      // file" and went on to POST an invite of its own.
      const second = await runScript(stub, { dir });
      assert.notEqual(second.code, 0, 'a concurrent baseline must be refused, not merely a later one');
      assert.match(second.stderr, /never recorded an invite code/);
      assert.deepEqual(stub.invitesCreated, [], 'the refused run must not create an invite');

      release();
      const winner = await first;
      assert.equal(winner.code, 0, winner.stderr);
      assert.deepEqual(stub.invitesCreated, ['invite-code-1'], 'two concurrent baselines, one invite');
      assert.equal(
        inviteReceipt(dir),
        `run ${baselineRunId(dir)}\nhttps://discord.gg/invite-code-1\n`,
        'the handle on disk must name the invite that actually exists',
      );
    });

    // And the remedy the refusal names clears everything that was created: the
    // orphan signature is a live code with nothing on disk naming it.
    const verify = await runScript(stub, { dir, args: ['--verify'] });
    assert.equal(verify.code, 0, verify.stderr);
    assert.deepEqual(liveInvites(stub), [], 'no invite may outlive the run that created it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * The claim is create-or-fail on the terminal-receipt path too. A spent receipt
 * frees the name, and freeing it is `unlink` then the same exclusive create - so
 * a baseline that takes over a receipt still locks the name against a racer for
 * the rest of its run, exactly as one starting from an empty directory does.
 */
test('a baseline that takes over a spent receipt still locks out a concurrent one', async () => {
  const stub = await stubDiscord({ uniqueInviteCodes: true });
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    assert.equal((await runScript(stub, { dir })).code, 0);
    assert.equal((await runScript(stub, { dir, args: ['--verify'] })).code, 0);
    assert.match(inviteReceipt(dir), /^revoked invite-code-1 HTTP 200 at /m);

    await withHeldBaseline(stub, dir, async (first, release) => {
      const second = await runScript(stub, { dir });
      assert.notEqual(second.code, 0, 'the receipt was already taken over by the parked run');
      assert.match(second.stderr, /never recorded an invite code/);

      release();
      assert.equal((await first).code, 0);
      assert.deepEqual(
        stub.invitesCreated,
        ['invite-code-1', 'invite-code-2'],
        'one invite for the first baseline, one for the run that took over its receipt',
      );
      assert.deepEqual(liveInvites(stub), ['invite-code-2'], 'and only the current run\'s invite is live');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * The cost of claiming before the network is that a run which never gets to the
 * create now holds a marker for work it did not do. It has to give that back, or
 * a bad token would wedge every later baseline in the directory over an invite
 * that does not exist.
 */
test('a baseline that fails before the create releases its own claim', async () => {
  const stub = await stubDiscord({ rolesStatus: 403 });
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    const failed = await runScript(stub, { dir });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /Could not read roles/);
    assert.throws(
      () => inviteReceipt(dir),
      /ENOENT/,
      'a run that never reached the create must not leave a claim behind',
    );

    stub.rolesStatus = 200;
    const recovered = await runScript(stub, { dir });
    assert.equal(recovered.code, 0, recovered.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * The other half of that, and the direction that must fail closed: once the
 * create is on the wire an invite may exist whatever came back, so the marker
 * stays and the next baseline is refused. `the baseline stages the invite file
 * before the invite exists` proves the marker survives; this proves it still
 * does the job the release must never undo.
 */
test('a baseline that fails after the create keeps its claim', async () => {
  const stub = await stubDiscord({ inviteCreateStatus: 500 });
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    const base = await runScript(stub, { dir });
    assert.notEqual(base.code, 0);
    assert.equal(inviteReceipt(dir), `run ${baselineRunId(dir)}\npending\n`);

    const second = await runScript(stub, { dir });
    assert.notEqual(second.code, 0, 'a create that may have succeeded must still wedge the next baseline');
    assert.match(second.stderr, /never recorded an invite code/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

/**
 * The release is the one path that deletes the invite artifact, so it must only
 * ever delete the marker its own run wrote. Here the parked run's claim is
 * replaced by someone else's live handle before it fails: deleting that would
 * orphan an invite in the name of cleaning up.
 */
test('a failing baseline does not release a handle it did not write', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-staging-demo-'));
  try {
    const foreign = 'run 11111111-1111-4111-8111-111111111111\nhttps://discord.gg/foreign-code\n';
    await withHeldBaseline(stub, dir, async (run, release) => {
      writeFileSync(join(dir, 'invite.txt'), foreign);
      stub.rolesStatus = 403;
      release();
      const result = await run;
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Could not read roles/);
      assert.equal(
        readFileSync(join(dir, 'invite.txt'), 'utf8'),
        foreign,
        'the failing run must leave a handle that is not its own exactly where it found it',
      );
    });
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
    // TOG-2971 P3: this was `<= 4`, which is not a regression test for per-type
    // fan-out - it is satisfied by two, three or four requests, so a scan that
    // fanned out across two of the four action types would still have passed.
    // On this fixture the audit log is one short page, so --verify makes exactly
    // one scan of exactly one request. Assert that number.
    assert.equal(
      stub.auditRequests,
      1,
      `--verify must make exactly one audit request on a single-page log; saw ${stub.auditRequests}`,
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
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 404 at /m);
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
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 200 at /m);
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
    assert.match(inviteReceipt(dir), /^revoked invite-code HTTP 200 at /m);
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
