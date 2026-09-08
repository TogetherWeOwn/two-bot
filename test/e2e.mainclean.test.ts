import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, RULES, SCREENING_DESCRIPTION, STARTER_MESSAGE, WELCOME_DESCRIPTION } from '../src/redesign/clean-slate.ts';
import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, LIVE_GUILD_NAME } from '../src/staging/spec.ts';

const APPLY = fileURLToPath(new URL('../scripts/main-guild-clean-slate.ts', import.meta.url));
const ROLLBACK = fileURLToPath(new URL('../scripts/main-guild-clean-slate-rollback.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const ADMIN = String(1n << 3n);
const TOKEN = `${Buffer.from(LIVE_BOT_APPLICATION_ID).toString('base64url')}.mock.signature`;
const ID = (value: number) => String(800000000000000000n + BigInt(value));

type JsonObject = Record<string, unknown>;
type Role = { id: string; name: string; managed: boolean; color: number; hoist: boolean; permissions: string; mentionable: boolean };
type Channel = { id: string; name: string; type: number; parent_id: string | null; topic: string | null; permission_overwrites: Array<{ id: string; type: number; allow: string; deny: string }> };
type Member = { user: { id: string; username: string; bot: boolean }; roles: string[]; premium_since: string | null; pending: boolean };
type State = {
  guild: JsonObject;
  roles: Role[];
  channels: Channel[];
  welcome: JsonObject;
  onboarding: JsonObject;
  screening: JsonObject;
  integrations: JsonObject[];
  application: JsonObject;
  members: Member[];
  messages: Map<string, Array<{ id: string; author: { id: string }; content: string }>>;
};
type Stub = { base: string; state: State; writes: Array<{ method: string; path: string; body: unknown }>; close(): Promise<void> };

function initialState(admin = true): State {
  const adminRole = ID(1);
  const legacyCategory = ID(2);
  const legacyGeneral = ID(3);
  return {
    guild: {
      id: LIVE_GUILD_ID,
      name: LIVE_GUILD_NAME,
      owner_id: ID(99),
      application_id: null,
      features: ['COMMUNITY', 'RAID_ALERTS_DISABLED'],
      description: 'before',
      system_channel_id: legacyGeneral,
      rules_channel_id: null,
      public_updates_channel_id: null,
      raid_protection: { enabled: true, untouched: 'sentinel' },
    },
    roles: [
      { id: LIVE_GUILD_ID, name: '@everyone', managed: false, color: 0, hoist: false, permissions: '0', mentionable: false },
      { id: adminRole, name: 'Owen', managed: true, color: 0, hoist: true, permissions: admin ? ADMIN : '0', mentionable: false },
      { id: ID(4), name: 'Owner', managed: false, color: 123, hoist: false, permissions: '77', mentionable: true },
      { id: ID(5), name: 'Legacy member role', managed: false, color: 0, hoist: false, permissions: '0', mentionable: false },
    ],
    channels: [
      { id: legacyCategory, name: 'LEGACY', type: 4, parent_id: null, topic: null, permission_overwrites: [] },
      { id: legacyGeneral, name: 'general', type: 0, parent_id: legacyCategory, topic: 'legacy topic', permission_overwrites: [{ id: ID(5), type: 0, allow: '2048', deny: '0' }] },
      { id: ID(6), name: 'old-room', type: 0, parent_id: legacyCategory, topic: null, permission_overwrites: [{ id: ID(5), type: 0, allow: '1024', deny: '0' }] },
    ],
    welcome: { enabled: false, description: 'old welcome', welcome_channels: [], extra: 'kept' },
    onboarding: { prompts: [{ id: 'old' }], default_channel_ids: [legacyGeneral], enabled: true, mode: 1, extra: 'kept' },
    screening: { enabled: false, form_fields: [], description: 'old screening', extra: 'kept' },
    integrations: [{ id: ID(10), application: { id: ID(11) }, name: 'kept integration' }],
    application: { id: LIVE_BOT_APPLICATION_ID, name: 'Owen' },
    members: [
      { user: { id: LIVE_BOT_APPLICATION_ID, username: 'Owen', bot: true }, roles: [adminRole], premium_since: null, pending: false },
      { user: { id: ID(20), username: 'purchased', bot: false }, roles: [ID(5)], premium_since: '2026-01-01T00:00:00.000Z', pending: false },
      { user: { id: ID(21), username: 'otherbot', bot: true }, roles: [], premium_since: null, pending: false },
    ],
    messages: new Map([[legacyGeneral, []]]),
  };
}

function cloneState(state: State): JsonObject {
  return {
    guild: structuredClone(state.guild),
    roles: structuredClone(state.roles),
    channels: structuredClone(state.channels),
    welcome: structuredClone(state.welcome),
    onboarding: structuredClone(state.onboarding),
    screening: structuredClone(state.screening),
    integrations: structuredClone(state.integrations),
    application: structuredClone(state.application),
    members: structuredClone(state.members),
    messages: [...state.messages.entries()].map(([key, messages]) => [key, structuredClone(messages)]),
  };
}

async function stubDiscord(admin = true): Promise<Stub> {
  const state = initialState(admin);
  const writes: Stub['writes'] = [];
  let next = 100;
  const server: Server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '';
    const send = (status: number, body?: unknown) => {
      if (body === undefined) return res.writeHead(status).end();
      const json = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      res.end(json);
    };
    const read = (done: (body: unknown) => void) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => done(JSON.parse(Buffer.concat(chunks).toString() || 'null')));
    };
    if (method !== 'GET') {
      return read((body) => {
        writes.push({ method, path, body });
        if (method === 'DELETE') {
          let match = /\/guilds\/\d+\/roles\/(\d+)$/.exec(path);
          if (match) state.roles = state.roles.filter((role) => role.id !== match![1]);
          match = /\/channels\/(\d+)$/.exec(path);
          if (match) {
            state.channels = state.channels.filter((channel) => channel.id !== match![1]);
            state.messages.delete(match[1]!);
          }
          match = /\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
          if (match) state.messages.set(match[1]!, (state.messages.get(match[1]!) ?? []).filter((message) => message.id !== match![2]));
          return send(204);
        }
        if (method === 'POST' && new RegExp(`/guilds/${LIVE_GUILD_ID}/roles$`).test(path)) {
          const role = { ...(body as Role), id: ID(next++), managed: false };
          state.roles.push(role);
          return send(200, role);
        }
        if (method === 'POST' && new RegExp(`/guilds/${LIVE_GUILD_ID}/channels$`).test(path)) {
          const channel = { ...(body as Channel), id: ID(next++) };
          state.channels.push(channel);
          state.messages.set(channel.id, []);
          return send(200, channel);
        }
        let match = /\/channels\/(\d+)\/messages$/.exec(path);
        if (method === 'POST' && match) {
          const message = { id: ID(next++), author: { id: LIVE_BOT_APPLICATION_ID }, content: String((body as JsonObject).content ?? '') };
          state.messages.set(match[1]!, [...(state.messages.get(match[1]!) ?? []), message]);
          return send(200, message);
        }
        match = /\/channels\/(\d+)$/.exec(path);
        if (method === 'PATCH' && match) {
          const channel = state.channels.find((item) => item.id === match![1]);
          if (!channel) return send(404, {});
          Object.assign(channel, body);
          return send(200, channel);
        }
        if (method === 'PATCH' && path === `/api/v10/guilds/${LIVE_GUILD_ID}`) {
          Object.assign(state.guild, body);
          return send(200, state.guild);
        }
        if (method === 'PATCH' && path.endsWith('/welcome-screen')) {
          state.welcome = { ...state.welcome, ...(body as JsonObject) };
          return send(200, state.welcome);
        }
        if (method === 'PUT' && path.endsWith('/onboarding')) {
          state.onboarding = { ...state.onboarding, ...(body as JsonObject) };
          return send(200, state.onboarding);
        }
        if (method === 'PATCH' && path.endsWith('/member-verification')) {
          state.screening = { ...state.screening, ...(body as JsonObject) };
          return send(200, state.screening);
        }
        return send(400, { path, method });
      });
    }
    if (path === '/api/v10/users/@me') return send(200, { id: LIVE_BOT_APPLICATION_ID });
    if (path === '/api/v10/users/@me/guilds') return send(200, [{ id: LIVE_GUILD_ID }]);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}`) return send(200, state.guild);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/roles`) return send(200, state.roles);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/channels`) return send(200, state.channels);
    if (path.startsWith(`/api/v10/guilds/${LIVE_GUILD_ID}/members?`)) return send(200, state.members);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/welcome-screen`) return send(200, state.welcome);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/onboarding`) return send(200, state.onboarding);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/member-verification`) return send(200, state.screening);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/integrations`) return send(200, state.integrations);
    if (path === '/api/v10/oauth2/applications/@me') return send(200, state.application);
    let match = /\/channels\/(\d+)\/messages\?limit=50$/.exec(path);
    if (match) return send(200, state.messages.get(match[1]!) ?? []);
    match = /\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (match) return send(200, (state.messages.get(match[1]!) ?? []).find((message) => message.id === match![2]) ?? {});
    return send(404, { path });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    state,
    writes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Run = { code: number; stdout: string; stderr: string };
function run(script: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        DISCORD_BOT_TOKEN: TOKEN,
        DISCORD_GUILD_ID: LIVE_GUILD_ID,
        ...env,
      },
    }, (error, stdout, stderr) => resolve({
      code: error ? Number((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
      stdout: String(stdout),
      stderr: String(stderr),
    }));
  });
}

function artifactPaths(dir: string): { pre: string; post: string; manifest: string } {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return {
    pre: join(dir, files.find((file) => file.endsWith('-pre.json')) ?? 'missing-pre'),
    post: join(dir, files.find((file) => file.endsWith('-post.json')) ?? 'missing-post'),
    manifest: join(dir, files.find((file) => file.endsWith('-rollback.json')) ?? 'missing-manifest'),
  };
}

async function apply(stub: Stub, dir: string, extra: Record<string, string> = {}): Promise<Run> {
  return run(APPLY, ['--confirm-main-guild', '--apply'], {
    MAIN_GUILD_API_BASE: stub.base,
    MAIN_GUILD_ARTIFACT_DIR: dir,
    ...extra,
  });
}

test('wrong token and wrong guild are refused before contacting Discord', async () => {
  const wrongToken = await run(APPLY, [], { DISCORD_BOT_TOKEN: `${Buffer.from(ID(999)).toString('base64url')}.x.y`, MAIN_GUILD_API_BASE: 'http://127.0.0.1:1/api/v10' });
  assert.equal(wrongToken.code, 2);
  assert.match(wrongToken.stderr, /not the live Owen bot/);
  const wrongGuild = await run(APPLY, [], { DISCORD_GUILD_ID: ID(999), MAIN_GUILD_API_BASE: 'http://127.0.0.1:1/api/v10' });
  assert.equal(wrongGuild.code, 2);
  assert.match(wrongGuild.stderr, /not the live guild/);
});

test('missing confirmation sends no request', async () => {
  const stub = await stubDiscord();
  try {
    const result = await run(APPLY, ['--apply'], { MAIN_GUILD_API_BASE: stub.base });
    assert.equal(result.code, 2);
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('Owen without Administrator aborts before writes and before artifacts', async () => {
  const stub = await stubDiscord(false);
  const dir = mkdtempSync(join(tmpdir(), 'two-main-noadmin-'));
  try {
    const result = await apply(stub, dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /does not have Administrator/);
    assert.equal(stub.writes.length, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    await stub.close();
  }
});

test('apply is complete, additive, preserves same-name legacy state, and a second run writes zero times', async () => {
  const stub = await stubDiscord();
  const before = cloneState(stub.state);
  const dir = mkdtempSync(join(tmpdir(), 'two-main-apply-'));
  try {
    const first = await apply(stub, dir);
    assert.equal(first.code, 0, first.stderr);
    const legacyGeneral = stub.state.channels.find((channel) => channel.id === ID(3))!;
    assert.equal(legacyGeneral.parent_id, ID(2));
    assert.equal(legacyGeneral.topic, 'legacy topic');
    assert.deepEqual(legacyGeneral.permission_overwrites, [{ id: ID(5), type: 0, allow: '2048', deny: '0' }]);
    assert.ok(stub.state.channels.find((channel) => channel.name === 'general' && channel.parent_id !== ID(2)));
    assert.deepEqual(stub.state.roles.find((role) => role.id === ID(4)), (before.roles as Role[]).find((role) => role.id === ID(4)));
    assert.deepEqual(stub.state.members, before.members);
    assert.deepEqual(stub.state.integrations, before.integrations);
    assert.deepEqual(stub.state.guild.raid_protection, (before.guild as JsonObject).raid_protection);
    const writesAfterFirst = stub.writes.length;
    const secondDir = mkdtempSync(join(tmpdir(), 'two-main-second-'));
    const second = await apply(stub, secondDir);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(stub.writes.length, writesAfterFirst, 'idempotent second apply must issue zero writes');
  } finally {
    await stub.close();
  }
});

test('accepted categories, ten channels, welcome, onboarding, screening and starter message are applied', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-main-shape-'));
  try {
    const result = await apply(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    for (const category of CATEGORIES) {
      const categoryObject = stub.state.channels.find((channel) => channel.type === 4 && channel.name === category.name)!;
      assert.ok(categoryObject);
      for (const name of category.channels) assert.ok(stub.state.channels.find((channel) => channel.name === name && channel.parent_id === categoryObject.id));
    }
    assert.equal(CATEGORIES.flatMap((category) => category.channels).length, 10);
    assert.equal(stub.state.welcome.description, WELCOME_DESCRIPTION);
    assert.equal((stub.state.welcome.welcome_channels as unknown[]).length, 3);
    assert.equal(stub.state.onboarding.enabled, false);
    assert.deepEqual(stub.state.onboarding.prompts, []);
    assert.equal(stub.state.screening.description, SCREENING_DESCRIPTION);
    assert.deepEqual((((stub.state.screening.form_fields as JsonObject[])[0]!.values) as string[]), RULES);
    assert.ok([...stub.state.messages.values()].flat().some((message) => message.content === STARTER_MESSAGE));
    assert.ok(stub.writes.every((request) => !/members|bans/.test(request.path)));
    const destructive = stub.writes.filter((request) => request.method === 'DELETE');
    assert.equal(destructive.length, 0, 'the apply path must expose no destructive endpoint');
    const paths = artifactPaths(dir);
    assert.ok(existsSync(paths.pre));
    assert.ok(existsSync(paths.post));
    const pre = JSON.parse(readFileSync(paths.pre, 'utf8')) as JsonObject;
    assert.ok(pre.welcomeScreen && pre.onboarding && pre.membershipScreening && pre.members && pre.botInventory);
  } finally {
    await stub.close();
  }
});

test('manifest exists before the first request and records an interrupted applied inverse', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-main-interrupt-'));
  try {
    const result = await apply(stub, dir, { MAIN_GUILD_TEST_ABORT_AFTER_RESPONSE: '1' });
    assert.equal(result.code, 87);
    assert.equal(stub.writes.length, 1);
    const paths = artifactPaths(dir);
    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8')) as { operations: Array<{ state: string; responseId?: string; requestStartedAt?: string }> };
    assert.equal(manifest.operations.length, 1);
    assert.equal(manifest.operations[0]!.state, 'pending');
    assert.ok(manifest.operations[0]!.requestStartedAt);
    assert.ok(manifest.operations[0]!.responseId);
    assert.ok(existsSync(paths.pre));
  } finally {
    await stub.close();
  }
});

test('guarded rollback restores every field changed by a completed apply', async () => {
  const stub = await stubDiscord();
  const before = cloneState(stub.state);
  const dir = mkdtempSync(join(tmpdir(), 'two-main-rollback-'));
  try {
    const result = await apply(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    const paths = artifactPaths(dir);
    const noConfirm = await run(ROLLBACK, ['--manifest', paths.manifest], { MAIN_GUILD_API_BASE: stub.base });
    assert.equal(noConfirm.code, 2);
    const rolledBack = await run(ROLLBACK, ['--manifest', paths.manifest, '--confirm-main-guild', '--apply'], { MAIN_GUILD_API_BASE: stub.base });
    assert.equal(rolledBack.code, 0, rolledBack.stderr);
    assert.deepEqual(cloneState(stub.state), before);
  } finally {
    await stub.close();
  }
});
