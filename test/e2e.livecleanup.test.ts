import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ACTIVE_CATEGORY_IDS,
  ACTIVE_CHANNEL_IDS,
  appendJournalWitness,
  AUTO_VOICE_CATEGORY_ID,
  applyOperationOverwrites,
  basePermissions,
  isAutoVoiceEphemeralChild,
  inFlightExceptionIsAvailable,
  journalWitnessPath,
  LEGACY_CATEGORY_IDS,
  LEGACY_CHANNEL_IDS,
  type Channel,
  type CleanupManifest,
  type JsonObject,
  journalSignature,
  manifestInFlightId,
  type LiveCleanupSnapshot,
  type Member as SnapshotMember,
  normalizeOverwrites,
  operationSemanticHash,
  type Overwrite,
  readJournalWitness,
  type Role,
  stable,
  withSemanticHash,
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
  /** Mutable Server Guide payload, served from `GET /guilds/{id}/onboarding`. */
  references: { onboarding: JsonObject };
  /** Every `guild.features` ordering this stub has served, newest last. */
  featureOrders: string[];
  writes: Array<{ method: string; path: string; body: unknown }>;
  writeOrder: string[];
  rollbackOrder: string[];
  failOnboardingRead(status: number): void;
  /**
   * Serve `GET /onboarding` as a raw body; `null` payload sends no body at all. `status`
   * defaults to 200 so a caller that only shapes the body keeps reading an authoritative
   * answer; pass a non-200 to pin the status half of the readability gate.
   */
  serveOnboardingRaw(contentType: string, payload: string | null, status?: number): void;
  failNextWrite(status: number): void;
  partialNextWrite(): void;
  /** Tear the write to one specific object rather than whichever comes first. */
  partialWriteOn(objectId: string): void;
  /**
   * Push a channel into live state once the Nth PATCH of this stub's life has been served.
   * The auto-voice generator spawns on a member joining the lobby, which is not synchronized
   * with anything the phase does, so the cases that matter are the ones where it lands
   * *between* a gate and the writes it guards — mid-apply and mid-rollback. Counting writes
   * is what makes those deterministic instead of a sleep race.
   */
  spawnAfterWrites(writeCount: number, channel: Channel): void;
  /** Delete a channel from live state, the way the generator does when a room empties. */
  despawn(channelId: string): void;
  /** The despawn half of {@link spawnAfterWrites}: a room empties mid-apply or mid-rollback. */
  despawnAfterWrites(writeCount: number, channelId: string): void;
  /**
   * Land a message in a channel, which moves its `last_message_id`. This fixture was
   * captured without that field, which is exactly why the stub suite could not see the
   * failure it causes: on the live guild the three channels Owen itself logs to move it
   * continuously, and every live-vs-live hash comparison used to break on it (TOG-3141,
   * round 16). Nothing else about the channel changes — that is the point.
   */
  postMessage(channelId: string): void;
  /** The {@link spawnAfterWrites} landing for a message: traffic arriving mid-apply or mid-rollback. */
  postMessageAfterWrites(writeCount: number, channelId: string): void;
  /**
   * Pin a message, which moves `last_pin_timestamp`. The same field class as
   * {@link postMessage} reached by a different action, and the one the live captures could not
   * measure — nobody pinned anything during the window, and causing a pin on the live guild to
   * prove it is not a read.
   */
  pinMessage(channelId: string): void;
  /**
   * Move a child the way a third party would, out from under the phase. Because sync
   * is decided by value, this also drops the child out of the synchronized set.
   */
  desyncChild(childId: string, overwrites: Channel['permission_overwrites']): void;
  /**
   * Omit `permission_overwrites` from the single-object read `GET /channels/{id}` only,
   * leaving the list read complete. That splits the plan from apply's own second-opinion
   * read, so a test can pin the apply-side gate on a plan built from a full answer.
   */
  hideOverwritesOnObjectRead(objectId: string): void;
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

// The drift fixture is the live capture from 2026-09-16T10:27:52Z and is left exactly as
// captured — it is the evidence this phase was re-planned on, so it is never rewritten to
// match the code. It predates the owner's reuse rule (TOG-2806, 18:20Z), under which six of
// the channels it reviewed as legacy became active-tree channels. Every expectation below is
// therefore the still-legacy subset of that capture, derived from LEGACY_CHANNEL_IDS rather
// than hard-coded, so reclassifying a channel moves the expectation and reclassifying one
// that never drifted does not.
assert.equal(PERMISSION_DRIFT.mismatchCount, PERMISSION_DRIFT.mismatches.length);
const DRIFT_STILL_LEGACY = PERMISSION_DRIFT.mismatches.filter((mismatch) => LEGACY_CHANNEL_IDS.includes(mismatch.channelId as never));

function fixtureState(): State {
  const state = structuredClone(PRODUCTION_STATE);
  assert.equal(state.guild.id, LIVE_GUILD_ID);
  const mismatches = state.channels.filter((channel) => LEGACY_CHANNEL_IDS.includes(channel.id as never)).filter((channel) => {
    const parent = state.channels.find((item) => item.id === channel.parent_id)!;
    return stable(normalizeOverwrites(channel.permission_overwrites)) !== stable(normalizeOverwrites(parent.permission_overwrites));
  });
  assert.equal(mismatches.length, DRIFT_STILL_LEGACY.length);
  assert.deepEqual(mismatches.map((channel) => channel.id).sort(), DRIFT_STILL_LEGACY.map((mismatch) => mismatch.channelId).sort());
  return state;
}

async function stubDiscord(): Promise<Stub> {
  const state = fixtureState();
  const writes: Stub['writes'] = [];
  const writeOrder: string[] = [];
  const rollbackOrder: string[] = [];
  // Measured live across five TOG-2907 pre-snapshots, `GET /guilds/{id}/onboarding`
  // returns `guild_id`, `prompts`, `default_channel_ids`, `enabled` and `mode` on every
  // 200 — `default_channel_ids` is always present, empty or not. The stub used to omit it,
  // which is what let a status-only readability gate look total (TOG-3060).
  const references: Stub['references'] = { onboarding: { enabled: false, default_channel_ids: [], prompts: [] } };
  const featureOrders: string[] = [];
  let guildReads = 0;
  let nextFailure = 0;
  let partialNextWrite = false;
  let partialWriteTarget: string | null = null;
  let onboardingStatus = 200;
  let onboardingRaw: { contentType: string; payload: string | null; status: number } | null = null;
  let pendingSpawn: { after: number; channel: Channel } | null = null;
  let pendingDespawn: { after: number; channelId: string } | null = null;
  let pendingMessage: { after: number; channelId: string } | null = null;
  // Snowflakes, so the field moves monotonically the way Discord's does.
  let lastMessageId = 1550000000000000000n;
  const landMessage = (channelId: string) => {
    const target = state.channels.find((item) => item.id === channelId);
    assert.ok(target, `stub: no channel ${channelId} to land a message in`);
    (target as unknown as JsonObject).last_message_id = String(++lastMessageId);
  };
  const hiddenOverwriteReads = new Set<string>();
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
        if (partialNextWrite && (partialWriteTarget === null || partialWriteTarget === channel.id)) {
          partialNextWrite = false;
          partialWriteTarget = null;
          overwrites = overwrites.filter((overwrite) => overwrite.id !== LIVE_GUILD_ID);
        }
        const everyone = overwrites.find((overwrite) => overwrite.id === LIVE_GUILD_ID);
        if (everyone && (BigInt(everyone.deny) & (1n << 10n)) !== 0n) writeOrder.push(channel.id);
        else rollbackOrder.push(channel.id);
        // Discord decides which children a category PATCH carries by value: a child is
        // synchronized exactly while its overwrites equal the category's, so the edit
        // carries the children that matched the category's *previous* value and leaves
        // every other one where it is. Modelling this as sticky set membership instead
        // hides the case TOG-2934 hit, where a category restored ahead of its children
        // re-syncs nothing and the children are stranded at the applied value.
        const previous = stable(normalizeOverwrites(channel.permission_overwrites));
        channel.permission_overwrites = structuredClone(overwrites);
        if (channel.type === 4) {
          for (const child of state.channels.filter((item) => item.parent_id === channel.id)) {
            if (stable(normalizeOverwrites(child.permission_overwrites)) === previous) child.permission_overwrites = structuredClone(overwrites);
          }
        }
        // The auto-voice generator answers a member join, not anything the phase does, so
        // the interesting landings are the ones between a gate and the writes it guards.
        // Counting served writes makes those deterministic instead of a sleep race.
        if (pendingSpawn && writes.length >= pendingSpawn.after) {
          state.channels.push(structuredClone(pendingSpawn.channel));
          pendingSpawn = null;
        }
        if (pendingDespawn && writes.length >= pendingDespawn.after) {
          state.channels = state.channels.filter((item) => item.id !== pendingDespawn!.channelId);
          pendingDespawn = null;
        }
        if (pendingMessage && writes.length >= pendingMessage.after) {
          landMessage(pendingMessage.channelId);
          pendingMessage = null;
        }
        return send(200, channel);
      });
    }
    if (path === '/api/v10/users/@me') return send(200, { id: LIVE_BOT_APPLICATION_ID });
    if (path === '/api/v10/users/@me/guilds') return send(200, [{ id: LIVE_GUILD_ID }]);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}`) {
      // Discord hands back `features` in a different order on essentially every
      // request, so every hash the tooling compares across two reads has to survive
      // that. Rotating it on each GET keeps the whole suite honest about it rather
      // than parking the behaviour in one test nobody else exercises.
      const features = Array.isArray(state.guild.features) ? state.guild.features as string[] : [];
      const at = features.length === 0 ? 0 : guildReads++ % features.length;
      const rotated = [...features.slice(at), ...features.slice(0, at)];
      featureOrders.push(rotated.join(','));
      return send(200, { ...state.guild, features: rotated });
    }
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/roles`) return send(200, state.roles);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/channels`) return send(200, state.channels);
    if (path.startsWith(`/api/v10/guilds/${LIVE_GUILD_ID}/members?`)) return send(200, state.members);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/integrations`) return send(200, state.integrations);
    if (path === '/api/v10/oauth2/applications/@me') return send(200, state.application);
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/welcome-screen`) return send(200, { enabled: true });
    // `captureSnapshot` reads this one best-effort, so the stub has to be able to fail it
    // the way Discord does — an error body, not the onboarding object with a bad status.
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/onboarding`) {
      // A 200 that is not a Server Guide payload: an edge interstitial, an empty body, a
      // rate-limit object. `api()` reduces every one of these to `{status: 200, body: …}`
      // with nothing the derivation can read, so the stub has to serve the raw bytes
      // rather than a JSON value the test helper would re-encode.
      if (onboardingRaw !== null) {
        const { contentType, payload, status } = onboardingRaw;
        if (payload === null) return res.writeHead(status, { 'content-type': contentType }).end();
        res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) });
        return res.end(payload);
      }
      return onboardingStatus === 200 ? send(200, references.onboarding) : send(onboardingStatus, { message: 'stubbed failure', code: 0 });
    }
    if (path === `/api/v10/guilds/${LIVE_GUILD_ID}/member-verification`) return send(200, { form_fields: [] });
    const channel = /\/channels\/(\d+)$/.exec(path);
    if (channel) {
      const found = state.channels.find((item) => item.id === channel[1]);
      if (found && hiddenOverwriteReads.has(found.id)) {
        const { permission_overwrites: _absent, ...rest } = found;
        return send(200, rest);
      }
      return send(200, found ?? {});
    }
    return send(404, { path });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    state,
    references,
    featureOrders,
    writes,
    writeOrder,
    rollbackOrder,
    failOnboardingRead(status: number) { onboardingStatus = status; },
    serveOnboardingRaw(contentType: string, payload: string | null, status = 200) { onboardingRaw = { contentType, payload, status }; },
    failNextWrite(status: number) { nextFailure = status; },
    partialNextWrite() { partialNextWrite = true; },
    partialWriteOn(objectId: string) { partialNextWrite = true; partialWriteTarget = objectId; },
    spawnAfterWrites(writeCount: number, channel: Channel) { pendingSpawn = { after: writeCount, channel }; },
    despawn(channelId: string) { state.channels = state.channels.filter((item) => item.id !== channelId); },
    despawnAfterWrites(writeCount: number, channelId: string) { pendingDespawn = { after: writeCount, channelId }; },
    postMessage(channelId: string) { landMessage(channelId); },
    postMessageAfterWrites(writeCount: number, channelId: string) { pendingMessage = { after: writeCount, channelId }; },
    pinMessage(channelId: string) {
      const target = state.channels.find((item) => item.id === channelId);
      assert.ok(target, `stub: no channel ${channelId} to pin in`);
      lastMessageId += 1n;
      (target as unknown as JsonObject).last_pin_timestamp = new Date(Number(lastMessageId % 1000000000n)).toISOString();
    },
    desyncChild(childId: string, overwrites: Channel['permission_overwrites']) {
      state.channels.find((item) => item.id === childId)!.permission_overwrites = structuredClone(overwrites);
    },
    hideOverwritesOnObjectRead(objectId: string) { hiddenOverwriteReads.add(objectId); },
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

