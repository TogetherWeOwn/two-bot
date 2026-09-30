/**
 * Temporary voice channels (TOG-3052).
 *
 * The service runs against the REAL Postgres store and a fake gateway, so the
 * SQL that carries ownership is exercised by the same tests that exercise the
 * rules. A fake store would let the two drift, and ownership is the one thing
 * this feature cannot get wrong.
 *
 * The tests under "the hard invariant" are the point of this file: a channel
 * with no persisted row is never deleted. If a future change makes any of them
 * pass without the guard, the guard is gone.
 */
import assert from 'node:assert/strict';
import test, { after, beforeEach, describe } from 'node:test';
import { loadTempVoiceConfig, TEMP_VOICE_CONTROLS, type TempVoiceConfig, type TempVoiceControl } from '../src/tempVoice/config.ts';
import { filterChannelName, renderNameTemplate } from '../src/tempVoice/nameFilter.ts';
import { RenameThrottle, RENAME_MIN_INTERVAL_MS, findRenameCollision, foldChannelNameForCollision } from '../src/tempVoice/rename.ts';
import { TempVoiceStore } from '../src/tempVoice/store.ts';
import { openPostgres } from '../src/store/postgresDriver.ts';
import {
  CATEGORY_FULL_CODE,
  MISSING_PERMISSIONS_CODE,
  TEMP_VOICE_REQUIRED_PERMISSIONS,
  TempVoiceGatewayError,
  TempVoiceService,
  tempVoiceOverwrites,
  type ControlContext,
  type OverwriteFlag,
  type OverwriteSpec,
  type TempVoiceGateway,
} from '../src/tempVoice/service.ts';
import { tempVoiceCommandData, buildTempVoicePanel } from '../src/tempVoice/discord.ts';
import type { AutomodPolicy } from '../src/automod/types.ts';
import { openTestDb } from './helpers/testDb.ts';
import { log } from '../src/core/log.ts';

const GUILD = '1545644954272137297';
const GENERATOR = '1546211381844512798';
const CATEGORY = '1546211378430345200';
const LOBBY = '1546211378430345286';
const OWNER = '1546451670500642001';
const OTHER = '1546451670500642002';
const ROLE = '1546451670500642003';

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
  position?: number;
  members: string[];
  userLimit: number;
  bitrate: number;
  /** targetId -> flag -> true (allow) | false (deny). */
  overwrites: Map<string, Map<OverwriteFlag, boolean>>;
}

class FakeGateway implements TempVoiceGateway {
  channels = new Map<string, FakeChannel>();
  deleteCalls: Array<{ channelId: string; reason: string }> = [];
  moves: Array<{ userId: string; channelId: string | null }> = [];
  createCalls = 0;
  renameCalls: Array<{ channelId: string; name: string }> = [];
  failRename: Error | null = null;
  failCreate: TempVoiceGatewayError | null = null;
  unmovable = new Set<string>();
  private seq = 0;

  constructor() {
    // Lobby and the generator exist in the same category, permanently, with
    // nobody in them. Every sweep in this file therefore has the chance to
    // delete them, which is exactly the accident being guarded against.
    this.seed(LOBBY, 'Lobby');
    this.seed(GENERATOR, 'Squad');
  }

  seed(id: string, name: string, members: string[] = []): FakeChannel {
    const channel: FakeChannel = {
      id, name, categoryId: CATEGORY, members, userLimit: 0, bitrate: 64000, overwrites: new Map(),
    };
    this.channels.set(id, channel);
    return channel;
  }

  botUserId(): string { return '1469137636663758888'; }

  async createVoiceChannel(input: { guildId: string; name: string; categoryId: string; position?: number; overwrites: OverwriteSpec[] }) {
    this.createCalls++;
    if (this.failCreate) throw this.failCreate;
    const id = String(1600000000000000000n + BigInt(++this.seq));
    const channel = this.seed(id, input.name);
    channel.categoryId = input.categoryId;
    channel.position = input.position;
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
    this.moves.push({ userId, channelId });
  }

  async renameChannel(channelId: string, name: string): Promise<void> {
    this.renameCalls.push({ channelId, name });
    if (this.failRename) throw this.failRename;
    const channel = this.channels.get(channelId);
    if (!channel) throw new TempVoiceGatewayError('gone', 10003);
    channel.name = name;
  }

  async setUserLimit(channelId: string, limit: number): Promise<void> {
    this.channels.get(channelId)!.userLimit = limit;
  }

  async setBitrate(channelId: string, bitrate: number): Promise<void> {
    this.channels.get(channelId)!.bitrate = bitrate;
  }

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
    return this.channels.has(channelId) ? 1 : undefined;
  }

  async canMove(_guildId: string, userId: string): Promise<boolean> {
    return !this.unmovable.has(userId);
  }

  async maxBitrate(): Promise<number> { return 96000; }

  /** Permissions the bot is pretending NOT to hold on the category. */
  lackedPermissions = new Set<OverwriteFlag>();

  async missingPermissions(
    _guildId: string,
    _categoryId: string,
    flags: readonly OverwriteFlag[],
  ): Promise<OverwriteFlag[]> {
    return flags.filter((flag) => this.lackedPermissions.has(flag));
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

/** Create a channel for `userId` the way a real generator join would. */
async function join(svc: TempVoiceService, userId: string, username = 'owen') {
  gateway.channels.get(GENERATOR)!.members.push(userId);
  const outcome = await svc.onGeneratorJoin({ guildId: GUILD, userId, username });
  return outcome;
}

function ctx(actorId: string, actorChannelId: string | null): ControlContext {
  return { guildId: GUILD, actorId, actorChannelId };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Every button custom id on the rendered panel, in order. */
function panelCustomIds(cfg: TempVoiceConfig): string[] {
  return buildTempVoicePanel(cfg).flatMap((row) =>
    row.toJSON().components.flatMap((component) =>
      'custom_id' in component && component.custom_id ? [component.custom_id] : []));
}

beforeEach(async () => {
  await dbFixture.reset();
  gateway = new FakeGateway();
  clock = Date.parse('2026-09-16T12:00:00.000Z');
});
after(async () => dbFixture.cleanup());

// ---------------------------------------------------------------------------

describe('rolling create burst limits', () => {
  const burstConfig = () => config({ maxPerUser: 10, maxPerGuild: 40, createCooldownSeconds: 0 });

  test('allows three user creates, refuses the fourth without mutation, and recovers one slot at the window boundary', async () => {
    const svc = service(burstConfig());
    const start = clock;
    for (let i = 0; i < 3; i++) {
      clock = start + i * 10_000;
      assert.equal((await join(svc, OWNER)).status, 'created');
    }
    clock = start + 59_999;
    const refused = await join(svc, OWNER);
    assert.equal(refused.status, 'refused');
    if (refused.status === 'refused') assert.match(refused.reason, /rate limit.*3.*60/i);
    assert.equal(gateway.createCalls, 3);
    assert.equal(gateway.moves.length, 3);
    assert.equal(await store.countForGuild(GUILD), 3);
    clock = start + 60_000;
    assert.equal((await join(svc, OWNER)).status, 'created');
    assert.equal((await join(svc, OWNER)).status, 'refused', 'a rolling window does not reset every slot');
    assert.equal(gateway.createCalls, 4);
  });

  test('allows ten guild creates across users, refuses the eleventh and recovers after 60 seconds', async () => {
    const svc = service(burstConfig());
    for (let i = 0; i < 10; i++) {
      assert.equal((await join(svc, String(BigInt(OWNER) + BigInt(i)))).status, 'created');
    }
    const refused = await join(svc, ROLE);
    assert.equal(refused.status, 'refused');
    if (refused.status === 'refused') assert.match(refused.reason, /server.*rate limit.*10.*60/i);
    assert.equal(gateway.createCalls, 10);
    assert.equal(gateway.moves.length, 10);
    clock += 60_000;
    assert.equal((await join(svc, ROLE)).status, 'created');
  });

  test('rapid leave/rejoin after deletion and service restart cannot reset the user budget', async () => {
    for (let i = 0; i < 3; i++) {
      const svc = service();
      const made = await join(svc, OWNER);
      assert.equal(made.status, 'created');
      if (made.status !== 'created') return;
      await gateway.moveMember(GUILD, OWNER, null);
      assert.equal(await svc.deleteGeneratedChannel(GUILD, made.channelId, 'empty test channel'), 'deleted');
    }
    assert.equal(await store.countForOwner(GUILD, OWNER), 0);
    const restarted = new TempVoiceService({ store: new TempVoiceStore(dbFixture.db), gateway, config: config(), policy: POLICY, now });
    assert.equal((await join(restarted, OWNER)).status, 'refused');
    assert.equal(gateway.createCalls, 3);
    clock += 60_000;
    assert.equal((await join(restarted, OWNER)).status, 'created');
  });

  test('failed Discord creates release channel slots but not the burst budget', async () => {
    const svc = service(burstConfig());
    gateway.failCreate = new TempVoiceGatewayError('full', CATEGORY_FULL_CODE);
    for (let i = 0; i < 3; i++) await join(svc, OWNER);
    assert.equal(await store.countForGuild(GUILD), 0);
    gateway.failCreate = null;
    assert.equal((await join(svc, OWNER)).status, 'refused');
    assert.equal(gateway.createCalls, 3);
  });

  for (const dimension of ['user', 'guild'] as const) {
    test(`parallel joins through independent stores cannot overspend the ${dimension} budget`, async () => {
      const peerDb = await openPostgres({ connectionString: process.env.TWO_TEST_DATABASE_URL!, schema: dbFixture.schema });
      try {
        const peer = new TempVoiceService({ store: new TempVoiceStore(peerDb), gateway, config: burstConfig(), policy: POLICY, now });
        const svc = service(burstConfig());
        const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) =>
          join(i % 2 ? peer : svc, dimension === 'user' ? OWNER : String(BigInt(OWNER) + BigInt(i)))));
        const limit = dimension === 'user' ? 3 : 10;
        assert.equal(outcomes.filter((result) => result.status === 'created').length, limit);
        assert.equal(outcomes.filter((result) => result.status === 'refused').length, 12 - limit);
        assert.equal(gateway.createCalls, limit);
        assert.equal(gateway.moves.length, limit);
      } finally {
        await peerDb.close();
      }
    });
  }

  test('guild budgets are isolated even for the same user', async () => {
    const reserve = (guildId: string) => store.reserveIfUnderCaps({
      guildId, generatorId: GENERATOR, categoryId: CATEGORY, ownerId: OWNER,
      name: 'test', createdAt: new Date(clock).toISOString(),
      maxPerUser: 10, maxPerGuild: 40, cooldownSeconds: 0,
    });
    for (let i = 0; i < 3; i++) assert.equal((await reserve(GUILD)).ok, true);
    assert.equal((await reserve(GUILD)).ok, false);
    assert.equal((await reserve('1545644954272137298')).ok, true);
  });
});

