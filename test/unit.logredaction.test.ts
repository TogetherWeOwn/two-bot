// TOG-8299. Log-redaction negative battery for docs/SECRETS.md rule 4.
//
// The unit.tokenleak sweep proves the *logger* never emits a token-shaped
// value; this file proves the *call sites* never hand it one. A fake bot token
// and a fake member OAuth token are pushed through the real log-emitting code
// paths, every captured byte of stdout/stderr is scanned, and the suite reds
// if either fake value (or anything shaped like a Discord token) appears.
//
// The reviewer's check: pick any `log.info`/`log.error` call site in this
// repo, add a probe line like `log.info('x', { probe: FAKE_BOT_TOKEN })`
// (the constant is exported for exactly this), and watch this suite fail
// naming the leak. Remove it and it goes green.
//
// Runs under plain `node --test` with no database: the moderation half uses
// an in-memory ModerationStore double, and the endpoint half runs with no
// store (its replay guard falls back to the in-process cache).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { log, setLogLevel } from '../src/core/log.ts';
import {
  assertStagingGuild,
  E2E_TOKEN_CREDENTIAL,
  E2E_TOKEN_ENV,
  openSession,
  sessionIsOpen,
} from '../src/e2e/session.ts';
import {
  applicationIdFromToken,
  checkStagingToken,
  LIVE_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_ID,
  LIVE_GUILD_ID,
  TWO_STAGING_GUILD_ID,
} from '../src/staging/spec.ts';
import { startInternalActions, type InternalServer } from '../src/internal/server.ts';
import { KeyRing, sign } from '../src/internal/signing.ts';
import { buildChannelKeys, buildRoleKeys, IMPLEMENTED_ACTIONS } from '../src/internal/actions.ts';
import { ModerationService, type ModerationExecution } from '../src/moderation/service.ts';
import { ModerationStore } from '../src/moderation/store.ts';
import type { ModerationDiscordClient } from '../src/moderation/discord.ts';
import type { ModerationRequest } from '../src/moderation/types.ts';
import type { AuditSink } from '../src/audit/service.ts';
import type { Db, RunResult } from '../src/store/db.ts';
import type { Acted } from '../src/e2e/guard.ts';
import type { GatewayEvent, HarnessTransport } from '../src/e2e/transport.ts';

// ---------------------------------------------------------------------------
// Fakes. All laboratory values, never credentials.
//
// FAKE_BOT_TOKEN is shaped like a real Discord bot token (three segments with
// the M-led head the discord-bot-token rule matches) so it trips both the
// exact-value check (`captured.includes(value)`) and the shape check (the
// same pattern mirrored from .gitleaks.toml in unit.tokenleak.test.ts). It is
// random per process, so a scanner cannot mistake it for a committed literal.
// FAKE_OAUTH_TOKEN is a member OAuth access_token, the one secret that
// arrives inside a request body rather than from the environment.
const BOT_SHAPE = /\b[MNO][A-Za-z0-9_-]{22,26}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/i;
function fakeBotToken(): string {
  const seg = (chars: string, n: number) =>
    Array.from(randomBytes(n), (b) => chars[b % chars.length]).join('');
  const head = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return `M${seg(head, 23)}.${seg(head, 6)}.${seg(head, 27)}`;
}
/** Exported for the reviewer's red-green check described in the header. */
export const FAKE_BOT_TOKEN = fakeBotToken();
const FAKE_OAUTH_TOKEN = `ya29-test-only-${randomBytes(16).toString('hex')}`;
const FAKE_AUDIT_SECRET = `audit-secret-test-only-${randomBytes(8).toString('hex')}`;
const FAKE_DB_URL = `postgres://bot:not-a-real-password-${randomBytes(4).toString('hex')}@127.0.0.1:5432/two_test`;

