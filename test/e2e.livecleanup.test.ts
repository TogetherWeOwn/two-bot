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
  applyOperationOverwrites,
  basePermissions,
  LEGACY_CATEGORY_IDS,
  LEGACY_CHANNEL_IDS,
  type Channel,
  type CleanupManifest,
  type JsonObject,
  type LiveCleanupSnapshot,
  type Member as SnapshotMember,
  normalizeOverwrites,
  operationSemanticHash,
  type Overwrite,
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
type PermissionDriftFixture = {
  capturedAt: string;
  guildId: string;
  mismatchCount: number;
  mismatches: Array<{
    channelId: string;
    parentId: string;
    channelOverwrites: Channel['permission_overwrites'];
    parentOverwrites: Channel['permission_overwrites'];
  }>;
};
const PERMISSION_DRIFT = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/live-cleanup-permission-drift.json', import.meta.url)), 'utf8')) as PermissionDriftFixture;
const PRODUCTION_STATE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/live-cleanup-production-state.json', import.meta.url)), 'utf8')) as State;
const EXPECTED_OPERATIONS = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/live-cleanup-expected-operations.json', import.meta.url)), 'utf8')) as {
  operationCount: number;
  operationSemanticHash: string;
  operations: Array<{ sequence: number; id: string; objectType: 'category' | 'channel'; objectId: string }>;
};

function fixtureState(): State {
  const state = structuredClone(PRODUCTION_STATE);
  assert.equal(state.guild.id, LIVE_GUILD_ID);
  const mismatches = state.channels.filter((channel) => LEGACY_CHANNEL_IDS.includes(channel.id as never)).filter((channel) => {
    const parent = state.channels.find((item) => item.id === channel.parent_id)!;
    return stable(normalizeOverwrites(channel.permission_overwrites)) !== stable(normalizeOverwrites(parent.permission_overwrites));
  });
  assert.equal(mismatches.length, PERMISSION_DRIFT.mismatchCount);
  assert.deepEqual(mismatches.map((channel) => channel.id).sort(), PERMISSION_DRIFT.mismatches.map((mismatch) => mismatch.channelId).sort());
  return state;
}

async function stubDiscord(): Promise<Stub> {
  const state = fixtureState();
  const syncedChildren = new Set(state.channels.filter((channel) => {
    const parent = state.channels.find((item) => item.id === channel.parent_id);
    return parent && stable(channel.permission_overwrites) === stable(parent.permission_overwrites);
  }).map((channel) => channel.id));
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
            if (syncedChildren.has(child.id)) child.permission_overwrites = structuredClone(overwrites);
            if (stable(child.permission_overwrites) === stable(overwrites)) syncedChildren.add(child.id);
          }
        } else if (channel.parent_id) {
          const parent = state.channels.find((item) => item.id === channel.parent_id)!;
          if (stable(channel.permission_overwrites) === stable(parent.permission_overwrites)) syncedChildren.add(channel.id);
          else syncedChildren.delete(channel.id);
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

/**
 * Discord's channel permission stack, written independently of the planner's own
 * assertion so the visibility test is not the planner agreeing with itself:
 * base role permissions -> @everyone overwrite -> union of role overwrites ->
 * member overwrite. Administrator short-circuits, which is why it cannot be denied.
 */
function canView(member: SnapshotMember, snapshot: LiveCleanupSnapshot, overwrites: Overwrite[]): boolean {
  let permissions = basePermissions(member, snapshot);
  if ((permissions & BigInt(ADMIN)) !== 0n) return true;
  const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === snapshot.guildId);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || overwrite.id === snapshot.guildId || !member.roles.includes(overwrite.id)) continue;
    allow |= BigInt(overwrite.allow);
    deny |= BigInt(overwrite.deny);
  }
  permissions = (permissions & ~deny) | allow;
  const mine = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === member.id);
  if (mine) permissions = (permissions & ~BigInt(mine.deny)) | BigInt(mine.allow);
  return (permissions & BigInt(VIEW)) !== 0n;
}

