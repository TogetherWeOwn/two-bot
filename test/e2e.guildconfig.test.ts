import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, MODERATOR_ROLE, OWNER_ROLE, SERVER_DESCRIPTION, TOPICS, desiredEveryoneOverwrite } from '../src/redesign/clean-slate.ts';
import { STAGING_BOT_APPLICATION_ID } from '../src/staging/spec.ts';

const SNAPSHOT = fileURLToPath(new URL('../scripts/guild-config-snapshot.ts', import.meta.url));
const RESTORE = fileURLToPath(new URL('../scripts/guild-config-restore.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const GUILD = '1545644954272137297';
const TOKEN = `${Buffer.from(STAGING_BOT_APPLICATION_ID).toString('base64url')}.mock.signature`;
const id = (n: number) => String(910000000000000000n + BigInt(n));

type JsonObject = Record<string, unknown>;
type Role = { id: string; name: string; managed: boolean; color: number; hoist: boolean; permissions: string; mentionable: boolean; position: number };
type Overwrite = { id: string; type: number; allow: string; deny: string };
type Channel = { id: string; name: string; type: number; parent_id: string | null; position: number; topic?: string | null; permission_overwrites: Overwrite[] };
type Emoji = { id: string; name: string; roles: string[]; require_colons: boolean; managed: boolean; animated: boolean; available: boolean; image?: string };
type State = { guild: JsonObject; roles: Role[]; channels: Channel[]; emojis: Emoji[] };

function acceptedState(): State {
  const state: State = {
    guild: { id: GUILD, name: 'TWO Staging', description: SERVER_DESCRIPTION, verification_level: 2, system_channel_flags: 0 },
    roles: [
      { id: GUILD, name: '@everyone', managed: false, color: 0, hoist: false, permissions: '0', mentionable: false, position: 0 },
      { id: id(1), ...OWNER_ROLE, managed: false, position: 10 },
      { id: id(2), ...MODERATOR_ROLE, managed: false, position: 9 },
      { id: STAGING_BOT_APPLICATION_ID, name: 'Owen QA Test', managed: true, color: 0, hoist: true, permissions: String(1n << 3n), mentionable: false, position: 11 },
    ],
    channels: [],
    emojis: [{ id: id(90), name: 'two', roles: [], require_colons: true, managed: false, animated: false, available: true }],
  };
  let next = 20;
  CATEGORIES.forEach((category, categoryPosition) => {
    const categoryId = id(next++);
    state.channels.push({ id: categoryId, name: category.name, type: 4, parent_id: null, position: categoryPosition, permission_overwrites: [] });
    category.channels.forEach((name, position) => state.channels.push({
      id: id(next++),
      name,
      type: name === 'Lobby' || name === 'Squad' ? 2 : 0,
      parent_id: categoryId,
      position,
      ...(name in TOPICS ? { topic: TOPICS[name as keyof typeof TOPICS] } : {}),
      permission_overwrites: [desiredEveryoneOverwrite(GUILD, name)],
    }));
  });
  return state;
}

async function stubDiscord(options: { botPermissions?: bigint; botPosition?: number; botRoleIds?: string[] } = {}) {
  const state = acceptedState();
  const botRole = state.roles.find((role) => role.id === STAGING_BOT_APPLICATION_ID)!;
  botRole.permissions = String(options.botPermissions ?? (1n << 3n));
  botRole.position = options.botPosition ?? botRole.position;
  const botRoleIds = options.botRoleIds ?? [STAGING_BOT_APPLICATION_ID];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '';
    const send = (status: number, body?: unknown) => {
      if (body === undefined) return res.writeHead(status).end();
      const json = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      res.end(json);
    };
    if (method === 'GET') {
      if (path === '/api/v10/users/@me') return send(200, { id: STAGING_BOT_APPLICATION_ID });
      if (path === '/api/v10/users/@me/guilds') return send(200, [{ id: GUILD }]);
      if (path === `/api/v10/guilds/${GUILD}`) return send(200, state.guild);
      if (path === `/api/v10/guilds/${GUILD}/roles`) return send(200, state.roles);
      if (path === `/api/v10/guilds/${GUILD}/members/${STAGING_BOT_APPLICATION_ID}`) return send(200, { roles: botRoleIds });
      if (path === `/api/v10/guilds/${GUILD}/channels`) return send(200, state.channels);
      if (path === `/api/v10/guilds/${GUILD}/emojis`) return send(200, state.emojis);
      if (path === `/emojis/${id(90)}.png`) {
        const image = Buffer.from('two');
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length });
        return res.end(image);
      }
      return send(404, { path });
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || 'null') as JsonObject;
      writes.push({ method, path, body });
      if (method === 'PATCH' && path === `/api/v10/guilds/${GUILD}/roles` && Array.isArray(body)) {
        for (const position of body as Array<{ id: string; position: number }>) {
          const role = state.roles.find((item) => item.id === position.id)!;
          role.position = position.position;
        }
        return send(200, state.roles);
      }
      let match = new RegExp(`/guilds/${GUILD}/roles/(\\d+)$`).exec(path);
      if (method === 'PATCH' && match) {
        const role = state.roles.find((item) => item.id === match![1])!;
        Object.assign(role, body);
        return send(200, role);
      }
      if (method === 'PATCH' && path === `/api/v10/guilds/${GUILD}/channels` && Array.isArray(body)) {
        for (const position of body as Array<{ id: string; position: number; parent_id?: string | null }>) {
          const channel = state.channels.find((item) => item.id === position.id)!;
          channel.position = position.position;
          if ('parent_id' in position) channel.parent_id = position.parent_id ?? null;
        }
        return send(200, state.channels);
      }
      match = /\/channels\/(\d+)$/.exec(path);
      if (method === 'PATCH' && match) {
        const channel = state.channels.find((item) => item.id === match![1])!;
        Object.assign(channel, body);
        return send(200, channel);
      }
      if (method === 'PATCH' && path === `/api/v10/guilds/${GUILD}`) {
        Object.assign(state.guild, body);
        return send(200, state.guild);
      }
      if (method === 'POST' && path === `/api/v10/guilds/${GUILD}/roles`) {
        const roleBody = body as Pick<Role, 'name' | 'color' | 'hoist' | 'permissions' | 'mentionable'>;
        const role: Role = { id: id(100 + state.roles.length), managed: false, position: 1, ...roleBody };
        state.roles.push(role);
        return send(200, role);
      }
      if (method === 'POST' && path === `/api/v10/guilds/${GUILD}/channels`) {
        const channelBody = body as Pick<Channel, 'name' | 'type'> & Partial<Channel>;
        const channel: Channel = {
          id: id(200 + state.channels.length),
          parent_id: null,
          position: 0,
          permission_overwrites: [],
          ...channelBody,
          name: channelBody.name,
          type: channelBody.type,
        };
        state.channels.push(channel);
        return send(200, channel);
      }
      return send(400, { method, path });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    writes,
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v10`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function run(script: string, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => execFile(process.execPath, [script, ...args], {
    cwd: REPO,
    env: { ...process.env, DISCORD_STAGING_BOT_TOKEN: TOKEN, DISCORD_STAGING_GUILD_ID: GUILD, ...env },
  }, (error, stdout, stderr) => resolve({
    code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0,
    stdout: String(stdout),
    stderr: String(stderr),
  })));
}

test('snapshot captures roles/channels/overwrites/settings/emoji and fails without off-box upload', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-snapshot-'));
  try {
    const failed = await run(SNAPSHOT, [], {
      GUILD_CONFIG_API_BASE: stub.base,
      GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, ''),
      TWO_GUILD_CONFIG_BACKUP_DIR: dir,
      TWO_GUILD_CONFIG_UPLOAD_CMD: '',
      TWO_BACKUP_UPLOAD_CMD: '',
    });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /required; refusing a local-only snapshot/);
    const names = readdirSync(dir);
    const snapshot = JSON.parse(readFileSync(join(dir, names.find((name) => name.endsWith('.json') && !name.endsWith('.drift.json'))!), 'utf8'));
    const drift = JSON.parse(readFileSync(join(dir, names.find((name) => name.endsWith('.drift.json'))!), 'utf8'));
    assert.equal(snapshot.roles.length, stub.state.roles.length);
    assert.equal(snapshot.channels.length, stub.state.channels.length);
    assert.equal(snapshot.emojis.length, 1);
    assert.equal(snapshot.emojis[0].image, 'data:image/png;base64,dHdv');
    assert.ok(snapshot.channels.some((channel: Channel) => channel.permission_overwrites.length > 0));
    assert.equal(drift.counts.drift, 0);
  } finally {
    await stub.close();
  }
});

test('restore that recreates role, category and child channel remaps ids and reaches semantic hash success', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-recreate-'));
  const source = join(dir, 'source.json');
  const evidence = join(dir, 'evidence.json');
  const sourceOwner = stub.state.roles.find((role) => role.name === 'Owner')!;
  const sourceCategory = stub.state.channels.find((channel) => channel.type === 4 && channel.name === CATEGORIES[0]!.name)!;
  const sourceChildren = stub.state.channels.filter((channel) => channel.parent_id === sourceCategory.id);
  const sourceChildIds = new Set(sourceChildren.map((channel) => channel.id));
  const sourceRoleOverwrite = { id: sourceOwner.id, type: 0, allow: '1', deny: '0' };
  sourceChildren[0]!.permission_overwrites.push(sourceRoleOverwrite);
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...stub.state,
    emojis: stub.state.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  stub.state.roles = stub.state.roles.filter((role) => role.id !== sourceOwner.id);
  stub.state.channels = stub.state.channels.filter((channel) => channel.id !== sourceCategory.id && !sourceChildIds.has(channel.id));
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply', '--evidence', evidence], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /semantic-source=[0-9a-f]{64}/);
    assert.match(applied.stdout, /remaining=0/);
    const proof = JSON.parse(readFileSync(evidence, 'utf8'));
    assert.equal(proof.hashesEqual, true);
    assert.notEqual(proof.sourceHash, proof.afterHash);
    assert.equal(proof.semanticSourceHash, proof.afterHash);
    assert.equal(proof.remaining.operations, 0);
    const restoredOwner = stub.state.roles.find((role) => role.name === 'Owner')!;
    const restoredCategory = stub.state.channels.find((channel) => channel.type === 4 && channel.name === sourceCategory.name)!;
    const restoredChild = stub.state.channels.find((channel) => channel.name === sourceChildren[0]!.name && channel.parent_id === restoredCategory.id)!;
    assert.notEqual(restoredOwner.id, sourceOwner.id);
    assert.notEqual(restoredCategory.id, sourceCategory.id);
    assert.equal(restoredChild.permission_overwrites.at(-1)!.id, restoredOwner.id);
  } finally {
    await stub.close();
  }
});

test('overwrite-only restore requires Manage Roles before any write', async () => {
  const stub = await stubDiscord({ botPermissions: 1n << 4n });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-overwrite-permission-'));
  const source = join(dir, 'source.json');
  const general = stub.state.channels.find((channel) => channel.name === 'general')!;
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...stub.state,
    emojis: stub.state.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  general.permission_overwrites = [];
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, /missing Manage Roles/);
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('overwrite-only restore checks every referenced role against Owen hierarchy before any write', async () => {
  const stub = await stubDiscord({ botPermissions: (1n << 4n) | (1n << 28n), botPosition: 9 });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-overwrite-hierarchy-'));
  const source = join(dir, 'source.json');
  const owner = stub.state.roles.find((role) => role.name === 'Owner')!;
  const moderator = stub.state.roles.find((role) => role.name === 'Moderator')!;
  const general = stub.state.channels.find((channel) => channel.name === 'general')!;
  general.permission_overwrites.push(
    { id: owner.id, type: 0, allow: '1', deny: '0' },
    { id: moderator.id, type: 0, allow: '2', deny: '0' },
  );
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...stub.state,
    emojis: stub.state.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  general.permission_overwrites = general.permission_overwrites.filter((overwrite) => overwrite.id === GUILD);
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, /overwrite target Owner \(10\), Moderator \(9\)/);
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('overwrite preflight rejects channel-effective permission loss before any write', async () => {
  const managePermissions = (1n << 4n) | (1n << 28n);
  const grantRoleId = id(3);
  const stub = await stubDiscord({ botPermissions: 0n, botRoleIds: [STAGING_BOT_APPLICATION_ID, grantRoleId] });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-overwrite-effective-'));
  const source = join(dir, 'source.json');
  const grantRole: Role = { id: grantRoleId, name: 'Owen Restore', managed: false, color: 0, hoist: false, permissions: String(managePermissions), mentionable: false, position: 8 };
  stub.state.roles.push(grantRole);
  const sourceState = structuredClone(stub.state);
  sourceState.channels.find((channel) => channel.name === 'general')!.permission_overwrites = [];
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...sourceState,
    emojis: sourceState.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  const currentGeneral = stub.state.channels.find((channel) => channel.name === 'general')!;
  currentGeneral.permission_overwrites = [{ id: GUILD, type: 0, allow: '0', deny: String(managePermissions) }];
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, /channel permission preflight failed: general \(missing Manage Channels, Manage Roles; unowned mask 0\)/);
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('overwrite preflight rejects permission bits Owen cannot grant before any write', async () => {
  const managePermissions = (1n << 4n) | (1n << 28n);
  const grantRoleId = id(3);
  const stub = await stubDiscord({ botPermissions: 0n, botRoleIds: [STAGING_BOT_APPLICATION_ID, grantRoleId] });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-overwrite-unowned-'));
  const source = join(dir, 'source.json');
  const grantRole: Role = { id: grantRoleId, name: 'Owen Restore', managed: false, color: 0, hoist: false, permissions: String(managePermissions), mentionable: false, position: 8 };
  stub.state.roles.push(grantRole);
  const sourceState = structuredClone(stub.state);
  sourceState.channels.find((channel) => channel.name === 'general')!.permission_overwrites = [{ id: GUILD, type: 0, allow: String(1n << 3n), deny: '0' }];
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...sourceState,
    emojis: sourceState.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, /channel permission preflight failed: general \(missing none; unowned mask 8\)/);
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('overwrite preflight allows guild-held bits denied on the current channel', async () => {
  const managePermissions = (1n << 4n) | (1n << 28n);
  const sendMessages = 1n << 11n;
  const grantRoleId = id(3);
  const stub = await stubDiscord({ botPermissions: 0n, botRoleIds: [STAGING_BOT_APPLICATION_ID, grantRoleId] });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-overwrite-guild-ceiling-'));
  const source = join(dir, 'source.json');
  const grantRole: Role = { id: grantRoleId, name: 'Owen Restore', managed: false, color: 0, hoist: false, permissions: String(managePermissions | sendMessages), mentionable: false, position: 8 };
  stub.state.roles.push(grantRole);
  const sourceState = structuredClone(stub.state);
  sourceState.channels.find((channel) => channel.name === 'general')!.permission_overwrites = [{ id: GUILD, type: 0, allow: String(sendMessages), deny: '0' }];
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...sourceState,
    emojis: sourceState.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  const currentGeneral = stub.state.channels.find((channel) => channel.name === 'general')!;
  currentGeneral.permission_overwrites = [{ id: GUILD, type: 0, allow: '0', deny: String(sendMessages) }];
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 0, applied.stderr);
    assert.ok(stub.writes.some((write) => write.method === 'PATCH' && write.path.endsWith(`/channels/${currentGeneral.id}`)));
  } finally {
    await stub.close();
  }
});

test('overwrite preflight rejects unowned bits on a new root channel before any write', async () => {
  const managePermissions = (1n << 4n) | (1n << 28n);
  const grantRoleId = id(3);
  const stub = await stubDiscord({ botPermissions: 0n, botRoleIds: [STAGING_BOT_APPLICATION_ID, grantRoleId] });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-overwrite-new-root-'));
  const source = join(dir, 'source.json');
  const grantRole: Role = { id: grantRoleId, name: 'Owen Restore', managed: false, color: 0, hoist: false, permissions: String(managePermissions), mentionable: false, position: 8 };
  stub.state.roles.push(grantRole);
  const sourceState = structuredClone(stub.state);
  sourceState.channels.push({
    id: id(99),
    name: 'new-root',
    type: 0,
    parent_id: null,
    position: sourceState.channels.length,
    permission_overwrites: [{ id: GUILD, type: 0, allow: String(1n << 3n), deny: '0' }],
  });
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...sourceState,
    emojis: sourceState.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, /channel permission preflight failed: new-root \(missing none; unowned mask 8\)/);
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('Administrator does not bypass overwrite role hierarchy before any write', async () => {
  const stub = await stubDiscord({ botPosition: 5 });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-admin-hierarchy-'));
  const source = join(dir, 'source.json');
  const sourceState = structuredClone(stub.state);
  const owner = sourceState.roles.find((role) => role.name === 'Owner')!;
  sourceState.channels.find((channel) => channel.name === 'general')!.permission_overwrites.push({ id: owner.id, type: 0, allow: '1', deny: '0' });
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...sourceState,
    emojis: sourceState.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, /hierarchy preflight failed: Owen role position 5 is not above overwrite target Owner \(10\)/);
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('new child overwrite preflight uses the desired parent permission ceiling before any write', async () => {
  const managePermissions = (1n << 4n) | (1n << 28n);
  const grantRoleId = id(3);
  const stub = await stubDiscord({ botPermissions: 0n, botRoleIds: [STAGING_BOT_APPLICATION_ID, grantRoleId] });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-new-child-parent-ceiling-'));
  const source = join(dir, 'source.json');
  const grantRole: Role = { id: grantRoleId, name: 'Owen Restore', managed: false, color: 0, hoist: false, permissions: String(managePermissions), mentionable: false, position: 8 };
  stub.state.roles.push(grantRole);
  const sourceState = structuredClone(stub.state);
  const parent = sourceState.channels.find((channel) => channel.type === 4 && channel.name === CATEGORIES[0]!.name)!;
  parent.permission_overwrites = [{ id: GUILD, type: 0, allow: '0', deny: String(managePermissions) }];
  const child = sourceState.channels.find((channel) => channel.parent_id === parent.id)!;
  stub.state.channels = stub.state.channels.filter((channel) => channel.id !== child.id);
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...sourceState,
    emojis: sourceState.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, new RegExp(`channel permission preflight failed: ${child.name} \\(missing Manage Channels, Manage Roles; unowned mask`));
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('child overwrite preflight uses the desired parent state changed by the same restore', async () => {
  const managePermissions = (1n << 4n) | (1n << 28n);
  const grantRoleId = id(3);
  const stub = await stubDiscord({ botPermissions: 0n, botRoleIds: [STAGING_BOT_APPLICATION_ID, grantRoleId] });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-stale-parent-ceiling-'));
  const source = join(dir, 'source.json');
  const grantRole: Role = { id: grantRoleId, name: 'Owen Restore', managed: false, color: 0, hoist: false, permissions: String(managePermissions), mentionable: false, position: 8 };
  stub.state.roles.push(grantRole);
  const sourceState = structuredClone(stub.state);
  const parent = sourceState.channels.find((channel) => channel.type === 4 && channel.name === CATEGORIES[0]!.name)!;
  const currentParent = stub.state.channels.find((channel) => channel.id === parent.id)!;
  currentParent.permission_overwrites = [];
  parent.permission_overwrites = [{ id: GUILD, type: 0, allow: '0', deny: String(managePermissions) }];
  const child = sourceState.channels.find((channel) => channel.parent_id === parent.id)!;
  child.permission_overwrites.push({ id: GUILD, type: 0, allow: '1', deny: '0' });
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...sourceState,
    emojis: sourceState.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, new RegExp(`channel permission preflight failed: ${child.name} \\(missing none; unowned mask [1-9]\\d*`));
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('desired parent permission ceilings remap source role ids before preflight', async () => {
  const managePermissions = (1n << 4n) | (1n << 28n);
  const currentGrantRoleId = id(3);
  const sourceGrantRoleId = id(103);
  const stub = await stubDiscord({ botPermissions: 0n, botRoleIds: [STAGING_BOT_APPLICATION_ID, currentGrantRoleId] });
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-remapped-parent-role-'));
  const source = join(dir, 'source.json');
  const grantRole: Role = { id: currentGrantRoleId, name: 'Owen Restore', managed: false, color: 0, hoist: false, permissions: String(managePermissions), mentionable: false, position: 8 };
  stub.state.roles.push(grantRole);
  const sourceState = structuredClone(stub.state);
  sourceState.roles.find((role) => role.id === currentGrantRoleId)!.id = sourceGrantRoleId;
  const parent = sourceState.channels.find((channel) => channel.type === 4 && channel.name === CATEGORIES[0]!.name)!;
  parent.permission_overwrites = [{ id: sourceGrantRoleId, type: 0, allow: '0', deny: String(managePermissions) }];
  const child = sourceState.channels.find((channel) => channel.parent_id === parent.id)!;
  child.permission_overwrites.push({ id: GUILD, type: 0, allow: '1', deny: '0' });
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...sourceState,
    emojis: sourceState.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  try {
    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, new RegExp(`channel permission preflight failed: ${child.name} \\(missing none; unowned mask [1-9]\\d*`));
    assert.equal(stub.writes.length, 0);
  } finally {
    await stub.close();
  }
});

test('restore drill is dry-run by default, guarded, repairs drift including ordering, emits hashes/counts, and is idempotent', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-guild-restore-'));
  const source = join(dir, 'source.json');
  const evidence = join(dir, 'evidence.json');
  writeFileSync(source, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: GUILD,
    ...stub.state,
    emojis: stub.state.emojis.map((emoji) => ({ ...emoji, image: 'data:image/png;base64,dHdv' })),
  })}\n`);
  stub.state.guild.description = 'drift';
  const owner = stub.state.roles.find((role) => role.name === 'Owner')!;
  const moderator = stub.state.roles.find((role) => role.name === 'Moderator')!;
  owner.color = 0;
  [owner.position, moderator.position] = [moderator.position, owner.position];
  const categories = stub.state.channels.filter((channel) => channel.type === 4).sort((a, b) => a.position - b.position);
  [categories[0]!.position, categories[1]!.position] = [categories[1]!.position, categories[0]!.position];
  const general = stub.state.channels.find((channel) => channel.name === 'general')!;
  const lookingToPlay = stub.state.channels.find((channel) => channel.name === 'looking-to-play')!;
  [general.position, lookingToPlay.position] = [lookingToPlay.position, general.position];
  general.permission_overwrites = [];
  try {
    const dry = await run(RESTORE, ['--snapshot', source], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /WOULD patch role Owner/);
    assert.equal(stub.writes.length, 0);

    const refused = await run(RESTORE, ['--snapshot', source, '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(refused.code, 2);
    assert.equal(stub.writes.length, 0);

    const applied = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply', '--evidence', evidence], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /before=[0-9a-f]{64} after=[0-9a-f]{64} source=[0-9a-f]{64}/);
    assert.match(applied.stdout, /remaining=0/);
    const proof = JSON.parse(readFileSync(evidence, 'utf8'));
    assert.equal(proof.hashesEqual, true);
    assert.equal(proof.remaining.operations, 0);
    assert.ok(proof.counts.before.roles > 0);
    assert.equal(proof.counts.after.channels, proof.counts.source.channels);
    assert.equal(stub.state.guild.description, SERVER_DESCRIPTION);
    assert.equal(stub.state.roles.find((role) => role.name === 'Owner')!.color, OWNER_ROLE.color);
    assert.equal(stub.state.roles.find((role) => role.name === 'Owner')!.position, 10);
    assert.deepEqual(stub.state.channels.filter((channel) => channel.type === 4).sort((a, b) => a.position - b.position).map((channel) => channel.name), CATEGORIES.map((category) => category.name));
    assert.equal(stub.state.channels.find((channel) => channel.name === 'general')!.position, 0);
    assert.deepEqual(stub.state.channels.find((channel) => channel.name === 'general')!.permission_overwrites, [desiredEveryoneOverwrite(GUILD, 'general')]);

    const writes = stub.writes.length;
    const second = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /applying 0 operation\(s\)/);
    assert.match(second.stdout, /complete with 0 Discord write\(s\)/);
    assert.equal(stub.writes.length, writes);

    stub.state.emojis[0]!.available = false;
    const hashMismatch = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(hashMismatch.code, 1);
    assert.match(hashMismatch.stdout, /applying 0 operation\(s\)/);
    assert.match(hashMismatch.stderr, /residual drift=\[\]/);
    assert.match(hashMismatch.stderr, /post-restore hash does not match source hash \(0 operation\(s\) remain\)/);
  } finally {
    await stub.close();
  }
});
