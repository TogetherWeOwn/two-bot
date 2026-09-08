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

async function stubDiscord() {
  const state = acceptedState();
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
      if (path === `/api/v10/guilds/${GUILD}/members/${STAGING_BOT_APPLICATION_ID}`) return send(200, { roles: [STAGING_BOT_APPLICATION_ID] });
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
      let match = new RegExp(`/guilds/${GUILD}/roles/(\\d+)$`).exec(path);
      if (method === 'PATCH' && match) {
        const role = state.roles.find((item) => item.id === match![1])!;
        Object.assign(role, body);
        return send(200, role);
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

test('restore drill is dry-run by default, guarded, repairs drift, emits hashes/counts, and is idempotent', async () => {
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
  stub.state.roles.find((role) => role.name === 'Owner')!.color = 0;
  stub.state.channels.find((channel) => channel.name === 'general')!.permission_overwrites = [];
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
    assert.equal(proof.remaining.operations, 0);
    assert.ok(proof.counts.before.roles > 0);
    assert.equal(proof.counts.after.channels, proof.counts.source.channels);
    assert.equal(stub.state.guild.description, SERVER_DESCRIPTION);
    assert.equal(stub.state.roles.find((role) => role.name === 'Owner')!.color, OWNER_ROLE.color);
    assert.deepEqual(stub.state.channels.find((channel) => channel.name === 'general')!.permission_overwrites, [desiredEveryoneOverwrite(GUILD, 'general')]);

    const writes = stub.writes.length;
    const second = await run(RESTORE, ['--snapshot', source, '--confirm-staging-guild', '--apply'], { GUILD_CONFIG_API_BASE: stub.base, GUILD_CONFIG_CDN_BASE: stub.base.replace(/\/api\/v10$/, '') });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /applying 0 operation\(s\)/);
    assert.match(second.stdout, /complete with 0 Discord write\(s\)/);
    assert.equal(stub.writes.length, writes);
  } finally {
    await stub.close();
  }
});