describe('config', () => {
  test('canonical flag enables staging, refuses live, and overrides the legacy flag', () => {
    const env = {
      TEMP_VOICE_ENABLED: '1',
      DISCORD_GUILD_ID: GUILD,
      TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID: GENERATOR,
      TWO_TEMP_VOICE_CATEGORY_ID: CATEGORY,
    };
    assert.equal(loadTempVoiceConfig(env).enabled, true);
    assert.throws(() => loadTempVoiceConfig({ ...env, DISCORD_GUILD_ID: '1468919436503318553' }), /staging-only/);
    assert.equal(loadTempVoiceConfig({ ...env, TEMP_VOICE_ENABLED: '0', TWO_TEMP_VOICE: '1' }).enabled, false);
  });

  test('is off, and silent, when TWO_TEMP_VOICE is unset', () => {
    const cfg = loadTempVoiceConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.protectedChannelIds.size, 0);
  });

  test('refuses to load against any guild but TWO Staging', () => {
    assert.throws(
      () => loadTempVoiceConfig({
        TWO_TEMP_VOICE: '1',
        DISCORD_GUILD_ID: '326474832151838730',
        TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID: GENERATOR,
        TWO_TEMP_VOICE_CATEGORY_ID: CATEGORY,
      }),
      /staging-only/,
    );
  });

  test('protects the generator, the category, and every configured extra', () => {
    const cfg = loadTempVoiceConfig({
      TWO_TEMP_VOICE: '1',
      DISCORD_GUILD_ID: GUILD,
      TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID: GENERATOR,
      TWO_TEMP_VOICE_CATEGORY_ID: CATEGORY,
      TWO_TEMP_VOICE_PROTECTED_CHANNEL_IDS: `${LOBBY}, `,
      TWO_TEMP_VOICE_DISABLED_CONTROLS: 'bitrate,kick',
    });
    assert.deepEqual([...cfg.protectedChannelIds].sort(), [GENERATOR, CATEGORY, LOBBY].sort());
    assert.deepEqual([...cfg.disabledControls].sort(), ['bitrate', 'kick']);
  });

  test('rejects an unknown disabled control rather than silently enabling it', () => {
    assert.throws(
      () => loadTempVoiceConfig({
        TWO_TEMP_VOICE: '1',
        DISCORD_GUILD_ID: GUILD,
        TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID: GENERATOR,
        TWO_TEMP_VOICE_CATEGORY_ID: CATEGORY,
        TWO_TEMP_VOICE_DISABLED_CONTROLS: 'rename',
      }),
      /unknown controls: rename/,
    );
  });

  test('rejects a non-snowflake generator id', () => {
    assert.throws(
      () => loadTempVoiceConfig({
        TWO_TEMP_VOICE: '1',
        DISCORD_GUILD_ID: GUILD,
        TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID: 'Squad',
        TWO_TEMP_VOICE_CATEGORY_ID: CATEGORY,
      }),
      /must be a Discord snowflake/,
    );
  });
});

describe('name filtering', () => {
  const where = { guildId: GUILD, channelId: '1', userId: OWNER };

  test('shares the chat word list', () => {
    const result = filterChannelName('a badword room', POLICY, where);
    assert.equal(result.ok, false);
  });

  test('blocks an invite link even when the guild allows zero mentions', () => {
    // mentionLimit 0 would short-circuit matchAutomod on mention_spam before it
    // ever reached the invite check, if the name filter did not neutralise it.
    const result = filterChannelName('join discord.gg/abc', { ...POLICY, mentionLimit: 0 }, where);
    assert.equal(result.ok, false);
  });

  test('strips sigils and control characters instead of refusing', () => {
    const result = filterChannelName('@everyone  chill   room ', POLICY, where);
    assert.deepEqual(result, { ok: true, name: 'everyone chill room' });
  });

  test('refuses a name that is empty once cleaned', () => {
    assert.equal(filterChannelName('@@@', POLICY, where).ok, false);
  });

  test('refuses a name over 100 characters', () => {
    assert.equal(filterChannelName('x'.repeat(101), POLICY, where).ok, false);
  });

  test('renders the template', () => {
    assert.equal(renderNameTemplate("{username}'s channel", { username: 'ava', count: 1, seq: 4 }), "ava's channel");
    assert.equal(renderNameTemplate('room {seq}', { username: 'ava', count: 1, seq: 4 }), 'room 4');
  });
});

describe('rename throttling', () => {
  test('allows the first rename and queues the second', () => {
    const throttle = new RenameThrottle();
    assert.equal(throttle.request('c', 'one', 1000).apply, true);
    const second = throttle.request('c', 'two', 2000);
    assert.equal(second.apply, false);
    assert.equal(second.retryAfterMs, RENAME_MIN_INTERVAL_MS - 1000);
  });

  test('drops intermediate names, keeping only the latest', () => {
    const throttle = new RenameThrottle();
    throttle.request('c', 'one', 0);
    throttle.request('c', 'two', 1000);
    throttle.request('c', 'three', 2000);
    assert.equal(throttle.pending('c', 'one'), 'three');
  });

  test('a restart does not hand every channel a free rename', () => {
    const throttle = new RenameThrottle();
    throttle.seed('c', 1000);
    assert.equal(throttle.request('c', 'one', 2000).apply, false);
  });

  test('a rejected reservation restores the previous persisted window', () => {
    const throttle = new RenameThrottle();
    throttle.seed('c', 1000);
    const at = 1000 + RENAME_MIN_INTERVAL_MS;
    throttle.request('c', 'rejected', at);
    throttle.rejected('c', 'rejected', at);
    assert.equal(throttle.pending('c', 'original'), null);
    assert.equal(throttle.ready('c', at), true);
    assert.equal(throttle.ready('c', at - 1), false, 'rejection must not forget the earlier rename');
  });

  test('rejection preserves a newer queue and ignores a stale attempt', () => {
    const throttle = new RenameThrottle();
    throttle.request('c', 'rejected', 1000);
    throttle.request('c', 'newer', 2000);
    throttle.rejected('c', 'rejected', 1000);
    assert.equal(throttle.pending('c', 'original'), 'newer');
    assert.equal(throttle.ready('c', 2000), true);
    throttle.request('c', 'another attempt', 3000);
    throttle.rejected('c', 'rejected', 1000);
    assert.equal(throttle.pending('c', 'original'), 'another attempt');
    assert.equal(throttle.ready('c', 3001), false);
  });

  test('opens again once the window passes', () => {
    const throttle = new RenameThrottle();
    throttle.request('c', 'one', 0);
    assert.equal(throttle.ready('c', RENAME_MIN_INTERVAL_MS - 1), false);
    assert.equal(throttle.ready('c', RENAME_MIN_INTERVAL_MS), true);
  });
});

