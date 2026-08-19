/**
 * POST /internal/actions, end to end over real HTTP.
 *
 * The list here is the one published in docs/INTERNAL_ACTIONS.md §10, minus
 * the two idempotency-key cases that need the durable store (TWO-18). It was
 * agreed before there was any code, which is the point: these are the ways
 * this endpoint gets someone hurt, not the ways it is convenient to test.
 *
 * Two doubles are in play. The happy paths run against tools/mock-discord, so
 * we assert on the HTTP the bot really sent. The failure paths inject a fetch
 * or a client directly, because "Discord timed out" is not a thing a mock
 * server should have to pretend to be.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startMockDiscord, type MockDiscord } from '../tools/mock-discord/server.ts';
import { startInternalActions, type InternalServer, type InternalServerOptions } from '../src/internal/server.ts';
import { KeyRing, sign } from '../src/internal/signing.ts';
import { buildRoleKeys } from '../src/internal/actions.ts';
import { DiscordActions, type ActionDiscord, type AddMemberOutcome } from '../src/internal/discordActions.ts';
import { AUTH_FAILURE_MESSAGE } from '../src/internal/errors.ts';

const KEY_ID = 'web-prod';
const SECRET = 'k'.repeat(48);
const OTHER_SECRET = 'z'.repeat(48);
const MEMBER = '900000000000009999';
const ROLE_KEY = 'rocketleague';
const ROLE_ID = '1065438504521322526'; // src/onboarding/catalog.ts
const ALL_ACTIONS = new Set(['role.assign', 'guild.add_member']);

let mock: MockDiscord;
const servers: InternalServer[] = [];

before(async () => {
  mock = await startMockDiscord();
});
after(async () => {
  for (const s of servers) await s.close();
  await mock.close();
});
beforeEach(() => {
  mock.captured.length = 0;
});

/** A client that records what it was asked to do and nothing else. */
function recordingDiscord(over: Partial<ActionDiscord> = {}) {
  const calls: string[] = [];
  const client: ActionDiscord = {
    async memberRoles(_g, _u) {
      calls.push('memberRoles');
      return [];
    },
    async addRole(_g, _u, r) {
      calls.push(`addRole:${r}`);
    },
    async addMember(_g, u, _t): Promise<AddMemberOutcome> {
      calls.push(`addMember:${u}`);
      return 'added';
    },
    ...over,
  };
  return { client, calls };
}

async function start(over: Partial<InternalServerOptions> = {}): Promise<InternalServer> {
  const srv = await startInternalActions({
    host: '127.0.0.1',
    port: 0,
    keys: new KeyRing([{ id: KEY_ID, secret: SECRET }]),
    guildId: mock.guildId,
    discord: recordingDiscord().client,
    roleKeys: buildRoleKeys(),
    enabled: new Set(ALL_ACTIONS),
    ...over,
  });
  servers.push(srv);
  return srv;
}

/** A server wired to the real REST client, pointed at tools/mock-discord. */
async function startAgainstMock(over: Partial<InternalServerOptions> = {}) {
  return start({
    // mock.apiBase omits the version, because discord.js appends it. This
    // client talks to the API directly, so it says which version it wants.
    discord: new DiscordActions({ token: 'mock-bot-token', base: `${mock.apiBase}/v10` }),
    ...over,
  });
}

interface CallOptions {
  body?: unknown;
  /** Bytes actually sent, when they must differ from what was signed. */
  raw?: string;
  /** Bytes that were signed, when they must differ from what is sent. */
  signedRaw?: string;
  keyId?: string;
  secret?: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  contentType?: string | null;
  omitAuth?: boolean;
}

interface CallResult {
  status: number;
  retryAfter: string | null;
  body: {
    ok: boolean;
    request_id: string;
    result?: { outcome?: string };
    error?: { code: string; message: string; retryable: boolean };
  };
}

async function call(srv: InternalServer, o: CallOptions = {}): Promise<CallResult> {
  const raw = Buffer.from(o.raw ?? JSON.stringify(o.body ?? {}));
  const signed = o.signedRaw === undefined ? raw : Buffer.from(o.signedRaw);
  const timestamp = o.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? randomBytes(16).toString('hex');
  const signature = o.signature ?? sign(o.secret ?? SECRET, timestamp, nonce, signed);

  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
  if (!o.omitAuth) {
    headers['x-two-key-id'] = o.keyId ?? KEY_ID;
    headers['x-two-timestamp'] = timestamp;
    headers['x-two-nonce'] = nonce;
    headers['x-two-signature'] = signature;
  }

  const res = await fetch(srv.url, { method: 'POST', headers, body: raw });
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: (await res.json()) as CallResult['body'],
  };
}

