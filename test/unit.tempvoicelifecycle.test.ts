/**
 * Temp-voice lifecycle proof (TOG-7186).
 *
 * The service rules are covered piece by piece in unit.tempvoice.test.ts; this
 * file proves the whole span in one run against the REAL Postgres store and a
 * fake gateway: create-on-join, occupied, emptied, deleted past the grace
 * window - and then scans for orphans (a channel with no row, or a row with no
 * channel) and asserts the scan is empty.
 *
 * Staging equivalent: scripts/staging-temp-voice-demo.ts phases
 * create -> restart -> cleanup drive the same span against TWO Staging over
 * REST. This fixture is the offline half of that proof and the one CI runs.
 */
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import type { TempVoiceConfig, TempVoiceControl } from '../src/tempVoice/config.ts';
import { TempVoiceStore } from '../src/tempVoice/store.ts';
import { openTestDb } from './helpers/testDb.ts';
import {
  TempVoiceService,
  type OverwriteFlag,
  type OverwriteSpec,
  type TempVoiceGateway,
} from '../src/tempVoice/service.ts';
import type { AutomodPolicy } from '../src/automod/types.ts';

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
  members: string[];
}

class FakeGateway implements TempVoiceGateway {
  channels = new Map<string, FakeChannel>();
  deleteCalls: Array<{ channelId: string; reason: string }> = [];
  private seq = 0;

  constructor() {
    // Lobby and the generator live in the category with nobody in them, so the
    // orphan scan below has permanent bystanders it must never flag.
    this.channels.set(LOBBY, { id: LOBBY, name: 'Lobby', categoryId: CATEGORY, members: [] });
    this.channels.set(GENERATOR, { id: GENERATOR, name: 'Squad', categoryId: CATEGORY, members: [] });
  }

  botUserId(): string { return '1469137636663758888'; }

  async createVoiceChannel(input: {
    guildId: string; name: string; categoryId: string; position?: number; overwrites: OverwriteSpec[];
  }): Promise<{ id: string }> {
    const id = String(1600000000000000000n + BigInt(++this.seq));
    this.channels.set(id, { id, name: input.name, categoryId: input.categoryId, members: [] });
    return { id };
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
  async applyOverwrite(): Promise<void> {}
  async clearOverwrite(): Promise<void> {}

  async occupantsOf(channelId: string): Promise<string[] | null> {
    const channel = this.channels.get(channelId);
    return channel ? [...channel.members] : null;
  }

  async positionBelow(channelId: string): Promise<number | undefined> {
    return this.channels.has(channelId) ? 1 : undefined;
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

beforeEach(async () => {
  await dbFixture.reset();
  gateway = new FakeGateway();
  clock = Date.parse('2026-09-16T12:00:00.000Z');
});
after(async () => dbFixture.cleanup());

/**
 * An orphan is a generated channel Discord still has that we have no row for,
 * or a live row whose channel Discord no longer has. Lobby and the generator
 * are bystanders, never candidates: they have no rows by design.
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

test('lifecycle: create on join, occupy, empty, delete past grace, zero orphans', async () => {
  const svc = service();

  assert.deepEqual(await orphanScan(), { channelsWithoutRows: [], rowsWithoutChannels: [] });

  // Create on join: the owner sits in the generator, Owen mints their channel.
  gateway.channels.get(GENERATOR)!.members.push(OWNER);
  const outcome = await svc.onGeneratorJoin({ guildId: GUILD, userId: OWNER, username: 'ava' });
  assert.equal(outcome.status, 'created');
  const channelId = outcome.status === 'created' ? outcome.channelId : '';
  assert.deepEqual(await gateway.occupantsOf(channelId), [OWNER], 'the joiner is moved straight in');

  // Occupy: a second member joins. Past the grace window, an occupied channel
  // must still survive the sweep.
  gateway.channels.get(channelId)!.members.push(OTHER);
  await svc.onVoiceStateChange({ guildId: GUILD, userId: OTHER, fromChannelId: null, toChannelId: channelId });
  assert.deepEqual((await gateway.occupantsOf(channelId))?.sort(), [OTHER, OWNER].sort());
  clock += 120_000;
  assert.equal((await svc.sweep(GUILD)).deleted, 0);
  assert.ok(gateway.channels.has(channelId), 'an occupied channel survives past the grace window');

  // Empty: both members leave, each departure marked through the voice-state path.
  gateway.channels.get(channelId)!.members = [OTHER];
  await svc.onVoiceStateChange({ guildId: GUILD, userId: OWNER, fromChannelId: channelId, toChannelId: null });
  gateway.channels.get(channelId)!.members = [];
  await svc.onVoiceStateChange({ guildId: GUILD, userId: OTHER, fromChannelId: channelId, toChannelId: null });
  assert.deepEqual(await gateway.occupantsOf(channelId), []);

  // Delete on empty: the first sweep starts the grace window instead of
  // deleting; the sweep past the window deletes exactly this channel.
  assert.equal((await svc.sweep(GUILD)).deleted, 0);
  assert.ok(gateway.channels.has(channelId), 'an empty channel survives inside its grace window');
  clock += 61_000;
  assert.equal((await svc.sweep(GUILD)).deleted, 1);
  assert.equal(gateway.channels.has(channelId), false, 'the channel is gone from Discord');
  assert.equal(await store.getByChannel(GUILD, channelId), null, 'the row is gone too');
  assert.equal(await store.countForGuild(GUILD), 0);
  assert.equal(
    await store.listStaleReservations(GUILD, new Date(clock).toISOString()).then((rows) => rows.length),
    0,
    'no reservation is left dangling',
  );

  // The orphan scan returns empty, and the bystanders survived the whole span.
  assert.deepEqual(await orphanScan(), { channelsWithoutRows: [], rowsWithoutChannels: [] });
  assert.ok(gateway.channels.has(LOBBY), 'Lobby survives');
  assert.ok(gateway.channels.has(GENERATOR), 'the generator survives');
  assert.deepEqual(
    gateway.deleteCalls.map((call) => call.channelId),
    [channelId],
    'the only channel ever deleted is the generated one',
  );
});