describe('creating a channel', () => {
  test('creates below the generator, in the category, and moves the member in', async () => {
    const svc = service();
    const outcome = await join(svc, OWNER, 'ava');
    assert.equal(outcome.status, 'created');
    assert.equal(outcome.status === 'created' && outcome.name, "ava's channel");

    const channel = gateway.channels.get(outcome.status === 'created' ? outcome.channelId : '')!;
    assert.equal(channel.categoryId, CATEGORY);
    assert.equal(channel.position, 1);
    assert.deepEqual(channel.members, [OWNER]);

    const row = await store.getByChannel(GUILD, channel.id);
    assert.equal(row?.ownerId, OWNER);
  });

  test('grants the owner channel-scoped powers and nothing guild-wide', async () => {
    const svc = service();
    const outcome = await join(svc, OWNER);
    assert.equal(outcome.status, 'created');
    const channel = gateway.channels.get(outcome.status === 'created' ? outcome.channelId : '')!;

    const owner = channel.overwrites.get(OWNER)!;
    assert.equal(owner.get('ManageChannels'), true);
    assert.equal(owner.get('MoveMembers'), true);
    // Explicit overwrites, never inherited: @everyone is stated, not assumed.
    assert.equal(channel.overwrites.get(GUILD)!.get('Connect'), true);
    // Administrator is not a flag this feature can even express.
    const flags = [...channel.overwrites.values()].flatMap((entry) => [...entry.keys()]);
    assert.equal(flags.includes('Administrator' as OverwriteFlag), false);
  });

  test('filters a blocked word out of the display name at create rather than minting it', async () => {
    const svc = service();
    const outcome = await join(svc, OWNER, 'a badword fan');
    assert.equal(outcome.status, 'created');
    const createdName = outcome.status === 'created' ? outcome.name : '';
    assert.doesNotMatch(createdName.toLowerCase(), /badword/, 'the channel name must not carry the blocked word');
    const channel = gateway.channels.get(outcome.status === 'created' ? outcome.channelId : '')!;
    assert.equal(channel.name, createdName);
    const row = await store.getByChannel(GUILD, channel.id);
    assert.equal(row?.name, createdName, 'the persisted row must store the filtered name, not the raw render');
  });

  test('filters an invite link out of the display name at create', async () => {
    const svc = service();
    const before = gateway.createCalls;
    const outcome = await join(svc, OWNER, 'join discord.gg/abc');
    assert.equal(outcome.status, 'created');
    const createdName = outcome.status === 'created' ? outcome.name : '';
    assert.doesNotMatch(createdName, /discord\.gg/, 'the channel name must not carry the invite link');
    assert.equal(gateway.createCalls, before + 1, 'filtering renames, it does not refuse the join');
  });

  test('refuses when the template itself violates automod instead of laundering it', async () => {
    const svc = service(config({ nameTemplate: 'badword room {seq}' }));
    const before = gateway.createCalls;
    const outcome = await join(svc, OWNER, 'ava');
    assert.equal(outcome.status, 'refused');
    assert.match(outcome.status === 'refused' ? outcome.reason : '', /not allowed/);
    assert.equal(gateway.createCalls, before, 'a blocked template must refuse before the create call, not after');
    assert.equal(await store.countForGuild(GUILD), 0, 'a blocked name must not consume the guild cap');
    const audit = await dbFixture.db.prepare(
      `SELECT reason FROM temp_voice_audit WHERE action = 'create' AND outcome = 'refused' ORDER BY created_at DESC LIMIT 1`,
    ).get<{ reason: string | null }>();
    assert.equal(audit?.reason, 'name_blocked');
  });

  test('refuses over the per-user cap BEFORE calling Discord', async () => {
    const svc = service();
    await join(svc, OWNER);
    const before = gateway.createCalls;
    const second = await join(svc, OWNER);
    assert.equal(second.status, 'refused');
    assert.equal(gateway.createCalls, before, 'anti-abuse must run before the create call, not after');
  });

  test('refuses over the per-guild cap', async () => {
    const svc = service(config({ maxPerGuild: 1 }));
    await join(svc, OWNER);
    const second = await join(svc, OTHER);
    assert.equal(second.status, 'refused');
    assert.match(second.status === 'refused' ? second.reason : '', /limit/i);
  });

  test('refuses inside the create cooldown', async () => {
    const svc = service(config({ maxPerUser: 5, createCooldownSeconds: 30 }));
    const first = await join(svc, OWNER);
    assert.equal(first.status, 'created');
    clock += 10_000;
    const second = await join(svc, OWNER);
    assert.equal(second.status, 'refused');
    clock += 30_000;
    assert.equal((await join(svc, OWNER)).status, 'created');
  });

  test('refuses cleanly when the category is full (50035) and does not spend the cap', async () => {
    const svc = service();
    gateway.failCreate = new TempVoiceGatewayError('category full', CATEGORY_FULL_CODE);
    const outcome = await join(svc, OWNER);
    assert.equal(outcome.status, 'refused');
    assert.match(outcome.status === 'refused' ? outcome.reason : '', /category is full/);
    assert.equal(await store.countForOwner(GUILD, OWNER), 0, 'a failed create must roll its reservation back');

    gateway.failCreate = null;
    assert.equal((await join(svc, OWNER)).status, 'created');
  });

  for (const recovery of ['sweep', 'restart', 'missing'] as const) {
    test(`retains provenance and cap accounting after rollback failure until ${recovery} cleanup`, async () => {
      const svc = service(config({ maxPerGuild: 1 }));
      gateway.moveMember = async () => { throw new Error('move failed'); };
      const deleteChannel = gateway.deleteChannel.bind(gateway);
      gateway.deleteChannel = async () => { throw new TempVoiceGatewayError('delete denied', MISSING_PERMISSIONS_CODE); };

      const outcome = await join(svc, OWNER);
      assert.equal(outcome.status, 'refused');
      assert.match(outcome.status === 'refused' ? outcome.reason : '', /Cleanup is pending/);
      const children = [...gateway.channels.values()].filter((channel) => ![LOBBY, GENERATOR].includes(channel.id));
      assert.equal(children.length, 1);
      const channelId = children[0].id;
      assert.equal((await store.getByChannel(GUILD, channelId))?.ownerId, OWNER,
        'a failed rollback must keep the surviving channel discoverable');
      assert.equal(await store.countForOwner(GUILD, OWNER), 1);
      assert.equal(await store.countForGuild(GUILD), 1);
      assert.equal((await join(svc, OTHER)).status, 'refused');
      assert.equal(gateway.createCalls, 1, 'retained cleanup rows must still consume the guild cap');
      const audit = await dbFixture.db.prepare(
        `SELECT outcome FROM temp_voice_audit WHERE channel_id = ? AND action = 'create_rollback'`,
      ).get<{ outcome: string }>(channelId);
      assert.equal(audit?.outcome, 'failed', 'rollback failures must not be swallowed');

      await assert.rejects(service().reconcile(GUILD), /delete denied/);
      assert.ok(await store.getByChannel(GUILD, channelId), 'a repeated cleanup failure must also retain provenance');

      gateway.deleteChannel = deleteChannel;
      const restarted = service();
      if (recovery === 'sweep') {
        await restarted.sweep(GUILD);
        clock += 60_000;
        assert.equal((await restarted.sweep(GUILD)).deleted, 1);
      } else if (recovery === 'restart') {
        assert.equal((await restarted.reconcile(GUILD)).deleted, 1);
      } else {
        gateway.channels.delete(channelId);
        assert.equal(await restarted.deleteGeneratedChannel(GUILD, channelId, 'retry rollback'), 'missing');
      }
      assert.equal(gateway.channels.has(channelId), false);
      assert.equal(await store.getByChannel(GUILD, channelId), null);
      assert.equal(await store.countForGuild(GUILD), 0);
      assert.ok(gateway.channels.has(LOBBY));
      assert.ok(gateway.channels.has(GENERATOR));
    });
  }

  test('retries a transient attachment failure before retaining a failed cleanup', async (t) => {
    const attach = store.attach.bind(store);
    let attempts = 0;
    t.mock.method(store, 'attach', async (id: string, channelId: string) => {
      if (++attempts === 1) throw new Error('transient attachment failure');
      return attach(id, channelId);
    });
    gateway.deleteChannel = async () => { throw new Error('delete unavailable'); };
    const outcome = await join(service(), OWNER);
    assert.equal(outcome.status, 'refused');
    assert.equal(attempts, 2);
    const live = await store.listLive(GUILD);
    assert.equal(live.length, 1);
    assert.ok(gateway.channels.has(live[0].channelId!));
  });

  test('does not delete an unrecorded channel when the rollback cannot persist provenance', async (t) => {
    t.mock.method(store, 'attach', async () => false);
    await assert.rejects(join(service(), OWNER), /rollback cannot persist channel/);
    assert.deepEqual(gateway.deleteCalls, []);
    assert.equal(await store.countForGuild(GUILD), 1, 'do not silently discard the reservation');
  });

  test('successful compensating deletion releases a failed move reservation', async () => {
    gateway.moveMember = async () => { throw new Error('move failed'); };
    assert.equal((await join(service(), OWNER)).status, 'refused');
    assert.equal(gateway.deleteCalls.length, 1);
    assert.equal(gateway.channels.size, 2);
    assert.equal(await store.countForGuild(GUILD), 0);
  });

  test('refuses a 50013 without telling the member to retry', async () => {
    const svc = service();
    gateway.failCreate = new TempVoiceGatewayError('missing permissions', MISSING_PERMISSIONS_CODE);
    const outcome = await join(svc, OWNER);
    assert.equal(outcome.status, 'refused');
    const reason = outcome.status === 'refused' ? outcome.reason : '';
    // Discord returns 50013 when the bot tries to grant a permission it does
    // not hold. No amount of retrying changes that, so "please try again" is
    // advice that can never work - the message has to name the real fix.
    assert.doesNotMatch(reason, /try again/i);
    assert.match(reason, /admin/i);
    assert.match(reason, /MoveMembers/);
    assert.equal(await store.countForOwner(GUILD, OWNER), 0, 'a failed create must roll its reservation back');
  });
});

