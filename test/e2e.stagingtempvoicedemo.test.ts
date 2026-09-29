/**
 * Mock-Discord acceptance for the staging temp-voice demo join-to-create path
 * ([TOG-6500](/TOG/issues/TOG-6500), TOG-3052 staging evidence, TOG-3471 path).
 *
 * WHY THIS EXISTS. `scripts/staging-temp-voice-demo.ts` drives the shipped
 * `TempVoiceService` (the same service object `src/index.ts` hands the
 * gateway, the same `registerTempVoice` registration) against TWO Staging and
 * re-reads Discord over REST. It had zero test-file references and hardcoded
 * `https://discord.com/api/v10`, so no test could run the join-to-create path
 * against a mock. The script now honors `DISCORD_API_BASE` (staging-only,
 * default-off, same shape as `scripts/staging-session-demo.ts`); this file is
 * the offline half of that proof and the one CI runs.
 *
 * WHAT IT PROVES, against the REAL Postgres store (`openTestDb`, one schema
 * per file) and a fake Discord gateway:
 *   1. the demo script honors the mock seam and boots offline on `--help`
 *      (no token, no database, no network);
 *   2. join-to-create mints the expected channel shape: correct category,
 *      positioned below Lobby, owner holds ManageChannels/MoveMembers, no
 *      Administrator grant anywhere;
 *   3. the sweep deletes the channel and its row once the grace expires;
 *   4. failure leaves no residue: no orphan channels in the mock, no live
 *      rows (the orphan signature is a live channel with nothing tracking it).
 *
 * WHAT IT DOES NOT PROVE. The full `client.login()` gateway round trip is not
 * exercised here: `tools/mock-discord/server.ts` has no voice-channel CRUD
 * (create/delete/patch, permission overwrites, positions), so a discord.js
 * login against it cannot reach the generator join. The service under test is
 * the exact object the demo constructs; the script seam itself (REST base +
 * `client.rest.options.api` override) is asserted by reading the script and by
 * booting `--help` against a scrubbed environment.
 *
 * Hermetic: child `node` processes for `--help` only; everything else is
 * in-process against scratch Postgres. No token, no live Discord, no live
 * guild writes. Prints `demo-create` / `demo-cleanup` lines a reviewer can see.
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TempVoiceConfig, TempVoiceControl } from '../src/tempVoice/config.ts';
import { TempVoiceStore } from '../src/tempVoice/store.ts';
import {
  CATEGORY_FULL_CODE,
  TempVoiceGatewayError,
  TempVoiceService,
  type OverwriteFlag,
  type OverwriteSpec,
  type TempVoiceGateway,
} from '../src/tempVoice/service.ts';
import type { AutomodPolicy } from '../src/automod/types.ts';
import { openTestDb } from './helpers/testDb.ts';

const ROOT = resolve(fileURLToPath(import.meta.url), '..');
const SCRIPT = resolve(ROOT, '../scripts/staging-temp-voice-demo.ts');

const GUILD = '1545644954272137297';
const GENERATOR = '1546211381844512798';
const CATEGORY = '1546211378430345200';
const LOBBY = '1546211378430345286';
const OWNER = '1546451670500642001';
const OTHER = '1546451670500642002';

const POLICY: AutomodPolicy = {
  badWords: ['badword'],
  blockedAttachmentExtensions: [],
  allowedDomains: [],
  repeatedMessageCount: 3,
  repeatedMessageWindowSeconds: 60,
  mentionLimit: 5,
  bypassRoleIds: new Set(),
  exemptChannelIds: new Set(),
  sanctions: [],
};

function config(overrides: Partial<TempVoiceConfig> = {}): TempVoiceConfig {
  return {
    enabled: true,
    generatorChannelId: GENERATOR,
    categoryId: CATEGORY,
    protectedChannelIds: new Set([GENERATOR, CATEGORY, LOBBY]),
    emptyGraceSeconds: 60,
    sweepSeconds: 30,
    maxPerUser: 1,
    maxPerGuild: 40,
    createCooldownSeconds: 0,
    nameTemplate: "{username}'s channel",
    panelChannelId: null,
    disabledControls: new Set<TempVoiceControl>(),
    ...overrides,
  };
}

interface FakeChannel {
  id: string;
  name: string;
  categoryId: string;
  position: number;
  members: string[];
  /** targetId -> flag -> true (allow) | false (deny). */
  overwrites: Map<string, Map<OverwriteFlag, boolean>>;
}

