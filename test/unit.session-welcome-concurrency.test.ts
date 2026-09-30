import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Events, type Client, type GuildMember } from 'discord.js';
import type { FunnelEvent } from '../src/core/events.ts';
import { registerSessionWelcome } from '../src/discord/sessionWelcome.ts';
import { SESSION_PICKS, SessionRecorder } from '../src/onboarding/session.ts';
import type { EventStore } from '../src/store/eventStore.ts';

const GUILD = 'guild';
const LANDING = 'landing';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

function harness(dryRun = false) {
  const client = new EventEmitter();
  const events: FunnelEvent[] = [];
  const checks: string[] = [];
  const messages: { content: string; allowedMentions: { users: string[] } }[] = [];
  const roleWrites: string[] = [];
  const dms: string[] = [];
  const hooks = {
    check: async (_memberId: string) => {},
    send: async () => {},
    record: async () => {},
  };
  let landingChannelIds = [LANDING];
  const channel = {
    id: LANDING,
    guild: { id: GUILD },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    async send(payload: (typeof messages)[number]) {
      await hooks.send();
      messages.push(payload);
      return { id: `message-${messages.length}` };
    },
  };
  const store = {
    async hasEvent(guildId: string, memberId: string, eventType: string) {
      checks.push(memberId);
      // Snapshot before the barrier: without the guard, simultaneous callbacks
      // both observe false even if one records before the other resumes.
      const exists = events.some((event) =>
        event.guildId === guildId && event.memberId === memberId && event.eventType === eventType);
      await hooks.check(memberId);
      return exists;
    },
    async record(event: FunnelEvent) {
      await hooks.record();
      // Do not dedupe here: a second prompted call must fail the assertion.
      events.push(event);
    },
  } as unknown as EventStore;
  Object.assign(client, {
    user: { id: 'bot' },
    channels: { cache: new Map([[LANDING, channel]]) },
  });
  registerSessionWelcome(client as unknown as Client, {
    recorder: new SessionRecorder(store),
    store,
    guildId: GUILD,
    landingChannelIds: () => landingChannelIds,
    goodbyeChannelIds: () => [],
    picks: SESSION_PICKS,
    dryRun,
  });
  function member(id = 'member', guildId = GUILD, bot = false): GuildMember {
    return {
      id,
      guild: { id: guildId },
      user: { bot, send: async () => { dms.push(id); } },
      pending: false,
      roles: {
        add: async () => { roleWrites.push(id); },
        remove: async () => { roleWrites.push(id); },
        set: async () => { roleWrites.push(id); },
      },
    } as unknown as GuildMember;
  }
  return {
    events, checks, messages, roleWrites, dms, hooks, member,
    join: (m: GuildMember) => client.emit(Events.GuildMemberAdd, m),
    clearGate: (m: GuildMember) => client.emit(Events.GuildMemberUpdate, { ...m, pending: true }, m),
    update: (m: GuildMember) => client.emit(Events.GuildMemberUpdate, m, m),
    setLandingChannels: (ids: string[]) => { landingChannelIds = ids; },
  };
}

function assertWelcome(h: ReturnType<typeof harness>, memberId = 'member') {
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].content, new RegExp(`<@${memberId}>`));
  assert.deepEqual(h.messages[0].allowedMentions, { users: [memberId] });
  assert.deepEqual(h.events.map(({ guildId, memberId, eventType, source }) =>
    ({ guildId, memberId, eventType, source })), [{
    guildId: GUILD, memberId, eventType: 'onboarding_prompted', source: `channel:${LANDING}`,
  }]);
  assert.deepEqual(h.roleWrites, []);
  assert.deepEqual(h.dms, []);
}

