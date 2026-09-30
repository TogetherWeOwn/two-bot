import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Db, Statement } from '../src/store/db.ts';
import { DiscordRest } from '../src/discord/rest.ts';
import { log } from '../src/core/log.ts';
import { RANKS, startCommunitySnapshots } from '../src/jobs/communitySnapshots.ts';

function fixture(t: TestContext, failActive = false) {
  const ticks: Array<() => void> = [];
  const reads: string[] = [];
  const writes: string[] = [];
  const paths: string[] = [];
  const errors: string[] = [];
  const completed: string[] = [];
  let cycles = 0;
  let transactions = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(globalThis, 'setInterval', (tick: () => void) => {
    ticks.push(tick);
    return { unref() {} } as ReturnType<typeof setInterval>;
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(log, 'info', (message: string) => { completed.push(message); });
  t.mock.method(log, 'error', (message: string) => { errors.push(message); });

  const db: Db = {
    prepare(sql: string): Statement {
      return {
        async get() { throw new Error(`unexpected get: ${sql}`); },
        async all<T>(): Promise<T[]> {
          assert.match(sql, /FROM members/);
          reads.push(sql);
          return [{ member_id: 'excluded', first_message_at: null, first_voice_at: null, left_at: null }] as T[];
        },
        async run() {
          assert.match(sql, /^\s*(INSERT|UPDATE|DELETE) /);
          writes.push(sql);
          return { changes: 1 };
        },
      };
    },
    async exec() { throw new Error('unexpected exec'); },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      transactions++;
      if (failActive) throw new Error('active transaction failed');
      return fn(db);
    },
    async close() {},
  };
  const rest = new DiscordRest({
    token: 'test-token',
    base: 'https://discord.test/api/v10',
    fetchImpl: async () => { throw new Error('offline test forbids network access'); },
  });
  t.mock.method(rest, 'get', async (path: string) => {
    paths.push(path);
    if (path.includes('/members?')) {
      await barrier;
      return [{ user: { id: 'human', bot: false }, roles: [] }];
    }
    assert.equal(path, '/guilds/guild-test/roles');
    return RANKS.map((rank) => ({ id: `role-${rank.key}`, name: rank.label }));
  });
  const handle = startCommunitySnapshots({
    db, rest, guildId: 'guild-test',
    now() { cycles++; return '2026-09-30T00:00:00.000Z'; },
  });
  t.after(async () => { handle.stop(); release(); await flush(); });
  return {
    handle, ticks, reads, writes, paths, errors, completed, release,
    get cycles() { return cycles; },
    get transactions() { return transactions; },
  };
}

// Let all finite collector awaits and queued promise reactions settle, without sleeps.
async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

for (const failActive of [false, true]) {
  test(`stop discards queued counter/rank work while the active rank cycle ${failActive ? 'fails' : 'finishes'}`, async (t) => {
    const f = fixture(t, failActive);
    await flush();
    assert.equal(f.cycles, 1);
    assert.equal(f.reads.length, 3);
    assert.deepEqual(f.paths, ['/guilds/guild-test/members?limit=1000&after=0']);
    assert.equal(f.writes.length, 0);
    assert.equal(f.transactions, 0);

    const [counterTick, rankTick] = f.ticks;
    counterTick();
    rankTick();
    counterTick();
    rankTick();
    f.handle.stop();
    f.handle.stop();
    // Captured callbacks can still fire even though the timers were cleared.
    counterTick();
    rankTick();
    f.release();
    await flush();

    assert.equal(f.cycles, 1, 'no pending cycle started');
    assert.equal(f.reads.length, 3, 'no pending cycle read the database');
    assert.deepEqual(f.paths, [
      '/guilds/guild-test/members?limit=1000&after=0',
      '/guilds/guild-test/roles',
    ], 'only the active rank cycle finishes its REST reads');
    assert.equal(f.transactions, 1, 'the active cycle still attempts publication after stop');
    if (failActive) {
      assert.deepEqual(f.errors, ['rank_snapshot_failed']);
      assert.equal(f.writes.length, 0);
    } else {
      assert.deepEqual(f.errors, []);
      assert.ok(f.writes.some((sql) => sql.includes('INSERT INTO rank_snapshots')));
      assert.ok(f.writes.some((sql) => sql.includes('INSERT INTO member_ranks')));
      assert.ok(f.completed.includes('rank_snapshot_recorded'));
    }

    const writes = f.writes.length;
    counterTick();
    rankTick();
    await flush();
    assert.equal(f.cycles, 1);
    assert.equal(f.reads.length, 3);
    assert.equal(f.paths.length, 2);
    assert.equal(f.transactions, 1);
    assert.equal(f.writes.length, writes);
  });
}

test('stop before the initial rank microtask prevents all collector I/O', async (t) => {
  const f = fixture(t);
  f.ticks[0]();
  f.ticks[1]();
  f.handle.stop();
  f.handle.stop();
  f.ticks[0]();
  f.ticks[1]();
  await flush();
  assert.equal(f.cycles, 0);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.paths, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.transactions, 0);
});