describe('permission preflight', () => {
  test('the create path confers only what the bot can grant; the rest stays a category-level requirement', () => {
    const granted = new Set<OverwriteFlag>();
    for (const spec of tempVoiceOverwrites(GUILD, '1469137636663758888', OWNER)) {
      for (const flag of spec.allow ?? []) granted.add(flag);
    }
    // TOG-9541: live staging proved the bot holds ManageRoles on the category
    // yet Discord 403/50013s any create (or PATCH) whose overwrites confer it.
    // So the create path must confer exactly the required set MINUS
    // ManageRoles, while the preflight still requires all six (the owner
    // controls edit overwrites under the bot's category-level ManageRoles).
    const conferrable = [...TEMP_VOICE_REQUIRED_PERMISSIONS].filter((flag) => flag !== 'ManageRoles');
    assert.deepEqual([...granted].sort(), [...conferrable].sort());
    assert.ok(TEMP_VOICE_REQUIRED_PERMISSIONS.includes('ManageRoles'), 'controls still need the category-level grant');
  });

  for (const permission of TEMP_VOICE_REQUIRED_PERMISSIONS) {
    test(`missing ${permission} refuses before any create, move, or reservation`, async () => {
      gateway.lackedPermissions = new Set([permission]);
      const result = await join(service(), OWNER);
      assert.equal(result.status, 'refused');
      assert.match(result.status === 'refused' ? result.reason : '', new RegExp(permission));
      assert.equal(gateway.createCalls, 0);
      assert.deepEqual(gateway.moves, []);
      assert.equal(await store.countForGuild(GUILD), 0);
      assert.equal(await store.lastCreatedAt(GUILD, OWNER), null);
    });
  }

  test('no create-time overwrite confers ManageRoles — the bot cannot grant it (TOG-9541)', () => {
    const botId = gateway.botUserId();
    const overwrites = tempVoiceOverwrites(GUILD, botId, OWNER);
    assert.deepEqual(
      overwrites.filter((spec) => spec.allow?.includes('ManageRoles')),
      [],
      'conferring ManageRoles in a create fails live with 403/50013 even though preflight passes',
    );
  });

  test('names the missing permission rather than failing opaquely', async () => {
    gateway.lackedPermissions = new Set<OverwriteFlag>(['MoveMembers']);
    const result = await service().preflight(GUILD);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['MoveMembers']);
  });

  test('passes when the bot holds everything, and is a no-op when disabled', async () => {
    assert.deepEqual(await service().preflight(GUILD), { ok: true, missing: [] });
    gateway.lackedPermissions = new Set<OverwriteFlag>(['ManageChannels']);
    const off = await service(config({ enabled: false })).preflight(GUILD);
    assert.deepEqual(off, { ok: true, missing: [] }, 'a disabled feature must not report a setup fault');
  });
});

// ---------------------------------------------------------------------------
// The hard invariant. These are the tests that must fail if the guard weakens.
// ---------------------------------------------------------------------------

describe('the hard invariant: no row, no delete', () => {
  test('a channel with no persisted row is refused, and Discord is never called', async () => {
    const svc = service();
    const stranger = gateway.seed('1600000000000009999', 'somebody-elses-channel');
    const outcome = await svc.deleteGeneratedChannel(GUILD, stranger.id, 'test');
    assert.equal(outcome, 'refused');
    assert.deepEqual(gateway.deleteCalls, [], 'refusing must mean no delete call at all');
    assert.ok(gateway.channels.has(stranger.id));
  });

  test('Lobby is refused by id even if a row somehow names it', async () => {
    const svc = service();
    // Forge the worst case: a row that claims Lobby is ours.
    const claim = await store.reserveIfUnderCaps({
      guildId: GUILD, generatorId: GENERATOR, categoryId: CATEGORY, ownerId: OWNER,
      name: 'Lobby', createdAt: new Date(clock).toISOString(),
      maxPerUser: 1, maxPerGuild: 40, cooldownSeconds: 0,
    });
    assert.equal(claim.ok, true);
    assert.ok(claim.ok && await store.attach(claim.row.id, LOBBY));

    const outcome = await svc.deleteGeneratedChannel(GUILD, LOBBY, 'test');
    assert.equal(outcome, 'refused');
    assert.deepEqual(gateway.deleteCalls, []);
    assert.ok(gateway.channels.has(LOBBY), 'Lobby must survive a row that claims it');
  });

  test('the generator itself is refused', async () => {
    const svc = service();
    assert.equal(await svc.deleteGeneratedChannel(GUILD, GENERATOR, 'test'), 'refused');
    assert.ok(gateway.channels.has(GENERATOR));
  });

  test('a full sweep of an empty category deletes nothing it does not own', async () => {
    const svc = service();
    gateway.seed('1600000000000009998', 'manually made voice room');
    const report = await svc.sweep(GUILD);
    assert.equal(report.deleted, 0);
    assert.deepEqual(gateway.deleteCalls, []);
    assert.equal(gateway.channels.size, 3, 'Lobby, the generator, and the hand-made room all survive');
  });

  test('deleting is idempotent: a channel already gone is success, and the row still goes', async () => {
    const svc = service();
    const outcome = await join(svc, OWNER);
    assert.equal(outcome.status, 'created');
    const channelId = outcome.status === 'created' ? outcome.channelId : '';
    gateway.channels.delete(channelId); // somebody deleted it by hand

    assert.equal(await svc.deleteGeneratedChannel(GUILD, channelId, 'test'), 'missing');
    assert.equal(await store.getByChannel(GUILD, channelId), null);
  });
});

describe('empty grace', () => {
  async function emptyChannel(svc: TempVoiceService): Promise<string> {
    const outcome = await join(svc, OWNER);
    assert.equal(outcome.status, 'created');
    const channelId = outcome.status === 'created' ? outcome.channelId : '';
    gateway.channels.get(channelId)!.members = [];
    await svc.onVoiceStateChange({ guildId: GUILD, userId: OWNER, fromChannelId: channelId, toChannelId: null });
    return channelId;
  }

  test('an empty channel survives until the grace expires', async () => {
    const svc = service();
    const channelId = await emptyChannel(svc);
    clock += 59_000;
    assert.equal((await svc.sweep(GUILD)).deleted, 0);
    assert.ok(gateway.channels.has(channelId));

    clock += 2_000;
    assert.equal((await svc.sweep(GUILD)).deleted, 1);
    assert.equal(gateway.channels.has(channelId), false);
  });

  test('somebody rejoining inside the grace cancels the delete', async () => {
    const svc = service();
    const channelId = await emptyChannel(svc);
    clock += 30_000;
    gateway.channels.get(channelId)!.members = [OTHER];
    await svc.onVoiceStateChange({ guildId: GUILD, userId: OTHER, fromChannelId: null, toChannelId: channelId });

    clock += 120_000;
    assert.equal((await svc.sweep(GUILD)).deleted, 0);
    assert.ok(gateway.channels.has(channelId));
  });

  test('the sweep re-checks occupancy rather than trusting the stored marker', async () => {
    const svc = service();
    const channelId = await emptyChannel(svc);
    // The cache said empty; the gateway says otherwise when asked again.
    gateway.channels.get(channelId)!.members = [OTHER];
    clock += 120_000;
    assert.equal((await svc.sweep(GUILD)).deleted, 0);
    assert.ok(gateway.channels.has(channelId));
  });
});