test('concurrent join/rules callbacks send and record once, holding the claim through recording',
  { timeout: 2000 }, async () => {
    const h = harness();
    const check = barrier();
    const send = barrier();
    const record = barrier();
    h.hooks.check = async () => { await check.wait; };
    h.hooks.send = async () => { await send.wait; };
    h.hooks.record = async () => { await record.wait; };
    const member = h.member();

    h.join(member);
    h.clearGate(member);
    await turn();
    assert.deepEqual(h.checks, ['member'], 'one lookup while both callbacks are eligible');
    assert.equal(h.messages.length, 0);

    check.release();
    await turn();
    h.clearGate(member);
    await turn();
    assert.deepEqual(h.checks, ['member'], 'send is still in flight');
    send.release();
    await turn();
    assert.equal(h.messages.length, 1);
    assert.equal(h.events.length, 0, 'recording is blocked after the public send');
    h.join(member);
    await turn();
    assert.deepEqual(h.checks, ['member'], 'claim must survive until recording finishes');

    record.release();
    await turn();
    assert.deepEqual(h.checks, Array(4).fill('member'), 'queued callbacks check the persisted event');
    assertWelcome(h);
    h.clearGate(member);
    await turn();
    assert.deepEqual(h.checks, Array(5).fill('member'), 'later callbacks check the persisted event');
    assertWelcome(h);
  });

test('a blocked member does not serialize unrelated members', { timeout: 2000 }, async () => {
  const h = harness();
  const first = barrier();
  h.hooks.check = async (id) => { if (id === 'first') await first.wait; };
  h.join(h.member('first'));
  h.clearGate(h.member('second'));
  await turn();
  assertWelcome(h, 'second');
  assert.deepEqual(h.checks, ['first', 'second']);

  first.release();
  await turn();
  assert.deepEqual(h.events.map((event) => event.memberId), ['second', 'first']);
  assert.equal(h.messages.length, 2);
});

test('pre-send failures release the claim for a later valid callback', async (t) => {
  for (const failure of ['lookup', 'no-channel', 'send'] as const) {
    await t.test(failure, { timeout: 2000 }, async () => {
      const h = harness();
      if (failure === 'lookup') h.hooks.check = async () => { throw new Error('lookup failed'); };
      if (failure === 'no-channel') h.setLandingChannels([]);
      if (failure === 'send') h.hooks.send = async () => { throw new Error('send refused'); };
      h.join(h.member());
      await turn();
      assert.equal(h.messages.length, 0);
      assert.equal(h.events.length, 0);

      h.hooks.check = async () => {};
      h.hooks.send = async () => {};
      h.setLandingChannels([LANDING]);
      h.clearGate(h.member());
      await turn();
      assert.deepEqual(h.checks, ['member', 'member']);
      assertWelcome(h);
    });
  }
});

test('an overlapping callback retries after the active attempt fails before delivery',
  { timeout: 2000 }, async (t) => {
    for (const failure of ['lookup', 'send'] as const) {
      await t.test(failure, { timeout: 2000 }, async () => {
        const h = harness();
        const entered = barrier();
        const active = barrier();
        let attempts = 0;
        h.hooks[failure === 'lookup' ? 'check' : 'send'] = async () => {
          if (++attempts !== 1) return;
          entered.release();
          await active.wait;
          throw new Error(`${failure} failed before delivery`);
        };

        h.join(h.member());
        await entered.wait;
        try {
          h.clearGate(h.member());
          await turn();
          assert.deepEqual(h.checks, ['member'], 'overlapping callback waits for the active attempt');
          assert.equal(h.messages.length, 0);
          assert.equal(h.events.length, 0);
        } finally {
          active.release();
        }
        await turn();
        assert.deepEqual(h.checks, ['member', 'member'], 'queued callback rechecks persistence');
        assertWelcome(h);
      });
    }
  });

test('session dry-run retains its welcome behavior with concurrent callbacks', async () => {
  const h = harness(true);
  h.join(h.member());
  h.clearGate(h.member());
  await turn();
  assertWelcome(h);
});

test('foreign guilds, bots, pending joins, and unchanged pending state remain ineligible', async () => {
  const h = harness();
  h.join(h.member('foreign', 'another-guild'));
  h.clearGate(h.member('foreign', 'another-guild'));
  h.join(h.member('bot', GUILD, true));
  h.clearGate(h.member('bot', GUILD, true));
  h.join({ ...h.member('pending'), pending: true } as GuildMember);
  h.update(h.member('unchanged'));
  await turn();
  assert.deepEqual(h.checks, []);
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.roleWrites, []);
  assert.deepEqual(h.dms, []);
});
