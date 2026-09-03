/**
 * §7 attribution is wired to the gateway.
 *
 * A note store that exists but is never consulted files every one-click join
 * `unknown`, which is exactly the failure TOG-464 exists to prevent - and it
 * looks identical to working code until the first cohort lands. So this drives
 * joins through the real `registerHandlers` and asserts the recorded source.
 *
 * Same approach as unit.raidwiring.test.ts: `registerHandlers` only calls
 * `client.on`/`client.once`, so an EventEmitter is a faithful stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { registerHandlers } from '../src/discord/client.ts';
import { ExpectedJoins, WEB_ONE_CLICK_SOURCE } from '../src/core/expectedJoins.ts';
import type { FunnelHandlers, JoinInput } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';

const GUILD = '326474832151838730';

function fakeDeps(over: { grew?: string[]; inviterId?: string | null } = {}) {
  const joins: JoinInput[] = [];
  const handlers = {
    onJoin: async (i: JoinInput) => {
      joins.push(i);
      return null;
    },
    onLeave: async () => ({}),
    onMessage: async () => null,
    onVoiceJoin: async () => null,
  } as unknown as FunnelHandlers;
  const grew = over.grew ?? [];
  const invites = {
    diffAndStore: async () => grew,
    attribute: (g: string[]) => (g.length === 1 ? `invite:${g[0]}` : 'unknown'),
    inviterFor: async () => over.inviterId ?? null,
  } as unknown as InviteTracker;
  return { joins, handlers, invites };
}

function member(id: string) {
  return {
    id,
    user: { bot: false },
    joinedAt: new Date('2026-09-03T12:00:00Z'),
    guild: { id: GUILD, invites: { fetch: async () => [] }, vanityURLCode: null },
  };
}

/** discord.js emits asynchronously; give the handler a turn to finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test('an expected join is stamped web:one_click', async () => {
  const { joins, handlers, invites } = fakeDeps();
  const expectedJoins = new ExpectedJoins();
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { handlers, invites, expectedJoins });

  expectedJoins.expect(GUILD, 'm1', WEB_ONE_CLICK_SOURCE);
  bus.emit(Events.GuildMemberAdd, member('m1'));
  await settle();

  assert.equal(joins.length, 1);
  assert.equal(joins[0].source, 'web:one_click');
  assert.equal(expectedJoins.size, 0, 'the note was consumed');
});

test('the note beats a coincidental invite delta, and takes no inviter', async () => {
  // An organic join through code aB3xY9 lands in the same window as a
  // one-click join. The one-click member must not be credited to the code -
  // or to its inviter.
  const { joins, handlers, invites } = fakeDeps({ grew: ['aB3xY9'], inviterId: 'inviter-1' });
  const expectedJoins = new ExpectedJoins();
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { handlers, invites, expectedJoins });

  expectedJoins.expect(GUILD, 'm1', WEB_ONE_CLICK_SOURCE);
  bus.emit(Events.GuildMemberAdd, member('m1'));
  await settle();

  assert.equal(joins[0].source, 'web:one_click');
  assert.equal(joins[0].inviterId, null);
});

test('an unannounced join still attributes by invite diff', async () => {
  const { joins, handlers, invites } = fakeDeps({ grew: ['aB3xY9'], inviterId: 'inviter-1' });
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, {
    handlers,
    invites,
    expectedJoins: new ExpectedJoins(),
  });

  bus.emit(Events.GuildMemberAdd, member('m2'));
  await settle();

  assert.equal(joins[0].source, 'invite:aB3xY9');
  assert.equal(joins[0].inviterId, 'inviter-1');
});

test('without an ExpectedJoins, joins record exactly as before', async () => {
  const { joins, handlers, invites } = fakeDeps();
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { handlers, invites });

  bus.emit(Events.GuildMemberAdd, member('m3'));
  await settle();

  assert.equal(joins.length, 1);
  assert.equal(joins[0].source, 'unknown');
});