describe('per-channel sweep failures', () => {
  for (const outcome of ['deleted', 'missing'] as const) {
    test(`audit failure after ${outcome} cleanup does not undercount or starve later channels`, async (t) => {
      const svc = service();
      const channelIds: string[] = [];
      for (const userId of [OWNER, OTHER]) {
        const created = await join(svc, userId);
        assert.equal(created.status, 'created');
        const channelId = created.status === 'created' ? created.channelId : '';
        gateway.channels.get(channelId)!.members = [];
        await svc.onVoiceStateChange({ guildId: GUILD, userId, fromChannelId: channelId, toChannelId: null });
        channelIds.push(channelId);
        clock++;
      }
      const [failedAuditId, healthyId] = channelIds;
      if (outcome === 'missing') {
        const original = gateway.deleteChannel.bind(gateway);
        t.mock.method(gateway, 'deleteChannel', async (channelId: string, reason: string) => {
          if (channelId === failedAuditId) gateway.channels.delete(channelId);
          return original(channelId, reason);
        });
      }
      const error = new Error('audit unavailable');
      const audit = store.audit.bind(store);
      t.mock.method(store, 'audit', async (...args: Parameters<TempVoiceStore['audit']>) => {
        if (args[0].channelId === failedAuditId && args[0].action === 'delete') throw error;
        return audit(...args);
      });
      const errors = t.mock.method(log, 'error', () => {});
      clock += 120_000;

      const report = await svc.sweep(GUILD);
      for (const channelId of channelIds) {
        assert.equal(gateway.channels.has(channelId), false);
        assert.equal(await store.getByChannel(GUILD, channelId), null);
      }
      assert.equal(await store.countForGuild(GUILD), 0);
      assert.deepEqual(gateway.deleteCalls.map((call) => call.channelId), [failedAuditId, healthyId]);
      assert.deepEqual(report, { adopted: 0, deleted: 2, rowsDropped: 0, reservationsDropped: 0 });
      assert.deepEqual(errors.mock.calls.map((call) => call.arguments), [
        ['temp_voice_delete_audit_failed', { guildId: GUILD, channelId: failedAuditId, outcome, err: String(error) }],
      ]);
      assert.equal((await svc.sweep(GUILD)).deleted, 0, 'completed cleanup is not retried or double-counted');
    });
  }

  for (const failure of ['deleteChannel', 'occupantsOf'] as const) {
    test(`${failure} failure retains provenance and does not starve later channels`, async (t) => {
      const svc = service();
      async function emptyGeneratedChannel(userId: string): Promise<string> {
        const outcome = await join(svc, userId);
        assert.equal(outcome.status, 'created');
        const channelId = outcome.status === 'created' ? outcome.channelId : '';
        gateway.channels.get(channelId)!.members = [];
        await svc.onVoiceStateChange({ guildId: GUILD, userId, fromChannelId: channelId, toChannelId: null });
        clock++;
        return channelId;
      }
      const failedId = await emptyGeneratedChannel(OWNER);
      const healthyId = await emptyGeneratedChannel(OTHER);
      const vanishedId = await emptyGeneratedChannel(ROLE);
      gateway.channels.delete(vanishedId);
      const unownedId = gateway.seed('1600000000000009998', 'manual room').id;

      // Even a forged provenance row must not make Lobby eligible for deletion.
      const claim = await store.reserveIfUnderCaps({
        guildId: GUILD, generatorId: GENERATOR, categoryId: CATEGORY, ownerId: '1600000000000009997',
        name: 'Lobby', createdAt: new Date(clock).toISOString(),
        maxPerUser: 1, maxPerGuild: 40, cooldownSeconds: 0,
      });
      assert.ok(claim.ok);
      assert.ok(await store.attach(claim.row.id, LOBBY));
      await store.setEmptySince(claim.row.id, new Date(clock).toISOString());
      const failedRow = await store.getByChannel(GUILD, failedId);
      const error = new TempVoiceGatewayError('Missing Permissions', MISSING_PERMISSIONS_CODE);
      if (failure === 'deleteChannel') {
        const original = gateway.deleteChannel.bind(gateway);
        t.mock.method(gateway, 'deleteChannel', async (channelId: string, reason: string) => {
          if (channelId === failedId) throw error;
          return original(channelId, reason);
        });
      } else {
        const original = gateway.occupantsOf.bind(gateway);
        t.mock.method(gateway, 'occupantsOf', async (channelId: string) => {
          if (channelId === failedId) throw error;
          return original(channelId);
        });
      }
      const errors = t.mock.method(log, 'error', () => {});
      clock += 120_000;

      assert.deepEqual(await svc.sweep(GUILD), { adopted: 0, deleted: 1, rowsDropped: 1, reservationsDropped: 0 });
      assert.deepEqual(await store.getByChannel(GUILD, failedId), failedRow, 'failure must retain the row and empty marker');
      assert.ok(gateway.channels.has(failedId));
      assert.equal(await store.getByChannel(GUILD, healthyId), null);
      assert.equal(gateway.channels.has(healthyId), false);
      assert.equal(await store.getByChannel(GUILD, vanishedId), null);

      // A consistently failing first row must not starve the next sweep either.
      const nextId = await emptyGeneratedChannel(OTHER);
      clock += 120_000;
      assert.deepEqual(await svc.sweep(GUILD), { adopted: 0, deleted: 1, rowsDropped: 0, reservationsDropped: 0 });
      assert.deepEqual(await store.getByChannel(GUILD, failedId), failedRow);
      assert.equal(await store.getByChannel(GUILD, nextId), null);
      assert.equal(gateway.channels.has(nextId), false);
      assert.deepEqual(gateway.deleteCalls.map((call) => call.channelId), [healthyId, nextId]);
      assert.ok(gateway.channels.has(LOBBY));
      assert.ok(gateway.channels.has(GENERATOR));
      assert.ok(gateway.channels.has(unownedId));
      assert.ok(await store.getByChannel(GUILD, LOBBY));
      assert.deepEqual(
        errors.mock.calls.filter((call) => call.arguments[0] === 'temp_voice_sweep_channel_failed')
          .map((call) => call.arguments[1]),
        Array.from({ length: 2 }, () => ({ guildId: GUILD, channelId: failedId, err: String(error) })),
      );

      // Once the gateway recovers, the original provenance still authorizes retry.
      t.mock.restoreAll();
      assert.equal((await svc.sweep(GUILD)).deleted, 1);
      assert.equal(await store.getByChannel(GUILD, failedId), null);
      assert.equal(gateway.channels.has(failedId), false);
    });
  }
});

describe('boot reconcile', () => {
  test('re-adopts a channel that still has somebody in it', async () => {
    const first = service();
    const outcome = await join(first, OWNER);
    assert.equal(outcome.status, 'created');
    const channelId = outcome.status === 'created' ? outcome.channelId : '';

    // Restart: brand new service, same database, same fake Discord.
    const restarted = service();
    const report = await restarted.reconcile(GUILD);
    assert.deepEqual(report, { adopted: 1, deleted: 0, rowsDropped: 0, reservationsDropped: 0 });
    assert.ok(gateway.channels.has(channelId), 'an occupied channel must survive a restart');
    assert.equal((await store.getByChannel(GUILD, channelId))?.ownerId, OWNER);

    // And it is still controllable afterwards - no ghost row, no orphan channel.
    const renamed = await restarted.rename(ctx(OWNER, channelId), 'after restart');
    assert.equal(renamed.status, 'ok');
    assert.equal(gateway.channels.get(channelId)!.name, 'after restart');
  });

  test('a restart does not hand back a rename the owner already spent', async () => {
    const first = service();
    const outcome = await join(first, OWNER);
    const channelId = outcome.status === 'created' ? outcome.channelId : '';
    assert.equal((await first.rename(ctx(OWNER, channelId), 'spent')).status, 'ok');

    clock += 60_000;
    const restarted = service();
    await restarted.reconcile(GUILD);
    const queued = await restarted.rename(ctx(OWNER, channelId), 'sneaky');
    assert.match(queued.message, /queued/);
    assert.equal(gateway.channels.get(channelId)!.name, 'spent');
  });

  test('drops the row for a channel that vanished while we were down', async () => {
    const svc = service();
    const outcome = await join(svc, OWNER);
    const channelId = outcome.status === 'created' ? outcome.channelId : '';
    gateway.channels.delete(channelId);

    const report = await service().reconcile(GUILD);
    assert.equal(report.rowsDropped, 1);
    assert.deepEqual(gateway.deleteCalls, [], 'a vanished channel needs no delete call');
    assert.equal(await store.getByChannel(GUILD, channelId), null);
  });

  test('deletes a channel that emptied while we were down', async () => {
    const svc = service();
    const outcome = await join(svc, OWNER);
    const channelId = outcome.status === 'created' ? outcome.channelId : '';
    gateway.channels.get(channelId)!.members = [];

    const report = await service().reconcile(GUILD);
    assert.equal(report.deleted, 1);
    assert.equal(gateway.channels.has(channelId), false);
  });

  test('drops a stale reservation without deleting anything', async () => {
    const claim = await store.reserveIfUnderCaps({
      guildId: GUILD, generatorId: GENERATOR, categoryId: CATEGORY, ownerId: OWNER,
      name: 'never attached', createdAt: new Date(clock).toISOString(),
      maxPerUser: 1, maxPerGuild: 40, cooldownSeconds: 0,
    });
    assert.equal(claim.ok, true);
    clock += 10 * 60 * 1000;

    const report = await service().reconcile(GUILD);
    assert.equal(report.reservationsDropped, 1);
    assert.deepEqual(gateway.deleteCalls, [], 'a possible orphan is leaked deliberately, never guessed at');
    assert.equal(await store.countForOwner(GUILD, OWNER), 0);
  });
});