function operationChangesState(operation: CleanupManifest['operations'][number]): boolean {
  return stable(operation.write.permission_overwrites) !== stable(operation.inverseWrite.permission_overwrites);
}

function rollbackRequiresPatch(manifest: CleanupManifest, snapshotChannels: Channel[], operation: CleanupManifest['operations'][number]): boolean {
  if (operationChangesState(operation)) return true;
  if (operation.objectType !== 'channel') return false;
  const original = snapshotChannels.find((channel) => channel.id === operation.objectId)!;
  const parentOperation = manifest.operations.find((item) => item.objectType === 'category' && item.objectId === original.parent_id)!;
  return operationChangesState(parentOperation)
    && stable(operation.inverseWrite.permission_overwrites) === stable(parentOperation.write.permission_overwrites);
}

async function plan(stub: Stub, dir: string): Promise<Run> {
  return run(CLEANUP, cleanupArgs(dir), { MAIN_GUILD_API_BASE: stub.base });
}
async function apply(stub: Stub, dir: string, env: Record<string, string> = {}): Promise<Run> {
  return run(CLEANUP, cleanupArgs(dir, true), { MAIN_GUILD_API_BASE: stub.base, ...env });
}
async function rollback(stub: Stub, dir: string): Promise<Run> {
  return run(ROLLBACK, ['--manifest', manifestPath(dir), '--confirm-main-guild', '--apply'], { MAIN_GUILD_API_BASE: stub.base });
}