test('production-shaped drift fixture pins 65 stable operations and dry-run writes nothing', async () => {
  const stub = await stubDiscord();
  try {
    const runtimeMismatches = stub.state.channels.filter((channel) => LEGACY_CHANNEL_IDS.includes(channel.id as never)).filter((channel) => {
      const parent = stub.state.channels.find((item) => item.id === channel.parent_id)!;
      return stable(normalizeOverwrites(channel.permission_overwrites)) !== stable(normalizeOverwrites(parent.permission_overwrites));
    });
    assert.equal(runtimeMismatches.length, DRIFT_STILL_LEGACY.length);
    assert.deepEqual(runtimeMismatches.map((channel) => channel.id).sort(), DRIFT_STILL_LEGACY.map((mismatch) => mismatch.channelId).sort());
    const firstDir = mkdtempSync(join(tmpdir(), 'two-live-clean-plan-'));
    const first = await plan(stub, firstDir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(stub.writes.length, 0);
    const firstManifest = JSON.parse(readFileSync(planManifestPath(firstDir), 'utf8')) as CleanupManifest;
    assert.equal(firstManifest.operationCount, EXPECTED_OPERATIONS.operationCount);
    assert.equal(firstManifest.reviewedLegacyChannelIds.length, 106);
    assert.equal(firstManifest.reviewedLegacyCategoryIds.length, 18);
    assert.equal(firstManifest.operationSemanticHash, operationSemanticHash(firstManifest.operations));
    assert.equal(firstManifest.operationSemanticHash, EXPECTED_OPERATIONS.operationSemanticHash);
    assert.equal(new Set(firstManifest.operations.map((operation) => operation.id)).size, EXPECTED_OPERATIONS.operationCount);
    assert.equal(firstManifest.operations.filter((operation) => operation.objectType === 'category').length, 18);
    const channelOperations = firstManifest.operations.filter((operation) => operation.objectType === 'channel');
    assert.equal(channelOperations.length, 47);
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

/**
 * The live failure this pins (TOG-2806, 2026-09-16): `--apply` refused 15 consecutive
 * times with `Live state drifted`, because `guild.features` comes back in a fresh
 * order per request and the snapshot hash therefore never repeated. Two reads three
 * minutes apart were set-equal and hash-different. Nothing about the guild changed.
 */
test('a reordered guild.features is not live drift, through plan, apply and rollback', async () => {
  const stub = await stubDiscord();
  try {
    const firstDir = mkdtempSync(join(tmpdir(), 'two-live-clean-features-a-'));
    const first = await plan(stub, firstDir);
    assert.equal(first.code, 0, first.stderr);
    const secondDir = mkdtempSync(join(tmpdir(), 'two-live-clean-features-b-'));
    const second = await plan(stub, secondDir);
    assert.equal(second.code, 0, second.stderr);
    // The guild is untouched between these two reads, so the semantic hash — which
    // excludes generatedAt — has to be identical, whatever order the features arrived in.
    const firstSnapshot = JSON.parse(readFileSync(join(firstDir, 'snapshot', 'pre.json'), 'utf8')) as LiveCleanupSnapshot;
    const secondSnapshot = JSON.parse(readFileSync(join(secondDir, 'snapshot', 'pre.json'), 'utf8')) as LiveCleanupSnapshot;
    assert.ok(stub.featureOrders.length >= 2, 'the stub must have served the guild more than once');
    assert.ok(new Set(stub.featureOrders).size > 1, 'the stub must have served more than one feature ordering');
    assert.equal(secondSnapshot.semanticHash, firstSnapshot.semanticHash);
    // And the drift gate that consumes that hash has to agree, which is the part the
    // operator could not get past: apply re-reads the guild before its first write.
    const applied = await apply(stub, firstDir);
    assert.equal(applied.code, 0, applied.stderr);
    assert.doesNotMatch(applied.stderr, /Live state drifted/);
    // Rollback re-reads it again and compares the non-channel half against the
    // pre-snapshot, so a second canonicalization site would surface right here.
    const restored = await rollback(stub, firstDir);
    assert.equal(restored.code, 0, restored.stderr);
    assert.doesNotMatch(restored.stderr, /non-channel drift/);
  } finally { await stub.close(); }
});

/**
 * Discord answers 400 code 350003 `Onboarding channels must be readable by everyone`
 * for any channel the Server Guide or the community guild references point at, and a
 * bot cannot clear the reference (403 code 20001 on `PUT /guilds/{id}/onboarding`).
 * Measured live on TOG-2806: apply stopped on operation 31 and five reviewed legacy
 * channels stayed visible. The plan has to say so up front instead of dying into it.
 */
test('a Server Guide reference drops its channel from the plan and is reported, not hidden', async () => {
  const stub = await stubDiscord();
  try {
    const pinned = PERMISSION_DRIFT.mismatches[0]!.channelId;
    const promptId = ID(90);
    stub.references.onboarding = {
      enabled: true,
      default_channel_ids: [],
      prompts: [{ id: promptId, options: [{ id: ID(91), channel_ids: [pinned] }] }],
    };
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-onboarding-'));
    const result = await plan(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stub.writes.length, 0);
    const manifest = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(manifest.operationCount, EXPECTED_OPERATIONS.operationCount - 1);
    assert.equal(manifest.operations.filter((operation) => operation.objectId === pinned).length, 0);
    assert.deepEqual(manifest.onboardingExclusions, [{ channelId: pinned, referencedBy: [`onboarding.prompt:${promptId}`] }]);
    assert.match(result.stdout, new RegExp(`STAYS-VISIBLE ${pinned}`));
    assert.match(result.stdout, new RegExp(`will hide: ${LEGACY_CHANNEL_IDS.length - 1} of ${LEGACY_CHANNEL_IDS.length}`));
    // A manifest that under-reports its exclusions claims to hide all 106 while
    // planning one operation fewer, which is exactly the shape the operator would sign
    // off on by mistake. The exclusion list is outside the plan signature — like the
    // exemption set — so apply has to check it against the live guild itself.
    writeFileSync(planManifestPath(dir), `${JSON.stringify({ ...manifest, onboardingExclusions: [] }, null, 2)}\n`);
    chmodSync(planManifestPath(dir), 0o600);
    const applied = await apply(stub, dir);
    assert.equal(applied.code, 1);
    assert.equal(stub.writes.length, 0);
    assert.match(applied.stderr, /Manifest onboarding exclusions do not match/);
  } finally { await stub.close(); }
});

test('guild references exclude too, and a Server Guide that is off pins nothing', async () => {
  const stub = await stubDiscord();
  try {
    const pinned = PERMISSION_DRIFT.mismatches[1]!.channelId;
    stub.state.guild.rules_channel_id = pinned;
    const referencedDir = mkdtempSync(join(tmpdir(), 'two-live-clean-rules-ref-'));
    const referenced = await plan(stub, referencedDir);
    assert.equal(referenced.code, 0, referenced.stderr);
    const referencedManifest = JSON.parse(readFileSync(planManifestPath(referencedDir), 'utf8')) as CleanupManifest;
    assert.deepEqual(referencedManifest.onboardingExclusions, [{ channelId: pinned, referencedBy: ['guild.rules_channel_id'] }]);
    assert.equal(referencedManifest.operationCount, EXPECTED_OPERATIONS.operationCount - 1);
    // A Server Guide that is switched off pins nothing, so excluding its channels
    // would leave them visible for no reason. Without this the `enabled` gate is free
    // to be vacuous.
    // `null`, not `delete`: Discord sends the key on every guild read and answers `null`
    // when the guild pins nothing. Absence means the read did not answer, which the
    // planner now refuses — see the guild-reference readability test below.
    stub.state.guild.rules_channel_id = null;
    stub.references.onboarding = {
      enabled: false,
      default_channel_ids: [pinned],
      prompts: [{ id: ID(92), options: [{ id: ID(93), channel_ids: [PERMISSION_DRIFT.mismatches[0]!.channelId] }] }],
    };
    const offDir = mkdtempSync(join(tmpdir(), 'two-live-clean-guide-off-'));
    const off = await plan(stub, offDir);
    assert.equal(off.code, 0, off.stderr);
    const offManifest = JSON.parse(readFileSync(planManifestPath(offDir), 'utf8')) as CleanupManifest;
    assert.deepEqual(offManifest.onboardingExclusions, []);
    assert.equal(offManifest.operationCount, EXPECTED_OPERATIONS.operationCount);
  } finally { await stub.close(); }
});

test('a pinned channel synchronized with its legacy category refuses the whole plan', async () => {
  const stub = await stubDiscord();
  try {
    const drifted = new Set(PERMISSION_DRIFT.mismatches.map((mismatch) => mismatch.channelId));
    const synchronized = LEGACY_CHANNEL_IDS.find((id) => !drifted.has(id))!;
    const parentId = stub.state.channels.find((channel) => channel.id === synchronized)!.parent_id!;
    stub.references.onboarding = {
      enabled: true,
      default_channel_ids: [synchronized],
      prompts: [],
    };
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-guide-synced-'));
    const result = await plan(stub, dir);
    // Skipping the channel PATCH would not save it: the category deny reaches it by
    // inheritance, through a write Discord never gets the chance to refuse. There is
    // no honest partial plan, so refuse and name the reference to move.
    assert.notEqual(result.code, 0);
    assert.equal(stub.writes.length, 0);
    assert.match(result.stderr, new RegExp(`Reviewed legacy channel ${synchronized} is pinned publicly readable`));
    assert.match(result.stderr, new RegExp(`permission-synchronized with category ${parentId}`));
    // The refusal still has to leave the stop evidence behind.
    assert.ok(existsSync(join(dir, 'snapshot', 'pre.json')));
  } finally { await stub.close(); }
});

/**
 * The Server Guide read is best-effort in `captureSnapshot` — a transient failure must not
 * cost the pre-snapshot. But this PR promoted it from evidence to a planning input, and an
 * error body has no `enabled`/`default_channel_ids`/`prompts`, so a 403/429/500 is
 * indistinguishable from a Server Guide that pins nothing. Nothing downstream catches it:
 * `assertManifest` compares dry-run against apply and both read the same failing endpoint,
 * and the independent audit derives its exclusions from the same field. Left unguarded the
 * synchronized case is silent — no exclusion, so no refusal, no channel PATCH for Discord
 * to answer 350003 to, and the category deny hides the pinned channel by inheritance while
 * the run reports `will hide: 106 of 106` and exits 0.
 */
test('an unreadable Server Guide refuses the plan instead of pinning nothing', async () => {
  for (const status of [403, 429, 500]) {
    const stub = await stubDiscord();
    try {
      const drifted = new Set(PERMISSION_DRIFT.mismatches.map((mismatch) => mismatch.channelId));
      const synchronized = LEGACY_CHANNEL_IDS.find((id) => !drifted.has(id))!;
      // Read at 200 this pins a synchronized legacy channel, which refuses loudly. The
      // failing read must not turn that refusal into a clean 65-operation plan.
      stub.references.onboarding = { enabled: true, default_channel_ids: [synchronized], prompts: [] };
      stub.failOnboardingRead(status);
      const dir = mkdtempSync(join(tmpdir(), `two-live-clean-guide-${status}-`));
      const result = await plan(stub, dir);
      assert.notEqual(result.code, 0);
      assert.equal(stub.writes.length, 0);
      assert.match(result.stderr, new RegExp(`Server Guide .* answered HTTP ${status}`));
      assert.ok(!existsSync(planManifestPath(dir)), `HTTP ${status} produced a plan manifest`);
      // Refusing still has to leave the stop evidence behind.
      assert.ok(existsSync(join(dir, 'snapshot', 'pre.json')));
    } finally { await stub.close(); }
  }
});

/**
 * Round 8 (TOG-3060): gating the status alone is the same defect one field to the left.
 * `api()` records `body: await response.json().catch(() => null)`, so a 200 that is not a
 * Server Guide payload arrives as `status: 200` with nothing the derivation can read — and
 * reads exactly like a guild that pins nothing. Reproduced 5/5 before the readability gate:
 * every body below planned clean, exit 0, `onboardingExclusions: []`, a full-count plan and
 * `will hide: <all> of <all>`. The error-object case needs no parse failure at all.
 *
 * Driven with a *synchronized* pinned channel, because that is the silent half: a real 200
 * refuses the whole plan, so anything that still exits 0 has lost the answer.
 */
test('a 200 that is not a Server Guide payload refuses the plan', async () => {
  const bodies: Array<{ label: string; contentType: string; payload: string | null }> = [
    { label: 'html interstitial', contentType: 'text/html', payload: '<!doctype html><title>error</title>' },
    { label: 'empty body', contentType: 'application/json', payload: null },
    { label: 'json null', contentType: 'application/json', payload: 'null' },
    { label: 'json array', contentType: 'application/json', payload: '[]' },
    { label: 'rate limit object', contentType: 'application/json', payload: JSON.stringify({ message: 'You are being rate limited.', code: 0, retry_after: 1.5 }) },
    { label: 'server guide missing default_channel_ids', contentType: 'application/json', payload: JSON.stringify({ guild_id: LIVE_GUILD_ID, enabled: true, prompts: [] }) },
    { label: 'server guide missing prompts', contentType: 'application/json', payload: JSON.stringify({ guild_id: LIVE_GUILD_ID, enabled: true, default_channel_ids: [] }) },
  ];
  for (const { label, contentType, payload } of bodies) {
    const stub = await stubDiscord();
    try {
      const drifted = new Set(PERMISSION_DRIFT.mismatches.map((mismatch) => mismatch.channelId));
      const synchronized = LEGACY_CHANNEL_IDS.find((id) => !drifted.has(id))!;
      stub.references.onboarding = { enabled: true, default_channel_ids: [synchronized], prompts: [] };
      stub.serveOnboardingRaw(contentType, payload);
      const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-guide-unreadable-'));
      const result = await plan(stub, dir);
      assert.notEqual(result.code, 0, `${label} produced a plan`);
      assert.equal(stub.writes.length, 0, label);
      assert.match(result.stderr, /is not a Server Guide payload/, label);
      assert.ok(!existsSync(planManifestPath(dir)), `${label} produced a plan manifest`);
      // Refusing still has to leave the stop evidence behind.
      assert.ok(existsSync(join(dir, 'snapshot', 'pre.json')), label);
    } finally { await stub.close(); }
  }
});

/**
 * The status half of the Server Guide gate, pinned on its own.
 *
 * Readability subsumes the status check for every body Discord actually sends with an
 * error, so deleting `onboardingStatus !== 200 ||` left the suite green — genuine
 * defence in depth, but unpinned, which means a refactor can delete it and stay green.
 * This is the case that needs it: a non-200 carrying a well-formed Server Guide payload,
 * the shape a caching proxy or an edge that replays a stale body produces. A 429 is not
 * an authoritative answer about what the guild pins right now no matter how well-formed
 * its body is, so readability alone must not be enough to clear it.
 */
test('a non-200 carrying a well-formed Server Guide payload still refuses the plan', async () => {
  const stub = await stubDiscord();
  try {
    const drifted = new Set(PERMISSION_DRIFT.mismatches.map((mismatch) => mismatch.channelId));
    const synchronized = LEGACY_CHANNEL_IDS.find((id) => !drifted.has(id))!;
    // Read at 200 this pins a synchronized legacy channel, which refuses loudly; the
    // point is that the refusal must come from the status, not from that.
    stub.serveOnboardingRaw('application/json', JSON.stringify({
      guild_id: LIVE_GUILD_ID,
      enabled: true,
      default_channel_ids: [synchronized],
      prompts: [],
    }), 429);
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-guide-stale-'));
    const result = await plan(stub, dir);
    assert.notEqual(result.code, 0);
    assert.equal(stub.writes.length, 0);
    assert.match(result.stderr, /Server Guide .* answered HTTP 429/);
    assert.ok(!existsSync(planManifestPath(dir)));
    assert.ok(existsSync(join(dir, 'snapshot', 'pre.json')));
  } finally { await stub.close(); }
});

/**
 * The same defect class as the two tests above, on the source that actually pins channels
 * on this guild: all five TOG-2907 pre-snapshots have `onboarding.enabled === false`, so
 * the Server Guide contributes 0 exclusions and both real ones come from `guildReferences`.
 *
 * `guild` is a `mustGet`, so no transport failure reaches the derivation — what does is
 * field-level absence inside a 200, which a status code does not rule out. Before the
 * gate, on the live 2026-09-16T12:20:52Z pre-snapshot: 67 operations excluding
 * 1132448261253369939 and 1138590808715571300, against 69 with both PATCHed — and those
 * two PATCHes are the 400/350003 that stopped the TOG-2806 apply on operation 31. (Those
 * counts are the measurement as taken, before the owner's reuse rule reclassified six
 * channels — 1138590808715571300 among them — and moved the plan to 65 operations.)
 *
 * Driven, like the Server Guide cases, off a channel *synchronized* with its category:
 * that is the silent half, where losing the exclusion loses a refusal rather than
 * producing a PATCH Discord would have rejected.
 */
test('an unreadable guild reference block refuses the plan', async () => {
  const variants: Array<{ label: string; wreck: (guild: JsonObject) => void }> = [
    { label: 'all three keys absent', wreck: (guild) => { delete guild.rules_channel_id; delete guild.public_updates_channel_id; delete guild.safety_alerts_channel_id; } },
    { label: 'one key absent', wreck: (guild) => { delete guild.public_updates_channel_id; } },
    { label: 'key present but not a channel id', wreck: (guild) => { guild.safety_alerts_channel_id = { id: '1' }; } },
  ];
  for (const { label, wreck } of variants) {
    const stub = await stubDiscord();
    try {
      const drifted = new Set(PERMISSION_DRIFT.mismatches.map((mismatch) => mismatch.channelId));
      const synchronized = LEGACY_CHANNEL_IDS.find((id) => !drifted.has(id))!;
      stub.state.guild.rules_channel_id = synchronized;
      wreck(stub.state.guild);
      const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-guild-refs-'));
      const result = await plan(stub, dir);
      assert.notEqual(result.code, 0, `${label} produced a plan`);
      assert.equal(stub.writes.length, 0, label);
      assert.match(result.stderr, /Guild references \(GET \/guilds\/\{id\}\) carried no/, label);
      assert.ok(!existsSync(planManifestPath(dir)), `${label} produced a plan manifest`);
      // Refusing still has to leave the stop evidence behind.
      assert.ok(existsSync(join(dir, 'snapshot', 'pre.json')), label);
    } finally { await stub.close(); }
  }
});

/**
 * The guild-reference defect class again, on the field that carries this phase's entire
 * rollback guarantee. `permission_overwrites ?? []` read a channel object that arrived
 * inside a 200 without the key as a channel with no overwrites — and that invented empty
 * list is what gets signed as the operation's `expectedBefore` *and* its `inverseWrite`,
 * so rollback would have deleted the overwrites it promises to restore rather than merely
 * failing to restore them.
 *
 * Measured on the live 2026-09-16T12:20:52Z pre-snapshot before the gate: dropping the key
 * from channel 1047562772407398500 left all 67 operations in place and shipped a *signed*
 * `inverseWrite` of 0 overwrites against its 2 real ones. Nothing downstream could catch
 * it — apply re-reads the same collapsed field and agrees with the plan.
 *
 * Driven off both halves, because they fail differently: a drifted channel is its own
 * operation, and its category decides the synchronized set that picks which children are
 * written at all.
 */
test('a channel that omits permission_overwrites inside a 200 refuses the plan', async () => {
  const drifted = PERMISSION_DRIFT.mismatches[0]!;
  const variants: Array<{ label: string; wreck: (state: State) => void; expect: RegExp }> = [
    {
      label: 'absent on a drifted legacy channel',
      wreck: (state) => { delete (state.channels.find((channel) => channel.id === drifted.channelId) as Partial<Channel>).permission_overwrites; },
      expect: new RegExp(`Reviewed object ${drifted.channelId} carried no \`permission_overwrites\` key at all`),
    },
    {
      label: 'absent on the parent legacy category',
      wreck: (state) => { delete (state.channels.find((channel) => channel.id === drifted.parentId) as Partial<Channel>).permission_overwrites; },
      expect: new RegExp(`Reviewed object ${drifted.parentId} carried no \`permission_overwrites\` key at all`),
    },
    {
      label: 'present but null',
      wreck: (state) => { (state.channels.find((channel) => channel.id === drifted.channelId) as JsonObject).permission_overwrites = null; },
      expect: /carried a `permission_overwrites` that is not an array \(null\)/,
    },
    {
      label: 'an entry with no allow/deny',
      wreck: (state) => { state.channels.find((channel) => channel.id === drifted.channelId)!.permission_overwrites = [{ id: LIVE_GUILD_ID, type: 0 } as unknown as Overwrite]; },
      expect: /carried a `permission_overwrites\[0\]` with no readable `allow`, `deny`/,
    },
  ];
  for (const { label, wreck, expect } of variants) {
    const stub = await stubDiscord();
    try {
      wreck(stub.state);
      const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-absent-overwrites-'));
      const result = await plan(stub, dir);
      assert.notEqual(result.code, 0, `${label} produced a plan`);
      assert.equal(stub.writes.length, 0, label);
      assert.match(result.stderr, expect, label);
      assert.ok(!existsSync(planManifestPath(dir)), `${label} produced a plan manifest`);
      // The unanswered read is the evidence; refusing must not destroy it.
      assert.ok(existsSync(join(dir, 'snapshot', 'pre.json')), label);
    } finally { await stub.close(); }
  }
});

/**
 * `assertReviewedShape` covers the channel objects a snapshot read produced, but
 * `expectedBefore`, `write` and `inverseWrite` arrive from a *manifest file on disk* and
 * reach `inFlightDriftIsOurs` and the rollback script through `normalizeOverwrites` alone.
 * That makes the throw inside `normalizeOverwrites` the only gate on those, not a duplicate
 * of the snapshot one — and it is also what stops `String(overwrite.allow)` turning an
 * absent `allow` into the literal string `"undefined"`, which used to compare equal to
 * itself at plan time and then fail as a 400 on operation N, live, mid-phase.
 *
 * Called directly because no snapshot read can reach it: the snapshot gate refuses first.
 */
test('normalizeOverwrites refuses an unanswered list rather than returning an empty one', async () => {
  const cases: Array<{ label: string; value: unknown; expect: RegExp }> = [
    { label: 'absent', value: undefined, expect: /carried no `permission_overwrites` key at all/ },
    { label: 'null', value: null, expect: /carried a `permission_overwrites` that is not an array \(null\)/ },
    { label: 'an entry with no allow', value: [{ id: LIVE_GUILD_ID, type: 0, deny: '1024' }], expect: /`permission_overwrites\[0\]` with no readable `allow`/ },
    { label: 'an entry with a numeric allow', value: [{ id: LIVE_GUILD_ID, type: 0, allow: 0, deny: '1024' }], expect: /`permission_overwrites\[0\]` with no readable `allow`/ },
    { label: 'an entry that is not an object', value: ['1024'], expect: /`permission_overwrites\[0\]` that is not an object/ },
  ];
  for (const { label, value, expect } of cases) {
    assert.throws(() => normalizeOverwrites(value as Overwrite[], 'Manifest operation body'), expect, label);
    assert.throws(() => normalizeOverwrites(value as Overwrite[], 'Manifest operation body'), /Refusing rather than read an unanswered permission overwrite list as an empty one/, label);
  }
  // A readable list still normalizes: the gate is not a blanket refusal.
  assert.deepEqual(
    normalizeOverwrites([{ id: 'b', type: 0, allow: '0', deny: '1024' }, { id: 'a', type: 0, allow: '0', deny: '1024' }] as Overwrite[]),
    [{ id: 'a', type: 0, allow: '0', deny: '1024' }, { id: 'b', type: 0, allow: '0', deny: '1024' }],
  );
});

/**
 * `assertHierarchy` is the check that proves Owen outranks every managed role before this
 * phase writes anything, and it failed open on exactly the absence above: `role.position ??
 * -1` read an unanswered rank as the bottom of the list, and a falsy `managed` dropped the
 * role out of the target set entirely. Both absences passed a snapshot the control refuses.
 *
 * The control runs first and has to trip, or the two absence variants below prove nothing:
 * they are the *same role*, lifted to the same position that the control refuses.
 */
test('a role that omits position or managed refuses the plan instead of failing the hierarchy check open', async () => {
  const control = await stubDiscord();
  let liftedRoleId = '';
  let liftedPosition = 0;
  try {
    const owen = control.state.members.find((member) => member.user.id === LIVE_BOT_APPLICATION_ID)!;
    const highestOwen = Math.max(...control.state.roles.filter((role) => owen.roles.includes(role.id)).map((role) => role.position));
    const target = control.state.roles.find((role) => role.managed && role.id !== LIVE_GUILD_ID && !owen.roles.includes(role.id))!;
    liftedRoleId = target.id;
    liftedPosition = highestOwen + 5;
    target.position = liftedPosition;
    const result = await plan(control, mkdtempSync(join(tmpdir(), 'two-live-clean-hierarchy-control-')));
    assert.notEqual(result.code, 0, 'control: a managed role above Owen produced a plan');
    assert.match(result.stderr, /Owen is not above every managed target role/);
    assert.equal(control.writes.length, 0);
  } finally { await control.close(); }

  const variants: Array<{ label: string; wreck: (role: Role) => void; expect: RegExp }> = [
    { label: 'position absent', wreck: (role) => { delete (role as Partial<Role>).position; }, expect: /carried no readable `position`/ },
    { label: 'managed absent', wreck: (role) => { delete (role as Partial<Role>).managed; }, expect: /carried no readable `managed`/ },
    { label: 'position present but a string', wreck: (role) => { (role as JsonObject).position = String(liftedPosition); }, expect: /carried no readable `position`/ },
  ];
  for (const { label, wreck, expect } of variants) {
    const stub = await stubDiscord();
    try {
      const role = stub.state.roles.find((item) => item.id === liftedRoleId)!;
      role.position = liftedPosition;
      wreck(role);
      const result = await plan(stub, mkdtempSync(join(tmpdir(), 'two-live-clean-hierarchy-absent-')));
      assert.notEqual(result.code, 0, `${label} produced a plan`);
      assert.equal(stub.writes.length, 0, label);
      assert.match(result.stderr, new RegExp(`Role ${liftedRoleId} `), label);
      assert.match(result.stderr, expect, label);
    } finally { await stub.close(); }
  }
});

/**
 * Round 12 (TOG-3114, non-blocking finding): the same collapse class as the two tests
 * above, on `member.roles ?? []`. It is fail-*closed* for `assertHierarchy` — Owen with no
 * roles has no Administrator and refuses — which is why it survived two rounds. Where it
 * fails open is `archiveVisibilityExemptions`: a collapsed read drops the member's
 * Administrator-bearing roles, `archiveExemption` returns null, and the principal is left
 * off the RETAINS-VIEW list the operator signs the manifest against. Discord ignores every
 * overwrite this phase emits for an Administrator, so nothing downstream corrects it.
 *
 * The control has to trip first, or the absence variants prove nothing: the *same member*
 * is an exemption with its roles read, and must be refused — not silently dropped — with
 * them unread. The evidence assertions matter as much as the refusal: capture runs before
 * planning, so both the pre-snapshot and the holders file have to survive it, the latter
 * naming the member rather than omitting a row that reads as "holds nothing".
 */
test('a member whose role list did not answer refuses the plan instead of dropping them from the exemption set', async () => {
  const control = await stubDiscord();
  let adminMemberId = '';
  try {
    const owenId = LIVE_BOT_APPLICATION_ID;
    const ownerId = control.state.guild.owner_id as string;
    const adminRoleIds = new Set(control.state.roles.filter((role) => (BigInt(role.permissions) & BigInt(ADMIN)) !== 0n).map((role) => role.id));
    const admin = control.state.members.find((member) => member.user.id !== owenId && member.user.id !== ownerId && member.roles.some((id) => adminRoleIds.has(id)))!;
    adminMemberId = admin.user.id;
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-member-roles-control-'));
    const result = await plan(control, dir);
    assert.equal(result.code, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    assert.ok(manifest.visibilityExemptions.some((item) => item.memberId === adminMemberId && item.reason === 'administrator'), 'control: the Administrator holder must be a recorded exemption');
    assert.match(result.stdout, new RegExp(`RETAINS-VIEW administrator \\w+ ${adminMemberId}`));
  } finally { await control.close(); }

  const variants: Array<{ label: string; wreck: (member: JsonObject) => void; expect: RegExp }> = [
    { label: 'absent', wreck: (member) => { delete member.roles; }, expect: /carried no `roles` key at all/ },
    { label: 'null', wreck: (member) => { member.roles = null; }, expect: /carried a `roles` that is not an array \(null\)/ },
    { label: 'an entry that is not a role id', wreck: (member) => { member.roles = [{ id: '1' }]; }, expect: /carried a `roles\[0\]` that is not a role id string/ },
  ];
  for (const { label, wreck, expect } of variants) {
    const stub = await stubDiscord();
    try {
      wreck(stub.state.members.find((member) => member.user.id === adminMemberId)! as unknown as JsonObject);
      const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-member-roles-absent-'));
      const result = await plan(stub, dir);
      assert.notEqual(result.code, 0, `${label} produced a plan`);
      assert.equal(stub.writes.length, 0, label);
      assert.ok(!existsSync(planManifestPath(dir)), `${label} produced a plan manifest`);
      assert.match(result.stderr, new RegExp(`Member ${adminMemberId} `), label);
      assert.match(result.stderr, expect, label);
      assert.match(result.stderr, /may hold Administrator/, label);
      // Refusing still has to leave the stop evidence behind, and the holders file has to
      // name the member it could not read rather than drop their rows.
      assert.ok(existsSync(join(dir, 'snapshot', 'pre.json')), label);
      const holders = readFileSync(join(dir, 'snapshot', 'holders.csv'), 'utf8');
      assert.match(holders, new RegExp(`"${adminMemberId}",.*UNREADABLE-ROLES`), label);
    } finally { await stub.close(); }
  }
});

/**
 * Apply's own per-operation before-state check is the second opinion on the plan — a fresh
 * `GET /channels/{id}` compared against the signed `expectedBefore`. It laundered an absent
 * list exactly as the plan side did, so when the same read was unanswered at both times the
 * two agreed on `[]` and the PATCH went out under a signed, empty `inverseWrite`.
 *
 * Here the list read stays complete, so the plan is built and signed from a full answer and
 * only apply's own read is unanswered. It has to stop mid-phase, before any write, naming
 * the read rather than blaming the plan for a before-state mismatch.
 */
test("an unreadable live read refuses apply mid-phase, before that operation's PATCH", async () => {
  const stub = await stubDiscord();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-apply-absent-'));
    assert.equal((await plan(stub, dir)).code, 0);
    const manifest = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    const first = manifest.operations[0]!;
    stub.hideOverwritesOnObjectRead(first.objectId);
    const result = await apply(stub, dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`Live read of ${first.objectType} ${first.objectId} \\(GET /channels/\\{id\\}\\) carried no \`permission_overwrites\` key at all`));
    assert.equal(stub.writes.length, 0, 'apply issued a write after an unanswered live read');
  } finally { await stub.close(); }
});

/**
 * Neither of these two scripts is referenced by CI, `package.json`, or any other test, so
 * `check` cannot see them — which is how round 8 shipped a planner change that made both
 * throw on their own documented invocation while the suite and `tsc` stayed green
 * (TOG-3059, TOG-3060). This is the cheapest thing that would have caught it.
 *
 * `derive` rewrites the committed pin in place, so this also re-proves that the pin the
 * operator diffs a live dry-run against is what the current planner actually derives.
 */
test('the pin regenerator and the independent audit both still run', async () => {
  const pinPath = fileURLToPath(new URL('./fixtures/live-cleanup-expected-operations.json', import.meta.url));
  const committed = readFileSync(pinPath);
  try {
    const derive = await run(fileURLToPath(new URL('../scripts/derive-live-cleanup-pins.ts', import.meta.url)), []);
    assert.equal(derive.code, 0, derive.stderr);
    assert.match(derive.stdout, new RegExp(`operationCount: ${EXPECTED_OPERATIONS.operationCount}`));
    assert.match(derive.stdout, new RegExp(`operationSemanticHash: ${EXPECTED_OPERATIONS.operationSemanticHash}`));
    // Byte-for-byte, not just equal by count and hash: the pin is committed output.
    assert.equal(readFileSync(pinPath).toString(), committed.toString(), 'scripts/derive-live-cleanup-pins.ts no longer reproduces the committed pin');
  } finally {
    writeFileSync(pinPath, committed);
  }
  const audit = await run(fileURLToPath(new URL('../scripts/audit-live-cleanup-visibility.ts', import.meta.url)), []);
  assert.equal(audit.code, 0, audit.stderr);
  assert.match(audit.stdout, /AUDIT PASSED/);
  assert.match(audit.stdout, new RegExp(`audited: ${LEGACY_CHANNEL_IDS.length}`));
});

test('a Server Guide with no `enabled` field is read as enabled and still excludes', async () => {
  const stub = await stubDiscord();
  try {
    const pinned = PERMISSION_DRIFT.mismatches[0]!.channelId;
    // Absent `enabled` is the claim we cannot check, so it has to fail towards excluding:
    // reading it as disabled would plan a PATCH Discord answers 350003 to. Without this the
    // `enabled !== false` gate passes just as well written `enabled === true`.
    stub.references.onboarding = { default_channel_ids: [pinned], prompts: [] };
    const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-guide-noenabled-'));
    const result = await plan(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    assert.deepEqual(manifest.onboardingExclusions, [{ channelId: pinned, referencedBy: ['onboarding.default_channel_ids'] }]);
    assert.equal(manifest.operationCount, EXPECTED_OPERATIONS.operationCount - 1);
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

    // Nobody outside the recorded exemption set may see any reviewed legacy channel after the plan.
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
    assert.equal(manifest.operationCount, EXPECTED_OPERATIONS.operationCount + 1);
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

// The live guild spawned `1549949487949283359` (`Hangout #1`) under the active `🔊 VOICE`
// category at 2026-09-17T01:05:54Z, between this phase's review snapshot and its first live
// dry-run, and the unreviewed-ID refusal stopped the whole 65-operation plan. The generator
// creates and deletes these continuously, so the shape has to plan — while every neighbouring
// shape it could be confused with still refuses.
test('an auto-voice ephemeral child plans unchanged while its near neighbours still refuse', async () => {
  const liveShapeStub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-autovoice-'));
  try {
    liveShapeStub.state.channels.push({
      id: '1549949487949283359',
      name: 'Hangout #1',
      type: 2,
      parent_id: AUTO_VOICE_CATEGORY_ID,
      permission_overwrites: [{ id: LIVE_GUILD_ID, type: 0, allow: '3146752', deny: '0' }],
    });
    const result = await plan(liveShapeStub, dir);
    assert.equal(result.code, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    // Tolerating it must be inert: same count, same pinned hash as a guild without it.
    assert.equal(manifest.operationCount, EXPECTED_OPERATIONS.operationCount);
    assert.equal(manifest.operationSemanticHash, EXPECTED_OPERATIONS.operationSemanticHash);
    assert.ok(
      !manifest.operations.some((operation) => operation.objectId === '1549949487949283359'),
      'no planned operation may name an auto-voice ephemeral channel',
    );
    assert.equal(liveShapeStub.writes.length, 0);
  } finally { await liveShapeStub.close(); }

  // Each neighbour differs from the tolerated shape in exactly one field, and TOG-2907 split
  // them into two outcomes rather than one. The refusal these used to share was a gate on the
  // whole guild; it now only covers the reviewed legacy tree, so three of the four plan.
  //
  // Planning and drift are different tolerances and this table is what holds them apart. The
  // first neighbour is `voice-bot-source` verbatim — the permanent type-0 channel that refused
  // the live 65-operation plan and the read-only audit at 02:59Z, four hours after #117 bought
  // a tolerance for a different shape. It must plan, and it must land in the *wider* bucket:
  // widening `isAutoVoiceEphemeralChild` to cover it would move its line from
  // `UNREVIEWED-TOLERATED` to `TOLERATED` and quietly drop it from every drift gate. That
  // mutation passes an exit-code assertion, so the bucket is asserted instead.
  const neighbours: { label: string; id: string; name: string; type: number; parentId: string; refuses?: RegExp }[] = [
    { label: 'voice-bot-source', id: '1549978014450716773', name: 'voice-bot-source', type: 0, parentId: AUTO_VOICE_CATEGORY_ID },
    { label: 'other-active-category', id: ID(998), name: 'near neighbour other-active-category', type: 2, parentId: ACTIVE_CATEGORY_IDS[0] },
    { label: 'no-parent', id: ID(997), name: 'near neighbour no-parent', type: 2, parentId: '' },
    // The one position a new object could inherit the deny this phase is about to set, or
    // displace a reviewed child. It still fails closed, by ID.
    { label: 'legacy-category', id: ID(996), name: 'near neighbour legacy-category', type: 2, parentId: LEGACY_CATEGORY_IDS[0], refuses: /unexpected child IDs/ },
  ];
  for (const neighbour of neighbours) {
    const stub = await stubDiscord();
    const dir = mkdtempSync(join(tmpdir(), `two-live-clean-autovoice-${neighbour.label}-`));
    try {
      stub.state.channels.push({
        id: neighbour.id,
        name: neighbour.name,
        type: neighbour.type,
        parent_id: neighbour.parentId === '' ? null : neighbour.parentId,
        permission_overwrites: [],
      });
      const result = await plan(stub, dir);
      if (neighbour.refuses) {
        assert.equal(result.code, 1, `${neighbour.label} must refuse: ${result.stderr}`);
        assert.match(result.stderr, neighbour.refuses, neighbour.label);
        assert.equal(stub.writes.length, 0, neighbour.label);
        continue;
      }
      assert.equal(result.code, 0, `${neighbour.label} must plan: ${result.stderr}`);
      assert.ok(
        result.stdout.includes(`UNREVIEWED-TOLERATED ${neighbour.id} ${neighbour.name} — unreviewed type-${neighbour.type} object outside the reviewed legacy tree (parent ${neighbour.parentId === '' ? 'none' : neighbour.parentId})`),
        `${neighbour.label} must be named in the log as a planning tolerance, not tolerated silently: ${result.stdout}`,
      );
      assert.doesNotMatch(
        result.stdout, new RegExp(`${neighbour.id} .* — auto-voice ephemeral child`),
        `${neighbour.label} must not reach the narrower drift tolerance, which would drop it from every drift gate`,
      );
      assert.match(result.stdout, /Unreviewed objects tolerated in this snapshot: 1/, neighbour.label);
      // Tolerating must be inert on the plan itself, exactly as the ephemeral shape is.
      const manifest = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
      assert.equal(manifest.operationCount, EXPECTED_OPERATIONS.operationCount, neighbour.label);
      assert.equal(manifest.operationSemanticHash, EXPECTED_OPERATIONS.operationSemanticHash, neighbour.label);
      assert.ok(!manifest.operations.some((operation) => operation.objectId === neighbour.id), `no operation may name ${neighbour.label}`);
      assert.equal(stub.writes.length, 0, neighbour.label);
    } finally { await stub.close(); }
  }
});

// The tolerance above buys plan reachability and buys nothing after it. A tolerated object is
// still compared byte for byte by the apply-time drift gate, so the phase's guarantee — that
// it refuses if the guild moved under it — is unchanged for everything except the generator's
// churn. Without this test, widening `isDriftExcluded` to match the planning tolerance is a
// one-line change that no other assertion in this file notices.
test('a planning tolerance is not a drift tolerance', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-tolerance-not-drift-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    // Created after the plan was signed: the shape planning would have tolerated, arriving at
    // the one moment tolerating it is not safe.
    stub.state.channels.push({
      id: '1549978014450716773', name: 'voice-bot-source', type: 0,
      parent_id: AUTO_VOICE_CATEGORY_ID, permission_overwrites: [],
    });
    const applied = await apply(stub, dir);
    assert.equal(applied.code, 1, 'an unreviewed object appearing between plan and apply must still refuse');
    assert.match(applied.stderr, /Live state drifted/);
    assert.doesNotMatch(applied.stdout, /1549978014450716773/, 'and it must not be reported as tolerated on the apply path');
    assert.equal(stub.writes.length, 0);
  } finally { await stub.close(); }
});

// TOG-3139 finding 1. Tolerating the generator's children at the unreviewed-ID refusal is
// what makes the plan reachable; extending that tolerance to the unreadable-overwrite walk
// is what broke the phase. Measured on the version that skipped the walk: plan exit 0,
// apply exit 0 with 65 writes landed, then rollback died on an *uncaught* exception out of
// `normalizeOverwrites` — the run ended applied with its rollback path gone, reported as a
// Node stack trace. The refusal below is the whole fix, so it is asserted directly.
test('an auto-voice ephemeral child whose overwrite read did not answer is refused, not tolerated', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-autovoice-unreadable-'));
  try {
    const child: Record<string, unknown> = { id: '1549949487949283359', name: 'Hangout #1', type: 2, parent_id: AUTO_VOICE_CATEGORY_ID };
    stub.state.channels.push(child as unknown as Channel); // no `permission_overwrites` key at all
    const result = await plan(stub, dir);
    assert.equal(result.code, 1, 'an unreadable overwrite list must refuse even on a tolerated identity');
    assert.match(result.stderr, /1549949487949283359 carried no `permission_overwrites` key at all/);
    assert.match(result.stderr, /permission overwrites are unknown/);
    assert.equal(stub.writes.length, 0);
    // Refusing must still preserve the stop evidence rather than collapse the run.
    assert.ok(existsSync(join(dir, 'snapshot', 'pre.json')), 'the pre-snapshot must survive the refusal');
  } finally { await stub.close(); }

  // The refusal is about readability, not identity: the same channel with a readable list
  // still plans. Without this half, deleting the tolerance entirely would also pass above.
  const readableStub = await stubDiscord();
  const readableDir = mkdtempSync(join(tmpdir(), 'two-live-clean-autovoice-readable-'));
  try {
    readableStub.state.channels.push({
      id: '1549949487949283359', name: 'Hangout #1', type: 2, parent_id: AUTO_VOICE_CATEGORY_ID,
      permission_overwrites: [{ id: LIVE_GUILD_ID, type: 0, allow: '3146752', deny: '0' }],
    });
    const result = await plan(readableStub, readableDir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readableStub.writes.length, 0);
  } finally { await readableStub.close(); }
});

// `isAutoVoiceEphemeralChild` excludes `ACTIVE_CHANNEL_IDS` members, and that clause is the
// only thing standing between the tolerance and two reviewed active-tree objects: `Lobby`
// and the `➕ Join to Create` generator are themselves type-2 channels sitting directly under
// the auto-voice category. Every other route to the predicate is shadowed by an earlier
// assertion, so dropping the clause survives the end-to-end suite — it is provable only
// against the predicate itself, which is why this test is a unit test and not a run.
test('the auto-voice tolerance never classifies a reviewed active-tree channel as ephemeral', () => {
  const autoVoiceChildren = fixtureState().channels.filter((channel) => channel.parent_id === AUTO_VOICE_CATEGORY_ID);
  assert.ok(autoVoiceChildren.length > 0, 'the fixture must actually contain the shape this guards');
  for (const channel of autoVoiceChildren) {
    assert.equal(channel.type, 2, `${channel.id} is the type the predicate tolerates`);
    assert.ok((ACTIVE_CHANNEL_IDS as readonly string[]).includes(channel.id), `${channel.id} is a reviewed active channel`);
    assert.equal(
      isAutoVoiceEphemeralChild(channel), false,
      `${channel.id} is reviewed and permanent, so tolerating it would drop it out of the reviewed-shape assertions`,
    );
  }
  // The generator's own spawn, which differs only in not being reviewed, must still be tolerated.
  assert.equal(
    isAutoVoiceEphemeralChild({ id: '1549949487949283359', type: 2, parent_id: AUTO_VOICE_CATEGORY_ID }), true,
    'an unreviewed voice child of the auto-voice category is exactly what the predicate exists to tolerate',
  );
});

/** A fresh `Hangout #N`, the exact shape the generator creates under the active voice category. */
const HANGOUT = (n: number): Channel => ({
  id: String(1549949487949283359n + BigInt(n)),
  name: `Hangout #${n}`,
  type: 2,
  parent_id: AUTO_VOICE_CATEGORY_ID,
  permission_overwrites: [{ id: LIVE_GUILD_ID, type: 0, allow: '3146752', deny: '0' }],
});

/**
 * Tolerating the shape at plan time (above) only made the dry-run reachable. Every gate that
 * compares two live reads — apply's pre-write drift check, its postflight, and both of
 * rollback's inventory/hash checks — was still hashing the whole channel list, so any spawn or
 * despawn between them refused. Measured at 728a62e6 (TOG-3141): spawn after plan and despawn
 * after plan both exit 1 before any write; a spawn *mid-apply* fails postflight with all 65
 * writes already landed and the manifest at `apply_failed`; a spawn after a clean apply blocks
 * rollback entirely; a spawn mid-rollback strands the guild 34 operations in. The generator
 * runs continuously on the live guild, so none of these are hypothetical.
 */
test('auto-voice churn at every apply and rollback gate no longer refuses or strands the phase', async () => {
  const spawnAfterPlan = await stubDiscord();
  const spawnDir = mkdtempSync(join(tmpdir(), 'two-live-clean-churn-spawn-'));
  try {
    assert.equal((await plan(spawnAfterPlan, spawnDir)).code, 0);
    spawnAfterPlan.state.channels.push(HANGOUT(1));
    const applied = await apply(spawnAfterPlan, spawnDir);
    assert.equal(applied.code, 0, applied.stderr);
    assert.doesNotMatch(applied.stderr, /Live state drifted/);
    // The tolerance is named on the way past the gate, not inferred from `pre.json`.
    assert.match(applied.stdout, new RegExp(`TOLERATED ${HANGOUT(1).id} Hangout #1`));
    assert.equal(spawnAfterPlan.writes.length, EXPECTED_OPERATIONS.operationCount);
    assert.equal((JSON.parse(readFileSync(manifestPath(spawnDir), 'utf8')) as CleanupManifest).status, 'applied');
  } finally { await spawnAfterPlan.close(); }

  const despawnAfterPlan = await stubDiscord();
  const despawnDir = mkdtempSync(join(tmpdir(), 'two-live-clean-churn-despawn-'));
  try {
    despawnAfterPlan.state.channels.push(HANGOUT(1));
    assert.equal((await plan(despawnAfterPlan, despawnDir)).code, 0);
    despawnAfterPlan.despawn(HANGOUT(1).id);
    const applied = await apply(despawnAfterPlan, despawnDir);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(despawnAfterPlan.writes.length, EXPECTED_OPERATIONS.operationCount);
  } finally { await despawnAfterPlan.close(); }

  // The one that used to fail *after* every write had landed.
  const midApply = await stubDiscord();
  const midApplyDir = mkdtempSync(join(tmpdir(), 'two-live-clean-churn-mid-apply-'));
  try {
    assert.equal((await plan(midApply, midApplyDir)).code, 0);
    midApply.spawnAfterWrites(5, HANGOUT(2));
    const applied = await apply(midApply, midApplyDir);
    assert.equal(applied.code, 0, applied.stderr);
    assert.doesNotMatch(applied.stderr, /Postflight semantic hash mismatch/);
    assert.equal(midApply.writes.length, EXPECTED_OPERATIONS.operationCount);
    assert.equal((JSON.parse(readFileSync(manifestPath(midApplyDir), 'utf8')) as CleanupManifest).status, 'applied');
    // Postflight comparing a filtered hash must not weaken what `post.json` records:
    // the stored snapshot still carries the true whole-guild hash the artifact is read on.
    const post = JSON.parse(readFileSync(join(midApplyDir, 'phase-01', 'post.json'), 'utf8')) as LiveCleanupSnapshot;
    const { semanticHash: _stored, ...postInput } = post;
    assert.equal(post.semanticHash, withSemanticHash(postInput).semanticHash);
    assert.ok(post.channels.some((channel) => channel.id === HANGOUT(2).id), 'the stored post-snapshot keeps the tolerated channel');
  } finally { await midApply.close(); }

  // Recovery is the half that mattered most: a spawn between apply and rollback used to
  // block the rollback of an already-applied phase, and one mid-rollback stranded it.
  //
  // Both directions matter and they are not the same path through the inventory gate. A spawn
  // adds an id to the live side; a despawn removes one that the *pre-snapshot* side still
  // carries, which is the case the round-14 review reproduced (child present at plan and at
  // apply, gone by rollback). Filtering only the live side would pass every spawn case here
  // and still refuse every despawn. `gone` is the id rollback must find missing and not try
  // to recreate — it is ephemeral, so its absence is not damage to repair.
  const recoveries = [
    { landing: 'spawn-between', gone: null },
    { landing: 'spawn-mid-rollback', gone: null },
    { landing: 'despawn-between', gone: HANGOUT(5).id },
    { landing: 'despawn-mid-rollback', gone: HANGOUT(6).id },
  ] as const;
  for (const { landing, gone } of recoveries) {
    const stub = await stubDiscord();
    const dir = mkdtempSync(join(tmpdir(), `two-live-clean-churn-${landing}-`));
    try {
      // A despawn case needs the child alive across plan *and* apply, so that the id it
      // later loses is one both stored snapshots recorded.
      if (gone) stub.state.channels.push(landing === 'despawn-between' ? HANGOUT(5) : HANGOUT(6));
      assert.equal((await plan(stub, dir)).code, 0);
      assert.equal((await apply(stub, dir)).code, 0);
      const applyWrites = stub.writes.length;
      if (landing === 'spawn-between') stub.state.channels.push(HANGOUT(3));
      else if (landing === 'spawn-mid-rollback') stub.spawnAfterWrites(applyWrites + 5, HANGOUT(4));
      else if (landing === 'despawn-between') stub.despawn(gone!);
      else stub.despawnAfterWrites(applyWrites + 5, gone!);
      const restored = await rollback(stub, dir);
      assert.equal(restored.code, 0, `${landing}: ${restored.stderr}`);
      assert.doesNotMatch(restored.stderr, /inventory drifted|inventory differs|semantic hash mismatch/);
      assert.equal((JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest).status, 'rolled_back');
      const pre = JSON.parse(readFileSync(join(dir, 'snapshot', 'pre.json'), 'utf8')) as LiveCleanupSnapshot;
      assert.ok(gone === null || pre.channels.some((channel) => channel.id === gone), `${landing}: pre.json must carry the id that later vanished`);
      for (const channel of pre.channels) {
        const live = stub.state.channels.find((item) => item.id === channel.id);
        if (channel.id === gone) {
          assert.equal(live, undefined, `${landing}: rollback recreated an ephemeral child it never deleted`);
          continue;
        }
        assert.ok(live, `${landing}: ${channel.id} missing after rollback`);
        assert.equal(stable(normalizeOverwrites(live.permission_overwrites)), stable(normalizeOverwrites(channel.permission_overwrites)), `${landing}: ${channel.id}`);
      }
    } finally { await stub.close(); }
  }
});

/**
 * Excluding the churning *objects* was only half of it. The remaining half is a churning
 * *field*: `semanticSnapshot` spreads raw channel bodies, so `last_message_id` is inside every
 * hash, and it moves whenever anyone says anything.
 *
 * Measured on real captures rather than argued (TOG-3141, round 16). Across seven live
 * snapshots of the TOG guild, `last_message_id` is the only channel field that ever moved
 * without an administrator acting; two captures 2h19m apart differ on exactly three channels —
 * `audit-log`, `voice-log` and `server-log`, all written by Owen itself — and are byte-identical
 * under `driftSemanticHash` once it is dropped. All three are permanently inside
 * `REVIEWED_OBJECT_IDS`, so the auto-voice exclusion can never reach them by design.
 *
 * The price of missing this is not a refusal. Two of the four landings below are past the point
 * of no return: postflight runs with all 65 writes applied, and rollback's hash runs after every
 * reverting write, one line before `status = 'rolled_back'`. So a single log line landing at the
 * wrong moment used to mark a correct phase `apply_failed`, or leave the manifest `rolling_back`
 * over a guild that had in fact been fully restored.
 *
 * The production fixture was captured without the field at all, which is precisely why the stub
 * suite could not see any of this — the stub now has to land the message itself.
 */
/**
 * The live evidence is a channel Owen logs to — active tree, never written by this phase — but
 * the phase's own targets take messages too, so both are exercised: the exclusion is scoped to
 * two fields, not to a set of objects.
 */
const chattyChannelId = (): string => {
  const chatty = fixtureState().channels.find((channel) => channel.type === 0 && (ACTIVE_CHANNEL_IDS as readonly string[]).includes(channel.id));
  assert.ok(chatty, 'the fixture must carry an active text channel to stand in for audit-log');
  return chatty.id;
};

// Split one landing per test rather than looped inside one, because these gates are reached at
// four different prices and each one has to be shown to be the gate that was actually fixed. A
// single compound test fails at the first landing when the fix is reverted and says nothing
// about the other three.
test('a message landing between dry-run and apply is not live drift', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-message-after-plan-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    stub.postMessage(chattyChannelId());
    stub.postMessage(LEGACY_CHANNEL_IDS[0]!);
    const applied = await apply(stub, dir);
    assert.equal(applied.code, 0, applied.stderr);
    assert.doesNotMatch(applied.stderr, /Live state drifted/);
    assert.equal(stub.writes.length, EXPECTED_OPERATIONS.operationCount);
    assert.equal((JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest).status, 'applied');
  } finally { await stub.close(); }
});

// The second entry in the excluded list, so that dropping it is a mutation a test kills rather
// than an untested precaution. It is reached by a pin, not a post, and it is not measurable on
// the live guild without causing the pin.
test('a pin between dry-run and apply is not live drift either', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-pin-after-plan-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    stub.pinMessage(chattyChannelId());
    const applied = await apply(stub, dir);
    assert.equal(applied.code, 0, applied.stderr);
    assert.doesNotMatch(applied.stderr, /Live state drifted/);
    assert.equal(stub.writes.length, EXPECTED_OPERATIONS.operationCount);
  } finally { await stub.close(); }
});

test('a message landing mid-apply does not fail the postflight with all 65 writes already applied', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-message-mid-apply-'));
  const chatty = chattyChannelId();
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    stub.postMessageAfterWrites(5, chatty);
    const applied = await apply(stub, dir);
    assert.equal(applied.code, 0, applied.stderr);
    assert.doesNotMatch(applied.stderr, /Postflight semantic hash mismatch/);
    assert.equal((JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest).status, 'applied');
    // Excluded from the *comparison* only. `post.json` still records what was live and still
    // carries the true whole-guild hash the artifact is read on — a filtered stored hash would
    // be a quieter and much worse bug than the one being fixed.
    const post = JSON.parse(readFileSync(join(dir, 'phase-01', 'post.json'), 'utf8')) as LiveCleanupSnapshot;
    const { semanticHash: _stored, ...postInput } = post;
    assert.equal(post.semanticHash, withSemanticHash(postInput).semanticHash);
    const recorded = post.channels.find((channel) => channel.id === chatty) as unknown as JsonObject;
    assert.equal(typeof recorded.last_message_id, 'string', 'post.json must keep the field it stopped comparing');
  } finally { await stub.close(); }
});

