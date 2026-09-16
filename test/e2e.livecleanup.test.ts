import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ACTIVE_CATEGORY_IDS,
  ACTIVE_CHANNEL_IDS,
  LEGACY_CATEGORY_IDS,
  LEGACY_CHANNEL_IDS,
  type Channel,
  type CleanupManifest,
  type JsonObject,
  operationSemanticHash,
  type Role,
  stable,
} from '../src/redesign/live-cleanup.ts';
import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, LIVE_GUILD_NAME } from '../src/staging/spec.ts';

const CLEANUP = fileURLToPath(new URL('../scripts/live-clean-slate-cleanup.ts', import.meta.url));
const ROLLBACK = fileURLToPath(new URL('../scripts/live-clean-slate-cleanup-rollback.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = `${Buffer.from(LIVE_BOT_APPLICATION_ID).toString('base64url')}.mock.signature`;
const ADMIN = String(1n << 3n);
const VIEW = String(1n << 10n);
const ID = (value: number) => String(700000000000000000n + BigInt(value));

type Member = { user: { id: string; username: string; bot: boolean }; roles: string[]; premium_since: string | null; pending: boolean };
type State = {
  guild: JsonObject;
  roles: Role[];
  channels: Channel[];
  integrations: JsonObject[];
  application: JsonObject;
  members: Member[];
};
type Stub = {
  base: string;
  state: State;
  writes: Array<{ method: string; path: string; body: unknown }>;
  writeOrder: string[];
  rollbackOrder: string[];
  failNextWrite(status: number): void;
  partialNextWrite(): void;
  close(): Promise<void>;
};
type Run = { code: number; stdout: string; stderr: string };

function fixtureState(): State {
  const everyone = { id: LIVE_GUILD_ID, type: 0, allow: VIEW, deny: '0' };
  const channels: Channel[] = [];
  for (const [index, id] of ACTIVE_CATEGORY_IDS.entries()) channels.push({ id, name: `active-category-${index}`, type: 4, parent_id: null, position: index, permission_overwrites: [everyone] });
  for (const [index, id] of ACTIVE_CHANNEL_IDS.entries()) channels.push({ id, name: `active-channel-${index}`, type: 0, parent_id: ACTIVE_CATEGORY_IDS[index % ACTIVE_CATEGORY_IDS.length]!, position: index, topic: `history-${id}`, permission_overwrites: [everyone] });
  for (const [index, id] of LEGACY_CATEGORY_IDS.entries()) channels.push({
    id,
    name: `legacy-category-${index}`,
    type: 4,
    parent_id: null,
    position: 100 + index,
    permission_overwrites: [
      everyone,
      { id: ID(50), type: 0, allow: '0', deny: String((1n << 10n) | (1n << 11n)) },
      { id: ID(51), type: 0, allow: VIEW, deny: '0' },
    ],
  });
  for (const [index, id] of LEGACY_CHANNEL_IDS.entries()) channels.push({
    id,
    name: `legacy-channel-${index}`,
    type: index % 7 === 0 ? 2 : 0,
    parent_id: LEGACY_CATEGORY_IDS[index % LEGACY_CATEGORY_IDS.length]!,
    position: 200 + index,
    topic: `preserved-history-${id}`,
    permission_overwrites: [
      everyone,
      { id: ID(50), type: 0, allow: '0', deny: String((1n << 10n) | (1n << 11n)) },
      { id: ID(51), type: 0, allow: VIEW, deny: '0' },
    ],
  });
  channels.push({ id: '1545924265868525588', name: '💬 CHAT', type: 4, parent_id: null, permission_overwrites: [] });
  channels.push({ id: '1545924268489973841', name: 'looking-to-play', type: 0, parent_id: '1545924265868525588', permission_overwrites: [] });
  channels.push({ id: '1545924265247903884', name: '📌 START HERE', type: 4, parent_id: null, permission_overwrites: [] });
  channels.push({ id: '1545924267453976696', name: '⚙️ SYSTEM', type: 4, parent_id: null, permission_overwrites: [] });
  return {
    guild: { id: LIVE_GUILD_ID, name: LIVE_GUILD_NAME, owner_id: ID(99), application_id: null, features: ['COMMUNITY'] },
    roles: [
      { id: LIVE_GUILD_ID, name: '@everyone', managed: false, permissions: '0', position: 0 },
      { id: ID(1), name: 'Owen', managed: true, permissions: ADMIN, position: 200, tags: { bot_id: LIVE_BOT_APPLICATION_ID } },
      { id: ID(50), name: 'Explicit deny', managed: false, permissions: '0', position: 10 },
      { id: ID(51), name: 'Required integration', managed: true, permissions: '0', position: 20, tags: { integration_id: ID(52) } },
    ],
    channels,
    integrations: [{ id: ID(52), name: 'kept integration', application: { id: ID(53) }, role_id: ID(51) }],
    application: { id: LIVE_BOT_APPLICATION_ID, name: 'Owen' },
    members: [
      { user: { id: LIVE_BOT_APPLICATION_ID, username: 'Owen', bot: true }, roles: [ID(1)], premium_since: null, pending: false },
      { user: { id: ID(60), username: 'holder', bot: false }, roles: [ID(50)], premium_since: null, pending: false },
      { user: { id: ID(61), username: 'integration', bot: true }, roles: [ID(51)], premium_since: null, pending: false },
    ],
  };
}

async function stubDiscord(): Promise<Stub> {
  const state = fixtureState();
  const writes: Stub['writes'] = [];
  const writeOrder: string[] = [];
  const rollbackOrder: string[] = [];
  let nextFailure = 0;
  let partialNextWrite = false;
  const server: Server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '';
    const send = (status: number, body?: unknown) => {
      if (body === undefined) return res.writeHead(status).end();
      const json = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      res.end(json);
    };
    const read = (done: (body: JsonObject) => void) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => done(JSON.parse(Buffer.concat(chunks).toString() || '{}') as JsonObject));
    };
    if (method === 'PATCH') {
      return read((body) => {
        writes.push({ method, path, body });
        if (nextFailure) {
          const status = nextFailure;
          nextFailure = 0;
          return send(status, status === 429 ? { retry_after: 0 } : { message: 'forced failure' });
        }
        const match = /\/channels\/(\d+)$/.exec(path);
        const channel = match && state.channels.find((item) => item.id === match[1]);
        if (!channel) return send(404, {});
        let overwrites = body.permission_overwrites as Channel['permission_overwrites'];
        if (partialNextWrite) {
          partialNextWrite = false;
          overwrites = overwrites.filter((overwrite) => overwrite.id !== LIVE_GUILD_ID);
        }
        const everyone = overwrites.find((overwrite) => overwrite.id === LIVE_GUILD_ID);
        if (everyone && (BigInt(everyone.deny) & (1n << 10n)) !== 0n) writeOrder.push(channel.id);
        else rollbackOrder.push(channel.id);
        channel.permission_overwrites = structuredClone(overwrites);
        if (channel.type === 4) {
          for (const child of state.channels.filter((item) => item.parent_id === channel.id)) {
            child.permission_overwrites = structuredClone(overwrites);
          }
        }
        return send(200, channel);
      });
    }
    if (path === '/api/v10/users/@me') return send(200, { id: LIVE_BOT_APPLICATION_ID });
    if (path === '/api/v10/users/@me/guilds') return send(200, [{ id: LIVE_GUILD_ID }]);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}`) return send(200, state.guild);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/roles`) return send(200, state.roles);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/channels`) return send(200, state.channels);
    if (path.startsWith(`/api/v10/guilds/${LIVE_GUILD_ID}/members?`)) return send(200, state.members);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/integrations`) return send(200, state.integrations);
    if (path === '/api/v10/oauth2/applications/@me') return send(200, state.application);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/welcome-screen`) return send(200, { enabled: true });
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/onboarding`) return send(200, { enabled: false, prompts: [] });
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/member-verification`) return send(200, { form_fields: [] });
    const channel = /\/channels\/(\d+)$/.exec(path);
    if (channel) return send(200, state.channels.find((item) => item.id === channel[1]) ?? {});
    return send(404, { path });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    state,
    writes,
    writeOrder,
    rollbackOrder,
    failNextWrite(status: number) { nextFailure = status; },
    partialNextWrite() { partialNextWrite = true; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function run(script: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], {
      cwd: REPO,
      env: { ...process.env, DISCORD_BOT_TOKEN: TOKEN, DISCORD_GUILD_ID: LIVE_GUILD_ID, ...env },
    }, (error, stdout, stderr) => resolve({
      code: error ? Number((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
      stdout: String(stdout),
      stderr: String(stderr),
    }));
  });
}

const cleanupArgs = (dir: string, apply = false) => ['--phase', 'archive-legacy', '--run-dir', dir, '--confirm-main-guild', ...(apply ? ['--apply'] : [])];
const manifestPath = (dir: string) => join(dir, 'phase-01', 'rollback.json');
const planManifestPath = (dir: string) => join(dir, 'plan', 'rollback.json');

async function plan(stub: Stub, dir: string): Promise<Run> {
  return run(CLEANUP, cleanupArgs(dir), { MAIN_GUILD_API_BASE: stub.base });
}
async function apply(stub: Stub, dir: string, env: Record<string, string> = {}): Promise<Run> {
  return run(CLEANUP, cleanupArgs(dir, true), { MAIN_GUILD_API_BASE: stub.base, ...env });
}
async function rollback(stub: Stub, dir: string): Promise<Run> {
  return run(ROLLBACK, ['--manifest', manifestPath(dir), '--confirm-main-guild', '--apply'], { MAIN_GUILD_API_BASE: stub.base });
}

test('production-shaped fixture pins 18 stable operations and dry-run writes nothing', async () => {
  const stub = await stubDiscord();
  try {
    const firstDir = mkdtempSync(join(tmpdir(), 'two-live-clean-plan-'));
    const first = await plan(stub, firstDir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(stub.writes.length, 0);
    const firstManifest = JSON.parse(readFileSync(planManifestPath(firstDir), 'utf8')) as CleanupManifest;
    assert.equal(firstManifest.operationCount, 18);
    assert.equal(firstManifest.reviewedLegacyChannelIds.length, 112);
    assert.equal(firstManifest.reviewedLegacyCategoryIds.length, 18);
    assert.equal(firstManifest.operationSemanticHash, operationSemanticHash(firstManifest.operations));
    assert.equal(new Set(firstManifest.operations.map((operation) => operation.id)).size, 18);
    assert.ok(firstManifest.operations.every((operation, index) => operation.sequence === index + 1));
    for (const file of ['snapshot/pre.json', 'snapshot/holders.csv', 'snapshot/references.json', 'plan/operations.json', 'plan/rollback.json', 'plan.log']) {
      const path = join(firstDir, file);
      assert.ok(existsSync(path), file);
      assert.equal(statSync(path).mode & 0o077, 0, `${file} must not be group/world accessible`);
    }
    const secondDir = mkdtempSync(join(tmpdir(), 'two-live-clean-plan-stable-'));
    const second = await plan(stub, secondDir);
    assert.equal(second.code, 0, second.stderr);
    const secondManifest = JSON.parse(readFileSync(planManifestPath(secondDir), 'utf8')) as CleanupManifest;
    assert.equal(secondManifest.operationSemanticHash, firstManifest.operationSemanticHash);
    assert.deepEqual(secondManifest.operations.map((operation) => operation.id), firstManifest.operations.map((operation) => operation.id));
  } finally { await stub.close(); }
});

test('unmanaged role visibility allow is refused because @everyone deny would not keep legacy channels hidden', async () => {
  const stub = await stubDiscord();
  try {
    const category = stub.state.channels.find((channel) => channel.id === LEGACY_CATEGORY_IDS[0])!;
    category.permission_overwrites.push({ id: ID(50), type: 0, allow: VIEW, deny: '0' });
    for (const child of stub.state.channels.filter((channel) => channel.parent_id === category.id)) {
      child.permission_overwrites = structuredClone(category.permission_overwrites);
    }
    const result = await plan(stub, mkdtempSync(join(tmpdir(), 'two-live-clean-visible-role-')));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unmanaged role View Channel allow|remains visible/);
    assert.equal(stub.writes.length, 0);
  } finally { await stub.close(); }
});

test('permission-unsynchronized legacy child is refused because category archive would not prove it hidden', async () => {
  const stub = await stubDiscord();
  try {
    stub.state.channels.find((channel) => channel.id === LEGACY_CHANNEL_IDS[0])!.permission_overwrites = [{ id: ID(51), type: 0, allow: VIEW, deny: '0' }];
    const result = await plan(stub, mkdtempSync(join(tmpdir(), 'two-live-clean-unsynchronized-')));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /permission-unsynchronized/);
    assert.equal(stub.writes.length, 0);
  } finally { await stub.close(); }
});

test('tampered plan and phase operation bodies refuse apply and rollback before writes', async () => {
  const planStub = await stubDiscord();
  const planDir = mkdtempSync(join(tmpdir(), 'two-live-clean-plan-tamper-'));
  try {
    assert.equal((await plan(planStub, planDir)).code, 0);
    const path = planManifestPath(planDir);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    manifest.operations[0]!.write.permission_overwrites = [];
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    chmodSync(path, 0o600);
    const result = await apply(planStub, planDir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /operation bodies|semantic hash/);
    assert.equal(planStub.writes.length, 0);
  } finally { await planStub.close(); }

  const phaseStub = await stubDiscord();
  const phaseDir = mkdtempSync(join(tmpdir(), 'two-live-clean-phase-tamper-'));
  try {
    assert.equal((await plan(phaseStub, phaseDir)).code, 0);
    assert.equal((await apply(phaseStub, phaseDir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '1' })).code, 86);
    const path = manifestPath(phaseDir);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    manifest.operations[1]!.write.permission_overwrites = [];
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    chmodSync(path, 0o600);
    const writesBefore = phaseStub.writes.length;
    const resumed = await apply(phaseStub, phaseDir);
    assert.equal(resumed.code, 1);
    assert.match(resumed.stderr, /operation bodies|deterministic plan|Stored manifest/);
    assert.equal(phaseStub.writes.length, writesBefore);
    const rolledBack = await rollback(phaseStub, phaseDir);
    assert.equal(rolledBack.code, 2);
    assert.match(rolledBack.stderr, /operation bodies|deterministic plan/);
    assert.equal(phaseStub.writes.length, writesBefore);
  } finally { await phaseStub.close(); }
});

test('one reviewed-ID mutation refuses apply before writes', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-id-drift-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    stub.state.channels.find((channel) => channel.id === LEGACY_CHANNEL_IDS[0])!.id = ID(999);
    const result = await apply(stub, dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /drifted|missing|unreviewed/);
    assert.equal(stub.writes.length, 0);
  } finally { await stub.close(); }
});

test('stale snapshot, wrong application/guild token, and hierarchy refusal fail closed', async () => {
  const stub = await stubDiscord();
  try {
    const staleDir = mkdtempSync(join(tmpdir(), 'two-live-clean-stale-'));
    assert.equal((await plan(stub, staleDir)).code, 0);
    const snapshotPath = join(staleDir, 'snapshot', 'pre.json');
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as JsonObject;
    snapshot.generatedAt = '2026-01-01T00:00:00.000Z';
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    const manifestPath = planManifestPath(staleDir);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CleanupManifest;
    manifest.snapshotGeneratedAt = snapshot.generatedAt as string;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    chmodSync(snapshotPath, 0o600);
    chmodSync(manifestPath, 0o600);
    utimesSync(snapshotPath, new Date(), new Date());
    const stale = await apply(stub, staleDir);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /signature|fresh enough/);

    const refreshedDir = mkdtempSync(join(tmpdir(), 'two-live-clean-refreshed-'));
    assert.equal((await plan(stub, refreshedDir)).code, 0);
    const refreshedSnapshotPath = join(refreshedDir, 'snapshot', 'pre.json');
    const refreshedSnapshot = JSON.parse(readFileSync(refreshedSnapshotPath, 'utf8')) as JsonObject;
    refreshedSnapshot.generatedAt = new Date().toISOString();
    writeFileSync(refreshedSnapshotPath, `${JSON.stringify(refreshedSnapshot, null, 2)}\n`);
    const refreshedManifestPath = planManifestPath(refreshedDir);
    const refreshedManifest = JSON.parse(readFileSync(refreshedManifestPath, 'utf8')) as CleanupManifest;
    refreshedManifest.snapshotGeneratedAt = refreshedSnapshot.generatedAt as string;
    writeFileSync(refreshedManifestPath, `${JSON.stringify(refreshedManifest, null, 2)}\n`);
    chmodSync(refreshedSnapshotPath, 0o600);
    chmodSync(refreshedManifestPath, 0o600);
    const refreshed = await apply(stub, refreshedDir);
    assert.equal(refreshed.code, 1);
    assert.match(refreshed.stderr, /signature/);

    const wrongToken = await run(CLEANUP, cleanupArgs(mkdtempSync(join(tmpdir(), 'two-live-clean-wrong-token-'))), { DISCORD_BOT_TOKEN: `${Buffer.from(ID(998)).toString('base64url')}.x.y`, MAIN_GUILD_API_BASE: 'http://127.0.0.1:1/api/v10' });
    assert.equal(wrongToken.code, 2);
    const wrongGuild = await run(CLEANUP, cleanupArgs(mkdtempSync(join(tmpdir(), 'two-live-clean-wrong-guild-'))), { DISCORD_GUILD_ID: ID(997), MAIN_GUILD_API_BASE: 'http://127.0.0.1:1/api/v10' });
    assert.equal(wrongGuild.code, 2);

    stub.state.roles.find((role) => role.name === 'Owen')!.permissions = '0';
    const hierarchy = await plan(stub, mkdtempSync(join(tmpdir(), 'two-live-clean-noadmin-')));
    assert.equal(hierarchy.code, 1);
    assert.match(hierarchy.stderr, /Administrator/);
  } finally { await stub.close(); }
});

test('429 and partial failure stop immediately with a recoverable manifest', async () => {
  const rateStub = await stubDiscord();
  const rateDir = mkdtempSync(join(tmpdir(), 'two-live-clean-429-'));
  try {
    assert.equal((await plan(rateStub, rateDir)).code, 0);
    rateStub.failNextWrite(429);
    const rate = await apply(rateStub, rateDir);
    assert.equal(rate.code, 1);
    assert.match(rate.stderr, /429/);
    assert.equal(rateStub.writes.length, 1);
    const manifest = JSON.parse(readFileSync(manifestPath(rateDir), 'utf8')) as CleanupManifest;
    assert.equal(manifest.status, 'apply_failed');
    assert.equal(manifest.operations[0]!.state, 'requesting');
  } finally { await rateStub.close(); }

  const resumeStub = await stubDiscord();
  const resumeDir = mkdtempSync(join(tmpdir(), 'two-live-clean-429-resume-'));
  try {
    assert.equal((await plan(resumeStub, resumeDir)).code, 0);
    resumeStub.failNextWrite(429);
    assert.equal((await apply(resumeStub, resumeDir)).code, 1);
    const resumed = await apply(resumeStub, resumeDir);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumeStub.writeOrder.length, 18);
  } finally { await resumeStub.close(); }

  const partialStub = await stubDiscord();
  const partialDir = mkdtempSync(join(tmpdir(), 'two-live-clean-partial-'));
  try {
    assert.equal((await plan(partialStub, partialDir)).code, 0);
    partialStub.partialNextWrite();
    const partial = await apply(partialStub, partialDir);
    assert.equal(partial.code, 1);
    assert.match(partial.stderr, /partial\/unexpected state/);
    assert.equal(partialStub.writes.length, 1);
    const manifest = JSON.parse(readFileSync(manifestPath(partialDir), 'utf8')) as CleanupManifest;
    assert.equal(manifest.status, 'apply_failed');
  } finally { await partialStub.close(); }
});

test('interrupted apply resumes without replay, then rollback restores exact semantic state in reverse order', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-interrupt-'));
  const before = structuredClone(stub.state.channels);
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const interrupted = await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '3' });
    assert.equal(interrupted.code, 86);
    assert.equal(stub.writes.length, 3);
    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(stub.writeOrder.length, 18);
    assert.equal(new Set(stub.writeOrder).size, 18, 'retry must not replay completed writes');
    assert.equal(stub.state.channels.length, before.length, 'channel IDs/history must be preserved');
    for (const original of before) assert.equal(stub.state.channels.find((channel) => channel.id === original.id)?.topic, original.topic);

    const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(manifest.status, 'applied');
    assert.ok(manifest.operations.every((operation) => operation.state === 'applied'));
    const interruptedRollback = manifest.operations.at(-1)!;
    stub.state.channels.find((channel) => channel.id === interruptedRollback.objectId)!.permission_overwrites = structuredClone(interruptedRollback.inverseWrite.permission_overwrites);
    for (const child of stub.state.channels.filter((channel) => channel.parent_id === interruptedRollback.objectId)) {
      child.permission_overwrites = structuredClone(interruptedRollback.inverseWrite.permission_overwrites);
    }
    const rolledBack = await rollback(stub, dir);
    assert.equal(rolledBack.code, 0, rolledBack.stderr);
    assert.deepEqual(stub.rollbackOrder, [...stub.writeOrder].reverse().slice(1));
    assert.equal(stable(stub.state.channels), stable(before));
    const finalManifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(finalManifest.status, 'rolled_back');
    assert.ok(finalManifest.operations.every((operation) => operation.state === 'rolled_back'));
  } finally { await stub.close(); }
});
