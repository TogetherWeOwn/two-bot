/**
 * Contained dispatcher boundary + pre-datastore boot rejections (TOG-3903).
 *
 * Under `BotDeps.stagingRestart` the gateway dispatcher is acceptance-only:
 * every event for an unknown/nonallowlisted actor or a wrong guild is dropped
 * BEFORE ordinary handler/observer calls. Invite snapshots (ready/join/invite),
 * all audit recording (including raw/moderation/member_update/voice), automod
 * inspection/edits, raid/join-risk, and downstream automation emission are all
 * suppressed. Known synthetic join/gate/message/voice/leave flow through the
 * ordinary handlers plus the rota observer (no welcome registration, so
 * `promptShown` is never involved).
 *
 * The real boot (`src/index.ts`) parses the synthetic allowlist and requires
 * explicit community staging-guild classification BEFORE `openDb`, even with
 * the rota master off; a nonempty containment flag other than exactly '0'/'1'
 * is refused before anything else. The spawn tests below prove those
 * rejections happen before `datastore_open` using the existing fake-env spawn
 * pattern (fixture token bindings, loopback database URL that is never
 * opened, no network, no HTTP mutation).
 *
 * Fixture guild/actor ids for the dispatcher doubles; the firewall pins the
 * real TWO staging guild id internally, so the firewall test uses it as the
 * allowlisted guild. This file never claims actual staging execution — every
 * boot below refuses before the datastore opens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { AuditLogEvent, Events, type Client } from 'discord.js';
import { registerHandlers } from '../src/discord/client.ts';
import type { FunnelHandlers } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';
import {
  checkStagingRestartPreflight,
  STAGING_RESTART_CONTAINMENT_FLAG,
} from '../src/staging/restartContainment.ts';
import {
  STAGING_BOT_APPLICATION_ID,
  TWO_STAGING_GUILD_ID,
} from '../src/staging/spec.ts';

// Fixture-only ids for the dispatcher doubles. Never the real staging guild:
// the dispatcher takes its guild binding as a parameter.
const STAGING_GUILD = '900000000000007000';
const FOREIGN_GUILD = '900000000000007099';
const SYN = '900000000000007001';
const SYN2 = '900000000000007002';
const UNKNOWN = '900000000000009999';
const CHANNEL = '900000000000007010';
const VOICE = '900000000000007011';

const settle = () => new Promise((r) => setTimeout(r, 10));

interface ContainedWorld {
  bus: EventEmitter;
  joins: Array<{ guildId: string; memberId: string; source: string }>;
  gates: Array<{ guildId: string; memberId: string }>;
  messages: Array<{ guildId: string; memberId: string; hasLevelHook: boolean }>;
  voiceJoins: Array<{ guildId: string; memberId: string; hasLevelHook: boolean }>;
  voiceLeaves: Array<{ guildId: string; memberId: string }>;
  leaves: Array<{ guildId: string; memberId: string }>;
  inviteCalls: string[];
  auditEvents: Array<{ entryId: string; kind: string }>;
  inspected: string[];
  raidCalls: number;
  announceCalls: number;
  riskCalls: number;
  observer: { joins: number; gates: number; messages: number; prompts: number };
  automationAccepted: string[];
}

function containedWorld(stagingRestart?: { guildId: string; syntheticActorIds: ReadonlySet<string> }): ContainedWorld {
  const w: ContainedWorld = {
    bus: new EventEmitter(),
    joins: [],
    gates: [],
    messages: [],
    voiceJoins: [],
    voiceLeaves: [],
    leaves: [],
    inviteCalls: [],
    auditEvents: [],
    inspected: [],
    raidCalls: 0,
    announceCalls: 0,
    riskCalls: 0,
    observer: { joins: 0, gates: 0, messages: 0, prompts: 0 },
    automationAccepted: [],
  };
  const handlers = {
    onJoin: async (i: { guildId: string; memberId: string; source: string }) => {
      w.joins.push({ guildId: i.guildId, memberId: i.memberId, source: i.source });
      return null;
    },
    onGateCleared: async (i: { guildId: string; memberId: string }) => {
      w.gates.push({ guildId: i.guildId, memberId: i.memberId });
      return null;
    },
    onMessage: async (i: { guildId: string; memberId: string; messageId?: string; onLevelUp?: unknown }) => {
      w.messages.push({ guildId: i.guildId, memberId: i.memberId, hasLevelHook: !!i.onLevelUp });
      return null;
    },
    onVoiceJoin: async (i: { guildId: string; memberId: string; onLevelUp?: unknown }) => {
      w.voiceJoins.push({ guildId: i.guildId, memberId: i.memberId, hasLevelHook: !!i.onLevelUp });
      return null;
    },
    onVoiceLeave: async (i: { guildId: string; memberId: string }) => {
      w.voiceLeaves.push({ guildId: i.guildId, memberId: i.memberId });
      return null;
    },
    onLeave: async (guildId: string, memberId: string) => {
      w.leaves.push({ guildId, memberId });
      return {};
    },
    voiceSessions: { openCount: 0, clear() {} },
  } as unknown as FunnelHandlers;
  const invites = {
    diffAndStore: async () => {
      w.inviteCalls.push('diffAndStore');
      return [];
    },
    attribute: () => {
      w.inviteCalls.push('attribute');
      return 'unknown';
    },
    inviterFor: async () => {
      w.inviteCalls.push('inviterFor');
      return null;
    },
  } as unknown as InviteTracker;
  const audit = {
    record: async (e: { entryId: string; kind: string }) => {
      w.auditEvents.push({ entryId: e.entryId, kind: e.kind });
      return true;
    },
    retryPending: async () => 0,
  };
  const automod = {
    service: {
      inspect: async (msg: { messageId: string }) => {
        w.inspected.push(msg.messageId);
        return { matched: false };
      },
    },
    guildId: STAGING_GUILD,
  } as never;
  const raid = {
    watch: {
      observe: () => {
        w.raidCalls++;
        return null;
      },
    },
    announce: async () => {
      w.announceCalls++;
    },
  } as never;
  const joinRisk = {
    observe: async () => {
      w.riskCalls++;
    },
  } as never;
  const onboardingRota = {
    join: async () => {
      w.observer.joins++;
    },
    gateCleared: async () => {
      w.observer.gates++;
    },
    message: async () => {
      w.observer.messages++;
    },
    promptShown: async () => {
      w.observer.prompts++;
    },
  } as never;
  // Leveling present so a level hook WOULD be built off-path; contained mode
  // must still suppress it (zero role writes).
  const leveling = {} as never;
  registerHandlers(w.bus as unknown as Client, {
    handlers,
    invites,
    audit,
    automod,
    raid,
    joinRisk,
    onboardingRota,
    leveling,
    levelRoleWrites: true,
    ...(stagingRestart ? { stagingRestart } : {}),
  });
  w.bus.on('automationMessageAccepted', (msg: { id: string }) => w.automationAccepted.push(msg.id));
  return w;
}

const contained = () =>
  containedWorld({ guildId: STAGING_GUILD, syntheticActorIds: new Set([SYN, SYN2]) });

function joinMember(id: string, guildId: string, pending = false) {
  return {
    id,
    user: { bot: false },
    pending,
    joinedAt: new Date('2026-09-03T12:00:00Z'),
    guild: { id: guildId, invites: { fetch: async () => [] }, vanityURLCode: null },
  };
}

function gatePair(id: string, guildId: string) {
  const base = { id, guild: { id: guildId }, user: { bot: false } };
  return [
    { ...base, pending: true, partial: false, nickname: 'a', roles: { cache: new Map() } },
    { ...base, pending: false, partial: false, nickname: 'a', roles: { cache: new Map() } },
  ];
}

function gatewayMessage(id: string, actorId: string, guildId: string) {
  return {
    id,
    guildId,
    channelId: CHANNEL,
    author: { id: actorId, bot: false },
    member: { roles: { cache: new Map() } },
    content: 'hello synthetic',
    mentions: { users: new Map() },
    attachments: new Map(),
    createdTimestamp: Date.now(),
    partial: false,
    webhookId: null,
  };
}

function voiceMove(actorId: string, guildId: string) {
  const member = { user: { bot: false } };
  return [
    { id: actorId, guild: { id: guildId }, channelId: null, member },
    { id: actorId, guild: { id: guildId }, channelId: VOICE, member },
  ];
}

function leaveMember(actorId: string, guildId: string) {
  return { guild: { id: guildId }, id: actorId };
}

test('contained dispatcher drops foreign-guild join before handler/observer/invite snapshot', async () => {
  const w = contained();
  w.bus.emit(Events.GuildMemberAdd, joinMember(SYN, FOREIGN_GUILD));
  await settle();
  assert.equal(w.joins.length, 0, 'foreign guild never reaches handlers.onJoin');
  assert.equal(w.observer.joins, 0, 'foreign guild never reaches the rota observer');
  assert.deepEqual(w.inviteCalls, [], 'no invite snapshot for a foreign guild');
  assert.equal(w.raidCalls, 0);
  assert.equal(w.riskCalls, 0);
});

test('contained dispatcher drops unknown-actor join in the staging guild', async () => {
  const w = contained();
  w.bus.emit(Events.GuildMemberAdd, joinMember(UNKNOWN, STAGING_GUILD));
  await settle();
  assert.equal(w.joins.length, 0);
  assert.equal(w.observer.joins, 0);
  assert.deepEqual(w.inviteCalls, [], 'rejected before any invite read');
});

test('contained dispatcher drops foreign-guild and unknown-actor gate/message/voice/leave', async () => {
  const w = contained();
  const [oldF, newF] = gatePair(SYN, FOREIGN_GUILD);
  w.bus.emit(Events.GuildMemberUpdate, oldF, newF);
  w.bus.emit(Events.MessageCreate, gatewayMessage('foreign-1', SYN, FOREIGN_GUILD));
  const [oldV, newV] = voiceMove(SYN, FOREIGN_GUILD);
  w.bus.emit(Events.VoiceStateUpdate, oldV, newV);
  w.bus.emit(Events.GuildMemberRemove, leaveMember(SYN, FOREIGN_GUILD));
  const [oldU, newU] = gatePair(UNKNOWN, STAGING_GUILD);
  w.bus.emit(Events.GuildMemberUpdate, oldU, newU);
  w.bus.emit(Events.MessageCreate, gatewayMessage('unknown-1', UNKNOWN, STAGING_GUILD));
  const [oldUV, newUV] = voiceMove(UNKNOWN, STAGING_GUILD);
  w.bus.emit(Events.VoiceStateUpdate, oldUV, newUV);
  w.bus.emit(Events.GuildMemberRemove, leaveMember(UNKNOWN, STAGING_GUILD));
  await settle();
  assert.deepEqual(w.gates, [], 'no gate writes for foreign or unknown actors');
  assert.deepEqual(w.messages, [], 'no message writes for foreign or unknown actors');
  assert.deepEqual(w.voiceJoins, [], 'no voice writes for foreign or unknown actors');
  assert.deepEqual(w.leaves, [], 'no leave writes for foreign or unknown actors');
  assert.equal(w.observer.gates, 0);
  assert.equal(w.observer.messages, 0);
  assert.deepEqual(w.auditEvents, [], 'member_update/voice audit never recorded');
  assert.deepEqual(w.inspected, [], 'automod never inspects a rejected message');
});

test('contained dispatcher rejects missing actor identity before any consumer', async () => {
  const w = contained();
  w.bus.emit(Events.GuildMemberAdd, joinMember(undefined as never, STAGING_GUILD));
  w.bus.emit(Events.MessageCreate, { ...gatewayMessage('missing-author', SYN, STAGING_GUILD), author: null });
  w.bus.emit(Events.GuildMemberRemove, leaveMember(undefined as never, STAGING_GUILD));
  const [oldV, newV] = voiceMove(undefined as never, STAGING_GUILD);
  w.bus.emit(Events.VoiceStateUpdate, oldV, newV);
  await settle();
  assert.deepEqual(w.joins, []);
  assert.deepEqual(w.messages, []);
  assert.deepEqual(w.leaves, []);
  assert.deepEqual(w.voiceJoins, []);
  assert.deepEqual(w.inviteCalls, []);
  assert.deepEqual(w.auditEvents, []);
  assert.deepEqual(w.observer, { joins: 0, gates: 0, messages: 0, prompts: 0 });
});

test('contained dispatcher suppresses invite snapshots on ready and invite-create', async () => {
  const w = contained();
  w.bus.emit(Events.ClientReady, {
    user: { tag: 'bot#0001' },
    guilds: {
      cache: new Map([
        [STAGING_GUILD, { id: STAGING_GUILD, invites: { fetch: async () => [] } }],
      ]),
    },
  });
  w.bus.emit(Events.InviteCreate, { guild: { id: STAGING_GUILD, invites: { fetch: async () => [] } } });
  await settle();
  assert.deepEqual(w.inviteCalls, [], 'ready and invite-create never snapshot invites');
});

test('contained dispatcher suppresses all audit recording including raw/moderation events', async () => {
  const w = contained();
  w.bus.emit(Events.Raw, {
    op: 0, t: 'MESSAGE_DELETE', s: 1, d: { guild_id: STAGING_GUILD, channel_id: CHANNEL, id: 'msg-1' },
  }, 0);
  w.bus.emit(Events.Raw, {
    op: 0, t: 'MESSAGE_UPDATE', s: 2,
    d: {
      guild_id: STAGING_GUILD, channel_id: CHANNEL, id: 'msg-2',
      author: { id: SYN }, edited_timestamp: '2026-09-03T12:00:01.000Z',
    },
  }, 0);
  w.bus.emit(Events.GuildAuditLogEntryCreate, {
    id: 'audit-1',
    action: AuditLogEvent.MemberKick,
    createdTimestamp: Date.now(),
    executorId: 'mod-1',
    targetId: SYN,
    reason: null,
    extra: null,
  }, { id: STAGING_GUILD });
  // member_update delta and voice move for a synthetic actor would audit
  // off-path; contained mode must still record nothing.
  w.bus.emit(Events.GuildMemberUpdate,
    { id: SYN, guild: { id: STAGING_GUILD }, partial: false, nickname: 'a', roles: { cache: new Map() } },
    { id: SYN, guild: { id: STAGING_GUILD }, nickname: 'b', roles: { cache: new Map() }, user: { bot: false } });
  const [oldV, newV] = voiceMove(SYN, STAGING_GUILD);
  w.bus.emit(Events.VoiceStateUpdate, oldV, newV);
  await settle();
  assert.deepEqual(w.auditEvents, [], 'raw, moderation, member_update and voice audit all suppressed');
});

test('contained dispatcher suppresses automod inspection and edit handling', async () => {
  const w = contained();
  w.bus.emit(Events.MessageCreate, gatewayMessage('syn-msg-1', SYN, STAGING_GUILD));
  await settle();
  assert.deepEqual(w.inspected, [], 'accepted synthetic message is never automod-inspected');
  assert.equal(w.messages.length, 1, 'synthetic still reaches the ordinary message handler');
  w.bus.emit(Events.MessageUpdate, gatewayMessage('syn-msg-1', SYN, STAGING_GUILD),
    { ...gatewayMessage('syn-msg-1', SYN, STAGING_GUILD), partial: false });
  await settle();
  assert.deepEqual(w.inspected, [], 'message edits never inspect under containment');
});

test('contained synthetic join/gate/message/voice/leave reach handlers and observer with zero mutations', async () => {
  const w = contained();
  // pending=true so the join itself does not also record the instant
  // already-through-the-gate conversion; the explicit update below is the
  // single gate write this test counts.
  w.bus.emit(Events.GuildMemberAdd, joinMember(SYN, STAGING_GUILD, true));
  await settle();
  const [oldG, newG] = gatePair(SYN, STAGING_GUILD);
  w.bus.emit(Events.GuildMemberUpdate, oldG, newG);
  await settle();
  w.bus.emit(Events.MessageCreate, gatewayMessage('syn-allowed-1', SYN, STAGING_GUILD));
  await settle();
  const [oldV, newV] = voiceMove(SYN2, STAGING_GUILD);
  w.bus.emit(Events.VoiceStateUpdate, oldV, newV);
  await settle();
  w.bus.emit(Events.GuildMemberRemove, leaveMember(SYN, STAGING_GUILD));
  await settle();

  assert.equal(w.joins.length, 1, 'synthetic join reaches handlers.onJoin');
  assert.equal(w.joins[0].source, 'unknown', 'contained joins carry no invitation evidence');
  assert.equal(w.gates.length, 1, 'synthetic gate reaches handlers.onGateCleared');
  assert.equal(w.messages.length, 1, 'synthetic message reaches handlers.onMessage');
  assert.equal(w.voiceJoins.length, 1, 'synthetic voice reaches handlers.onVoiceJoin');
  assert.equal(w.leaves.length, 1, 'synthetic leave reaches handlers.onLeave');
  assert.equal(w.observer.joins, 1, 'synthetic join reaches observer dispatch (observer double in this unit test)');
  assert.equal(w.observer.gates, 1, 'synthetic gate reaches the observer');
  assert.equal(w.observer.messages, 1, 'synthetic message reaches the observer');
  assert.equal(w.observer.prompts, 0, 'no welcome registration, so promptShown stays absent');

  assert.deepEqual(w.inviteCalls, [], 'zero invite reads even for allowed synthetics');
  assert.deepEqual(w.auditEvents, [], 'zero audit writes even for allowed synthetics');
  assert.equal(w.raidCalls, 0, 'no burst observation');
  assert.equal(w.announceCalls, 0, 'no raid announce send');
  assert.equal(w.riskCalls, 0, 'no join-risk observation');
  assert.deepEqual(w.inspected, [], 'no automod inspection');
  assert.deepEqual(w.automationAccepted, [], 'no downstream automation emission');
  assert.equal(w.messages[0].hasLevelHook, false, 'no level role-write hook under containment');
  assert.equal(w.voiceJoins[0].hasLevelHook, false, 'no voice level role-write hook under containment');
});

test('off path unchanged: unknown actor reaches handlers, hooks, automod and automation', async () => {
  const w = containedWorld();
  // pending=true so the join itself does not also record the instant
  // already-through-the-gate conversion; the explicit update below is the
  // single gate write this test counts.
  w.bus.emit(Events.GuildMemberAdd, joinMember(UNKNOWN, FOREIGN_GUILD, true));
  await settle();
  const [oldG, newG] = gatePair(UNKNOWN, FOREIGN_GUILD);
  w.bus.emit(Events.GuildMemberUpdate, oldG, newG);
  await settle();
  // Automod guild is the staging fixture; use it here so the off-path
  // inspection expectation is meaningful.
  w.bus.emit(Events.MessageCreate, gatewayMessage('off-1', UNKNOWN, STAGING_GUILD));
  await settle();
  assert.equal(w.joins.length, 1, 'off-path joins record exactly as before');
  assert.equal(w.gates.length, 1);
  assert.equal(w.messages.length, 1);
  assert.equal(w.observer.joins, 1);
  assert.deepEqual(w.inspected, ['off-1'], 'off-path messages are still automod-inspected');
  assert.deepEqual(w.automationAccepted, ['off-1'], 'off-path automation still emits');
  assert.equal(w.messages[0].hasLevelHook, true, 'off-path keeps the level hook');
});

// --- Firewall: guild-pinned second boundary ---------------------------------

test('firewall drops foreign-guild and unknown-actor writes including onLeave', async () => {
  const { StagingRestartFunnelFirewall } = await import('../src/staging/restartContainment.ts');
  const records: Array<{ guildId: string; memberId: string; eventType: string }> = [];
  const fakeStore = {
    record: async (e: { guildId: string; memberId: string | null; eventType: string }) => {
      records.push({ guildId: e.guildId, memberId: e.memberId ?? '', eventType: e.eventType });
      return { inserted: true };
    },
    touchActivity: async () => {},
    hasEvent: async () => false,
    nextMessageRung: async () => null,
  };
  // The firewall pins the TWO staging guild internally: only synthetic actors
  // in that guild pass, everything else (including onLeave) returns null.
  const firewall = new StagingRestartFunnelFirewall(fakeStore as never, null, null, new Set([SYN]));
  assert.equal(
    await firewall.onJoin({ guildId: FOREIGN_GUILD, memberId: SYN, isBot: false, source: 'gateway' }),
    null,
  );
  assert.equal(
    await firewall.onJoin({ guildId: TWO_STAGING_GUILD_ID, memberId: UNKNOWN, isBot: false, source: 'gateway' }),
    null,
  );
  assert.equal(await firewall.onGateCleared({ guildId: FOREIGN_GUILD, memberId: SYN, isBot: false }), null);
  assert.equal(
    await firewall.onMessage({ guildId: FOREIGN_GUILD, memberId: SYN, isBot: false, channelId: CHANNEL }),
    null,
  );
  assert.equal(
    await firewall.onVoiceJoin({ guildId: FOREIGN_GUILD, memberId: SYN, isBot: false, channelId: VOICE }),
    null,
  );
  assert.equal(
    await firewall.onVoiceLeave({ guildId: FOREIGN_GUILD, memberId: SYN, isBot: false, channelId: VOICE }),
    null,
  );
  assert.equal(await firewall.onLeave(FOREIGN_GUILD, SYN), null);
  assert.equal(await firewall.onLeave(TWO_STAGING_GUILD_ID, UNKNOWN), null);
  assert.equal(records.length, 0, 'foreign-guild and unknown-actor writes never persist, including onLeave');
  const joined = await firewall.onJoin({
    guildId: TWO_STAGING_GUILD_ID, memberId: SYN, isBot: false, source: 'gateway',
  });
  assert.equal(joined?.eventType, 'member_join', 'synthetic staging join passes through');
  const left = await firewall.onLeave(TWO_STAGING_GUILD_ID, SYN);
  assert.equal(left?.eventType, 'member_leave', 'synthetic staging leave passes through');
  assert.deepEqual(
    records.map((r) => r.eventType),
    ['member_join', 'member_leave'],
  );
});

// --- Real-boot pre-datastore rejections -------------------------------------

const ROOT = resolve(import.meta.dirname, '..');
const tokenFor = (appId: string) => `${Buffer.from(appId).toString('base64')}.Gxxxxx.yyyyyyyyyy`;
const LOOPBACK_DB = 'postgres://two@127.0.0.1:55432/two_staging_test';
const STAGING_DB = 'postgres://two@127.0.0.1:5432/two_bot_staging';

/**
 * Fully-bound contained boot env minus the two knobs under test (synthetic
 * allowlist, staging classifier), so each rejection test sets exactly what it
 * proves. Rota measurement stays at its master-off default unless a test says
 * otherwise. Nothing here is ever contacted: every boot below refuses before
 * `openDb`, and the loopback URL is never opened.
 */
function bootEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    DISCORD_STAGING_BOT_TOKEN: '',
    DISCORD_BOT_TOKEN: tokenFor(STAGING_BOT_APPLICATION_ID),
    TWO_DATABASE_URL: LOOPBACK_DB,
    TWO_STAGING_DATABASE_URL: STAGING_DB,
    DISCORD_GUILD_ID: TWO_STAGING_GUILD_ID,
    DISCORD_STAGING_GUILD_ID: TWO_STAGING_GUILD_ID,
    TWO_STAGING_RESTART_CONTAINMENT: '1',
    TWO_ONBOARDING_MODE: 'legacy',
    ...over,
  };
}

function boot(env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, ['src/index.ts'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15_000, env,
  });
  assert.equal(result.error, undefined);
  return result;
}

test('staging database binding must be a postgres URL with host and database', () => {
  const base = {
    discordToken: tokenFor(STAGING_BOT_APPLICATION_ID),
    databaseUrl: LOOPBACK_DB,
    stagingDatabaseUrl: STAGING_DB,
    guildId: TWO_STAGING_GUILD_ID,
  };
  const env = { [STAGING_RESTART_CONTAINMENT_FLAG]: '1' };
  for (const binding of [
    'not-a-url',
    'https://db.internal:5432/two_bot_staging',
    'postgres://two@127.0.0.1:5432/',
    'postgres://two@127.0.0.1:5432',
  ]) {
    const r = checkStagingRestartPreflight(env, { ...base, stagingDatabaseUrl: binding });
    assert.equal(r.ok, false, `binding=${JSON.stringify(binding)}`);
    assert.match(r.reason!, /valid staging database binding/);
  }
  assert.equal(checkStagingRestartPreflight(env, base).ok, true);
});