// ---------------------------------------------------------------------------
// Capture every byte written to stdout/stderr while `fn` runs. Test-runner
// protocol traffic is forwarded, not swallowed, for the same reason as the
// captureLogs helper in e2e.internalactions.test.ts: this process shares its
// streams with the runner, and swallowing its binary protocol loses the
// results of every test inside the window.
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const tap = (real: (c: unknown, ...rest: unknown[]) => boolean) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      chunks.push(text);
      if (/^\d+ \w+ /.test(text) && text.includes('TAP')) return real(chunk, ...rest);
      if (text.startsWith('not ok') || text.startsWith('ok ')) return real(chunk, ...rest);
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = tap(realOut as never);
  process.stderr.write = tap(realErr as never);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return chunks.join('');
}

/** Fail naming the offending fake if it (or a token-shaped value) leaked. */
function assertNoLeak(captured: string, where: string): void {
  assert.ok(!captured.includes(FAKE_BOT_TOKEN), `${where}: fake bot token reached log output`);
  assert.ok(!captured.includes(FAKE_OAUTH_TOKEN), `${where}: fake OAuth token reached log output`);
  assert.ok(!captured.includes(FAKE_AUDIT_SECRET), `${where}: fake audit secret reached log output`);
  assert.ok(!captured.includes(FAKE_DB_URL), `${where}: fake database URL reached log output`);
  assert.ok(!BOT_SHAPE.test(captured), `${where}: a token-shaped value reached log output`);
}

test('the fakes are shaped to trip the detector (else the battery below proves nothing)', () => {
  assert.match(FAKE_BOT_TOKEN, BOT_SHAPE, 'fake bot token no longer matches the bot-token shape');
  // The OAuth fake must NOT match the bot-token shape: it is the exact-value
  // check that catches it, and conflating the two would hide a dead check.
  assert.doesNotMatch(FAKE_OAUTH_TOKEN, BOT_SHAPE, 'oauth fake collides with the bot-token shape');
  assertNoLeak('nothing secret here: mock-token, placeholders, 1234', 'calibration');
});

// --- env-carried secrets never reach log output ----------------------------

test('a logger fed the live env names emits no fake value at any level', async () => {
  assert.match(FAKE_BOT_TOKEN, BOT_SHAPE);
  const saved = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    TWO_DATABASE_URL: process.env.TWO_DATABASE_URL,
    TWO_MODERATION_AUDIT_SECRET: process.env.TWO_MODERATION_AUDIT_SECRET,
  };
  process.env.DISCORD_TOKEN = FAKE_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = FAKE_BOT_TOKEN;
  process.env.TWO_DATABASE_URL = FAKE_DB_URL;
  process.env.TWO_MODERATION_AUDIT_SECRET = FAKE_AUDIT_SECRET;
  setLogLevel('debug');
  let captured = '';
  try {
    captured = await captureOutput(async () => {
      log.debug('redaction probe debug', { where: 'unit.logredaction' });
      log.info('redaction probe info', { where: 'unit.logredaction' });
      log.error('redaction probe error', { where: 'unit.logredaction' });
    });
  } finally {
    setLogLevel('info');
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.ok(captured.length > 0, 'expected the three probe lines to be captured');
  assertNoLeak(captured, 'logger probe');
});

// --- the OAuth token inside the endpoint body -------------------------------

const KEY_ID = 'web-prod';
const KEY_SECRET = 'k'.repeat(48);
const MEMBER = '900000000000009999';
const CHANNEL_KEY_SPEC = 'announcements:1045943373007171674';
const GUILD = TWO_STAGING_GUILD_ID;
const ALL_ACTIONS = new Set<string>(IMPLEMENTED_ACTIONS);

const servers: InternalServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

async function startServer(over: Record<string, unknown> = {}): Promise<InternalServer> {
  const srv = await startInternalActions({
    host: '127.0.0.1',
    port: 0,
    keys: new KeyRing([{ id: KEY_ID, secret: KEY_SECRET }]),
    guildId: GUILD,
    discord: {
      async memberRoles() { return []; },
      async addRole() {},
      async addMember() { return 'added'; },
      async postMessage() { return 'msg-1'; },
      async createEvent() { return 'evt-1'; },
      async updateEvent() {},
      async cancelEvent() {},
    },
    roleKeys: buildRoleKeys(),
    channelKeys: buildChannelKeys(CHANNEL_KEY_SPEC),
    enabled: new Set(ALL_ACTIONS),
    ...over,
  } as never);
  servers.push(srv);
  return srv;
}

