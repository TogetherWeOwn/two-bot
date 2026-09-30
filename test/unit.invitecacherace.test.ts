// TOG-8306: real invite diffs and membership projections with in-memory DB
// doubles. Explicit barriers expose the races without network or timer sleeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { registerHandlers, type BotDeps } from '../src/discord/client.ts';
import { FunnelHandlers, type JoinInput } from '../src/core/handlers.ts';
import { InviteTracker } from '../src/core/inviteTracker.ts';
import { ExpectedJoins, WEB_ONE_CLICK_SOURCE } from '../src/core/expectedJoins.ts';
import { EventStore } from '../src/store/eventStore.ts';
import type { Db } from '../src/store/db.ts';

const GUILD = '326474832151838730';
const CODE_A = 'aaa111';
const CODE_B = 'bBb222';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type FetchedInvite = { code: string; uses: number; inviter: null; channel: null };

function fixture(extra: Partial<BotDeps> = {}) {
  const started = deferred();
  const release = deferred();
  const joins: JoinInput[] = [];
  const baseline = new Map([[CODE_A, 0], [CODE_B, 0]]);
  const counters = new Map(baseline);
  let firstWrite = true;
  let failWrite = false;
  let reads = 0;
  // Use the production tracker; pause its first write AFTER the baseline read.
  const db = {
    prepare(sql: string) {
      if (sql.includes('SELECT code, uses FROM invite_snapshots')) {
        return { all: async () => {
          reads++;
          return [...baseline].map(([code, uses]) => ({ code, uses }));
        } };
      }
      if (sql.includes('INSERT INTO invite_snapshots')) {
        return { run: async (_guild: string, code: string, uses: number) => {
          if (firstWrite) {
            firstWrite = false;
            started.resolve();
            await release.promise;
            if (failWrite) throw new Error('test write failure');
          }
          baseline.set(code, uses);
        } };
      }
      if (sql.includes('SELECT inviter_id FROM invite_snapshots')) {
        return { get: async () => ({ inviter_id: null }) };
      }
      throw new Error(`Unexpected invite SQL: ${sql}`);
    },
  } as unknown as Db;
  // Every member shares one mutable guild; fetch captures counters at invocation.
  const guild = {
    id: GUILD,
    vanityURLCode: null,
    invites: { fetch: async (): Promise<FetchedInvite[]> =>
      [...counters].map(([code, uses]) => ({ code, uses, inviter: null, channel: null })) },
  };
  const handlers = {
    onJoin: async (i: JoinInput) => { joins.push(i); return null; },
    onGateCleared: async () => null,
    onLeave: async () => null,
  } as unknown as FunnelHandlers;
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, { handlers, invites: new InviteTracker(db), ...extra });
  return {
    bus, guild, started, release, joins, baseline, counters,
    reads: () => reads,
    failWrite: () => { failWrite = true; },
    member: (id: string) => ({
      id, guild, user: { bot: false }, pending: true, partial: true,
      joinedAt: new Date('2026-09-30T12:00:00Z'),
    }),
  };
}

test('same-tick joins serialize baseline reads, each seeing only its delta', async () => {
  const f = fixture();
  f.counters.set(CODE_A, 1);
  f.bus.emit(Events.GuildMemberAdd, f.member('mA'));
  f.counters.set(CODE_B, 1);
  f.bus.emit(Events.GuildMemberAdd, f.member('mB'));
  await f.started.promise;
  await flush();
  assert.equal(f.reads(), 1, 'second diff cannot read before the first write finishes');
  f.release.resolve();
  await flush();
  assert.deepEqual(f.joins.map((j) => [j.memberId, j.source]), [
    ['mA', `invite:${CODE_A}`], ['mB', `invite:${CODE_B}`],
  ]);
});

test('queued InviteCreate captures before a later join, rather than consuming its delta', async () => {
  const f = fixture();
  f.bus.emit(Events.InviteCreate, { guild: f.guild });
  await f.started.promise;
  f.bus.emit(Events.InviteCreate, { guild: f.guild });
  f.counters.set(CODE_A, 1);
  f.bus.emit(Events.GuildMemberAdd, f.member('organic'));
  await flush();
  f.release.resolve();
  await flush();
  assert.equal(f.joins[0]?.source, `invite:${CODE_A}`);
});

test('a prompt one-click receipt survives queue delay beyond the note TTL', async () => {
  let now = 0;
  const expectedJoins = new ExpectedJoins({ now: () => now });
  const f = fixture({ expectedJoins });
  f.bus.emit(Events.InviteCreate, { guild: f.guild });
  await f.started.promise;
  expectedJoins.expect(GUILD, 'web', WEB_ONE_CLICK_SOURCE);
  now = 1;
  f.bus.emit(Events.GuildMemberAdd, f.member('web'));
  now = 30_001;
  f.release.resolve();
  await flush();
  assert.equal(f.joins[0]?.source, WEB_ONE_CLICK_SOURCE);
  assert.equal(expectedJoins.size, 0);
  assert.equal(f.reads(), 2, 'one-click joins still update the invite snapshot');
});

