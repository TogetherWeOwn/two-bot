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
import { RenameThrottle, RENAME_MIN_INTERVAL_MS } from '../src/tempVoice/rename.ts';
import { TempVoiceStore } from '../src/tempVoice/store.ts';
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

describe('config', () => {
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
  test('the required set is exactly what the overwrites grant', () => {
    const granted = new Set<OverwriteFlag>();
    for (const spec of tempVoiceOverwrites(GUILD, '1469137636663758888', OWNER)) {
      for (const flag of spec.allow ?? []) granted.add(flag);
    }
    // Drift here is the 50013 above, deferred until a member hits the
    // generator in production. Any flag added to the overwrites is a flag the
    // bot must hold, and therefore a flag the preflight must check.
    assert.deepEqual([...granted].sort(), [...TEMP_VOICE_REQUIRED_PERMISSIONS].sort());
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

  test('ManageRoles belongs only to the bot channel overwrite, not the owner', () => {
    const botId = gateway.botUserId();
    const overwrites = tempVoiceOverwrites(GUILD, botId, OWNER);
    assert.deepEqual(overwrites.filter((spec) => spec.allow?.includes('ManageRoles')).map((spec) => spec.id), [botId]);
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

  test('a filtered name never reaches Discord', async () => {
    await setup();
    const outcome = await svc.rename(ctx(OWNER, channelId), 'badword lounge');
    assert.equal(outcome.status, 'refused');
    assert.notEqual(gateway.channels.get(channelId)!.name, 'badword lounge');
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