test('production-shaped 51-channel drift fixture pins 69 stable operations and dry-run writes nothing', async () => {
  const stub = await stubDiscord();
  try {
    const runtimeMismatches = stub.state.channels.filter((channel) => LEGACY_CHANNEL_IDS.includes(channel.id as never)).filter((channel) => {
      const parent = stub.state.channels.find((item) => item.id === channel.parent_id)!;
      return stable(normalizeOverwrites(channel.permission_overwrites)) !== stable(normalizeOverwrites(parent.permission_overwrites));
    });
    assert.equal(runtimeMismatches.length, PERMISSION_DRIFT.mismatchCount);
    assert.deepEqual(runtimeMismatches.map((channel) => channel.id).sort(), PERMISSION_DRIFT.mismatches.map((mismatch) => mismatch.channelId).sort());
    const firstDir = mkdtempSync(join(tmpdir(), 'two-live-clean-plan-'));
    const first = await plan(stub, firstDir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(stub.writes.length, 0);
    const firstManifest = JSON.parse(readFileSync(planManifestPath(firstDir), 'utf8')) as CleanupManifest;
    assert.equal(firstManifest.operationCount, EXPECTED_OPERATIONS.operationCount);
    assert.equal(firstManifest.reviewedLegacyChannelIds.length, 112);
    assert.equal(firstManifest.reviewedLegacyCategoryIds.length, 18);
    assert.equal(firstManifest.operationSemanticHash, operationSemanticHash(firstManifest.operations));
    assert.equal(firstManifest.operationSemanticHash, EXPECTED_OPERATIONS.operationSemanticHash);
    assert.equal(new Set(firstManifest.operations.map((operation) => operation.id)).size, EXPECTED_OPERATIONS.operationCount);
    assert.equal(firstManifest.operations.filter((operation) => operation.objectType === 'category').length, 18);
    const channelOperations = firstManifest.operations.filter((operation) => operation.objectType === 'channel');
    assert.equal(channelOperations.length, 51);
    assert.deepEqual(firstManifest.operations.map(({ sequence, id, objectType, objectId }) => ({ sequence, id, objectType, objectId })), EXPECTED_OPERATIONS.operations);
    for (const operation of channelOperations) {
      const mismatch = PERMISSION_DRIFT.mismatches.find((item) => item.channelId === operation.objectId)!;
      assert.equal(stable(operation.expectedBefore.permission_overwrites), stable(mismatch.channelOverwrites));
      assert.equal(stable(operation.inverseWrite.permission_overwrites), stable(mismatch.channelOverwrites));
      for (const original of mismatch.channelOverwrites) {
        const updated = operation.write.permission_overwrites.find((overwrite) => overwrite.id === original.id && overwrite.type === original.type)!;
        assert.equal(BigInt(updated.allow) & ~BigInt(VIEW), BigInt(original.allow) & ~BigInt(VIEW));
        assert.equal(BigInt(updated.deny) & ~BigInt(VIEW), BigInt(original.deny) & ~BigInt(VIEW));
      }
      const everyone = operation.write.permission_overwrites.find((overwrite) => overwrite.id === LIVE_GUILD_ID && overwrite.type === 0)!;
      assert.notEqual(BigInt(everyone.deny) & BigInt(VIEW), 0n);
    }
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

test('unmanaged role visibility is neutralized with an additive member deny', async () => {
  const stub = await stubDiscord();
  try {
    const roleId = ID(50);
    const memberId = ID(60);
    stub.state.roles.push({ id: roleId, name: 'fixture-visible-role', managed: false, permissions: '0', position: 10 });
    stub.state.members.push({ user: { id: memberId, username: 'fixture-holder', bot: false }, roles: [roleId], premium_since: null, pending: false });
    const category = stub.state.channels.find((channel) => channel.id === LEGACY_CATEGORY_IDS[0])!;
    category.permission_overwrites.push({ id: roleId, type: 0, allow: VIEW, deny: '0' });
    for (const child of stub.state.channels.filter((channel) => channel.parent_id === category.id)) {
      child.permission_overwrites = structuredClone(category.permission_overwrites);
    }
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-visible-role-'));
    const result = await plan(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stub.writes.length, 0);
    const manifest = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    const operation = manifest.operations.find((item) => item.objectId === category.id)!;
    assert.ok(operation.write.permission_overwrites.some((overwrite) => overwrite.id === roleId && overwrite.type === 0 && overwrite.allow === VIEW));
    const memberDeny = operation.write.permission_overwrites.find((overwrite) => overwrite.id === memberId && overwrite.type === 1)!;
    assert.notEqual(BigInt(memberDeny.deny) & BigInt(VIEW), 0n);
  } finally { await stub.close(); }
});

test('only Owner, Owen and Administrator holders keep visibility; every other bot is denied and recorded', async () => {
  const stub = await stubDiscord();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-bot-visibility-'));
    const result = await plan(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stub.writes.length, 0);
    const manifest = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot', 'pre.json'), 'utf8')) as LiveCleanupSnapshot;

    // TOG-2920 finding: this non-Owen bot held ViewChannel on this reviewed legacy
    // channel through a role allow that operation 17 preserves. The role allow must
    // survive; the bot must not.
    const REVIEWED_BOT = '235148962103951360';
    const ALLOWING_ROLE = '1060912046012633148';
    const DRIFTED_CHANNEL = '1087200619418357810';
    const operation = manifest.operations.find((item) => item.objectId === DRIFTED_CHANNEL)!;
    const roleBefore = operation.expectedBefore.permission_overwrites.find((item) => item.id === ALLOWING_ROLE && item.type === 0)!;
    const roleAfter = operation.write.permission_overwrites.find((item) => item.id === ALLOWING_ROLE && item.type === 0)!;
    assert.equal(BigInt(roleAfter.allow) & ~BigInt(VIEW), BigInt(roleBefore.allow) & ~BigInt(VIEW), 'unrelated role bits must survive');
    assert.equal(roleAfter.allow, roleBefore.allow, 'the explicit role allow must be preserved, not stripped');
    const botDeny = operation.write.permission_overwrites.find((item) => item.id === REVIEWED_BOT && item.type === 1);
    assert.ok(botDeny, 'the non-Administrator bot must receive an additive member deny');
    assert.notEqual(BigInt(botDeny.deny) & BigInt(VIEW), 0n);

    // Nobody outside the recorded exemption set may see any of the 112 after the plan.
    const after = structuredClone(snapshot);
    for (const item of manifest.operations) applyOperationOverwrites(after, item, item.write.permission_overwrites);
    const exempt = new Map(manifest.visibilityExemptions.map((item) => [item.memberId, item.reason]));
    const stillVisible = snapshot.members.filter((member) => LEGACY_CHANNEL_IDS.some((id) => {
      const channel = after.channels.find((item) => item.id === id)!;
      return canView(member, snapshot, normalizeOverwrites(channel.permission_overwrites ?? []));
    }));
    assert.deepEqual(stillVisible.map((member) => member.id).sort(), [...exempt.keys()].sort());
    assert.ok(stillVisible.some((member) => member.bot && member.id === LIVE_BOT_APPLICATION_ID), 'Owen must retain access');
    assert.ok(stillVisible.some((member) => member.id === String(snapshot.guild.owner_id)), 'the guild Owner must retain access');
    assert.ok(!stillVisible.some((member) => member.id === REVIEWED_BOT));
    for (const member of stillVisible) {
      const reason = exempt.get(member.id)!;
      if (reason === 'administrator') {
        assert.notEqual(basePermissions(member, snapshot) & BigInt(ADMIN), 0n, `${member.id} is recorded as Administrator but does not hold it`);
      } else {
        assert.ok(reason === 'owner' || reason === 'owen');
      }
    }
    assert.match(result.stdout, /Principals that still see the archived objects after this plan: \d+/);
    for (const item of manifest.visibilityExemptions) assert.match(result.stdout, new RegExp(`RETAINS-VIEW ${item.reason} \\w+ ${item.memberId}`));
  } finally { await stub.close(); }
});

test('a tampered visibility-exemption set refuses apply before writes', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-exemption-tamper-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const path = planManifestPath(dir);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    manifest.visibilityExemptions = [...manifest.visibilityExemptions, { memberId: ID(77), bot: true, reason: 'administrator' }];
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    chmodSync(path, 0o600);
    const result = await apply(stub, dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /visibility-exemption set/);
    assert.equal(stub.writes.length, 0);
  } finally { await stub.close(); }
});

test('additional permission drift becomes a child PATCH that preserves explicit overwrites', async () => {
  const stub = await stubDiscord();
  try {
    const reviewedDriftIds = new Set(PERMISSION_DRIFT.mismatches.map((mismatch) => mismatch.channelId));
    const channelId = LEGACY_CHANNEL_IDS.find((id) => !reviewedDriftIds.has(id))!;
    const channel = stub.state.channels.find((item) => item.id === channelId)!;
    const explicit = [{ id: ID(51), type: 0, allow: VIEW, deny: '0' }];
    channel.permission_overwrites = structuredClone(explicit);
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-additional-drift-'));
    const result = await plan(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stub.writes.length, 0);
    const manifest = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(manifest.operationCount, 70);
    const operation = manifest.operations.find((item) => item.objectId === channelId)!;
    assert.equal(operation.objectType, 'channel');
    assert.equal(stable(operation.inverseWrite.permission_overwrites), stable(explicit));
    assert.equal(stable(operation.write.permission_overwrites.filter((overwrite) => overwrite.id !== LIVE_GUILD_ID)), stable(explicit));
  } finally { await stub.close(); }
});

test('reviewed untouched objects and legacy-category children must retain their pinned topology', async () => {
  const movedStub = await stubDiscord();
  try {
    const startHere = movedStub.state.channels.find((channel) => channel.id === '1545924265247903884')!;
    const parent = movedStub.state.channels.find((channel) => channel.id === LEGACY_CATEGORY_IDS[0])!;
    startHere.type = 0;
    startHere.parent_id = parent.id;
    startHere.permission_overwrites = [...parent.permission_overwrites, { id: ID(50), type: 0, allow: VIEW, deny: '0' }];
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-moved-untouched-'));
    const result = await plan(movedStub, dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /pinned type and parent|unexpected child/);
    assert.equal(movedStub.writes.length, 0);
    assert.ok(existsSync(join(dir, 'snapshot', 'pre.json')), 'planning refusal must preserve the fresh pre-snapshot');
    assert.ok(existsSync(join(dir, 'snapshot', 'holders.csv')));
    assert.ok(existsSync(join(dir, 'snapshot', 'references.json')));
    assert.ok(existsSync(join(dir, 'plan.log')));
    assert.ok(!existsSync(join(dir, 'plan', 'operations.json')));
  } finally { await movedStub.close(); }

  const extraChildStub = await stubDiscord();
  try {
    const parent = extraChildStub.state.channels.find((channel) => channel.id === LEGACY_CATEGORY_IDS[0])!;
    extraChildStub.state.channels.push({ id: ID(999), name: 'unreviewed legacy child', type: 0, parent_id: parent.id, permission_overwrites: structuredClone(parent.permission_overwrites) });
    const result = await plan(extraChildStub, mkdtempSync(join(tmpdir(), 'two-live-clean-extra-child-')));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unexpected child IDs/);
    assert.equal(extraChildStub.writes.length, 0);
  } finally { await extraChildStub.close(); }
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

    const owen = stub.state.members.find((member) => member.user.id === LIVE_BOT_APPLICATION_ID)!;
    stub.state.roles.find((role) => owen.roles.includes(role.id) && (BigInt(role.permissions) & BigInt(ADMIN)) !== 0n)!.permissions = '0';
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
    assert.equal(resumeStub.writeOrder.length, 68);
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

test('a partial write leaves one in-flight operation that resume names and rollback recovers exactly', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-partial-recover-'));
  const before = structuredClone(stub.state.channels);
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    stub.partialNextWrite();
    const partial = await apply(stub, dir);
    assert.equal(partial.code, 1);
    assert.match(partial.stderr, /partial\/unexpected state/);

    // The interrupted operation is journalled `requesting`, and the live object now
    // matches neither its expected-before nor its full write. That is the state
    // TOG-2920 showed was unrecoverable: resume refused and rollback refused.
    const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    const requesting = manifest.operations.filter((operation) => operation.state === 'requesting');
    assert.equal(requesting.length, 1);
    const inFlight = requesting[0]!;
    const live = stub.state.channels.find((channel) => channel.id === inFlight.objectId)!;
    const liveShape = stable(normalizeOverwrites(live.permission_overwrites));
    assert.notEqual(liveShape, stable(inFlight.write.permission_overwrites), 'the live object must be a genuine partial, not the full write');
    assert.notEqual(liveShape, stable(inFlight.expectedBefore.permission_overwrites), 'the live object must be a genuine partial, not the untouched before-state');

    // Resume still refuses to push forward over an ambiguous write, but must now
    // name the operation and hand the operator the rollback command.
    const writesBeforeResume = stub.writes.length;
    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 1);
    assert.match(resumed.stderr, new RegExp(`Interrupted operation ${inFlight.id} left a partial write`));
    assert.match(resumed.stderr, /live-clean-slate-cleanup-rollback\.ts/);
    assert.equal(stub.writes.length, writesBeforeResume, 'a refused resume must not write');

    const rolledBack = await rollback(stub, dir);
    assert.equal(rolledBack.code, 0, rolledBack.stderr);
    assert.match(rolledBack.stdout, new RegExp(`RECOVERING in-flight ${inFlight.id}`));
    assert.equal(stable(stub.state.channels), stable(before), 'rollback must reach the exact pre-snapshot state');
    const finalManifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(finalManifest.status, 'rolled_back');
    assert.ok(finalManifest.operations.every((operation) => operation.state === 'rolled_back' || operation.state === 'pending'));
  } finally { await stub.close(); }
});