// Two gates, not one: the untouched-channel walk compares whole channel bodies one at a time
// and does not run through `driftSemanticHash`, so it needed the exclusion applied separately.
// It refuses before any rollback write; the post-rollback hash refuses after all of them, one
// line before `status = 'rolled_back'`.
for (const landing of ['before-rollback', 'mid-rollback'] as const) {
  test(`a message landing ${landing} does not strand the recovery path`, async () => {
    const stub = await stubDiscord();
    const dir = mkdtempSync(join(tmpdir(), `two-live-clean-message-${landing}-`));
    try {
      assert.equal((await plan(stub, dir)).code, 0);
      assert.equal((await apply(stub, dir)).code, 0);
      if (landing === 'before-rollback') stub.postMessage(chattyChannelId());
      else stub.postMessageAfterWrites(stub.writes.length + 5, chattyChannelId());
      const restored = await rollback(stub, dir);
      assert.equal(restored.code, 0, restored.stderr);
      assert.doesNotMatch(restored.stderr, /semantic hash mismatch|inventory drifted|inventory differs|untouched channel/);
      assert.equal((JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest).status, 'rolled_back');
    } finally { await stub.close(); }
  });
}

/**
 * The companion to the test above, and the reason the excluded field list is two entries and
 * not "whatever is noisy". Every field normalized away is drift the gate stops seeing, so the
 * neighbouring channel properties a third party can actually edit must still refuse — including
 * on the very channel whose `last_message_id` moved in the same window.
 */