test('real boot with malformed synthetic actors refuses before datastore_open', () => {
  for (const actors of ['bad', `${SYN},${SYN}`]) {
    const result = boot(bootEnv({
      TWO_STAGING_RESTART_SYNTHETIC_ACTORS: actors,
      TWO_COMMUNITY_STAGING_GUILD_IDS: TWO_STAGING_GUILD_ID,
    }));
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /synthetic actors must be comma-separated Discord user ids/);
    assert.doesNotMatch(output, /datastore_open/);
    assert.doesNotMatch(output, /Gxxxxx|yyyyyyyyyy/);
  }
});

test('real boot without staging classifier refuses before datastore_open even with rota master-off', () => {
  // Missing binding entirely, with the master switch explicitly off: the
  // classifier requirement is independent of rota measurement.
  const missing = boot(bootEnv({
    TWO_STAGING_RESTART_SYNTHETIC_ACTORS: '',
    TWO_ONBOARDING_ROTA_MEASUREMENT: '0',
  }));
  assert.notEqual(missing.status, 0);
  const missingOutput = missing.stdout + missing.stderr;
  assert.match(missingOutput, /explicit community staging-guild classification/);
  assert.doesNotMatch(missingOutput, /datastore_open/);
  // A binding that names any other guild is the same refusal, not a pass.
  const wrong = boot(bootEnv({
    TWO_STAGING_RESTART_SYNTHETIC_ACTORS: '',
    TWO_ONBOARDING_ROTA_MEASUREMENT: '0',
    TWO_COMMUNITY_STAGING_GUILD_IDS: FOREIGN_GUILD,
  }));
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stdout + wrong.stderr, /explicit community staging-guild classification/);
  assert.doesNotMatch(wrong.stdout + wrong.stderr, /datastore_open/);
});

test("real boot rejects a nonempty containment flag other than exact '0'/'1' before datastore_open", () => {
  for (const flag of ['true', 'yes', '2']) {
    const result = boot(bootEnv({
      TWO_STAGING_RESTART_CONTAINMENT: flag,
      TWO_STAGING_RESTART_SYNTHETIC_ACTORS: '',
      TWO_COMMUNITY_STAGING_GUILD_IDS: TWO_STAGING_GUILD_ID,
    }));
    assert.notEqual(result.status, 0, `flag=${JSON.stringify(flag)}`);
    const output = result.stdout + result.stderr;
    assert.match(output, /must be exactly 0 or 1/);
    assert.doesNotMatch(output, /datastore_open/);
  }
});
