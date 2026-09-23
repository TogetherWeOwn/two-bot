import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection, Events, PermissionsBitField, type Client, type GuildMember, type Message } from 'discord.js';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from '../src/analytics/communityClassifier.ts';
import { OnboardingRota } from '../src/analytics/onboardingRota.ts';
import { ONBOARDING_FACT_TYPES } from '../src/analytics/onboardingEvents.ts';
import { DiscordOnboardingRota } from '../src/discord/onboardingRota.ts';
import { registerHandlers, type BotDeps } from '../src/discord/client.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { EventStore } from '../src/store/eventStore.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';
import type { AutomodService } from '../src/automod/service.ts';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const GATE = '2026-09-01T12:00:00.000Z';
const FIRST = '2026-09-01T12:05:00.000Z';
const REPLY = '2026-09-01T12:10:00.000Z';
const KEY = 'test-only-runtime-rota-key-not-a-real-secret';
let fixture: TestDb;
let core: OnboardingRota;
let observer: DiscordOnboardingRota;

function buildObserver(env: NodeJS.ProcessEnv = {}, enabled = true) {
  core = new OnboardingRota(fixture.db, new CommunityClassifier(loadCommunityClassifierConfig(env)), {
    enabled, pseudonymKey: KEY,
  });
  return new DiscordOnboardingRota(fixture.db, core, {
    guildId: GUILD, humanChannelIds: new Set([CHANNEL]),
    staffRoleIds: new Set(['staff-role']), staffActorIds: new Set(['staff-primary']),
  });
}

before(async () => { fixture = await openTestDb(import.meta.filename); });
after(async () => fixture?.cleanup());
beforeEach(async () => { await fixture.reset(); observer = buildObserver(); });

function member(id = 'new-human', overrides: Record<string, unknown> = {}): GuildMember {
  return {
    id, user: { id, bot: false }, pending: false, partial: false,
    roles: { cache: new Collection() }, permissions: new PermissionsBitField(0n),
    isCommunicationDisabled: () => false,
    guild: {
      id: GUILD, ownerId: 'owner', features: ['MEMBER_VERIFICATION_GATE_ENABLED'],
      invites: { fetch: async () => [] }, vanityURLCode: null,
    },
    ...overrides,
  } as unknown as GuildMember;
}

function message(m = member(), overrides: Record<string, unknown> = {}): Message {
  return {
    member: m, guildId: GUILD, guild: { members: { fetch: async () => member() } },
    author: m.user, webhookId: null, system: false, id: 'first-message', channelId: CHANNEL,
    createdTimestamp: Date.parse(FIRST), reference: null,
    channel: {
      isDMBased: () => false, isThread: () => false,
      permissionsFor: () => new PermissionsBitField(['ViewChannel', 'SendMessages']),
    },
    ...overrides,
  } as unknown as Message;
}

function prompt(m = member(), overrides: Record<string, unknown> = {}) {
  return observer.promptShown({
    member: m, variant: 'session', actionChannelId: CHANNEL,
    message: message(m, { id: 'welcome', channelId: 'landing', createdTimestamp: Date.parse(GATE) + 100, ...overrides }),
  });
}

async function enroll(m = member()) {
  await observer.join(m, Promise.resolve('web:one_click'), GATE);
  await prompt(m);
}

function reply(m = member('staff-primary'), overrides: Record<string, unknown> = {}) {
  return message(m, {
    id: 'reply', type: 19, createdTimestamp: Date.parse(REPLY),
    reference: { guildId: GUILD, channelId: CHANNEL, messageId: 'first-message' },
    fetchReference: async () => message(), ...overrides,
  });
}