const roleAssign = { action: 'role.assign', discord_id: MEMBER, role_key: ROLE_KEY };
const addMember = (token: string) => ({ action: 'guild.add_member', discord_id: MEMBER, access_token: token });

/** The structured log lines emitted while `fn` runs, parsed. */
function jsonLines(captured: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of captured.split('\n')) {
    // The test reporter writes to this stream too, and not always with a
    // trailing newline, so a log line can start mid-string.
    const at = line.indexOf('{"ts":');
    if (at === -1) continue;
    try {
      out.push(JSON.parse(line.slice(at)) as Record<string, unknown>);
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

/** Everything written to stdout/stderr while `fn` runs. */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // Everything written while we listen is captured - a leak we did not
  // anticipate is exactly the thing this is looking for. But the test runner
  // shares these streams and its own protocol is binary, so anything that is
  // not one of our log lines is forwarded on unmodified. Swallowing it loses
  // the results of every test that runs inside this window.
  const relay = (real: (c: unknown, ...rest: unknown[]) => boolean) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      lines.push(text);
      if (text.includes('"msg":"internal_action')) return true;
      return real(chunk, ...rest);
    }) as typeof process.stdout.write;

  process.stdout.write = relay(realOut as never);
  process.stderr.write = relay(realErr as never);
  try {
    await fn();
    // The log line is written just after the response is flushed; let the
    // handler finish its tick before we stop listening.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return lines.join('');
}

// --- the two actions ---------------------------------------------------------

test('role.assign puts the role on the member', async () => {
  const srv = await startAgainstMock();
  const res = await call(srv, { body: roleAssign });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.result?.outcome, 'assigned');
  assert.match(res.body.request_id, /^[0-9A-Z]{26}$/);

  const put = mock.captured.filter((c) => c.method === 'PUT' && c.url.endsWith(`/roles/${ROLE_ID}`));
  assert.equal(put.length, 1, 'exactly one role write');
  assert.match(put[0].url, new RegExp(`/members/${MEMBER}/roles/${ROLE_ID}$`));
});

test('role.assign on a role the member already holds writes nothing', async () => {
  const srv = await startAgainstMock();
  mock.setMemberRoles(MEMBER, [ROLE_ID]);
  const res = await call(srv, { body: roleAssign });

  assert.equal(res.status, 200);
  assert.equal(res.body.result?.outcome, 'already_held');
  assert.equal(mock.captured.filter((c) => c.method === 'PUT').length, 0);
  mock.setMemberRoles(MEMBER, []);
});