test('a field the exclusion does not name is still live drift, on the same channel in the same window', async () => {
  const chatty = { id: chattyChannelId() };
  for (const edit of ['topic', 'name', 'position'] as const) {
    const stub = await stubDiscord();
    const dir = mkdtempSync(join(tmpdir(), `two-live-clean-message-control-${edit}-`));
    try {
      assert.equal((await plan(stub, dir)).code, 0);
      stub.postMessage(chatty.id);
      const live = stub.state.channels.find((channel) => channel.id === chatty.id)! as unknown as JsonObject;
      live[edit] = edit === 'position' ? Number(live.position ?? 0) + 1 : `${String(live[edit] ?? '')} edited by a third party`;
      const applied = await apply(stub, dir);
      assert.equal(applied.code, 1, `${edit}: a real edit must still refuse`);
      assert.match(applied.stderr, /Live state drifted/);
      assert.equal(stub.writes.length, 0, `${edit}: refusal must land before any write`);
    } finally { await stub.close(); }
  }
});

/**
 * The exclusion is a shape test, and shape is the one thing an attacker with a channel edit
 * can choose. Anchoring it on the reviewed ID set is what keeps it from being a laundering
 * route: move a reviewed legacy channel into the auto-voice shape between plan and apply and
 * the drift gate must still see it, exactly as it did before PR #117. Deleting the
 * `REVIEWED_OBJECT_IDS` clause fails this test — the laundered channel drops out of the
 * comparison and gets reported as tolerated. (It still refuses, because the pre-snapshot side
 * of the comparison kept the channel; the clause is what stops the tolerance, and with it the
 * ID set the gate protects, from being anything a third party can widen.)
 */