async function rows() {
  return fixture.db.prepare('SELECT event_type, actor_id, source, occurred_at, metadata FROM community_facts ORDER BY id')
    .all<{ event_type: string; actor_id: string; source: string; occurred_at: string; metadata: string }>();
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

async function waitForRows(count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await rows()).length === count) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} rows (have ${(await rows()).length})`);
    }
    await settle();
  }
}

function gateway(rota: DiscordOnboardingRota | undefined = observer, automod?: BotDeps['automod']) {
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, {
    handlers: new FunnelHandlers(new EventStore(fixture.db)),
    invites: {
      diffAndStore: async () => ['campaign'], attribute: () => 'invite:campaign', inviterFor: async () => null,
    } as unknown as InviteTracker,
    onboardingRota: rota, automod,
  });
  return bus;
}

test('runtime adapter emits seven facts, independent of raw scorecard capture; no raw member ids', async () => {
  await enroll();
  await observer.message(message());
  // The staff reply hands its write to the subject's chain fire-and-forget, so
  // the replier's promise can resolve before the reply rows land.
  await observer.message(reply());
  await waitForRows(7);
  assert.equal((await rows()).filter(r => r.event_type === 'welcome_rota_replied').length, 1);
  await observer.message(message(member(), { id: 'return', createdTimestamp: Date.parse(GATE) + 7 * 86_400_000 }));
  const actual = await rows();
  assert.deepEqual(actual.map(r => r.event_type).sort(), [...ONBOARDING_FACT_TYPES, 'welcome_rota_replied'].sort());
  assert.ok(actual.every(r => r.source === 'web:one_click'));
  assert.ok(actual.every(r => r.actor_id === core.memberId(GUILD, 'new-human')));
  assert.doesNotMatch(JSON.stringify(actual), /new-human|staff-primary/);
  const shown = JSON.parse(actual.find(r => r.event_type === 'onboarding_prompt_shown')!.metadata);
  assert.equal(shown.channelId, CHANNEL, 'qualifying destination is not the welcome send channel');
  assert.equal(shown.messageId, 'welcome');
  const latency = JSON.parse(actual.find(r => r.event_type === 'onboarding_reply_latency')!.metadata);
  assert.equal(latency.latencySeconds, 300);
});

test('join attribution is ordered before a concurrent gate, welcome and first message', async () => {
  let release!: (source: string) => void;
  const source = new Promise<string>(resolve => { release = resolve; });
  const joining = observer.join(member(), source, GATE);
  const shown = prompt();
  const acting = observer.message(message());
  await settle();
  assert.equal((await rows()).length, 0);
  release('invite:campaign');
  await Promise.all([joining, shown, acting]);
  assert.equal((await rows()).length, 4);
  assert.ok((await rows()).every(r => r.source === 'invite:campaign'));
});

test('gate after restart reads existing join attribution; missing attribution stays unknown', async () => {
  const store = new EventStore(fixture.db);
  await store.record({ guildId: GUILD, memberId: 'new-human', eventType: 'member_join', occurredAt: GATE, source: 'invite:durable' });
  await observer.gateCleared(member(), GATE);
  observer = buildObserver();
  await prompt();
  await observer.message(message());
  assert.ok((await rows()).every(r => r.source === 'invite:durable'));
  await observer.gateCleared(member('other-new-human'), GATE);
  assert.equal((await rows()).at(-1)!.source, 'unknown');
});

test('pending=false without enabled screening is not an observed acceptance; a real transition is', async () => {
  const m = member();
  m.guild.features = [];
  await enroll(m);
  await observer.message(message(m));
  assert.equal((await rows()).length, 0);
  await observer.gateCleared(m, GATE);
  assert.equal((await rows()).length, 1);
});

test('bots, missing screening, partial members, staff, owners and timeouts never enter the denominator', async () => {
  const exclusions = [
    member('bot', { user: { id: 'bot', bot: true } }),
    member('pending', { pending: true }), member('unknown', { pending: null }),
    member('partial', { partial: true }), member('roles-missing', { roles: null }),
    member('permissions-missing', { permissions: null }),
    member('moderator', { permissions: new PermissionsBitField('ModerateMembers') }),
    member('role-staff', { roles: { cache: new Collection([['staff-role', { id: 'staff-role' }]]) } }),
    member('owner'), member('staff-primary'),
    member('timed-out', { isCommunicationDisabled: () => true }),
    member('wrong-guild', { guild: { id: 'other', features: [] } }),
  ];
  for (const m of exclusions) {
    await enroll(m);
    await observer.gateCleared(m, GATE);
    await observer.message(message(m));
  }
  assert.equal((await rows()).length, 0);
});

test('configured classifier exclusions and disabled core remain zero-write through the adapter', async () => {
  for (const env of [
    { TWO_COMMUNITY_STAGING_GUILD_IDS: GUILD },
    { TWO_COMMUNITY_TEST_ACTOR_IDS: 'new-human' },
    { TWO_COMMUNITY_RAID_ACTOR_IDS: 'new-human' },
    { TWO_COMMUNITY_AUTOMATION_ACTOR_IDS: 'new-human' },
  ]) {
    observer = buildObserver(env);
    await enroll();
    await observer.message(message());
    assert.equal((await rows()).length, 0);
  }
  observer = buildObserver({}, false);
  await enroll();
  await observer.message(message());
  assert.equal((await rows()).length, 0);
});

test('missing prompt, wrong-guild delivery and disallowed destination cannot create exposure', async () => {
  await prompt();
  assert.equal((await rows()).length, 0);
  await observer.join(member(), Promise.resolve('unknown'), GATE);
  await prompt(member(), { guildId: 'other' });
  await observer.promptShown({ member: member(), message: message(), variant: 'legacy', actionChannelId: 'not-allowed' });
  assert.equal((await rows()).length, 1);
});

test('webhook/system/unknown-channel/thread and permission-denied messages do not qualify', async () => {
  await enroll();
  for (const overrides of [
    { webhookId: 'hook' }, { system: true }, { channelId: 'elsewhere' }, { guildId: 'other' },
    { member: null }, { author: { id: 'spoof', bot: false } },
    { channel: { isDMBased: () => true } },
    { channel: { isDMBased: () => false, isThread: () => true } },
    { channel: { isDMBased: () => false, isThread: () => false, permissionsFor: () => new PermissionsBitField('ViewChannel') } },
  ]) await observer.message(message(member(), overrides));
  assert.equal((await rows()).length, 2);
});

test('reply must reference the action and freshly resolve an eligible different human subject', async () => {
  await enroll();
  await observer.message(message());
  for (const overrides of [
    { reference: null },
    { type: 0 }, // forwarded/default message with a reference is not a reply
    { reference: { guildId: 'other', channelId: CHANNEL, messageId: 'first-message' } },
    { reference: { guildId: GUILD, channelId: 'elsewhere', messageId: 'first-message' } },
    { fetchReference: async () => message(member(), { id: 'different-action' }) },
    { fetchReference: async () => { throw new Error('reference unavailable'); } },
    { guild: { members: { fetch: async () => member('new-human', { pending: true }) } } },
    { guild: { members: { fetch: async () => member('new-human', { permissions: new PermissionsBitField('Administrator') }) } } },
  ]) await observer.message(reply(member('staff-primary'), overrides));
  await observer.message(reply(member())); // self
  assert.equal((await rows()).length, 4);
  let fetched = false;
  await observer.message(reply(member('staff-primary'), {
    guild: { members: { fetch: async (options: unknown) => {
      assert.deepEqual(options, { user: 'new-human', force: true });
      fetched = true;
      return member();
    } } },
  }));
  assert.equal(fetched, true);
  // Same fire-and-forget handoff as above: the qualifying reply write lands on
  // the subject's chain after the replier's promise resolves.
  await waitForRows(7);
  assert.equal((await rows()).filter(r => r.event_type === 'welcome_rota_replied').length, 1);
});

test('failed observation is contained and later observations still run', async () => {
  await observer.join(member(), Promise.reject(new Error('attribution failed')), GATE);
  assert.equal((await rows()).length, 0);
  await enroll();
  assert.equal((await rows()).length, 2);
});

test('an unresolved join for member A never stalls unrelated member B', async () => {
  // Head-of-line regression: one process-global chain let a stuck attribution
  // for A block every observation for anyone else. Per-member chains isolate.
  let releaseA!: (source: string) => void;
  const sourceA = new Promise<string>(resolve => { releaseA = resolve; });
  const joinA = observer.join(member('member-a'), sourceA, GATE);
  const b = member('member-b');
  await observer.join(b, Promise.resolve('web:one_click'), GATE);
  await prompt(b);
  await waitForRows(2);
  assert.ok((await rows()).every(r => r.actor_id === core.memberId(GUILD, 'member-b')));
  releaseA('web:one_click');
  await joinA;
  await waitForRows(3);
});

test('a stuck observation for one member never stops an unrelated automation event', async () => {
  // Reproduces the exact-head probe: unresolved A join + accepted B message
  // must still emit the automation event promptly, because the observer is
  // fire-and-forget off the automation path, not awaited before it.
  let releaseA!: (source: string) => void;
  const sourceA = new Promise<string>(resolve => { releaseA = resolve; });
  const joinA = observer.join(member('member-a'), sourceA, GATE);
  const b = member('member-b');
  await observer.join(b, Promise.resolve('web:one_click'), GATE);
  await prompt(b);
  const bus = gateway();
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('automation event stalled behind stuck observation')), 1000);
    bus.once('automationMessageAccepted', () => { clearTimeout(timer); resolve(); });
  });
  bus.emit(Events.MessageCreate, message(b));
  await done;
  // B's own observation still lands even though the client no longer awaits it;
  // drain it and A's tail so no rows leak into the next test's count.
  await waitForRows(4);
  releaseA('web:one_click');
  await joinA;
});

test('gateway reserves join and gate before other listeners and preserves durable cohort', async () => {
  const bus = gateway();
  const m = member('new-human', { pending: true });
  let joinDone!: () => void;
  const joined = new Promise<void>(resolve => { joinDone = resolve; });
  const original = observer.join.bind(observer);
  observer.join = (...args) => original(...args).finally(joinDone);
  bus.emit(Events.GuildMemberAdd, m);
  await joined;
  const cleared = member();
  bus.on(Events.GuildMemberUpdate, () => { void prompt(cleared, { createdTimestamp: Date.now() + 1000 }); });
  bus.emit(Events.GuildMemberUpdate, { pending: true, partial: true }, cleared);
  // The message is queued after the other listener's prompt, without a timing sleep.
  await observer.message(message(cleared, { createdTimestamp: Date.now() + 2000 }));
  const actual = await rows();
  assert.equal(actual.length, 4);
  assert.ok(actual.every(r => r.source === 'invite:campaign'));
});

test('gateway keeps a reply behind its action while automod acceptance is delayed', async () => {
  await enroll();
  let release!: (result: { matched: boolean }) => void;
  const firstInspection = new Promise<{ matched: boolean }>(resolve => { release = resolve; });
  const bus = gateway(observer, {
    guildId: GUILD,
    service: { inspect: async (input: { messageId: string }) => input.messageId === 'first-message'
      ? firstInspection : { matched: false } } as unknown as AutomodService,
  });
  const first = message(member(), { content: '', mentions: {}, attachments: new Map() });
  const response = reply(member('staff-primary'), { content: '', mentions: {}, attachments: new Map() });
  let completed = 0;
  const done = new Promise<void>(resolve => {
    bus.on('automationMessageAccepted', () => { if (++completed === 2) resolve(); });
  });
  bus.emit(Events.MessageCreate, first);
  bus.emit(Events.MessageCreate, response);
  await settle();
  assert.equal((await rows()).length, 2, 'neither action nor reply can overtake pending inspection');
  release({ matched: false });
  await done;
  // The reply write is handed to the subject's chain fire-and-forget, so the
  // automation event can fire before the reply rows land.
  await waitForRows(7);
  assert.equal((await rows()).filter(r => r.event_type === 'welcome_rota_replied').length, 1);
});

test('gateway suppresses measurement for automod rejection and unclassified inspection failures', async () => {
  await enroll();
  for (const inspect of [async () => ({ matched: true }), async () => { throw new Error('inspection unavailable'); }]) {
    const bus = gateway(observer, { guildId: GUILD, service: { inspect } as unknown as AutomodService });
    let completed!: () => void;
    const done = new Promise<void>(resolve => { completed = resolve; });
    // The rejected path has no automation event; wait for the inspector and one
    // event-loop turn so both gateway branches have finished.
    bus.emit(Events.MessageCreate, message(member(), { content: '', mentions: {}, attachments: new Map() }));
    setTimeout(completed, 30);
    await done;
    assert.equal((await rows()).length, 2);
  }
  const bus = gateway();
  const done = new Promise<void>(resolve => { bus.once('automationMessageAccepted', resolve); });
  bus.emit(Events.MessageCreate, message());
  await done;
  // The client no longer awaits the observer before emitting, so the event can
  // fire before the measurement rows land.
  await waitForRows(4);
});

test('absent runtime observer preserves existing funnel with zero derived writes', async () => {
  // Omit the optional measurement seam entirely, as default boot does.
  const bare = new EventEmitter();
  registerHandlers(bare as unknown as Client, {
    handlers: new FunnelHandlers(new EventStore(fixture.db)), invites: {} as InviteTracker,
  });
  const done = new Promise<void>(resolve => { bare.once('automationMessageAccepted', resolve); });
  bare.emit(Events.MessageCreate, message());
  await done;
  assert.equal((await rows()).length, 0);
  assert.equal(await new EventStore(fixture.db).hasEvent(GUILD, 'new-human', 'first_message'), true);
});