class FakeGateway implements TempVoiceGateway {
  channels = new Map<string, FakeChannel>();
  deleteCalls: Array<{ channelId: string; reason: string }> = [];
  failCreate: TempVoiceGatewayError | null = null;
  private seq = 0;

  constructor() {
    // Lobby below the generator, both permanent with nobody in them. Every
    // sweep therefore has the chance to delete them, which is exactly the
    // accident being guarded against; every orphan scan treats them as
    // bystanders, never candidates.
    this.channels.set(LOBBY, {
      id: LOBBY, name: 'Lobby', categoryId: CATEGORY, position: 5, members: [], overwrites: new Map(),
    });
    this.channels.set(GENERATOR, {
      id: GENERATOR, name: 'Squad', categoryId: CATEGORY, position: 6, members: [], overwrites: new Map(),
    });
  }

  botUserId(): string { return '1469137636663758888'; }

  async createVoiceChannel(input: {
    guildId: string; name: string; categoryId: string; position?: number; overwrites: OverwriteSpec[];
  }): Promise<{ id: string }> {
    if (this.failCreate) throw this.failCreate;
    const id = String(1600000000000000000n + BigInt(++this.seq));
    const channel: FakeChannel = {
      id, name: input.name, categoryId: input.categoryId,
      position: input.position ?? 7, members: [], overwrites: new Map(),
    };
    this.channels.set(id, channel);
    for (const spec of input.overwrites) this.mergeOverwrite(channel, spec);
    return { id };
  }

  private mergeOverwrite(channel: FakeChannel, spec: OverwriteSpec): void {
    const entry = channel.overwrites.get(spec.id) ?? new Map<OverwriteFlag, boolean>();
    for (const flag of spec.allow ?? []) entry.set(flag, true);
    for (const flag of spec.deny ?? []) entry.set(flag, false);
    channel.overwrites.set(spec.id, entry);
  }

  async deleteChannel(channelId: string, reason: string): Promise<'deleted' | 'missing'> {
    this.deleteCalls.push({ channelId, reason });
    if (!this.channels.has(channelId)) return 'missing';
    this.channels.delete(channelId);
    return 'deleted';
  }

  async moveMember(_guildId: string, userId: string, channelId: string | null): Promise<void> {
    for (const channel of this.channels.values()) {
      channel.members = channel.members.filter((id) => id !== userId);
    }
    if (channelId) this.channels.get(channelId)?.members.push(userId);
  }

  async renameChannel(channelId: string, name: string): Promise<void> {
    this.channels.get(channelId)!.name = name;
  }

  async setUserLimit(): Promise<void> {}
  async setBitrate(): Promise<void> {}
  async applyOverwrite(channelId: string, overwrite: OverwriteSpec): Promise<void> {
    this.mergeOverwrite(this.channels.get(channelId)!, overwrite);
  }
  async clearOverwrite(channelId: string, targetId: string): Promise<void> {
    this.channels.get(channelId)?.overwrites.delete(targetId);
  }

  async occupantsOf(channelId: string): Promise<string[] | null> {
    const channel = this.channels.get(channelId);
    return channel ? [...channel.members] : null;
  }

  async positionBelow(channelId: string): Promise<number | undefined> {
    const channel = this.channels.get(channelId);
    return channel ? channel.position + 1 : undefined;
  }

  async canMove(): Promise<boolean> { return true; }
  async maxBitrate(): Promise<number> { return 96000; }

