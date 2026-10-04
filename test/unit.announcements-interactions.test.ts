import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { Events, PermissionFlagsBits, type Client, type Interaction } from 'discord.js';
import { DiscordAnnouncements, registerAnnouncementCommands } from '../src/announcements/discord.ts';
import { AnnouncementsService, LFG_LEAVE_ACTION } from '../src/announcements/service.ts';
import { log } from '../src/core/log.ts';
import type { AnnouncementsStore } from '../src/announcements/store.ts';

const GUILD = '1550000000000000001';
const CHANNEL = '1550000000000000002';
const USER = '1550000000000000004';
const EVENT = '1550000000000000003';
const STRINGS: Record<string, string> = {
  'event-id': EVENT, status: 'going', title: 'Raid', 'starts-at': '2027-01-01T20:00:00Z',
  roles: 'tank:Tank:2', id: 'post-1', kind: 'rss', source: 'https://example.invalid/feed',
};

const originalFetch = globalThis.fetch;
let networkCalls = 0;
before(() => {
  mock.method(log, 'error', () => {});
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error('Interaction regression suite attempted a live network call.');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkCalls, 0);
});

function barrier<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Scenario {
  name: string;
  method: string;
  value: unknown;
  content: string;
  selectValue?: string;
  args: unknown[];
}

const scenarios: Scenario[] = [
  { name: 'rsvp', method: 'rsvp', value: 'going', content: 'RSVP saved: going.',
    args: [{ guildId: GUILD, eventId: EVENT, userId: USER, status: 'going' }] },
  { name: 'attendance', method: 'attendance', value: { going: [USER], interested: [], declined: [USER] },
    content: 'Going: 1\nInterested: 0\nDeclined: 1', args: [GUILD, EVENT] },
  { name: 'lfg', method: 'createLfg', value: { id: 'post-1' }, content: 'LFG posted: `post-1`.',
    args: [{ guildId: GUILD, channelId: CHANNEL, title: 'Raid', startsAt: STRINGS['starts-at'],
      roles: [{ key: 'tank', label: 'Tank', slots: 2 }], actorId: USER }] },
  { name: 'lfg-close', method: 'closeLfg', value: true, content: 'LFG closed.', args: [GUILD, 'post-1', USER] },
  { name: 'feed-add', method: 'addFeed', value: { id: 'feed-1' }, content: 'Feed relay created: `feed-1`.',
    args: [{ guildId: GUILD, channelId: CHANNEL, kind: 'rss', source: STRINGS.source, actorId: USER }] },
  { name: 'feed-remove', method: 'removeFeed', value: true, content: 'Feed relay removed.', args: [GUILD, 'post-1', USER] },
  { name: 'feed-list', method: 'listFeeds', value: [], content: 'No feed relays configured.', args: [GUILD] },
  { name: 'LFG signup select', selectValue: 'tank', method: 'signupLfg', value: 'joined', content: 'LFG joined.',
    args: [{ guildId: GUILD, id: 'post-1', roleKey: 'tank', userId: USER }] },
  { name: 'LFG leave select', selectValue: LFG_LEAVE_ACTION, method: 'leaveLfg', value: true, content: 'LFG left.',
    args: [GUILD, 'post-1', USER] },
];