test('rollback still refuses third-party drift on an operation that is not in flight', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-applied-drift-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir)).code, 0);
    const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(manifest.operations.filter((operation) => operation.state === 'requesting').length, 0);
    const applied = manifest.operations.findLast((operation) => operation.objectType === 'channel' && operationChangesState(operation))!;
    const target = stub.state.channels.find((channel) => channel.id === applied.objectId)!;
    target.permission_overwrites = [...target.permission_overwrites, { id: ID(88), type: 0, allow: VIEW, deny: '0' }];
    const writesBefore = stub.writes.length;
    const result = await rollback(stub, dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /drifted from both applied and inverse state/);
    assert.equal(stub.writes.length, writesBefore, 'a refused rollback must not write');
  } finally { await stub.close(); }
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
    assert.equal(stub.writeOrder.length, 69);
    assert.equal(new Set(stub.writeOrder).size, 69, 'retry must not replay completed writes');
    assert.equal(stub.state.channels.length, before.length, 'channel IDs/history must be preserved');
    for (const original of before) assert.equal(stub.state.channels.find((channel) => channel.id === original.id)?.topic, original.topic);

    const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(manifest.status, 'applied');
    assert.ok(manifest.operations.every((operation) => operation.state === 'applied'));
    const interruptedRollback = manifest.operations.findLast(operationChangesState)!;
    stub.state.channels.find((channel) => channel.id === interruptedRollback.objectId)!.permission_overwrites = structuredClone(interruptedRollback.inverseWrite.permission_overwrites);
    for (const child of stub.state.channels.filter((channel) => channel.parent_id === interruptedRollback.objectId)) {
      child.permission_overwrites = structuredClone(interruptedRollback.inverseWrite.permission_overwrites);
    }
    const expectedRollbackOrder = manifest.operations
      .filter((operation) => operation.id !== interruptedRollback.id && rollbackRequiresPatch(manifest, before, operation))
      .reverse()
      .map((operation) => operation.objectId);
    const rollbackWritesBefore = stub.writes.length;
    const rolledBack = await rollback(stub, dir);
    assert.equal(rolledBack.code, 0, rolledBack.stderr);
    const rollbackRequestOrder = stub.writes.slice(rollbackWritesBefore).map((write) => /\/channels\/(\d+)$/.exec(write.path)![1]);
    assert.deepEqual(rollbackRequestOrder, expectedRollbackOrder);
    assert.equal(stable(stub.state.channels), stable(before));
    const finalManifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(finalManifest.status, 'rolled_back');
    assert.ok(finalManifest.operations.every((operation) => operation.state === 'rolled_back'));
  } finally { await stub.close(); }
});