describe('owner controls', () => {
  let svc: TempVoiceService;
  let channelId: string;

  async function setup(cfg: TempVoiceConfig = config()) {
    svc = service(cfg);
    const outcome = await join(svc, OWNER);
    assert.equal(outcome.status, 'created');
    channelId = outcome.status === 'created' ? outcome.channelId : '';
  }

  test('every control is reachable from both the panel and /voice', () => {
    const [command] = tempVoiceCommandData() as Array<{ name: string; options: Array<{ name: string }> }>;
    const subcommands = new Set(command.options.map((option) => option.name));
    const buttons = new Set(panelCustomIds(config()).map((id) => id.split(':').pop()));
    for (const control of TEMP_VOICE_CONTROLS) {
      assert.ok(subcommands.has(control), `/voice ${control} is missing`);
      assert.ok(buttons.has(control), `the ${control} button is missing`);
    }
  });

  test('a disabled control drops off the panel and is refused by the service', async () => {
    const cfg = config({ disabledControls: new Set<TempVoiceControl>(['kick']) });
    await setup(cfg);
    assert.equal(panelCustomIds(cfg).some((id) => id.endsWith(':kick')), false);

    gateway.channels.get(channelId)!.members.push(OTHER);
    const outcome = await svc.kick(ctx(OWNER, channelId), OTHER);
    assert.equal(outcome.status, 'refused');
    assert.match(outcome.message, /disabled/);
  });

  test('a non-owner is refused', async () => {
    await setup();
    gateway.channels.get(channelId)!.members.push(OTHER);
    const outcome = await svc.lock(ctx(OTHER, channelId), true);
    assert.equal(outcome.status, 'refused');
    assert.equal(gateway.channels.get(channelId)!.overwrites.get(GUILD)!.get('Connect'), true);
  });

  test('a control outside a generated channel is a no-op, not an error', async () => {
    await setup();
    assert.equal((await svc.lock(ctx(OWNER, LOBBY), true)).status, 'noop');
    assert.equal((await svc.lock(ctx(OWNER, null), true)).status, 'noop');
    assert.equal(gateway.channels.get(LOBBY)!.overwrites.size, 0);
  });

  test('lock and hide compose without clobbering each other', async () => {
    await setup();
    await svc.lock(ctx(OWNER, channelId), true);
    await svc.hide(ctx(OWNER, channelId), true);
    const everyone = gateway.channels.get(channelId)!.overwrites.get(GUILD)!;
    assert.equal(everyone.get('Connect'), false);
    assert.equal(everyone.get('ViewChannel'), false);

    await svc.hide(ctx(OWNER, channelId), false);
    assert.equal(everyone.get('ViewChannel'), true);
    assert.equal(everyone.get('Connect'), false, 'revealing must not silently unlock');
  });

  test('limit and bitrate are bounded', async () => {
    await setup();
    assert.equal((await svc.setLimit(ctx(OWNER, channelId), 100)).status, 'refused');
    assert.equal((await svc.setLimit(ctx(OWNER, channelId), 5)).status, 'ok');
    assert.equal(gateway.channels.get(channelId)!.userLimit, 5);
    assert.equal((await svc.setBitrate(ctx(OWNER, channelId), 999999)).status, 'refused');
    assert.equal((await svc.setBitrate(ctx(OWNER, channelId), 96000)).status, 'ok');
  });

  test('renaming is throttled rather than left to hang on Discord', async () => {
    await setup();
    assert.equal((await svc.rename(ctx(OWNER, channelId), 'first')).status, 'ok');
    assert.equal(gateway.channels.get(channelId)!.name, 'first');

    clock += 60_000;
    const queued = await svc.rename(ctx(OWNER, channelId), 'second');
    assert.equal(queued.status, 'ok');
    assert.match(queued.message, /queued/);
    assert.equal(gateway.channels.get(channelId)!.name, 'first', 'the second rename must not reach Discord yet');

    clock += RENAME_MIN_INTERVAL_MS;
    await svc.sweep(GUILD);
    assert.equal(gateway.channels.get(channelId)!.name, 'second', 'the queued name lands once the window opens');
  });

  test('a definitively rejected rename is never applied by later sweeps', async () => {
    await setup();
    const before = await store.getByChannel(GUILD, channelId);
    gateway.failRename = new TempVoiceGatewayError('Missing Permissions', MISSING_PERMISSIONS_CODE);
    await assert.rejects(svc.rename(ctx(OWNER, channelId), 'rejected'), gateway.failRename);
    assert.equal((await store.getByChannel(GUILD, channelId))?.name, before?.name);
    assert.equal((await store.getByChannel(GUILD, channelId))?.lastRenamedAt, null);

    gateway.failRename = null;
    for (let i = 0; i < 3; i++) {
      clock += RENAME_MIN_INTERVAL_MS;
      await svc.sweep(GUILD);
    }
    assert.equal(gateway.channels.get(channelId)!.name, before?.name);
    assert.deepEqual(gateway.renameCalls, [{ channelId, name: 'rejected' }], 'a failed request is not queued');
  });

  test('a definitively rejected rename spends no throttle budget after permissions recover', async () => {
    await setup();
    gateway.failRename = new TempVoiceGatewayError('Missing Permissions', MISSING_PERMISSIONS_CODE);
    await assert.rejects(svc.rename(ctx(OWNER, channelId), 'rejected'), gateway.failRename);
    gateway.failRename = null;

    const valid = await svc.rename(ctx(OWNER, channelId), 'valid');
    assert.match(valid.message, /Renamed to/);
    assert.equal(gateway.channels.get(channelId)!.name, 'valid');
    assert.equal((await store.getByChannel(GUILD, channelId))?.lastRenamedAt, new Date(clock).toISOString());
    assert.match((await svc.rename(ctx(OWNER, channelId), 'next')).message, /queued/, 'the successful rename still spends its window');
  });

  test('a definitively rejected queued rename is discarded when the sweep flush fails', async () => {
    await setup();
    await svc.rename(ctx(OWNER, channelId), 'first');
    const before = await store.getByChannel(GUILD, channelId);
    clock += 60_000;
    assert.match((await svc.rename(ctx(OWNER, channelId), 'rejected')).message, /queued/);
    gateway.failRename = new TempVoiceGatewayError('Missing Permissions', MISSING_PERMISSIONS_CODE);
    clock += RENAME_MIN_INTERVAL_MS;
    await svc.sweep(GUILD);
    assert.equal((await store.getByChannel(GUILD, channelId))?.lastRenamedAt, before?.lastRenamedAt);
    gateway.failRename = null;
    clock += RENAME_MIN_INTERVAL_MS;
    await svc.sweep(GUILD);
    assert.equal(gateway.channels.get(channelId)!.name, 'first');
    assert.equal(gateway.renameCalls.length, 2, 'a definitive flush failure is never retried');
    assert.match((await svc.rename(ctx(OWNER, channelId), 'valid')).message, /Renamed to/);
  });

  test('other definitive Discord rename refusals also discard intent', async () => {
    await setup();
    for (const code of [10003, 50001, 50035]) {
      gateway.failRename = new TempVoiceGatewayError('definitive refusal', code);
      await assert.rejects(svc.rename(ctx(OWNER, channelId), 'rejected'), gateway.failRename);
      gateway.failRename = null;
      clock += RENAME_MIN_INTERVAL_MS;
      await svc.sweep(GUILD);
      assert.equal(gateway.channels.get(channelId)!.name, "owen's channel");
    }
    assert.equal(gateway.renameCalls.length, 3);
  });

  test('an unclassified Discord rename error is conservatively throttled', async () => {
    await setup();
    gateway.failRename = new TempVoiceGatewayError('rate limited', 429);
    await assert.rejects(svc.rename(ctx(OWNER, channelId), 'uncertain'), gateway.failRename);
    gateway.failRename = null;
    assert.match((await svc.rename(ctx(OWNER, channelId), 'latest')).message, /queued/);
    await svc.sweep(GUILD);
    assert.equal(gateway.renameCalls.length, 1);
    clock += RENAME_MIN_INTERVAL_MS;
    await svc.sweep(GUILD);
    assert.equal(gateway.channels.get(channelId)!.name, 'latest');
  });

  test('an ambiguous direct rename failure retains conservative throttling and latest intent', async () => {
    await setup();
    gateway.failRename = new TempVoiceGatewayError('connection reset after sending', null);
    await assert.rejects(svc.rename(ctx(OWNER, channelId), 'uncertain'), gateway.failRename);
    gateway.failRename = null;
    clock += 60_000;
    await svc.sweep(GUILD);
    assert.equal(gateway.renameCalls.length, 1);
    assert.match((await svc.rename(ctx(OWNER, channelId), 'latest')).message, /queued/);
    clock += RENAME_MIN_INTERVAL_MS - 60_000;
    await svc.sweep(GUILD);
    assert.equal(gateway.channels.get(channelId)!.name, 'latest');
    assert.deepEqual(gateway.renameCalls.map((call) => call.name), ['uncertain', 'latest']);
  });

  test('an ambiguous sweep rename failure reserves a window before another retry', async () => {
    await setup();
    await svc.rename(ctx(OWNER, channelId), 'first');
    clock += 60_000;
    await svc.rename(ctx(OWNER, channelId), 'queued');
    clock += RENAME_MIN_INTERVAL_MS - 60_000;
    gateway.failRename = new Error('connection reset after sending');
    await svc.sweep(GUILD);
    assert.equal(gateway.renameCalls.length, 2);
    clock += RENAME_MIN_INTERVAL_MS - 1;
    await svc.sweep(GUILD);
    assert.equal(gateway.renameCalls.length, 2, 'an ambiguous failure may have spent a Discord rename');
    gateway.failRename = null;
    clock += 1;
    await svc.sweep(GUILD);
    assert.equal(gateway.channels.get(channelId)!.name, 'queued');
    assert.equal(gateway.renameCalls.length, 3);
  });

  test('a filtered name never reaches Discord', async () => {
    await setup();
    const outcome = await svc.rename(ctx(OWNER, channelId), 'badword lounge');
    assert.equal(outcome.status, 'refused');
    assert.notEqual(gateway.channels.get(channelId)!.name, 'badword lounge');
  });

  test('renaming onto a sibling channel name is refused with a named error, never a duplicate', async () => {
    // One service, like production: a single shared throttle sees every queue.
    await setup(config({ maxPerUser: 5 }));
    const second = await join(svc, OTHER, 'other-champion');
    assert.equal(second.status, 'created');
    const otherId = second.status === 'created' ? second.channelId : '';
    const before = gateway.channels.get(channelId)!.name;

    // The generator template renders "{username}'s channel", so the sibling
    // holds "other-champion's channel", not the bare username.
    const outcome = await svc.rename(ctx(OWNER, channelId), "other-champion's channel");
    assert.equal(outcome.status, 'refused');
    assert.match(outcome.message, /already named/, 'the refusal must name the collision');
    assert.match(outcome.message, /other-champion/);
    assert.equal(gateway.channels.get(channelId)!.name, before, 'a colliding rename must not reach Discord');
    assert.equal(gateway.channels.get(otherId)!.name, "other-champion's channel", 'the sibling keeps its name');
  });

  test('a collision check is case-insensitive and fullwidth-folded', async () => {
    await setup(config({ maxPerUser: 5 }));
    const second = await join(svc, OTHER, 'Squad Alpha');
    assert.equal(second.status, 'created');

    // Sibling holds "Squad Alpha's channel" (template-rendered); case,
    // fullwidth, and the fullwidth apostrophe (NFKC-folds to ') all collide.
    assert.equal((await svc.rename(ctx(OWNER, channelId), "SQUAD ALPHA'S CHANNEL")).status, 'refused');
    assert.equal((await svc.rename(ctx(OWNER, channelId), 'Ｓｑｕａｄ Ａｌｐｈａ＇ｓ ｃｈａｎｎｅｌ')).status, 'refused');
    assert.equal(gateway.channels.get(channelId)!.name, "owen's channel");
  });

  test('renaming to the channel’s own current name is not a collision', async () => {
    await setup();
    assert.equal((await svc.rename(ctx(OWNER, channelId), 'first')).status, 'ok');
    clock += RENAME_MIN_INTERVAL_MS;
    assert.equal((await svc.rename(ctx(OWNER, channelId), 'first')).status, 'ok');
    assert.equal(gateway.channels.get(channelId)!.name, 'first');
  });

  test('a refused collision spends no throttle budget', async () => {
    await setup(config({ maxPerUser: 5 }));
    assert.equal((await join(svc, OTHER, 'room two')).status, 'created');

    assert.equal((await svc.rename(ctx(OWNER, channelId), "room two's channel")).status, 'refused');
    const outcome = await svc.rename(ctx(OWNER, channelId), 'fresh start');
    assert.equal(outcome.status, 'ok');
    assert.equal(gateway.channels.get(channelId)!.name, 'fresh start');
  });

  test('unicode names survive the rename round trip', async () => {
    await setup();
    const names = ['日本語ラウンジ', 'squad Café ☕', 'комната отдыха'];
    for (const [index, name] of names.entries()) {
      if (index > 0) clock += RENAME_MIN_INTERVAL_MS;
      const outcome = await svc.rename(ctx(OWNER, channelId), name);
      assert.equal(outcome.status, 'ok', JSON.stringify(name));
      assert.equal(gateway.channels.get(channelId)!.name, name);
      assert.equal((await store.getByChannel(GUILD, channelId))?.name, name, 'the persisted row must store the exact name');
    }
  });

  test('a name another channel queued but has not landed yet still collides', async () => {
    await setup(config({ maxPerUser: 5 }));
    const second = await join(svc, OTHER, 'starter name');
    assert.equal(second.status, 'created');
    const otherId = second.status === 'created' ? second.channelId : '';
    // Queue "claimed" on the other channel: throttled, so Discord still holds
    // the old name while the shared throttle holds the new one.
    assert.equal((await svc.rename(ctx(OTHER, otherId), 'first pick')).status, 'ok');
    clock += 60_000;
    const queued = await svc.rename(ctx(OTHER, otherId), 'claimed');
    assert.equal(queued.status, 'ok');
    assert.match(queued.message, /queued/);

    assert.equal((await svc.rename(ctx(OWNER, channelId), 'claimed')).status, 'refused');
  });

  test('a queued rename a new channel takes in the meantime is dropped, never landed as a duplicate', async () => {
    await setup(config({ maxPerUser: 5 }));
    assert.equal((await svc.rename(ctx(OWNER, channelId), 'first pick')).status, 'ok');
    clock += 60_000;
    const queued = await svc.rename(ctx(OWNER, channelId), "ava's channel");
    assert.equal(queued.status, 'ok');
    assert.match(queued.message, /queued/);
    // A new member joins; the create template renders the same name the owner
    // queued. The create path does not collision-check, so the queued flush
    // must yield rather than land a duplicate.
    assert.equal((await join(svc, OTHER, 'ava')).status, 'created');

    clock += RENAME_MIN_INTERVAL_MS;
    await svc.sweep(GUILD);
    const live = [...gateway.channels.values()].filter((channel) => ![LOBBY, GENERATOR].includes(channel.id));
    assert.equal(
      live.filter((channel) => channel.name === "ava's channel").length,
      1,
      'exactly one channel may hold the name',
    );
    assert.equal(gateway.channels.get(channelId)!.name, 'first pick', 'the queued rename is dropped, not landed');
  });

  test('reject removes a member who is already inside', async () => {
    await setup();
    gateway.channels.get(channelId)!.members.push(OTHER);
    const outcome = await svc.reject(ctx(OWNER, channelId), { id: OTHER, type: 'member' });
    assert.equal(outcome.status, 'ok');
    assert.equal(gateway.channels.get(channelId)!.overwrites.get(OTHER)!.get('Connect'), false);
    assert.equal(gateway.channels.get(channelId)!.members.includes(OTHER), false);
  });

  test('permit works for a role as well as a member', async () => {
    await setup();
    assert.equal((await svc.permit(ctx(OWNER, channelId), { id: ROLE, type: 'role' })).status, 'ok');
    assert.equal(gateway.channels.get(channelId)!.overwrites.get(ROLE)!.get('Connect'), true);
  });

  test('kick refuses a member the bot cannot move, instead of 403ing', async () => {
    await setup();
    gateway.channels.get(channelId)!.members.push(OTHER);
    gateway.unmovable.add(OTHER);
    const outcome = await svc.kick(ctx(OWNER, channelId), OTHER);
    assert.equal(outcome.status, 'refused');
    assert.match(outcome.message, /outrank/);
    assert.ok(gateway.channels.get(channelId)!.members.includes(OTHER));
  });

  test('kick is scoped to members actually in the channel', async () => {
    await setup();
    assert.equal((await svc.kick(ctx(OWNER, channelId), OTHER)).status, 'noop');
  });

  test('claim is refused while the owner is still present, and works once they leave', async () => {
    await setup();
    const channel = gateway.channels.get(channelId)!;
    channel.members.push(OTHER);
    assert.equal((await svc.claim(ctx(OTHER, channelId))).status, 'refused');

    channel.members = [OTHER];
    const claimed = await svc.claim(ctx(OTHER, channelId));
    assert.equal(claimed.status, 'ok');
    assert.equal((await store.getByChannel(GUILD, channelId))?.ownerId, OTHER);
    assert.equal(channel.overwrites.get(OTHER)!.get('ManageChannels'), true);
    assert.equal(channel.overwrites.has(OWNER), false, 'exactly one member holds the owner grant');
  });

  test('transfer only goes to somebody in the channel', async () => {
    await setup();
    assert.equal((await svc.transfer(ctx(OWNER, channelId), OTHER)).status, 'refused');
    gateway.channels.get(channelId)!.members.push(OTHER);
    assert.equal((await svc.transfer(ctx(OWNER, channelId), OTHER)).status, 'ok');
    assert.equal((await store.getByChannel(GUILD, channelId))?.ownerId, OTHER);
  });

  for (const action of ['claim', 'transfer'] as const) {
    test(`serializes simultaneous ${action}s across independent stores and connection pools`, { timeout: 5000 }, async (t) => {
      await setup();
      const third = '1546451670500642004';
      const channel = gateway.channels.get(channelId)!;
      channel.members = action === 'claim' ? [OTHER, third] : [OWNER, OTHER, third];
      const peerDb = await openPostgres({ connectionString: process.env.TWO_TEST_DATABASE_URL!, schema: dbFixture.schema, max: 2 });
      t.after(() => peerDb.close());
      const peer = new TempVoiceService({ store: new TempVoiceStore(peerDb), gateway, config: config(), policy: POLICY, now });
      const entered = deferred();
      const release = deferred();
      t.after(() => release.resolve());
      const apply = gateway.applyOverwrite.bind(gateway);
      t.mock.method(gateway, 'applyOverwrite', async (id: string, spec: OverwriteSpec) => {
        if (spec.id === OTHER) {
          entered.resolve();
          await release.promise;
        }
        await apply(id, spec);
      });
      const first = action === 'claim' ? svc.claim(ctx(OTHER, channelId)) : svc.transfer(ctx(OWNER, channelId), OTHER);
      await entered.promise;
      let second;
      try {
        second = action === 'claim' ? await peer.claim(ctx(third, channelId)) : await peer.transfer(ctx(OWNER, channelId), third);
      } finally {
        release.resolve();
      }
      const outcomes = [await first, second];
      assert.equal(outcomes.filter((outcome) => outcome.status === 'ok').length, 1);
      const owners = [...channel.overwrites].filter(([id, flags]) =>
        id !== gateway.botUserId() && (flags.get('ManageChannels') || flags.get('MoveMembers'))).map(([id]) => id);
      assert.deepEqual(owners, [OTHER], 'exactly one member may hold owner permissions');
      assert.equal((await store.getByChannel(GUILD, channelId))?.ownerId, OTHER);
      assert.equal((await peer.claim(ctx(third, channelId))).status, 'refused', 'revalidate the persisted winner after lock release');
      assert.equal((await peer.transfer(ctx(OWNER, channelId), third)).status, 'refused', 'the old owner loses transfer authority');
    });
  }

  for (const failure of ['revoke-before', 'revoke-after', 'grant-before', 'grant-after', 'finalize', 'finalize-stale'] as const) {
    for (const recovery of ['sweep', 'reconcile'] as const) {
      test(`${recovery} recovers a durable ownership intent after ${failure} failure`, async (t) => {
        await setup();
        const channel = gateway.channels.get(channelId)!;
        channel.members = [OWNER, OTHER];
        const clear = gateway.clearOverwrite.bind(gateway);
        const apply = gateway.applyOverwrite.bind(gateway);
        const complete = store.completeOwnerChange.bind(store);
        let failing = true;
        const assertSingleOwner = () => {
          const owners = [...channel.overwrites].filter(([id, flags]) =>
            id !== gateway.botUserId() && (flags.get('ManageChannels') || flags.get('MoveMembers')));
          assert.ok(owners.length <= 1, 'never grant two members owner permissions, even between calls');
        };
        t.mock.method(gateway, 'clearOverwrite', async (id: string, target: string) => {
          assert.equal((await store.getByChannel(GUILD, id))?.pendingOwnerId, OTHER,
            'intent must already be committed and visible on another connection before Discord mutation');
          if (failing && failure === 'revoke-before') throw new Error('revoke denied');
          await clear(id, target);
          assertSingleOwner();
          if (failing && failure === 'revoke-after') throw new Error('revoke response lost');
        });
        t.mock.method(gateway, 'applyOverwrite', async (id: string, spec: OverwriteSpec) => {
          assert.equal(channel.overwrites.has(OWNER), false, 'remove the old grant before adding the new one');
          if (failing && failure === 'grant-before') throw new Error('grant denied');
          await apply(id, spec);
          assertSingleOwner();
          if (failing && failure === 'grant-after') throw new Error('grant response lost');
        });
        t.mock.method(store, 'completeOwnerChange', async (id: string, oldOwner: string, target: string) => {
          if (failing && failure === 'finalize') throw new Error('database finalization unavailable');
          if (failing && failure === 'finalize-stale') return false;
          return complete(id, oldOwner, target);
        });

        const outcome = await svc.transfer(ctx(OWNER, channelId), OTHER);
        assert.equal(outcome.status, 'refused', 'a partial transition must not claim success');
        assert.match(outcome.message, /recovery/);
        const pending = await store.getByChannel(GUILD, channelId);
        assert.equal(pending?.ownerId, OWNER);
        assert.equal(pending?.pendingOwnerId, OTHER);
        assertSingleOwner();
        assert.equal((await svc.lock(ctx(OWNER, channelId), true)).status, 'refused');
        assert.equal((await svc.claim(ctx(OTHER, channelId))).status, 'refused');
        assert.equal((await svc.transfer(ctx(OWNER, channelId), '1546451670500642004')).status, 'refused');
        const audit = await dbFixture.db.prepare(
          `SELECT outcome FROM temp_voice_audit WHERE channel_id = ? AND action = 'owner_change'`,
        ).get<{ outcome: string }>(channelId);
        assert.equal(audit?.outcome, 'pending');

        failing = false;
        const restarted = new TempVoiceService({ store: new TempVoiceStore(dbFixture.db), gateway, config: config(), policy: POLICY, now });
        await restarted[recovery](GUILD);
        const recovered = await store.getByChannel(GUILD, channelId);
        assert.equal(recovered?.ownerId, OTHER);
        assert.equal(recovered?.pendingOwnerId, null);
        assert.equal(channel.overwrites.has(OWNER), false);
        assert.equal(channel.overwrites.get(OTHER)?.get('ManageChannels'), true);
        assert.equal(channel.overwrites.get(OTHER)?.get('MoveMembers'), true);
        assert.equal(channel.overwrites.get(OTHER)?.has('ManageRoles'), false);
        assertSingleOwner();
        await restarted[recovery](GUILD);
        assert.equal((await store.getByChannel(GUILD, channelId))?.ownerId, OTHER);
      });
    }
  }

  test('restart resumes a committed intent even if the worker never recorded its failure', async () => {
    await setup();
    const channel = gateway.channels.get(channelId)!;
    channel.members = [OTHER];
    const row = (await store.getByChannel(GUILD, channelId))!;
    assert.equal(await store.beginOwnerChange(row.id, OWNER, OTHER), true);
    await gateway.clearOverwrite(channelId, OWNER);
    await gateway.applyOverwrite(channelId, { id: OTHER, type: 'member', allow: ['ManageChannels', 'MoveMembers'] });
    // The worker died here, before database finalization or an error handler.
    const restarted = new TempVoiceService({ store: new TempVoiceStore(dbFixture.db), gateway, config: config(), policy: POLICY, now });
    await restarted.reconcile(GUILD);
    const recovered = await store.getByChannel(GUILD, channelId);
    assert.equal(recovered?.ownerId, OTHER);
    assert.equal(recovered?.pendingOwnerId, null);
    assert.equal(channel.overwrites.has(OWNER), false);
  });

  test('a recovery worker shares the ownership lock with a new claim', { timeout: 5000 }, async (t) => {
    await setup();
    const third = '1546451670500642004';
    gateway.channels.get(channelId)!.members = [OTHER, third];
    const row = (await store.getByChannel(GUILD, channelId))!;
    assert.equal(await store.beginOwnerChange(row.id, OWNER, OTHER), true);
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const apply = gateway.applyOverwrite.bind(gateway);
    t.mock.method(gateway, 'applyOverwrite', async (id: string, spec: OverwriteSpec) => {
      entered.resolve();
      await release.promise;
      await apply(id, spec);
    });
    const recovering = service().reconcile(GUILD);
    await entered.promise;
    try {
      const attempted = await service().claim(ctx(third, channelId));
      assert.equal(attempted.status, 'refused');
      assert.match(attempted.message, /in progress/);
    } finally {
      release.resolve();
      await recovering;
    }
    assert.equal((await store.getByChannel(GUILD, channelId))?.ownerId, OTHER);
    assert.equal(gateway.channels.get(channelId)!.overwrites.has(third), false);
  });

  test('claim revalidates that the actor is still connected', async () => {
    await setup();
    gateway.channels.get(channelId)!.members = [];
    assert.equal((await svc.claim(ctx(OTHER, channelId))).status, 'refused');
    assert.equal((await store.getByChannel(GUILD, channelId))?.ownerId, OWNER);
  });

  test('controls are inert while the feature is off', async () => {
    await setup();
    const off = service(config({ enabled: false }));
    assert.equal((await off.lock(ctx(OWNER, channelId), true)).status, 'noop');
    assert.equal(gateway.channels.get(channelId)!.overwrites.get(GUILD)!.get('Connect'), true);
    assert.equal((await off.sweep(GUILD)).deleted, 0);
    assert.deepEqual(gateway.deleteCalls, []);
  });
});