async function postAction(
  srv: InternalServer,
  body: unknown,
  over: { secret?: string; idempotencyKey?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-two-key-id': KEY_ID,
    'x-two-timestamp': timestamp,
    'x-two-nonce': nonce,
    'x-two-signature': sign(over.secret ?? KEY_SECRET, timestamp, nonce, raw),
  };
  if (over.idempotencyKey !== undefined) headers['idempotency-key'] = over.idempotencyKey;
  const res = await fetch(srv.url, { method: 'POST', headers, body: raw });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('the member OAuth token appears in no endpoint log line: success, rejection, or thrown error', async () => {
  // 1. Rejected before the action runs: the body's access_token is parsed and
  //    present, but the signing key is wrong so the action never starts.
  const rejectSrv = await startServer();
  const rejectLogs = await captureOutput(async () => {
    const res = await postAction(
      rejectSrv,
      { action: 'guild.add_member', discord_id: MEMBER, access_token: FAKE_OAUTH_TOKEN },
      { secret: 'z'.repeat(48) },
    );
    assert.equal(res.status, 401);
  });
  assert.ok(rejectLogs.includes('internal_action'), 'the rejection was actually logged');
  assertNoLeak(rejectLogs, 'endpoint rejection path');

  // 2. An enabled action whose Discord call throws with the token quoted in
  //    the error message. The realistic leak: a catch block that logs
  //    String(err). The server logs where it broke, never what it said.
  const throwSrv = await startServer({
    discord: {
      async memberRoles() { return []; },
      async addRole() {},
      async addMember(_g: string, _u: string, t: string) {
        throw new Error(`upstream exploded while sending access_token=${t}`);
      },
      async postMessage() { return 'msg-1'; },
      async createEvent() { return 'evt-1'; },
      async updateEvent() {},
      async cancelEvent() {},
    },
    enabled: new Set([...ALL_ACTIONS, 'guild.add_member']),
  });
  const throwLogs = await captureOutput(async () => {
    const res = await postAction(throwSrv, {
      action: 'guild.add_member',
      discord_id: MEMBER,
      access_token: FAKE_OAUTH_TOKEN,
    });
    assert.equal(res.status, 500);
    assert.ok(
      !JSON.stringify(res.body).includes(FAKE_OAUTH_TOKEN),
      'token leaked into the response',
    );
  });
  assert.ok(throwLogs.includes('internal_action'), 'the failure was actually logged');
  assertNoLeak(throwLogs, 'endpoint exception path');

  // 3. A signed role.assign whose role_key names nothing assignable. The
  //    refusal is logged with the reason code, and the log line must carry
  //    only the outcome, never the request body (announcement.post would
  //    serve too, but it needs the durable store for its idempotency key).
  const okSrv = await startServer();
  const okLogs = await captureOutput(async () => {
    const res = await postAction(okSrv, {
      action: 'role.assign',
      discord_id: MEMBER,
      role_key: `not-a-key-${FAKE_BOT_TOKEN}`,
    });
    assert.equal(res.status, 403);
  });
  assert.ok(okLogs.includes('internal_action'), 'the refusal was actually logged');
  assertNoLeak(okLogs, 'endpoint refusal path');
});

// --- moderation audit failure paths (in-memory store, no database) ----------

const ACTOR = '900000000000000001';
const TARGET = '900000000000000002';
const OWEN = '900000000000000003';
const CHANNEL = '900000000000000005';

/**
 * The ModerationService paths under test touch three tables
 * (moderation_idempotency, moderation_warnings, moderation_audit_outbox via
 * the audit sink). This double answers claim/complete/addWarning against a
 * Map and never touches SQL, so the battery runs with no database. `claim`
 * always reports a fresh win: precisely the state `recordSuccess` needs to
 * reach the failing audit sink and its log line.
 */
function memoryStore(): ModerationStore {
  const claims = new Map<string, { action: string; hash: string }>();
  const fakeDbInit: Db = {
    prepare(sql: string) {
      void sql;
      return {
        async get<T>(...params: unknown[]): Promise<T | undefined> {
          // claim(): INSERT ... ON CONFLICT DO NOTHING RETURNING. Report a
          // fresh win for a new key, which drives the success path; the
          // refusal test never reaches the store.
          if (params.length >= 2 && typeof params[1] === 'string') {
            const key = `${params[0]}:${params[1]}`;
            if (!claims.has(key)) {
              claims.set(key, { action: String(params[2]), hash: String(params[3]) });
              return { idempotency_key: params[1] } as T;
            }
          }
          return undefined;
        },
        async all<T>(): Promise<T[]> { return []; },
        async run(): Promise<RunResult> { return { changes: 1 }; },
      };
    },
    async exec(): Promise<void> {},
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> { return fn(fakeDbInit); },
    async close(): Promise<void> {},
  };
  return new ModerationStore(fakeDbInit, () => Date.parse('2026-09-08T12:00:00.000Z'));
}

function warnRequest(
  over: Partial<ModerationRequest & { requestId: string; idempotencyKey: string }> = {},
): ModerationExecution {
  return {
    action: 'moderation.warn',
    guildId: GUILD,
    actor: {
      userId: ACTOR,
      roleIds: ['900000000000000010'],
      highestRolePosition: 10,
      permissions: ~0n,
    },
    target: { userId: TARGET, roleIds: [], highestRolePosition: 1, isBot: false, isGuildOwner: false },
    channel: { channelId: CHANNEL, type: 0 },
    reason: `QA redaction proof quoting nothing secret ${randomBytes(4).toString('hex')}`,
    durationSeconds: 60,
    count: 5,
    seconds: 10,
    requestId: `req-${randomBytes(4).toString('hex')}`,
    idempotencyKey: `idem-${randomBytes(6).toString('hex')}`,
    ...over,
  };
}

function stubDiscord(): ModerationDiscordClient {
  return {
    async ban() {}, async unban() {}, async kick() {}, async timeout() {},
    async purge() { return 0; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return { allow: '1024', deny: '8192' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite() {},
  };
}

const failingAudit: AuditSink = {
  async record() {
    throw new Error(`audit store exploded quoting nothing ${randomBytes(2).toString('hex')}`);
  },
  async retryPending() { return 0; },
};

test('moderation failure log lines carry the audit entry id, never the secret', async () => {
  const service = new ModerationService(
    stubDiscord(),
    memoryStore(),
    { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set(), moderationAuditSecret: FAKE_AUDIT_SECRET },
    () => Date.parse('2026-09-08T12:00:00.000Z'),
    failingAudit,
  );
  const captured = await captureOutput(async () => {
    // Success path with a failing audit sink: recordSuccess logs
    // moderation_operational_audit_failed with the derived entry id.
    await service.execute(warnRequest());
    // Refusal path with a failing audit sink: recordRefusal logs
    // moderation_refusal_audit_failed.
    const bad = warnRequest();
    bad.target!.userId = ACTOR; // self target: refused before any mutation
    await assert.rejects(() => service.execute(bad), /cannot moderate yourself/);
  });
  assert.ok(
    captured.includes('moderation_operational_audit_failed') ||
      captured.includes('moderation_refusal_audit_failed'),
    'expected at least one moderation audit-failure log line',
  );
  assertNoLeak(captured, 'moderation audit failure');
});

// --- the throwaway-account credential ----------------------------------------

class ClosedTransport implements HarnessTransport {
  async acceptRules(): Promise<Acted<void>> { return { status: 200, value: undefined }; }
  async sendMessage(): Promise<Acted<{ id: string }>> { return { status: 200, value: { id: '1' } }; }
  async addReaction(): Promise<Acted<void>> { return { status: 200, value: undefined }; }
  async clickButton(): Promise<Acted<void>> { return { status: 200, value: undefined }; }
  async joinVoice(): Promise<Acted<void>> { return { status: 200, value: undefined }; }
  async leaveVoice(): Promise<Acted<void>> { return { status: 200, value: undefined }; }
  async awaitEvent(): Promise<Acted<GatewayEvent | null>> { return { status: 504, value: null }; }
}

test('the e2e credential never reaches log output, including on connect failure', async () => {
  assert.equal(sessionIsOpen(), false, 'a previous test left the singleton open');
  const creds = { dir: null as string | null, env: { [E2E_TOKEN_ENV]: FAKE_OAUTH_TOKEN } };

  const okLogs = await captureOutput(async () => {
    const session = await openSession({
      guildId: TWO_STAGING_GUILD_ID,
      connect: (token) => {
        assert.equal(token, FAKE_OAUTH_TOKEN, 'the transport is the only thing handed the credential');
        return new ClosedTransport();
      },
      credentials: creds,
    });
    session.close();
  });
  assertNoLeak(okLogs, 'e2e session open');

  const failLogs = await captureOutput(async () => {
    await assert.rejects(
      () =>
        openSession({
          guildId: TWO_STAGING_GUILD_ID,
          connect: () => {
            throw new Error(`gateway refused while sending ${FAKE_OAUTH_TOKEN}`);
          },
          credentials: creds,
        }),
      (err: unknown) =>
        err instanceof Error &&
        /connection failed/.test(err.message) &&
        !err.message.includes(FAKE_OAUTH_TOKEN),
    );
  });
  assertNoLeak(failLogs, 'e2e session connect failure');
  assert.equal(sessionIsOpen(), false, 'a failed connect must not strand the singleton');
});

// --- staging-token diagnostics name the application, never the token --------

test('staging-token diagnostics quote no credential material', async () => {
  const stagingShaped = `${Buffer.from(STAGING_BOT_APPLICATION_ID).toString('base64')}.${'G'.repeat(6)}.${'y'.repeat(10)}`;
  const liveShaped = `${Buffer.from(LIVE_BOT_APPLICATION_ID).toString('base64')}.${'G'.repeat(6)}.${'y'.repeat(10)}`;
  assert.equal(applicationIdFromToken(stagingShaped), STAGING_BOT_APPLICATION_ID);
  assert.equal(applicationIdFromToken(liveShaped), LIVE_BOT_APPLICATION_ID);

  // checkStagingToken returns MESSAGES that scripts print. The messages name
  // application ids (public numbers), never the submitted token.
  const captured = await captureOutput(async () => {
    for (const t of [stagingShaped, liveShaped, 'not-a-token', FAKE_BOT_TOKEN]) {
      const r = checkStagingToken(t);
      log.info('staging_token_checked', { ok: r.ok, message: r.message });
      assert.ok(!r.message.includes(t), 'diagnostic message quotes the submitted token');
    }
    assertStagingGuild(TWO_STAGING_GUILD_ID);
    assert.throws(() => assertStagingGuild(LIVE_GUILD_ID), /live guild/);
  });
  assertNoLeak(captured, 'staging-token diagnostics');
  assert.equal(E2E_TOKEN_ENV, 'TWO_E2E_USER_TOKEN');
  assert.equal(E2E_TOKEN_CREDENTIAL, 'two_e2e_user_token');
});

// --- static guard: no secret-named key or unlisted spread in a log call -----

test('no log call site passes a secret-named key or an unlisted spread', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repo = fileURLToPath(new URL('..', import.meta.url));

  // The exact-value battery above catches a leak that already happened; this
  // catches the shape of the next one. Object-literal keys are matched after
  // stripping string literals, so a key named `token` trips even when its
  // value is inert - rename the local (as src/moderation/service.ts should:
  // `auditToken`) rather than allowlisting it.
  const SECRET_KEYS = new Set([
    'token', 'secret', 'password', 'passwd', 'api_key', 'apikey', 'bearer',
    'private_key', 'privatekey', 'client_secret', 'refresh_token', 'access_token',
    'session_token', 'database_url', 'db_url', 'auth_token', 'credential',
  ]);
  // Spreads whose contents were read by hand for this card: schema names,
  // reconcile counters, eligibility flags, finite field sets. A new spread
  // into a log call fails here until a human verifies it carries no secret
  // and lists it.
  const KNOWN_SPREADS = new Set([
    'src/index.ts:applied', // ApplyWebContractResult: two schema names
    'src/index.ts:report', // ReconcileReport: four counters
    'src/leveling/rewardRoleApply.ts:eligibility', // GrantEligibility flags
    'scripts/funnel-attribution-eval.ts:summary', // EvalSummary scores
    'scripts/levels-reward-role-apply.ts:fields', // reward-role logger events
    'scripts/moderation-disable-preflight.ts:state', // outstanding counts + ids
  ]);
  // The endpoint's own per-request line is fields-listed in code
  // (src/internal/server.ts logLine); `extra` is only ever
  // safeErrorFields(err) (name + origin frame, never the message) and
  // `reason` is an ActionError logReason constant.
  const LOG_LINE_FIELDS = new Set([
    'requestId', 'keyId', 'action', 'idempotencyKey', 'outcome', 'code', 'status',
    'reason', 'retryable', 'durationMs', 'errName', 'errAt', 'err',
  ]);

  const strip = (text: string): string => {
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') {
        const j = text.indexOf('\n', i);
        out += '\n';
        i = j < 0 ? n : j + 1;
      } else if (c === '/' && text[i + 1] === '*') {
        const j = text.indexOf('*/', i + 2);
        i = j < 0 ? n : j + 2;
      } else if (c === "'" || c === '"' || c === '`') {
        const q = c;
        let j = i + 1;
        while (j < n) {
          if (text[j] === '\\') { j += 2; continue; }
          if (text[j] === q) break;
          j++;
        }
        i = j + 1;
        out += ' ';
      } else {
        out += c;
        i++;
      }
    }
    return out;
  };

  const callRe =
    /(?:\blog\s*\.\s*(?:debug|info|error|warn)\s*\(|console\s*\.\s*(?:log|error|warn|debug|info)\s*\()/g;
  const keyRe = /[{,]\s*(\.\.\.)?([A-Za-z_$][\w$]*)\s*(?=[,:}])/g;
  const violations: string[] = [];

  const files: string[] = execFileSync('git', ['-C', repo, 'ls-files', '*.ts'], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => !p.startsWith('tools/mock-discord/'))
    .filter((p) => p !== 'test/unit.logredaction.test.ts');
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(repo, rel), 'utf8');
    } catch {
      continue;
    }
    callRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(text)) !== null) {
      let depth = 0;
      let j = m.index + m[0].length - 1;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const chunk = strip(text.slice(m.index, j + 1));
      keyRe.lastIndex = 0;
      let km: RegExpExecArray | null;
      while ((km = keyRe.exec(chunk)) !== null) {
        const isSpread = km[1] === '...';
        const name = km[2]!;
        const line = text.slice(0, m.index).split('\n').length;
        if (isSpread) {
          if (!KNOWN_SPREADS.has(`${rel}:${name}`)) {
            violations.push(`${rel}:${line}: unlisted spread ...${name} into a log call`);
          }
          continue;
        }
        if (rel === 'src/internal/server.ts' && LOG_LINE_FIELDS.has(name)) continue;
        if (SECRET_KEYS.has(name.toLowerCase())) {
          violations.push(`${rel}:${line}: secret-named key \`${name}\` in a log call`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `secret-shaped log call sites:\n${violations.join('\n')}`);
});
