/**
 * TOG-8306: two joins through different codes on the same tick must each
 * attribute exactly, not `ambiguous:A+B`.
 *
 * The race window: discord.js dispatches every gateway event to an async
 * listener without awaiting the previous one, and the invite snapshot is a
 * read-modify-write (`diffAndStore` reads the stored baseline, then writes)
 * with awaits between the steps. Two same-tick joins interleaved as:
 *
 *   join A fetches (A +1) -> join B fetches (A +1, B +1) ->
 *   A reads the stored baseline -> B reads the SAME stored baseline ->
 *   A stores its snapshot -> B diffs against the stale baseline and sees
 *   both codes grow.
 *
 * B is then stamped `ambiguous:A+B` even though exactly one code grew for
 * it, and A's stored write can clobber B's counter back down, poisoning the
 * next join too. The fix chains the whole fetch-plus-diff per guild, so the
 * second snapshot's baseline read cannot run until the first snapshot's
 * write has committed.
 *
 * This drives two same-tick joins through the real `registerHandlers` with a
 * tracker whose write lands a timer-tick after its read - the same shape as
 * the Postgres-backed tracker - and asserts each join sees exactly its own
 * delta. Against the pre-fix code the second join records `ambiguous:...`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { registerHandlers } from '../src/discord/client.ts';
import type { FunnelHandlers, JoinInput } from '../src/core/handlers.ts';
import type { InviteState, InviteTracker } from '../src/core/inviteTracker.ts';

const GUILD = '326474832151838730';
const CODE_A = 'aaa111';
const CODE_B = 'bBb222';

/**
 * Mimics the real InviteTracker read-modify-write shape: the baseline read
 * and the stored write are separated by an await, so two concurrent
 * diffAndStore calls both read before either writes - unless the caller
 * serializes them (the TOG-8306 per-guild chain).
 */
function racingTracker() {
  const baseline = new Map<string, number>([[CODE_A, 0], [CODE_B, 0]]);
  const diffAndStore = async (_guildId: string, current: InviteState[]): Promise<string[]> => {
    const before = new Map(baseline);
    // The race window: any concurrent snapshot reads the same stale baseline.
    await new Promise((r) => setTimeout(r, 10));
    const grew = current
      .filter((inv) => {
        const prev = before.get(inv.code);
        return prev !== undefined && inv.uses > prev;
      })
      .map((inv) => inv.code);
    for (const inv of current) baseline.set(inv.code, inv.uses);
    return grew;
  };
  return {
    diffAndStore,
    attribute: (grew: string[]) =>
      grew.length === 1 ? `invite:${grew[0]}` : grew.length > 1 ? `ambiguous:${grew.join('+')}` : 'unknown',
    inviterFor: async () => null,
  } as unknown as InviteTracker;
}

function state(code: string, uses: number): InviteState {
  return { code, uses, inviterId: null, channelId: null };
}

function member(id: string, fetched: InviteState[]) {
  return {
    id,
    user: { bot: false },
    joinedAt: new Date('2026-09-03T12:00:00Z'),
    guild: { id: GUILD, invites: { fetch: async () => fetched }, vanityURLCode: null },
  };
}

test('two same-tick joins through different codes each attribute exactly (TOG-8306)', async () => {
  const joins: JoinInput[] = [];
  const handlers = {
    onJoin: async (i: JoinInput) => {
      joins.push(i);
      return null;
    },
    onGateCleared: async () => {},
    onLeave: async () => ({}),
    onMessage: async () => null,
    onVoiceJoin: async () => null,
  } as unknown as FunnelHandlers;
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { handlers, invites: racingTracker() });

  // Join A consumes code A; join B consumes code B a tick later. Both
  // dispatches land before either snapshot finishes - the interleaving that
  // used to stamp the second join ambiguous.
  bus.emit(Events.GuildMemberAdd, member('mA', [state(CODE_A, 1), state(CODE_B, 0)]));
  bus.emit(Events.GuildMemberAdd, member('mB', [state(CODE_A, 1), state(CODE_B, 1)]));
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(joins.length, 2);
  const byMember = new Map(joins.map((j) => [j.memberId, j.source]));
  assert.equal(byMember.get('mA'), `invite:${CODE_A}`);
  assert.equal(byMember.get('mB'), `invite:${CODE_B}`);
});