test('role.assign refuses a role key that is not in the map', async () => {
  const srv = await startAgainstMock();
  const res = await call(srv, {
    body: { action: 'role.assign', discord_id: MEMBER, role_key: 'admin' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error?.code, 'action_not_allowed');
  assert.equal(res.body.error?.retryable, false);
  assert.equal(mock.captured.length, 0, 'nothing reached Discord');
});

test('guild.add_member: 201 is added, 204 is already_member', async () => {
  const srv = await startAgainstMock();
  const newcomer = '900000000000001111';
  const existing = '900000000000002222';
  mock.addExistingMember(existing);

  const first = await call(srv, { body: { ...addMember('oauth-tok-1'), discord_id: newcomer } });
  assert.equal(first.status, 200);
  assert.equal(first.body.result?.outcome, 'added');
  assert.equal(mock.hasMember(newcomer), true);

  const second = await call(srv, { body: { ...addMember('oauth-tok-2'), discord_id: existing } });
  assert.equal(second.status, 200);
  assert.equal(second.body.result?.outcome, 'already_member', 'already in is a success, not an error');
});

test('guild.add_member is refused until it is switched on', async () => {
  // The action is built and tested; it stays dark until the CEO signs off on
  // the allowlist entry (TWO-24). Off is the default.
  const { client, calls } = recordingDiscord();
  const srv = await start({ discord: client, enabled: new Set(['role.assign']) });

  const res = await call(srv, { body: addMember('oauth-tok') });
  assert.equal(res.status, 403);
  assert.equal(res.body.error?.code, 'action_not_allowed');
  assert.deepEqual(calls, [], 'no Discord call for a disabled action');
});

// --- authentication ----------------------------------------------------------

test('a tampered body is rejected even though the signature is valid', async () => {
  const { client, calls } = recordingDiscord();
  const srv = await start({ discord: client });

  const res = await call(srv, {
    signedRaw: JSON.stringify(roleAssign),
    raw: JSON.stringify({ ...roleAssign, role_key: 'pc' }),
  });

  assert.equal(res.status, 401);
  assert.equal(res.body.error?.code, 'unauthorized');
  assert.deepEqual(calls, []);
});

test('a tampered signature is rejected', async () => {
  const srv = await start();
  const good = sign(SECRET, '1', 'a'.repeat(32), Buffer.from('{}'));
  const res = await call(srv, { body: roleAssign, signature: good });
  assert.equal(res.status, 401);
  assert.equal(res.body.error?.code, 'unauthorized');
});

test('an unknown key id is indistinguishable from a bad signature', async () => {
  const srv = await start();
  const unknownKey = await call(srv, { body: roleAssign, keyId: 'web-staging' });
  const badSig = await call(srv, { body: roleAssign, secret: OTHER_SECRET });

  assert.equal(unknownKey.status, badSig.status);
  assert.deepEqual(unknownKey.body.error, badSig.body.error);
  assert.equal(unknownKey.body.error?.message, AUTH_FAILURE_MESSAGE);
  assert.equal(unknownKey.retryAfter, badSig.retryAfter);
  // request_id is the only field that differs, and it must - it is the join
  // key between the website's logs and ours.
  assert.notEqual(unknownKey.body.request_id, badSig.body.request_id);
});

test('missing auth headers are unauthorized, not a 500', async () => {
  const srv = await start();
  const res = await call(srv, { body: roleAssign, omitAuth: true });
  assert.equal(res.status, 401);
  assert.equal(res.body.error?.code, 'unauthorized');
  assert.equal(res.body.error?.message, AUTH_FAILURE_MESSAGE);
});

test('a timestamp outside the window is stale, in both directions', async () => {
  const { client, calls } = recordingDiscord();
  const srv = await start({ discord: client });
  const now = Math.floor(Date.now() / 1000);

  for (const ts of [now - 121, now + 121]) {
    const res = await call(srv, { body: roleAssign, timestamp: String(ts) });
    assert.equal(res.status, 401, `timestamp ${ts - now}s`);
    assert.equal(res.body.error?.code, 'stale_request');
    assert.equal(res.body.error?.retryable, false);
  }
  // And the edge inside the window is fine.
  const ok = await call(srv, { body: roleAssign, timestamp: String(now - 119) });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, ['memberRoles', `addRole:${ROLE_ID}`]);
});

test('a replayed nonce is rejected and makes no Discord call', async () => {
  const { client, calls } = recordingDiscord();
  const srv = await start({ discord: client });
  const nonce = randomBytes(16).toString('hex');

  const first = await call(srv, { body: roleAssign, nonce });
  assert.equal(first.status, 200);
  const callsAfterFirst = [...calls];

  const replay = await call(srv, { body: roleAssign, nonce });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error?.code, 'replayed');
  assert.equal(replay.body.error?.retryable, false);
  assert.deepEqual(calls, callsAfterFirst, 'the replay reached Discord not at all');
});

// --- shape of the request ----------------------------------------------------

test('malformed bodies are 400, and each kind is caught', async () => {
  const { client, calls } = recordingDiscord();
  const srv = await start({ discord: client });

  const cases: [string, CallOptions][] = [
    ['not JSON', { raw: '{not json' }],
    ['a JSON array', { raw: '[1,2,3]' }],
    ['no action', { body: { discord_id: MEMBER } }],
    ['action of the wrong type', { body: { action: 42 } }],
    ['missing discord_id', { body: { action: 'role.assign', role_key: ROLE_KEY } }],
    ['discord_id of the wrong type', { body: { action: 'role.assign', discord_id: 12345, role_key: ROLE_KEY } }],
    ['discord_id that is not a snowflake', { body: { action: 'role.assign', discord_id: 'me', role_key: ROLE_KEY } }],
    ['missing role_key', { body: { action: 'role.assign', discord_id: MEMBER } }],
    ['the wrong content type', { body: roleAssign, contentType: 'text/plain' }],
  ];

  for (const [name, opts] of cases) {
    const res = await call(srv, opts);
    assert.equal(res.status, 400, name);
    assert.equal(res.body.error?.code, 'malformed', name);
    assert.equal(res.body.error?.retryable, false, name);
  }
  assert.deepEqual(calls, [], 'nothing malformed reached Discord');
});