  async missingPermissions(
    _guildId: string,
    _categoryId: string,
    _flags: readonly OverwriteFlag[],
  ): Promise<OverwriteFlag[]> {
    return [];
  }
}

const dbFixture = await openTestDb(import.meta.filename);
const store = new TempVoiceStore(dbFixture.db);

let gateway: FakeGateway;
let clock: number;
const now = () => clock;

function service(cfg: TempVoiceConfig = config()): TempVoiceService {
  return new TempVoiceService({ store, gateway, config: cfg, policy: POLICY, now });
}

/** Join the generator the way a real member would, through the shipped service. */
async function join(svc: TempVoiceService, userId: string, username = 'ava') {
  gateway.channels.get(GENERATOR)!.members.push(userId);
  return svc.onGeneratorJoin({ guildId: GUILD, userId, username });
}

/**
 * An orphan is a generated channel the mock still has that we have no row
 * for, or a live row whose channel the mock no longer has. Lobby and the
 * generator are bystanders, never candidates: they have no rows by design.
 */
async function orphanScan(): Promise<{ channelsWithoutRows: string[]; rowsWithoutChannels: string[] }> {
  const live = await store.listLive(GUILD);
  const liveIds = new Set(live.map((row) => row.channelId!));
  const channelsWithoutRows = [...gateway.channels.values()]
    .filter((channel) => channel.id !== LOBBY && channel.id !== GENERATOR && !liveIds.has(channel.id))
    .map((channel) => channel.id);
  const rowsWithoutChannels = live
    .filter((row) => !gateway.channels.has(row.channelId!))
    .map((row) => row.channelId!);
  return { channelsWithoutRows, rowsWithoutChannels };
}

beforeEach(async () => {
  await dbFixture.reset();
  gateway = new FakeGateway();
  clock = Date.parse('2026-09-16T12:00:00.000Z');
});
after(async () => dbFixture.cleanup());