test('a reviewed object wearing the auto-voice shape is still drift, and an unreviewed non-tolerated spawn still refuses', async () => {
  const launderStub = await stubDiscord();
  const launderDir = mkdtempSync(join(tmpdir(), 'two-live-clean-churn-launder-'));
  try {
    assert.equal((await plan(launderStub, launderDir)).code, 0);
    const laundered = launderStub.state.channels.find((channel) => channel.id === LEGACY_CHANNEL_IDS[0])!;
    laundered.type = 2;
    laundered.parent_id = AUTO_VOICE_CATEGORY_ID;
    const applied = await apply(launderStub, launderDir);
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, /Live state drifted/);
    assert.doesNotMatch(applied.stdout, new RegExp(`TOLERATED ${LEGACY_CHANNEL_IDS[0]}`));
    assert.equal(launderStub.writes.length, 0);
  } finally { await launderStub.close(); }

  const strangerStub = await stubDiscord();
  const strangerDir = mkdtempSync(join(tmpdir(), 'two-live-clean-churn-stranger-'));
  try {
    assert.equal((await plan(strangerStub, strangerDir)).code, 0);
    // Same category, text channel: one field off the tolerated shape, so still drift.
    strangerStub.state.channels.push({ ...HANGOUT(5), type: 0, name: 'not a hangout' });
    const applied = await apply(strangerStub, strangerDir);
    assert.equal(applied.code, 1);
    assert.match(applied.stderr, /Live state drifted/);
    assert.equal(strangerStub.writes.length, 0);
  } finally { await strangerStub.close(); }
});