function fixture(scenario: Scenario, service?: AnnouncementsService) {
  const defer = barrier<void>();
  const work = barrier<unknown>();
  const entered = barrier<void>();
  const events: string[] = [];
  const actions: Array<{ method: string; args: unknown[] }> = [];
  const replies: Array<{ content: string; ephemeral: boolean }> = [];
  const edits: Array<{ content: string }> = [];
  const interaction = {
    guildId: GUILD, channelId: CHANNEL, user: { id: USER },
    commandName: scenario.name, customId: 'two:lfg:post-1',
    values: scenario.selectValue === undefined ? [] : [scenario.selectValue],
    options: { getString: (name: string) => STRINGS[name] },
    memberPermissions: { has: (_permission: bigint) => true },
    replied: false, deferred: false,
    inGuild: () => true,
    isChatInputCommand: () => scenario.selectValue === undefined,
    isStringSelectMenu: () => scenario.selectValue !== undefined,
    isRepliable: () => true,
    deferReply: async (options: { ephemeral: boolean }) => {
      assert.deepEqual(options, { ephemeral: true });
      assert.equal(interaction.replied, false);
      assert.equal(interaction.deferred, false);
      events.push('defer:start');
      await defer.promise;
      interaction.deferred = true;
      events.push('defer:complete');
    },
    reply: async (options: { content: string; ephemeral: boolean }) => {
      assert.equal(interaction.deferred, false, 'no second initial reply after deferral');
      assert.equal(interaction.replied, false);
      events.push('reply');
      replies.push(options);
      interaction.replied = true;
    },
    editReply: async (options: { content: string }) => {
      assert.equal(interaction.deferred, true, 'completion must follow successful deferral');
      events.push('edit');
      edits.push(options);
      interaction.replied = true;
    },
  };
  const methods = Object.fromEntries(scenarios.map(({ method }) => [method, async (...args: unknown[]) => {
    actions.push({ method, args });
    events.push(method);
    entered.resolve();
    return work.promise;
  }]));
  let handler!: (interaction: Interaction) => Promise<void>;
  const client = {
    on: (event: string, listener: typeof handler) => {
      assert.equal(event, Events.InteractionCreate);
      assert.equal(handler, undefined, 'capture exactly one registered listener');
      handler = listener;
    },
  };
  registerAnnouncementCommands(client as unknown as Client, {
    guildId: GUILD,
    service: service ?? methods as unknown as AnnouncementsService,
    store: methods as unknown as AnnouncementsStore,
  });
  return {
    interaction, defer, work, entered, events, actions, replies, edits,
    run: () => handler(interaction as unknown as Interaction),
  };
}

test('registered RSVP defers before real service transport and persistence access', async (t) => {
  const upstream = barrier<Response>();
  const entered = barrier<void>();
  const accesses: string[] = [];
  const store: Pick<AnnouncementsStore, 'putRsvp' | 'audit'> = {
    putRsvp: async () => { accesses.push('putRsvp'); },
    audit: async () => { accesses.push('audit'); },
  };
  const discord = new DiscordAnnouncements({
    token: 'test-token', base: 'https://discord.invalid/api/v10',
    fetchImpl: async (input) => {
      accesses.push('fetch');
      assert.equal(String(input), `https://discord.invalid/api/v10/guilds/${GUILD}/scheduled-events/${EVENT}`);
      entered.resolve();
      return upstream.promise;
    },
  });
  const f = fixture(scenarios[0]!, new AnnouncementsService(store as AnnouncementsStore, discord));
  const running = f.run();
  t.after(async () => { f.defer.resolve(); upstream.resolve(Response.json({ status: 1 })); await running; });
  assert.deepEqual(f.events, ['defer:start']);
  assert.deepEqual(accesses, []);
  f.defer.resolve();
  await entered.promise;
  assert.deepEqual(f.events, ['defer:start', 'defer:complete']);
  assert.deepEqual(accesses, ['fetch']);
  assert.deepEqual(f.edits, []);
  upstream.resolve(Response.json({ status: 1 }));
  await running;
  assert.deepEqual(accesses, ['fetch', 'putRsvp', 'audit']);
  assert.deepEqual(f.edits, [{ content: 'RSVP saved: going.' }]);
  assert.deepEqual(f.replies, []);
});