test('the demo script honors DISCORD_API_BASE and boots offline on --help', async () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.match(source, /DISCORD_API_BASE/, 'the demo must read the mock seam');
  assert.match(
    source,
    /client\.rest\.options\.api/,
    'the demo must apply the same discord.js REST override as src/index.ts',
  );

  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const k of ['HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'SYSTEMDRIVE', 'LANG', 'TZ']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const k of Object.keys(env)) {
    assert.ok(
      !/TOKEN|SECRET|KEY|DATABASE|DISCORD|STAGING|E2E|PASSWORD/i.test(`${k}=${env[k]}`),
      `scrubbed env leaked a credential-looking variable: ${k}`,
    );
  }
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise) => {
    execFile(process.execPath, [SCRIPT, '--help'], { cwd: ROOT, env }, (err, stdout, stderr) => {
      resolvePromise({
        code: err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
  assert.equal(result.code, 0, `--help must boot with no credential; stderr: ${result.stderr}`);
  assert.match(result.stdout, /usage: node scripts\/staging-temp-voice-demo\.ts <create\|restart\|cleanup>/);
});

test('join-to-create mints the expected channel shape', async () => {
  const svc = service();
  assert.deepEqual(await orphanScan(), { channelsWithoutRows: [], rowsWithoutChannels: [] });

  const outcome = await join(svc, OWNER);
  assert.equal(outcome.status, 'created');
  const channelId = outcome.status === 'created' ? outcome.channelId : '';
  const channel = gateway.channels.get(channelId)!;
  const lobby = gateway.channels.get(LOBBY)!;

  console.log(`demo-create channel=${channelId} owner=${OWNER} category=${channel.categoryId} position=${channel.position} name=${channel.name}`);
  assert.equal(channel.categoryId, CATEGORY, 'the channel is in the configured category');
  assert.ok(channel.position > lobby.position, `positioned below Lobby (channel ${channel.position} > lobby ${lobby.position})`);

  const owner = channel.overwrites.get(OWNER)!;
  assert.equal(owner.get('ManageChannels'), true, 'the owner holds ManageChannels on this channel');
  assert.equal(owner.get('MoveMembers'), true, 'the owner holds MoveMembers on this channel');
  const flags = [...channel.overwrites.values()].flatMap((entry) => [...entry.keys()]);
  assert.equal(flags.includes('Administrator' as OverwriteFlag), false, 'no overwrite grants Administrator');

  const row = await store.getByChannel(GUILD, channelId);
  assert.equal(row?.ownerId, OWNER, 'the row tracks the owner');
  assert.deepEqual(await orphanScan(), { channelsWithoutRows: [], rowsWithoutChannels: [] });
});

test('the sweep deletes the channel and its row once the grace window expires', async () => {
  const svc = service();
  const outcome = await join(svc, OWNER);
  assert.equal(outcome.status, 'created');
  const channelId = outcome.status === 'created' ? outcome.channelId : '';
  console.log(`demo-create channel=${channelId} owner=${OWNER}`);

  gateway.channels.get(channelId)!.members = [];
  await svc.onVoiceStateChange({ guildId: GUILD, userId: OWNER, fromChannelId: channelId, toChannelId: null });

  assert.equal((await svc.sweep(GUILD)).deleted, 0, 'the first empty sweep starts the grace window rather than deleting');
  assert.ok(gateway.channels.has(channelId), 'the channel is still alive during grace');

  clock += 61_000;
  const second = await svc.sweep(GUILD);
  assert.equal(second.deleted, 1, 'the sweep deletes once the grace window has expired');
  console.log(`demo-cleanup deleted=1 channel=${channelId}`);
  assert.equal(gateway.channels.has(channelId), false, 'the channel is gone from the mock');
  assert.equal(await store.getByChannel(GUILD, channelId), null, 'the row is gone too');
  assert.deepEqual(await orphanScan(), { channelsWithoutRows: [], rowsWithoutChannels: [] });
  assert.ok(gateway.channels.has(LOBBY), 'Lobby survives');
  assert.ok(gateway.channels.has(GENERATOR), 'the generator survives');
  assert.deepEqual(
    gateway.deleteCalls.map((call) => call.channelId),
    [channelId],
    'the only channel ever deleted is the generated one',
  );
});

test('failure leaves no residue: no orphan channels, no live rows', async () => {
  const svc = service();
  gateway.failCreate = new TempVoiceGatewayError('category full', CATEGORY_FULL_CODE);
  const outcome = await join(svc, OWNER);
  assert.equal(outcome.status, 'refused', 'a failed create refuses rather than minting half a channel');
  gateway.failCreate = null;

  assert.equal(await store.countForGuild(GUILD), 0, 'a failed create holds no live rows');
  assert.deepEqual(await orphanScan(), { channelsWithoutRows: [], rowsWithoutChannels: [] });

  // The hard invariant, against the mock: a sweep with nothing owned deletes
  // nothing, and an unowned channel is refused rather than deleted.
  gateway.channels.set('1600000000000009998', {
    id: '1600000000000009998', name: 'hand-made room', categoryId: CATEGORY,
    position: 9, members: [], overwrites: new Map(),
  });
  const report = await service().sweep(GUILD);
  assert.equal(report.deleted, 0);
  assert.deepEqual(gateway.deleteCalls, [], 'refusing must mean no delete call at all');
  assert.deepEqual(
    await orphanScan(),
    { channelsWithoutRows: ['1600000000000009998'], rowsWithoutChannels: [] },
    'the hand-made room is visible to the scan rather than silently absorbed',
  );

  // A refused join after the failure still works: the caps were rolled back.
  const retry = await join(service(), OTHER);
  assert.equal(retry.status, 'created');
  const retryId = retry.status === 'created' ? retry.channelId : '';
  console.log(`demo-create channel=${retryId} owner=${OTHER} after-refusal-retry`);
  assert.deepEqual(
    (await orphanScan()).rowsWithoutChannels,
    [],
    'the retry leaves no row without a channel',
  );
});