function projection() {
  const rows = new Map<string, Record<string, unknown>>();
  const recorded: { type: string; member: string; at: string }[] = [];
  const db = {
    transaction: async (fn: (db: Db) => Promise<unknown>) => fn(db),
    prepare(sql: string) {
      if (sql.includes('INSERT INTO events')) {
        return { get: async (type: string, member: string, _guild: string, at: string) => {
          recorded.push({ type, member, at });
          return { id: recorded.length };
        } };
      }
      if (sql.includes('INSERT INTO members')) {
        return { run: async (_guild: string, member: string) => {
          if (!rows.has(member)) rows.set(member, {});
        } };
      }
      const column = sql.match(/UPDATE members SET ([a-z_]+) = \?/);
      if (column) {
        return { run: async (value: unknown, _guild: string, member: string) => {
          rows.get(member)![column[1]] = value;
        } };
      }
      throw new Error(`Unexpected event SQL: ${sql}`);
    },
  } as unknown as Db;
  return { rows, recorded, handlers: new FunnelHandlers(new EventStore(db)) };
}

test('slow invite I/O cannot persist an older join after a leave', async () => {
  const p = projection();
  const f = fixture({ handlers: p.handlers });
  f.bus.emit(Events.InviteCreate, { guild: f.guild });
  await f.started.promise;
  f.bus.emit(Events.GuildMemberAdd, f.member('brief'));
  f.bus.emit(Events.GuildMemberRemove, f.member('brief'));
  await flush();
  assert.equal(p.recorded.length, 0, 'leave waits for the pending join');
  // Release before awaiting leave: ordering deliberately prevents early leave.
  f.release.resolve();
  await flush();
  assert.deepEqual(p.recorded.map((e) => e.type), ['member_join', 'member_leave']);
  assert.equal(typeof p.rows.get('brief')?.left_at, 'string');
});

test('gate, leave and rejoin preserve dispatch order and observation timestamps', async () => {
  const p = projection();
  const f = fixture({ handlers: p.handlers });
  f.bus.emit(Events.InviteCreate, { guild: f.guild });
  await f.started.promise;
  f.bus.emit(Events.GuildMemberAdd, f.member('returning'));
  f.bus.emit(Events.GuildMemberUpdate, f.member('returning'), {
    ...f.member('returning'), pending: false,
  });
  f.bus.emit(Events.GuildMemberRemove, f.member('returning'));
  f.bus.emit(Events.GuildMemberAdd, {
    ...f.member('returning'), joinedAt: new Date('2026-09-30T13:00:00Z'),
  });
  await flush();
  const beforeRelease = new Date().toISOString();
  f.release.resolve();
  await flush();
  assert.deepEqual(p.recorded.map((e) => e.type), [
    'member_join', 'gate_cleared', 'member_leave', 'member_join',
  ]);
  assert.ok(p.recorded[1].at <= beforeRelease);
  assert.ok(p.recorded[2].at <= beforeRelease);
  assert.equal(p.rows.get('returning')?.left_at, null);
  assert.equal(p.rows.get('returning')?.joined_at, '2026-09-30T13:00:00.000Z');
});

test('a rejected fetch queued behind a slow write preserves the baseline and later joins', async () => {
  const f = fixture();
  const fetch = f.guild.invites.fetch;
  f.bus.emit(Events.InviteCreate, { guild: f.guild });
  await f.started.promise;
  f.guild.invites.fetch = async () => { throw new Error('test fetch failure'); };
  f.bus.emit(Events.InviteCreate, { guild: f.guild });
  await flush(); // Rejection must be handled now, not at the front of the queue.
  f.guild.invites.fetch = fetch;
  f.counters.set(CODE_A, 1);
  f.bus.emit(Events.GuildMemberAdd, f.member('after-failure'));
  f.release.resolve();
  await flush();
  assert.equal(f.joins[0]?.source, `invite:${CODE_A}`);
  assert.equal(f.reads(), 2, 'failed fetch must not diff/store an empty snapshot');
});

test('a failed store does not poison the guild queue', async () => {
  const f = fixture();
  f.failWrite();
  f.bus.emit(Events.InviteCreate, { guild: f.guild });
  await f.started.promise;
  f.counters.set(CODE_A, 1);
  f.bus.emit(Events.GuildMemberAdd, f.member('after-failure'));
  f.release.resolve();
  await flush();
  assert.equal(f.joins[0]?.source, `invite:${CODE_A}`);
});

test('REST response completion order cannot reorder stored snapshots', async () => {
  const f = fixture();
  const fetched = deferred();
  const releaseFetch = deferred();
  const fetch = f.guild.invites.fetch;
  let first = true;
  f.guild.invites.fetch = async () => {
    const states = await fetch();
    if (first) {
      first = false;
      fetched.resolve();
      await releaseFetch.promise;
    }
    return states;
  };
  f.counters.set(CODE_A, 1);
  f.bus.emit(Events.GuildMemberAdd, f.member('first'));
  await fetched.promise;
  f.counters.set(CODE_B, 1);
  f.bus.emit(Events.GuildMemberAdd, f.member('second'));
  await flush();
  assert.equal(f.reads(), 0, 'later REST response cannot start its diff first');
  releaseFetch.resolve();
  f.release.resolve();
  await flush();
  assert.deepEqual(f.joins.map((j) => j.source), [`invite:${CODE_A}`, `invite:${CODE_B}`]);
});