for (const scenario of scenarios) {
  test(`${scenario.name} waits for ephemeral deferral before I/O and edits its completion`, async (t) => {
    const f = fixture(scenario);
    const running = f.run();
    t.after(async () => { f.defer.resolve(); f.work.resolve(scenario.value); await running; });
    assert.deepEqual(f.events, ['defer:start']);
    assert.deepEqual(f.actions, [], 'no service or store access while deferral is pending');
    f.defer.resolve();
    await f.entered.promise;
    assert.deepEqual(f.events, ['defer:start', 'defer:complete', scenario.method]);
    assert.deepEqual(f.actions, [{ method: scenario.method, args: scenario.args }]);
    assert.deepEqual(f.replies, []);
    assert.deepEqual(f.edits, [], 'slow I/O has not completed the response yet');
    f.work.resolve(scenario.value);
    await running;
    assert.deepEqual(f.edits, [{ content: scenario.content }]);
    assert.deepEqual(f.replies, []);
    assert.equal(f.interaction.replied, true, 'thinking response is completed');
  });

  test(`${scenario.name} edits a bounded error after deferred I/O rejects`, async () => {
    const f = fixture(scenario);
    const running = f.run();
    f.defer.resolve();
    await f.entered.promise;
    f.work.reject(new Error('x'.repeat(2100)));
    await running;
    assert.deepEqual(f.edits, [{ content: 'x'.repeat(2000) }]);
    assert.deepEqual(f.replies, []);
    assert.equal(f.interaction.replied, true);
  });
}

for (const [name, permission, message] of [
  ['lfg', PermissionFlagsBits.ManageEvents, 'Manage Events permission is required.'],
  ['lfg-close', PermissionFlagsBits.ManageEvents, 'Manage Events permission is required.'],
  ['feed-add', PermissionFlagsBits.ManageGuild, 'Manage Server permission is required.'],
  ['feed-remove', PermissionFlagsBits.ManageGuild, 'Manage Server permission is required.'],
  ['feed-list', PermissionFlagsBits.ManageGuild, 'Manage Server permission is required.'],
] as const) {
  test(`${name} keeps its immediate permission refusal without deferral or I/O`, async () => {
    const f = fixture(scenarios.find((scenario) => scenario.name === name)!);
    f.interaction.memberPermissions.has = (requested) => { assert.equal(requested, permission); return false; };
    await f.run();
    assert.deepEqual(f.events, ['reply']);
    assert.deepEqual(f.replies, [{ content: message, ephemeral: true }]);
    assert.deepEqual(f.actions, []);
    assert.deepEqual(f.edits, []);
  });
}

for (const scenario of [scenarios[0]!, scenarios[7]!]) {
  for (const location of ['other guild', 'DM']) {
    test(`${scenario.name} ignores ${location} without acknowledgement or I/O`, async () => {
      const f = fixture(scenario);
      if (location === 'DM') f.interaction.inGuild = () => false;
      else f.interaction.guildId = '1550000000000000099';
      await f.run();
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.actions, []);
    });
  }
}

for (const kind of ['command', 'select', 'other interaction']) {
  test(`unrelated ${kind} is not acknowledged and performs no I/O`, async () => {
    const f = fixture(kind === 'select' ? scenarios[7]! : scenarios[0]!);
    f.interaction.commandName = 'not-an-announcement';
    f.interaction.customId = 'another:lfg:post-1';
    if (kind === 'other interaction') f.interaction.isChatInputCommand = () => false;
    await f.run();
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.actions, []);
  });
}

for (const scenario of [scenarios[0]!, scenarios[7]!]) {
  test(`${scenario.name} does not start I/O if deferral rejects`, async () => {
    const f = fixture(scenario);
    const running = f.run();
    f.defer.reject(new Error('synthetic acknowledgement failure'));
    await running;
    assert.deepEqual(f.actions, []);
    assert.deepEqual(f.edits, []);
    assert.deepEqual(f.replies, [{ content: 'synthetic acknowledgement failure', ephemeral: true }]);
  });
}

test('non-Error rejection completes the deferred response with the fallback message', async () => {
  const f = fixture(scenarios[0]!);
  const running = f.run();
  f.defer.resolve();
  await f.entered.promise;
  f.work.reject(null);
  await running;
  assert.deepEqual(f.edits, [{ content: 'The announcement command failed.' }]);
  assert.deepEqual(f.replies, []);
});

test('failed error edit is contained without sending another initial reply', async () => {
  const f = fixture(scenarios[0]!);
  f.interaction.editReply = async () => { throw new Error('synthetic edit failure'); };
  const running = f.run();
  f.defer.resolve();
  await f.entered.promise;
  f.work.reject(new Error('synthetic service failure'));
  await assert.doesNotReject(running);
  assert.deepEqual(f.replies, []);
});