test('an action outside the allowlist is refused, including one we have not built', async () => {
  const { client, calls } = recordingDiscord();
  const srv = await start({ discord: client });

  const invented = await call(srv, { body: { action: 'guild.ban', discord_id: MEMBER } });
  assert.equal(invented.status, 403);
  assert.equal(invented.body.error?.code, 'action_not_allowed');

  // Approved in the spec, but it needs the durable idempotency store. A typed
  // refusal beats a 500 while the website is being written against the doc.
  const pending = await call(srv, { body: { action: 'announcement.post', channel_key: 'announcements', body: 'hi' } });
  assert.equal(pending.status, 403);
  assert.equal(pending.body.error?.code, 'action_not_allowed');
  assert.equal(pending.body.error?.retryable, false);

  assert.deepEqual(calls, []);
});

test('anything but POST /internal/actions is a 404', async () => {
  const srv = await start();
  const res = await fetch(srv.url.replace('/internal/actions', '/internal/whatever'), { method: 'POST' });
  assert.equal(res.status, 404);
  const get = await fetch(srv.url);
  assert.equal(get.status, 404);
});

// --- limits ------------------------------------------------------------------

test('over the rate limit returns 429 with a usable Retry-After', async () => {
  const { client } = recordingDiscord();
  const srv = await start({ discord: client });

  let limited: CallResult | null = null;
  // The burst is 20; 25 back-to-back must run into the wall.
  for (let i = 0; i < 25; i++) {
    const res = await call(srv, { body: roleAssign });
    if (res.status === 429) {
      limited = res;
      break;
    }
  }

  assert.ok(limited, 'the rate limit never engaged');
  assert.equal(limited.body.error?.code, 'rate_limited');
  assert.equal(limited.body.error?.retryable, true, 'the site is meant to back off and retry');
  assert.ok(Number(limited.retryAfter) >= 1, `Retry-After was ${limited.retryAfter}`);
});

// --- Discord failing ---------------------------------------------------------

/** A fetch that answers every call the same way, and counts the attempts. */
function fixedFetch(make: () => Response | Promise<Response>) {
  const state = { calls: 0 };
  const impl = (async () => {
    state.calls++;
    return make();
  }) as unknown as typeof fetch;
  return { impl, state };
}

test('Discord 5xx, 429, 403 and a timeout each map to their own typed error', async () => {
  const cases: [string, () => Response, number, string, boolean][] = [
    ['500', () => new Response(null, { status: 500 }), 502, 'discord_unavailable', true],
    ['503', () => new Response(null, { status: 503 }), 502, 'discord_unavailable', true],
    ['403', () => new Response(null, { status: 403 }), 422, 'discord_rejected', false],
    ['429', () => new Response(null, { status: 429, headers: { 'retry-after': '3' } }), 429, 'rate_limited', true],
  ];

  for (const [name, make, status, code, retryable] of cases) {
    const { impl, state } = fixedFetch(make);
    const srv = await start({
      discord: new DiscordActions({ token: 't', base: 'http://127.0.0.1:1/api/v10', fetchImpl: impl }),
    });
    const res = await call(srv, { body: addMember('oauth-tok') });

    assert.equal(res.status, status, name);
    assert.equal(res.body.error?.code, code, name);
    assert.equal(res.body.error?.retryable, retryable, name);
    assert.equal(state.calls, 1, `${name}: exactly one attempt, no retry storm`);
  }
});

test('a Discord 429 passes its own Retry-After through', async () => {
  const { impl } = fixedFetch(() => new Response(null, { status: 429, headers: { 'retry-after': '3' } }));
  const srv = await start({
    discord: new DiscordActions({ token: 't', base: 'http://127.0.0.1:1/api/v10', fetchImpl: impl }),
  });
  const res = await call(srv, { body: addMember('oauth-tok') });
  assert.equal(res.retryAfter, '3');
});

test('Discord not answering inside the budget is upstream_timeout, once', async () => {
  const state = { calls: 0 };
  const hang = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      state.calls++;
      init.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as unknown as typeof fetch;

  const srv = await start({
    discord: new DiscordActions({
      token: 't',
      base: 'http://127.0.0.1:1/api/v10',
      fetchImpl: hang,
      addMemberTimeoutMs: 80,
    }),
  });

  const started = Date.now();
  const res = await call(srv, { body: addMember('oauth-tok') });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 504);
  assert.equal(res.body.error?.code, 'upstream_timeout');
  assert.equal(res.body.error?.retryable, true);
  assert.equal(state.calls, 1, 'no retry - the caller has a 2s budget of its own');
  assert.ok(elapsed < 1500, `failed fast in ${elapsed}ms`);
});

