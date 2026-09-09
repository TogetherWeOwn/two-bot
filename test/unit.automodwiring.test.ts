import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events, type Client } from 'discord.js';
import { AutomodService } from '../src/automod/service.ts';
import type { AutomodPolicy } from '../src/automod/types.ts';
import { registerHandlers } from '../src/discord/client.ts';
import type { FunnelHandlers } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';
import { ActionError } from '../src/internal/errors.ts';
import type { ModerationDiscordClient } from '../src/moderation/discord.ts';
import type { ModerationService } from '../src/moderation/service.ts';
import type { ModerationStore } from '../src/moderation/store.ts';
import type { AutomodStore } from '../src/automod/store.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const policy: AutomodPolicy = {
  badWords: ['blocked'],
  blockedAttachmentExtensions: [],
  allowedDomains: [],
  repeatedMessageCount: 3,
  repeatedMessageWindowSeconds: 30,
  mentionLimit: 3,
  bypassRoleIds: new Set(),
  exemptChannelIds: new Set(),
  sanctions: [{ violations: 1, action: 'delete' }],
};

function deps() {
  let recorded = 0;
  const inspected: string[] = [];
  const observed: number[] = [];
  const handlers = {
    onMessage: async () => { recorded++; },
    onJoin: async () => null,
    onGateCleared: async () => null,
    onLeave: async () => null,
    onVoiceJoin: async () => null,
    onVoiceLeave: async () => null,
    voiceSessions: { openCount: 0, clear() {} },
  } as unknown as FunnelHandlers;
  const invites = {
    diffAndStore: async () => [],
    attribute: () => 'unknown',
    inviterFor: async () => null,
  } as unknown as InviteTracker;
  const automod = {
    inspect: async (message: { messageId: string; content: string; observedTimestamp: number }) => {
      inspected.push(`${message.messageId}:${message.content}`);
      observed.push(message.observedTimestamp);
      return { matched: message.content === 'blocked', deleted: message.content === 'blocked' };
    },
  } as unknown as AutomodService;
  return {
    handlers,
    invites,
    automod: { service: automod, guildId: '1545644954272137297' },
    inspected,
    observed,
    recorded: () => recorded,
  };
}

function message(id: string, content: string) {
  return {
    id,
    guildId: '1545644954272137297',
    channelId: '1546211375251066941',
    author: { id: '900000000000000001', bot: false },
    member: { roles: { cache: new Map([['900000000000000002', {}]]) } },
    content,
    mentions: { users: new Map() },
    attachments: new Map(),
    createdTimestamp: Date.now(),
    partial: false,
  };
}

function failingAutomod(failure: 'claim' | 'release'): AutomodService {
  const moderationStore = {
    claim: async () => {
      if (failure === 'claim') throw new Error('db unavailable');
      return { state: 'claimed' as const };
    },
    release: async () => { throw new Error('release unavailable'); },
  } as unknown as ModerationStore;
  const discord = {
    deleteMessage: async () => {
      throw new ActionError('discord_rejected', 'Discord refused the request with 403');
    },
  } as unknown as ModerationDiscordClient;
  return new AutomodService(
    discord,
    {} as ModerationService,
    moderationStore,
    {} as AutomodStore,
    { target: async () => { throw new Error('not reached'); } },
    {
      dryRun: false,
      owenUserId: '1469137636663758888',
      botHighestRolePosition: 10,
      policy,
    },
  );
}

test('blocked gateway messages do not earn funnel activity or leveling', async () => {
  const d = deps();
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, d);
  bus.emit(Events.MessageCreate, message('blocked-1', 'blocked'));
  await settle();
  assert.deepEqual(d.inspected, ['blocked-1:blocked']);
  assert.equal(d.recorded(), 0);

  bus.emit(Events.MessageCreate, message('allowed-1', 'allowed'));
  await settle();
  assert.equal(d.recorded(), 1);
});

test('matched storage failures do not earn funnel activity or leveling', async () => {
  for (const failure of ['claim', 'release'] as const) {
    const d = deps();
    const bus = new EventEmitter();
    registerHandlers(bus as unknown as Client, {
      ...d,
      automod: { service: failingAutomod(failure), guildId: '1545644954272137297' },
    });
    bus.emit(Events.MessageCreate, message(`${failure}-failure`, 'blocked'));
    await settle();
    assert.equal(d.recorded(), 0, `${failure} failure must remain matched at the gateway`);
  }
});

test('edited and uncached partial messages are inspected at edit time', async () => {
  const realNow = Date.now;
  Date.now = () => 2_000;
  try {
    const d = deps();
    const bus = new EventEmitter();
    registerHandlers(bus as unknown as Client, d);
    bus.emit(Events.MessageUpdate, message('edited-1', 'allowed'), message('edited-1', 'blocked'));
    await settle();
    const fetched = message('edited-2', 'blocked');
    bus.emit(Events.MessageUpdate, null, {
      ...fetched,
      partial: true,
      fetch: async () => fetched,
    });
    await settle();
    assert.deepEqual(d.inspected, ['edited-1:blocked', 'edited-2:blocked']);
    assert.deepEqual(d.observed, [2_000, 2_000]);
    assert.equal(d.recorded(), 0, 'edits never create a second funnel message event');
  } finally {
    Date.now = realNow;
  }
});

test('messages outside the configured guild are never inspected', async () => {
  const d = deps();
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, d);
  bus.emit(Events.MessageCreate, { ...message('other-1', 'blocked'), guildId: '900000000000000099' });
  await settle();
  assert.deepEqual(d.inspected, []);
  assert.equal(d.recorded(), 1, 'the unrelated guild keeps its ordinary funnel behavior');
});