test('rollback accepts pending no-op operations after an interrupted apply', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-interrupted-rollback-'));
  const before = structuredClone(stub.state.channels);
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const interrupted = await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '2' });
    assert.equal(interrupted.code, 86);
    const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.ok(manifest.operations.some((operation) => operation.state === 'pending' && stable(operation.write.permission_overwrites) === stable(operation.inverseWrite.permission_overwrites)));
    const result = await rollback(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stable(stub.state.channels), stable(before));
    const finalManifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(finalManifest.status, 'rolled_back');
  } finally { await stub.close(); }
});

test('rollback repairs a mixed category/child state before checkpointing and remains retryable', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-mixed-rollback-'));
  const before = structuredClone(stub.state.channels);
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir)).code, 0);
    const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    const mixed = manifest.operations.findLast((operation) => operation.objectType === 'category'
      && stable(operation.write.permission_overwrites) !== stable(operation.inverseWrite.permission_overwrites)
      && before.some((channel) => channel.parent_id === operation.objectId && stable(channel.permission_overwrites) === stable(operation.inverseWrite.permission_overwrites)))!;
    stub.state.channels.find((channel) => channel.id === mixed.objectId)!.permission_overwrites = structuredClone(mixed.inverseWrite.permission_overwrites);
    const expectedRollbackWrites = manifest.operations.filter((operation) => rollbackRequiresPatch(manifest, before, operation)).length;
    const rollbackWritesBefore = stub.writes.length;
    const result = await rollback(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stub.writes.length - rollbackWritesBefore, expectedRollbackWrites, 'mixed state must PATCH the category rather than checkpoint it');
    assert.equal(stable(stub.state.channels), stable(before));
    const finalManifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(finalManifest.status, 'rolled_back');
    assert.ok(finalManifest.operations.every((operation) => operation.state === 'rolled_back'));
  } finally { await stub.close(); }
});