// --- the credential ----------------------------------------------------------

test('access_token appears in no log line: success, rejection, or thrown exception', async () => {
  const TOKEN = 'ya29-NEVER-LOG-THIS-0123456789';

  // 1. Success, through the real REST client against the mock.
  const okServer = await startAgainstMock();
  const okLogs = await captureLogs(async () => {
    const res = await call(okServer, { body: { ...addMember(TOKEN), discord_id: '900000000000003333' } });
    assert.equal(res.status, 200);
  });
  assert.ok(okLogs.includes('internal_action'), 'the request was actually logged');
  assert.ok(!okLogs.includes(TOKEN), 'token leaked on the success path');

  // 2. Rejected before the action runs - the body is still parsed and present.
  const rejectServer = await start();
  const rejectLogs = await captureLogs(async () => {
    const res = await call(rejectServer, { body: addMember(TOKEN), secret: OTHER_SECRET });
    assert.equal(res.status, 401);
  });
  assert.ok(!rejectLogs.includes(TOKEN), 'token leaked on the rejection path');

  // 3. An exception whose own message quotes the token. This is the realistic
  //    leak: some library throws with the request it was given, and a catch
  //    block logs String(err). We log where it broke, never what it said.
  const throwServer = await start({
    discord: recordingDiscord({
      async addMember(_g, _u, t) {
        throw new Error(`upstream exploded while sending access_token=${t}`);
      },
    }).client,
  });
  const throwLogs = await captureLogs(async () => {
    const res = await call(throwServer, { body: addMember(TOKEN) });
    assert.equal(res.status, 500);
    assert.equal(res.body.error?.code, 'internal');
    assert.equal(res.body.error?.retryable, true);
    assert.ok(!JSON.stringify(res.body).includes(TOKEN), 'token leaked into the response');
  });
  assert.ok(throwLogs.includes('internal_action'), 'the failure was actually logged');
  assert.ok(!throwLogs.includes(TOKEN), 'token leaked on the exception path');
});

test('the structured log line names the caller, the action and the outcome', async () => {
  const srv = await start();
  let line: Record<string, unknown> | undefined;

  const logs = await captureLogs(async () => {
    await call(srv, { body: roleAssign });
  });
  for (const parsed of jsonLines(logs)) {
    if (parsed.msg === 'internal_action') line = parsed;
  }

  assert.ok(line, 'no internal_action log line');
  assert.equal(line.keyId, KEY_ID);
  assert.equal(line.action, 'role.assign');
  assert.equal(line.outcome, 'assigned');
  assert.equal(line.status, 200);
  assert.equal(typeof line.durationMs, 'number');
  assert.equal(typeof line.requestId, 'string');
});

test('a rejection logs its reason code, so a run of them is diagnosable', async () => {
  const srv = await start();
  const logs = await captureLogs(async () => {
    await call(srv, { body: roleAssign, timestamp: String(Math.floor(Date.now() / 1000) - 300) });
  });
  const line = jsonLines(logs).find((l) => l.msg === 'internal_action');

  assert.equal(line?.code, 'stale_request');
  assert.equal(line?.reason, 'stale_timestamp', 'a pile of these is a clock problem, and should read like one');
});

// --- startup -----------------------------------------------------------------

test('the listener refuses to start on a public address or with no keys', async () => {
  await assert.rejects(
    () => startInternalActions({
      host: '203.0.113.10',
      port: 0,
      keys: new KeyRing([{ id: KEY_ID, secret: SECRET }]),
      guildId: mock.guildId,
      discord: recordingDiscord().client,
      roleKeys: buildRoleKeys(),
      enabled: new Set(ALL_ACTIONS),
    }),
    /public address/,
  );

  await assert.rejects(
    () => startInternalActions({
      host: '127.0.0.1',
      port: 0,
      keys: new KeyRing([]),
      guildId: mock.guildId,
      discord: recordingDiscord().client,
      roleKeys: buildRoleKeys(),
      enabled: new Set(ALL_ACTIONS),
    }),
    /no signing keys/,
  );
});