test('the dry-run names every object it tolerated, before it reports writing nothing', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-tolerated-log-'));
  try {
    const bare = await plan(stub, dir);
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /Unreviewed objects tolerated in this snapshot: 0/);

    const churnStub = await stubDiscord();
    const churnDir = mkdtempSync(join(tmpdir(), 'two-live-clean-tolerated-log-churn-'));
    try {
      churnStub.state.channels.push(HANGOUT(1), HANGOUT(2));
      const result = await plan(churnStub, churnDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Unreviewed objects tolerated in this snapshot: 2/);
      for (const n of [1, 2]) {
        assert.match(result.stdout, new RegExp(`TOLERATED ${HANGOUT(n).id} Hangout #${n} — auto-voice ephemeral child of ${AUTO_VOICE_CATEGORY_ID}`));
      }
      // Beside STAYS-VISIBLE, and before the write count — not appended after it.
      assert.ok(result.stdout.indexOf('STAYS-VISIBLE') < 0 || result.stdout.indexOf('TOLERATED') > result.stdout.indexOf('STAYS-VISIBLE'));
      assert.ok(result.stdout.indexOf('TOLERATED') < result.stdout.indexOf('Applied 0 Discord write(s).'), 'tolerances must be named before the write count');
      // And it has to survive into the artifact, not just the terminal.
      assert.match(readFileSync(join(churnDir, 'plan.log'), 'utf8'), new RegExp(`TOLERATED ${HANGOUT(1).id}`));
    } finally { await churnStub.close(); }
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
    assert.equal(resumeStub.writeOrder.length, EXPECTED_OPERATIONS.operationCount - 1);
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
    assert.equal(stub.writeOrder.length, EXPECTED_OPERATIONS.operationCount);
    assert.equal(new Set(stub.writeOrder).size, EXPECTED_OPERATIONS.operationCount, 'retry must not replay completed writes');
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
    const syncedChildren = before
      .filter((channel) => channel.parent_id === mixed.objectId && stable(normalizeOverwrites(channel.permission_overwrites)) === stable(mixed.inverseWrite.permission_overwrites))
      .map((channel) => channel.id);
    assert.ok(syncedChildren.length > 0, 'the mixed category must have synchronized children to strand');
    const rollbackWritesBefore = stub.writes.length;
    const result = await rollback(stub, dir);
    assert.equal(result.code, 0, result.stderr);
    const rollbackTargets = stub.writes.slice(rollbackWritesBefore).map((write) => /\/channels\/(\d+)$/.exec(write.path)![1]);
    assert.ok(rollbackTargets.includes(mixed.objectId), 'mixed state must PATCH the category rather than checkpoint it');
    // TOG-2934: the category is restored ahead of its children, so it no longer matches
    // them and Discord's sync carries nothing. Every child that was synchronized in the
    // pre-snapshot has to be PATCHed explicitly before the operation is checkpointed, or
    // it is stranded at the applied value with nothing left for a retry to re-enter.
    for (const childId of syncedChildren) {
      assert.match(result.stdout, new RegExp(`RESYNCED ${childId} under ${mixed.id}`));
      assert.ok(rollbackTargets.includes(childId), `synchronized child ${childId} must be restored explicitly`);
    }
    assert.equal(stable(stub.state.channels), stable(before));
    const finalManifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(finalManifest.status, 'rolled_back');
    assert.ok(finalManifest.operations.every((operation) => operation.state === 'rolled_back'));
  } finally { await stub.close(); }
});

test('a forged journal state refuses rollback before any write and leaves third-party drift alone', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-journal-forge-rollback-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir)).code, 0);
    const path = manifestPath(dir);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    assert.equal(manifest.operations.filter((operation) => operation.state === 'requesting').length, 0);
    // TOG-2935: relabelling a long-applied operation `requesting` was all it took to buy
    // the in-flight recovery exception, and rollback would then overwrite live state it
    // had never written. `planSignature` covers only immutable plan content, so only the
    // separate journal signature can refuse this.
    const forged = manifest.operations.findLast((operation) => operation.objectType === 'channel' && operationChangesState(operation))!;
    forged.state = 'requesting';
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    chmodSync(path, 0o600);
    const target = stub.state.channels.find((channel) => channel.id === forged.objectId)!;
    target.permission_overwrites = [...target.permission_overwrites, { id: ID(88), type: 0, allow: VIEW, deny: '0' }];
    const drifted = structuredClone(stub.state.channels);
    const writesBefore = stub.writes.length;
    const result = await rollback(stub, dir);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /journal signature is invalid/);
    assert.equal(stub.writes.length, writesBefore, 'a forged journal must be refused before any write');
    assert.equal(stable(stub.state.channels), stable(drifted), "the third party's write must be left exactly as it was");
  } finally { await stub.close(); }
});

test('a forged journal state refuses an apply resume before any write', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-journal-forge-resume-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '3' })).code, 86);
    const path = manifestPath(dir);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    // Exactly one `requesting` operation, or the refusal proves nothing: the resume
    // path rejects a second in-flight operation on its own, and that guard would mask
    // the journal check. Settle the genuine in-flight operation — its write did land
    // before the interruption — and move the label onto one that has long been applied,
    // which is the relabelling that buys the recovery exception.
    const genuine = manifest.operations.find((operation) => operation.state === 'requesting')!;
    genuine.state = 'applied';
    genuine.appliedAt = new Date().toISOString();
    const forged = manifest.operations.find((operation) => operation.state === 'applied' && operation.id !== genuine.id)!;
    forged.state = 'requesting';
    assert.equal(manifest.operations.filter((operation) => operation.state === 'requesting').length, 1);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    chmodSync(path, 0o600);
    const writesBefore = stub.writes.length;
    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 1);
    assert.match(resumed.stderr, /journal signature is invalid/);
    assert.doesNotMatch(resumed.stderr, /more than one requesting operation/);
    assert.equal(stub.writes.length, writesBefore, 'a forged journal must be refused before any write');
  } finally { await stub.close(); }
});

/**
 * The first category operation whose write changes state and that carries synchronized
 * children. `unsyncedChildIds` are its other children — pre-snapshot they did not match
 * the category, so Discord's sync could never have carried them and they each have their
 * own channel operation. Pass `requireUnsynced` when the test needs both kinds.
 */
function tearableCategory(manifest: CleanupManifest, channels: Channel[], requireUnsynced = false): { operation: CleanupManifest['operations'][number]; childIds: string[]; unsyncedChildIds: string[] } {
  for (const operation of manifest.operations) {
    if (operation.objectType !== 'category' || !operationChangesState(operation)) continue;
    const children = channels.filter((channel) => channel.parent_id === operation.objectId);
    const childIds = children
      .filter((channel) => stable(normalizeOverwrites(channel.permission_overwrites)) === stable(operation.inverseWrite.permission_overwrites))
      .map((channel) => channel.id);
    const unsyncedChildIds = children.map((channel) => channel.id).filter((id) => !childIds.includes(id));
    if (childIds.length === 0 || (requireUnsynced && unsyncedChildIds.length === 0)) continue;
    return { operation, childIds, unsyncedChildIds };
  }
  throw new Error('the fixture has no category operation with the required child shape');
}

/** The recovery hint apply prints only when it accepts the drift as its own in-flight write. */
const RECOVERY_HINT = /left a partial write on|live-clean-slate-cleanup-rollback\.ts/;

test('a torn category write is recovered in flight and every synchronized child returns to the pre-snapshot', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-category-inflight-'));
  const before = structuredClone(stub.state.channels);
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const planned = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    const { operation: category, childIds } = tearableCategory(planned, before);

    stub.partialWriteOn(category.objectId);
    const partial = await apply(stub, dir);
    assert.equal(partial.code, 1);
    assert.match(partial.stderr, /partial\/unexpected state/);

    // A torn category write carries its synchronized children down with it, so the
    // in-flight subtree is wider than the operation's own object. Recovery has to cover
    // the children too, and their live value here is one our own PATCH produced.
    const torn = stub.state.channels.find((channel) => channel.id === category.objectId)!;
    const tornShape = stable(normalizeOverwrites(torn.permission_overwrites));
    assert.notEqual(tornShape, stable(category.write.permission_overwrites));
    assert.notEqual(tornShape, stable(category.inverseWrite.permission_overwrites));
    for (const childId of childIds) {
      assert.equal(stable(normalizeOverwrites(stub.state.channels.find((channel) => channel.id === childId)!.permission_overwrites)), tornShape);
    }

    const writesBeforeResume = stub.writes.length;
    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 1);
    assert.match(resumed.stderr, new RegExp(`Interrupted operation ${category.id} left a partial write`));
    assert.equal(stub.writes.length, writesBeforeResume, 'a refused resume must not write');

    const rolledBack = await rollback(stub, dir);
    assert.equal(rolledBack.code, 0, rolledBack.stderr);
    assert.match(rolledBack.stdout, new RegExp(`RECOVERING in-flight ${category.id}`));
    assert.equal(stable(stub.state.channels), stable(before), 'rollback must reach the exact pre-snapshot state');
    const finalManifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal(finalManifest.status, 'rolled_back');
  } finally { await stub.close(); }
});

test('a third party on a synchronized child denies the in-flight exception and rollback refuses', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-inflight-scope-'));
  const before = structuredClone(stub.state.channels);
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const planned = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    const { operation: category, childIds } = tearableCategory(planned, before);

    stub.partialWriteOn(category.objectId);
    assert.equal((await apply(stub, dir)).code, 1);

    // TOG-2934: the in-flight exception used to cover every child of the category, so a
    // third party's write on one of them read as our own partial write and rollback
    // clobbered it. A value this phase could not have produced must revoke the exception.
    stub.desyncChild(childIds[0]!, [{ id: ID(88), type: 0, allow: VIEW, deny: '0' }]);
    const drifted = structuredClone(stub.state.channels);
    const writesBefore = stub.writes.length;
    const result = await rollback(stub, dir);
    assert.equal(result.code, 1);
    assert.match(result.stdout, new RegExp(`In-flight operation ${category.id} is NOT eligible for the recovery exception`));
    assert.match(result.stderr, /drifted from both applied and inverse state/);
    assert.equal(stub.writes.length, writesBefore, 'a refused rollback must not write');
    assert.equal(stable(stub.state.channels), stable(drifted), "the third party's write must be left exactly as it was");
  } finally { await stub.close(); }
});