describe('anti-abuse under a race', () => {
  test('different users cannot overbook the last guild slot', async () => {
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      store.reserveIfUnderCaps({
        guildId: GUILD,
        generatorId: GENERATOR,
        categoryId: CATEGORY,
        ownerId: `${OWNER}${i}`,
        name: 'last guild slot',
        createdAt: new Date(clock).toISOString(),
        maxPerUser: 1,
        maxPerGuild: 1,
        cooldownSeconds: 0,
      }),
    ));
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    assert.equal(outcomes.filter((outcome) => !outcome.ok && outcome.reason === 'guild_cap').length, 11);
    assert.equal(await store.countForGuild(GUILD), 1);
  });

  test('two simultaneous joins cannot both win the last slot', async () => {
    const svc = service(config({ maxPerUser: 1 }));
    gateway.channels.get(GENERATOR)!.members.push(OWNER);
    const [a, b] = await Promise.all([
      svc.onGeneratorJoin({ guildId: GUILD, userId: OWNER, username: 'ava' }),
      svc.onGeneratorJoin({ guildId: GUILD, userId: OWNER, username: 'ava' }),
    ]);
    const created = [a, b].filter((outcome) => outcome.status === 'created');
    assert.equal(created.length, 1, 'the cap is an atomic claim, not a check followed by an act');
    assert.equal(await store.countForOwner(GUILD, OWNER), 1);
  });
});
