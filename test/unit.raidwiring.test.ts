/**
 * The detector is wired to the gateway.
 *
 * A raid detector that exists but is never called looks exactly like one that
 * works, right up until the raid. So this drives joins through the real
 * `registerHandlers` and asserts an alert comes out the other end - and, just
 * as importantly, that a failure in the alerting path never costs us the join
 * record it was alerting about.
 *
 * discord.js is not started here: `registerHandlers` only ever calls
 * `client.on`/`client.once`, so an EventEmitter is a faithful stand-in and the
 * test needs no network, token or server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { registerHandlers } from '../src/discord/client.ts';
import { RaidWatch, type RaidAlert } from '../src/analytics/raidWatch.ts';
import type { FunnelHandlers, JoinInput } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';

const GUILD = '326474832151838730';

/** Records joins instead of writing them. */
function fakeDeps() {
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
  const invites = {
    diffAndStore: async () => [],
    attribute: () => 'unknown',
    inviterFor: async () => null,
  } as unknown as InviteTracker;
  return { joins, handlers, invites };
}

function member(id: string, atIso: string) {
  return {
    id,
    user: { bot: false },
    joinedAt: new Date(atIso),
    guild: { id: GUILD, invites: { fetch: async () => [] }, vanityURLCode: null },
  };
}

/** discord.js emits asynchronously; give the handler a turn to finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test('five joins on the gateway produce one alert', async () => {
  const { joins, handlers, invites } = fakeDeps();
  const alerts: RaidAlert[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, {
    handlers,
    invites,
    raid: {
      watch: new RaidWatch(),
      announce: async (a) => {
        alerts.push(a);
      },
    },
  });

  for (let i = 0; i < 5; i++) {
    bus.emit(Events.GuildMemberAdd, member(`m${i}`, `2026-02-01T20:00:0${i}Z`));
    await settle();
  }

  assert.equal(joins.length, 5, 'every join is still recorded');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].count, 5);
  assert.equal(alerts[0].guildId, GUILD);
});

test('a broken alert path never costs us the join record', async () => {
  const { joins, handlers, invites } = fakeDeps();
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, {
    handlers,
    invites,
    raid: {
      watch: new RaidWatch(),
      announce: async () => {
        throw new Error('staff channel deleted');
      },
    },
  });

  for (let i = 0; i < 6; i++) {
    bus.emit(Events.GuildMemberAdd, member(`m${i}`, `2026-02-01T20:00:0${i}Z`));
    await settle();
  }

  assert.equal(joins.length, 6);
});

test('ordinary joins minutes apart alert nobody', async () => {
  const { handlers, invites } = fakeDeps();
  const alerts: RaidAlert[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, {
    handlers,
    invites,
    raid: { watch: new RaidWatch(), announce: async (a) => void alerts.push(a) },
  });

  for (let i = 0; i < 10; i++) {
    bus.emit(Events.GuildMemberAdd, member(`m${i}`, `2026-02-01T2${i % 4}:00:00Z`));
    await settle();
  }

  assert.deepEqual(alerts, []);
});