test('apply resume withholds the recovery exception when a synchronized child holds an inexplicable value', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-resume-scope-child-'));
  const before = structuredClone(stub.state.channels);
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const planned = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    const { operation: category, childIds } = tearableCategory(planned, before);

    stub.partialWriteOn(category.objectId);
    assert.equal((await apply(stub, dir)).code, 1);

    // The adversarial control for the torn-write case above: same interruption, but a
    // third party has put a synchronized child somewhere our PATCH could not have. The
    // exception must be withheld, which means apply refuses as ordinary drift and does
    // NOT send the operator to rollback — rollback would clobber that write.
    stub.desyncChild(childIds[0]!, [{ id: ID(88), type: 0, allow: VIEW, deny: '0' }]);
    const drifted = structuredClone(stub.state.channels);
    const writesBefore = stub.writes.length;
    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 1);
    assert.match(resumed.stderr, /Live state drifted since dry-run\/resume/);
    assert.doesNotMatch(resumed.stderr, RECOVERY_HINT);
    assert.equal(stub.writes.length, writesBefore, 'a refused resume must not write');
    assert.equal(stable(stub.state.channels), stable(drifted), "the third party's write must be left exactly as it was");
  } finally { await stub.close(); }
});

test('apply resume keeps the in-flight subtree off unsynchronized siblings of the torn category', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-resume-scope-sibling-'));
  const before = structuredClone(stub.state.channels);
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const planned = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    const { operation: category, unsyncedChildIds } = tearableCategory(planned, before, true);

    stub.partialWriteOn(category.objectId);
    assert.equal((await apply(stub, dir)).code, 1);

    // The other half of the scope control. This sibling was never synchronized with the
    // category, so the torn write cannot explain it and its live value must not be
    // substituted into the expected state. Widening the subtree to every child would
    // absorb this drift silently and hand the operator a rollback that overwrites it.
    const sibling = stub.state.channels.find((channel) => channel.id === unsyncedChildIds[0]!)!;
    sibling.permission_overwrites = [...sibling.permission_overwrites, { id: ID(89), type: 0, allow: VIEW, deny: '0' }];
    const drifted = structuredClone(stub.state.channels);
    const writesBefore = stub.writes.length;
    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 1);
    assert.match(resumed.stderr, /Live state drifted since dry-run\/resume/);
    assert.doesNotMatch(resumed.stderr, RECOVERY_HINT);
    assert.equal(stub.writes.length, writesBefore, 'a refused resume must not write');
    assert.equal(stable(stub.state.channels), stable(drifted), "the third party's write must be left exactly as it was");
  } finally { await stub.close(); }
});

test('a replayed earlier checkpoint is refused before any write even though it is genuinely signed', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-journal-replay-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const planned = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    // Interrupt after the final write, so the last operation is journalled `requesting`
    // with its PATCH already accepted. Nothing here is forged: this checkpoint is one
    // the run really wrote, and it stays validly signed forever.
    const interrupted = await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: String(planned.operations.length) });
    assert.equal(interrupted.code, 86);
    const path = manifestPath(dir);
    const saved = readFileSync(path, 'utf8');
    const savedManifest = JSON.parse(saved) as CleanupManifest;
    const inFlight = savedManifest.operations.filter((operation) => operation.state === 'requesting');
    assert.equal(inFlight.length, 1);

    assert.equal((await apply(stub, dir)).code, 0);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest).status, 'applied');

    // TOG-2947: with the run settled, a third party edits the object that was in flight,
    // and the saved checkpoint is dropped back over the manifest. The journal HMAC still
    // verifies — replay needs no token — so only the append-only witness log can tell
    // rollback that this checkpoint has been superseded.
    const target = stub.state.channels.find((channel) => channel.id === inFlight[0]!.objectId)!;
    target.permission_overwrites = [...target.permission_overwrites, { id: ID(90), type: 0, allow: VIEW, deny: '0' }];
    const drifted = structuredClone(stub.state.channels);
    writeFileSync(path, saved);
    chmodSync(path, 0o600);
    const writesBefore = stub.writes.length;
    const replayed = await rollback(stub, dir);
    assert.equal(replayed.code, 2);
    assert.match(replayed.stderr, /superseded checkpoint/);
    assert.doesNotMatch(replayed.stdout, /RECOVERING in-flight/);

    // Apply must refuse the same replay rather than diagnose it as a partial write and
    // point the operator at the rollback that would do the clobbering.
    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 1);
    assert.match(resumed.stderr, /superseded checkpoint/);
    assert.doesNotMatch(resumed.stderr, RECOVERY_HINT);

    // And the witness cannot simply be re-pointed at the replayed checkpoint: every
    // record is chained under the bot token, so editing one is not possible without it.
    const witnessFile = `${path}.witness`;
    const lines = readFileSync(witnessFile, 'utf8').split('\n').filter((line) => line.length > 0);
    const tip = JSON.parse(lines.at(-1)!) as { sequence: number; phase: string; journalSignature: string; chain: string };
    lines[lines.length - 1] = JSON.stringify({ ...tip, sequence: savedManifest.journalSequence, journalSignature: savedManifest.journalSignature });
    writeFileSync(witnessFile, `${lines.join('\n')}\n`);
    const forgedWitness = await rollback(stub, dir);
    assert.equal(forgedWitness.code, 2);
    assert.match(forgedWitness.stderr, /is not authentic/);

    assert.equal(stub.writes.length, writesBefore, 'a replayed checkpoint must be refused before any write');
    assert.equal(stable(stub.state.channels), stable(drifted), "the third party's write must be left exactly as it was");
  } finally { await stub.close(); }
});

/**
 * TOG-2960 — a crash *inside* `checkpoint()`.
 *
 * The witness brackets the manifest write (`intent`, write, `commit`), so a process
 * killed in that window leaves the tip an uncommitted `intent`. Both halves of the
 * window used to be terminal: the next checkpoint appended a second `intent`, and
 * every later read failed the sequence check, so a run that had merely been
 * interrupted could never be resumed or rolled back again. Recovery has to close the
 * open checkpoint first, and which way it closes is a property of the manifest, not
 * of the log — hence one test per half.
 */
test('a crash between the checkpoint intent and its manifest write is recoverable', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-crash-pre-write-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '5' })).code, 86);
    const path = manifestPath(dir);
    const witnessFile = journalWitnessPath(path);
    const before = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    assert.equal(readJournalWitness(TOKEN, witnessFile).at(-1)!.phase, 'commit');

    // The crash: the next checkpoint's `intent` reached the log; its manifest write did
    // not. That checkpoint was the one clearing the in-flight operation to `applied`, so
    // it declares nothing in flight — which is also why the resume below has to settle
    // the operation from its live value rather than from a recovery exception.
    const abandoned = before.journalSequence + 1;
    appendJournalWitness(TOKEN, witnessFile, abandoned, 'intent', 'signature-of-a-manifest-that-never-landed', null);

    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /RECOVERED checkpoint \d+: its manifest write never landed/);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest).status, 'applied');

    // The abandoned intent is closed as `abort` — which does not advance the run's
    // latest durable checkpoint — and its sequence number is then retried for real.
    const records = readJournalWitness(TOKEN, witnessFile);
    assert.deepEqual(
      records.filter((record) => record.sequence === abandoned).map((record) => record.phase),
      ['intent', 'abort', 'intent', 'commit'],
    );
    assert.equal(records.at(-1)!.phase, 'commit');
  } finally { await stub.close(); }
});

test('a crash between the checkpoint manifest write and its commit record is recoverable', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-crash-post-write-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '5' })).code, 86);
    const path = manifestPath(dir);
    const witnessFile = journalWitnessPath(path);
    const before = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;

    // The crash: the manifest write landed, only its `commit` record was lost. Drop
    // the trailing commit — trailing truncation is exactly what this crash looks like.
    const lines = readFileSync(witnessFile, 'utf8').split('\n').filter((line) => line.length > 0);
    assert.equal((JSON.parse(lines.at(-1)!) as { phase: string }).phase, 'commit');
    writeFileSync(witnessFile, `${lines.slice(0, -1).join('\n')}\n`, { mode: 0o600 });
    const tip = readJournalWitness(TOKEN, witnessFile).at(-1)!;
    assert.equal(tip.phase, 'intent');
    assert.equal(tip.sequence, before.journalSequence);

    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /RECOVERED checkpoint \d+: its manifest write landed/);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest).status, 'applied');

    const records = readJournalWitness(TOKEN, witnessFile);
    const closed = records.filter((record) => record.sequence === before.journalSequence);
    assert.deepEqual(closed.map((record) => record.phase), ['intent', 'commit']);
    assert.equal(closed.at(-1)!.journalSignature, before.journalSignature, 'the recovered commit must name the manifest that actually landed');
  } finally { await stub.close(); }
});

test('a crash inside the very first checkpoint leaves a restartable run, not a bricked one', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-crash-first-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    // The first checkpoint died before writing any manifest, so the phase directory
    // holds a witness and nothing else. This used to refuse apply outright.
    const path = manifestPath(dir);
    mkdirSync(join(dir, 'phase-01'), { recursive: true, mode: 0o700 });
    appendJournalWitness(TOKEN, journalWitnessPath(path), 1, 'intent', 'signature-of-a-manifest-that-never-landed', null);
    assert.equal(existsSync(path), false);

    const started = await apply(stub, dir);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /RECOVERED checkpoint 1: its manifest write never landed/);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest).status, 'applied');
    const records = readJournalWitness(TOKEN, journalWitnessPath(path));
    assert.deepEqual(records.slice(0, 3).map((record) => record.phase), ['intent', 'abort', 'intent']);
  } finally { await stub.close(); }
});

test('recovery does not launder a replayed checkpoint or a removed journal', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-crash-abuse-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const planned = JSON.parse(readFileSync(planManifestPath(dir), 'utf8')) as CleanupManifest;
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: String(planned.operations.length) })).code, 86);
    const path = manifestPath(dir);
    const witnessFile = journalWitnessPath(path);
    const saved = readFileSync(path, 'utf8');
    const savedManifest = JSON.parse(saved) as CleanupManifest;
    assert.equal((await apply(stub, dir)).code, 0);
    const settled = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    assert.equal(settled.status, 'applied');

    const writesBefore = stub.writes.length;
    const drifted = structuredClone(stub.state.channels);

    // A witness that ever committed a checkpoint still proves a manifest existed, so
    // losing the manifest must not silently start a fresh journal over that history.
    // Checked here, on a cleanly committed tip, so it is this guard being exercised.
    unlinkSync(path);
    const removed = await apply(stub, dir);
    assert.equal(removed.code, 2);
    assert.match(removed.stderr, /records a committed checkpoint without its manifest/);

    // An open checkpoint must not become a way to smuggle a superseded manifest past
    // the freshness check: reconciliation only closes an intent whose manifest is
    // either that checkpoint or the last committed one, and a replay is neither.
    writeFileSync(path, saved, { mode: 0o600 });
    // Named in flight exactly as the replayed manifest wants it, so the refusal below is
    // the checkpoint classification and not the witness descriptor doing the work.
    appendJournalWitness(TOKEN, witnessFile, settled.journalSequence + 1, 'intent', 'signature-of-a-manifest-that-never-landed', savedManifest.operations.find((operation) => operation.state === 'requesting')?.id ?? null);
    const laundered = await rollback(stub, dir);
    assert.equal(laundered.code, 2);
    assert.match(laundered.stderr, /not an interrupted checkpoint/);
    assert.doesNotMatch(laundered.stdout, /RECOVERING in-flight/);
    assert.ok(savedManifest.journalSequence < settled.journalSequence);

    assert.equal(stub.writes.length, writesBefore, 'neither refusal may touch Discord');
    assert.equal(stable(stub.state.channels), stable(drifted));
  } finally { await stub.close(); }
});

/**
 * TOG-2975 — the three windows round 5 reproduced in the TOG-2960 recovery path.
 *
 * All three are about a witness record being trusted for slightly more than it proves:
 * an empty file read as a corrupt one, an open `intent` closed as `commit` over a
 * manifest the run will then reject, and a stale `requesting` label taken as evidence
 * of an interrupted write when the abandoned checkpoint says otherwise.
 */
test('a torn witness file creation leaves a restartable run, not an unreadable one', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-witness-torn-create-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const path = manifestPath(dir);
    const witnessFile = journalWitnessPath(path);

    // The crash: the very first `appendJournalWitness` creates the file and then writes
    // to it. A process killed between the two leaves a zero-byte witness and no
    // manifest — which records no more history than no witness at all.
    mkdirSync(join(dir, 'phase-01'), { recursive: true, mode: 0o700 });
    writeFileSync(witnessFile, '', { mode: 0o600 });
    assert.equal(existsSync(path), false);
    assert.equal(statSync(witnessFile).size, 0);

    const started = await apply(stub, dir);
    assert.equal(started.code, 0, started.stderr);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest).status, 'applied');
    assert.equal(readJournalWitness(TOKEN, witnessFile).at(0)!.phase, 'intent');

    // Reading an empty witness as "no checkpoint" is not the same as reading it as
    // "this manifest is current": a log that records nothing cannot show the manifest
    // beside it is the run's latest checkpoint, so acting on it is still refused.
    writeFileSync(witnessFile, '', { mode: 0o600 });
    const writesBefore = stub.writes.length;
    const refused = await rollback(stub, dir);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /records no checkpoint/);
    assert.equal(stub.writes.length, writesBefore, 'an unprovable manifest must be refused before any write');
  } finally { await stub.close(); }
});

/**
 * TOG-3006 — the other half of the torn-witness surface, found reviewing TOG-3001.
 *
 * A torn file *creation* left a restartable run from TOG-2975 on. A torn *trailing line*
 * did not: it threw, and both entry points then refused to start a run whose committed
 * records were all intact and readable. Needs a power cut rather than a kill — one
 * fsynced ~190-byte append does not tear — but the recovery it blocked was free.
 */
test('a torn trailing witness line leaves a restartable run, not an unreadable one', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-witness-torn-tail-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const path = manifestPath(dir);
    assert.equal((await apply(stub, dir)).code, 0);
    const witnessFile = journalWitnessPath(path);
    const whole = readFileSync(witnessFile, 'utf8');
    const committed = readJournalWitness(TOKEN, witnessFile);
    assert.ok(committed.length >= 2, 'the tear needs a record in front of it to still be readable');

    // The crash: power lost part-way through the final append, so the last record is on
    // disk mid-JSON with no newline behind it. Every record before it is untouched.
    const lastLineAt = whole.lastIndexOf('\n', whole.length - 2) + 1;
    writeFileSync(witnessFile, whole.slice(0, lastLineAt + 40), { mode: 0o600 });
    assert.equal(readFileSync(witnessFile, 'utf8').endsWith('\n'), false);

    // The torn line reads as never written — one record short, and the rest intact.
    const afterTear = readJournalWitness(TOKEN, witnessFile);
    assert.equal(afterTear.length, committed.length - 1);
    assert.deepEqual(afterTear, committed.slice(0, -1));

    // Which is the point: the run starts instead of exiting 2 on an unreadable log.
    const started = await rollback(stub, dir);
    assert.equal(started.code, 0, started.stderr);
    assert.doesNotMatch(started.stderr, /is not readable/);

    // And the garbage is gone rather than buried mid-file, where it would be permanent:
    // the reader skips a torn tail only while it is still the tail.
    const repaired = readFileSync(witnessFile, 'utf8');
    assert.equal(repaired.endsWith('\n'), true);
    assert.ok(repaired.startsWith(whole.slice(0, lastLineAt)), 'the committed prefix must survive byte for byte');
    assert.ok(readJournalWitness(TOKEN, witnessFile).length > afterTear.length, 'the repaired log took the next checkpoint');
  } finally { await stub.close(); }
});

test('an unreadable witness line that is not the last one is still refused', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-witness-spliced-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir)).code, 0);
    const witnessFile = journalWitnessPath(manifestPath(dir));
    const lines = readFileSync(witnessFile, 'utf8').split('\n').filter((line) => line.length > 0);
    assert.ok(lines.length >= 2, 'splicing needs a line after the damaged one');

    // Same damage as above, one line further from the end. TOG-3006 relaxed the reader
    // for a torn tail only: mid-log garbage is a spliced file, not an interrupted write.
    lines[lines.length - 2] = lines[lines.length - 2]!.slice(0, 40);
    writeFileSync(witnessFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    assert.throws(() => readJournalWitness(TOKEN, witnessFile), /is not readable/);

    const writesBefore = stub.writes.length;
    const refused = await rollback(stub, dir);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /is not readable/);
    assert.equal(stub.writes.length, writesBefore, 'an unreadable log must be refused before any write');
  } finally { await stub.close(); }
});

test('an open checkpoint is not closed over a manifest the run would reject', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-crash-invalid-manifest-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '5' })).code, 86);
    const path = manifestPath(dir);
    const witnessFile = journalWitnessPath(path);
    const good = readFileSync(path, 'utf8');
    const goodManifest = JSON.parse(good) as CleanupManifest;

    // The crash: an `intent` for the next checkpoint landed; its manifest write did not.
    // The journal signature covers only the mutable journal half, so an editor can
    // corrupt everything else — here the pre-snapshot the whole plan is pinned to — and
    // still present a file whose signature matches the abandoned checkpoint exactly.
    const abandoned = goodManifest.journalSequence + 1;
    const forged = { ...goodManifest, journalSequence: abandoned, snapshotSemanticHash: `${goodManifest.snapshotSemanticHash.slice(0, -1)}${goodManifest.snapshotSemanticHash.endsWith('0') ? '1' : '0'}` };
    forged.journalSignature = journalSignature(TOKEN, forged as CleanupManifest);
    assert.notEqual(forged.snapshotSemanticHash, goodManifest.snapshotSemanticHash);
    appendJournalWitness(TOKEN, witnessFile, abandoned, 'intent', forged.journalSignature, null);
    writeFileSync(path, `${JSON.stringify(forged, null, 2)}\n`, { mode: 0o600 });

    const writesBefore = stub.writes.length;
    const drifted = structuredClone(stub.state.channels);
    const refusedApply = await apply(stub, dir);
    assert.equal(refusedApply.code, 2, `${refusedApply.stdout}\n${refusedApply.stderr}`);
    assert.match(refusedApply.stderr, /Refusing to close the open checkpoint/);
    assert.match(refusedApply.stderr, /Manifest snapshot semantic hash mismatch/);
    // Rollback validates the manifest before it reconciles, so it refuses one step
    // earlier and never reaches the open checkpoint at all. Its reconciliation
    // validator is therefore defence in depth against that order being changed, not
    // the guard doing the work here — what matters is that neither entry point
    // appends over the intent.
    const refusedRollback = await rollback(stub, dir);
    assert.equal(refusedRollback.code, 2, `${refusedRollback.stdout}\n${refusedRollback.stderr}`);
    assert.match(refusedRollback.stderr, /Pre-snapshot hash does not match the manifest/);

    // Nothing was appended. An open `intent` is recoverable and a wrongly written
    // `commit` is not, so the refusal has to come before the append, not after it.
    const records = readJournalWitness(TOKEN, witnessFile);
    assert.deepEqual(records.filter((record) => record.sequence === abandoned).map((record) => record.phase), ['intent']);
    assert.equal(stub.writes.length, writesBefore, 'neither refusal may touch Discord');
    assert.equal(stable(stub.state.channels), stable(drifted));

    // And the point of refusing rather than closing: restoring the real manifest lets
    // the interrupted run finish. A `commit` for the forged checkpoint would have moved
    // the durable tip past the sequence the real manifest carries and stranded it.
    writeFileSync(path, good, { mode: 0o600 });
    const resumed = await apply(stub, dir);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest).status, 'applied');
  } finally { await stub.close(); }
});

/**
 * The in-flight exception is the one place a journal state licenses writing over a
 * value we did not put there, so it has to be earned by the abandoned checkpoint and
 * not by the manifest alone. Both crash shapes leave the same operation `requesting` in
 * the manifest and an open `intent` above it; the only thing separating them is which
 * operation that record says was in flight, and it is chained under the bot token so
 * trailing truncation cannot manufacture one. Hence a matched pair, both crashed inside
 * `checkpoint()` by the script itself so the recorded descriptor is the real one.
 */
test('a checkpoint abandoned with nothing in flight denies the recovery exception', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-inflight-deny-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '5' })).code, 86);
    const path = manifestPath(dir);
    const witnessFile = journalWitnessPath(path);
    const crashed = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    const inFlight = crashed.operations.filter((operation) => operation.state === 'requesting');
    assert.equal(inFlight.length, 1);
    const operation = inFlight[0]!;
    assert.equal(operation.objectType, 'channel', 'a channel operation has no synchronized children, so the witness alone decides');

    // The second crash lands in the checkpoint that clears this operation to `applied`.
    // Apply only reaches it after Discord returned the write and it was verified equal,
    // so that checkpoint declares nothing in flight — and the object was at `write`.
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_IN_CHECKPOINT: String(crashed.journalSequence + 2) })).code, 86);
    const records = readJournalWitness(TOKEN, witnessFile);
    assert.equal(records.at(-1)!.phase, 'intent');
    assert.equal(records.at(-1)!.inFlightId, null);
    const resumed = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    assert.equal(resumed.journalSequence, records.at(-1)!.sequence - 1, 'the abandoned checkpoint sits one above the manifest');
    assert.equal(resumed.operations.find((candidate) => candidate.id === operation.id)!.state, 'requesting');

    // A third party then moves that object. The stale `requesting` label must not buy
    // the right to write over them.
    const target = stub.state.channels.find((channel) => channel.id === operation.objectId)!;
    target.permission_overwrites = [...(target.permission_overwrites ?? []), { id: ID(91), type: 0, allow: VIEW, deny: '0' }];
    const drifted = structuredClone(stub.state.channels);
    const writesBefore = stub.writes.length;

    const refused = await rollback(stub, dir);
    assert.equal(refused.code, 1, `${refused.stdout}\n${refused.stderr}`);
    assert.match(refused.stdout, /the checkpoint witness records no interrupted write for it/);
    assert.doesNotMatch(refused.stdout, /RECOVERING in-flight/);
    assert.match(refused.stderr, new RegExp(`operation ${operation.id} drifted from both applied and inverse state`));
    assert.equal(stub.writes.length, writesBefore, 'a denied exception must not write');
    assert.equal(stable(stub.state.channels), stable(drifted), "the third party's write must be left exactly as it was");
  } finally { await stub.close(); }
});

test('a checkpoint abandoned while that operation was in flight still recovers it', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-inflight-allow-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    const before = structuredClone(stub.state.channels);
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '5' })).code, 86);
    const path = manifestPath(dir);
    const witnessFile = journalWitnessPath(path);
    const crashed = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
    const operation = crashed.operations.find((candidate) => candidate.state === 'requesting')!;

    // The same manifest and the same open checkpoint one sequence above it — but this
    // crash lands in the resume's opening checkpoint, taken while the request is still
    // outstanding. It names the operation, so the partial value below is ours to undo.
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_IN_CHECKPOINT: String(crashed.journalSequence + 1) })).code, 86);
    const records = readJournalWitness(TOKEN, witnessFile);
    assert.equal(records.at(-1)!.phase, 'intent');
    assert.equal(records.at(-1)!.inFlightId, operation.id);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest).journalSequence, crashed.journalSequence);

    const target = stub.state.channels.find((channel) => channel.id === operation.objectId)!;
    target.permission_overwrites = operation.write.permission_overwrites.slice(0, -1);
    assert.notEqual(stable(normalizeOverwrites(target.permission_overwrites)), stable(normalizeOverwrites(operation.write.permission_overwrites)));
    assert.notEqual(stable(normalizeOverwrites(target.permission_overwrites)), stable(normalizeOverwrites(operation.inverseWrite.permission_overwrites)));

    const recovered = await rollback(stub, dir);
    assert.equal(recovered.code, 0, `${recovered.stdout}\n${recovered.stderr}`);
    assert.match(recovered.stdout, new RegExp(`RECOVERING in-flight ${operation.id}`));
    assert.equal(stable(stub.state.channels), stable(before), 'the guild must be returned to the pre-snapshot state');
  } finally { await stub.close(); }
});

/**
 * TOG-3009 — the exception must be *granted* by the witness, not merely unopposed by it.
 *
 * `inFlightExceptionIsAvailable` decides on the records above the manifest's checkpoint,
 * and a zero-byte witness supplies none (TOG-2975 made that a readable empty log rather
 * than an error). An empty `every` is vacuously true, so the predicate handed back the
 * one permission that lets recovery write `inverseWrite` over an object holding an
 * arbitrary live value — on the strength of a log recording nothing.
 *
 * Both call sites happen to run `assertLatestCheckpoint` first, which refuses an empty
 * log, so this was never reachable through the scripts. That is the reason to close it
 * here rather than rely on it: the fail-open was inside the exported predicate and the
 * thing closing it was in its callers, so the next caller that reaches for this helper
 * without that ordering gets the overwrite. Asserted against the predicate directly,
 * because the call sites are exactly what must stop being load-bearing.
 */
test('a witness that records no checkpoint denies the in-flight recovery exception', async () => {
  const stub = await stubDiscord();
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-inflight-empty-witness-'));
  try {
    assert.equal((await plan(stub, dir)).code, 0);
    assert.equal((await apply(stub, dir, { LIVE_CLEANUP_TEST_ABORT_AFTER_WRITES: '5' })).code, 86);
    const path = manifestPath(dir);
    const witnessFile = journalWitnessPath(path);
    const crashed = JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;

    // A real crashed manifest, so the predicate reaches the witness read at all rather
    // than short-circuiting on a manifest with nothing in flight.
    const inFlightId = manifestInFlightId(crashed);
    assert.notEqual(inFlightId, null);
    assert.equal(inFlightExceptionIsAvailable(TOKEN, crashed, path), true, 'the untouched log grants it');

    // The torn file creation of `appendJournalWitness`: the file exists and holds no
    // records. It cannot deny the exception, and it must not grant it either.
    writeFileSync(witnessFile, '', { mode: 0o600 });
    assert.equal(statSync(witnessFile).size, 0);
    assert.equal(readJournalWitness(TOKEN, witnessFile).length, 0);
    assert.equal(inFlightExceptionIsAvailable(TOKEN, crashed, path), false);

    // The guard denies an empty log, not the predicate: an abandoned checkpoint naming
    // this operation still earns the exception, and one naming a different operation
    // still denies it.
    appendJournalWitness(TOKEN, witnessFile, 1, 'intent', 'checkpoint-1', null);
    appendJournalWitness(TOKEN, witnessFile, 1, 'commit', 'checkpoint-1', null);
    const above = { ...crashed, journalSequence: 1 };
    appendJournalWitness(TOKEN, witnessFile, 2, 'intent', 'checkpoint-2', inFlightId);
    assert.equal(inFlightExceptionIsAvailable(TOKEN, above, path), true);
    appendJournalWitness(TOKEN, witnessFile, 2, 'abort', 'checkpoint-2', inFlightId);
    appendJournalWitness(TOKEN, witnessFile, 2, 'intent', 'checkpoint-2', null);
    assert.equal(inFlightExceptionIsAvailable(TOKEN, above, path), false);
  } finally { await stub.close(); }
});

/**
 * TOG-3009 — the same fail-open from the other side. `openSync(path, 'a', 0o600)` sets
 * the mode only when it creates the file, so a witness restored, copied, or created by
 * anything else keeps its own mode. A readable-and-writable witness is not a disclosure
 * problem — the records are chained under the bot token — but it is a truncation
 * problem, and a truncated witness is indistinguishable from an interrupted checkpoint.
 * Every append therefore narrows it, on the fd rather than the path.
 */
test('appending to the checkpoint witness narrows a widened file back to 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'two-live-clean-witness-mode-'));
  const witnessFile = journalWitnessPath(join(dir, 'rollback.json'));

  writeFileSync(witnessFile, '', { mode: 0o644 });
  chmodSync(witnessFile, 0o644);
  assert.equal(statSync(witnessFile).mode & 0o777, 0o644);

  appendJournalWitness(TOKEN, witnessFile, 1, 'intent', 'checkpoint-1', null);
  assert.equal(statSync(witnessFile).mode & 0o777, 0o600);
  assert.equal(readJournalWitness(TOKEN, witnessFile).length, 1, 'narrowing must not cost the append');
});
