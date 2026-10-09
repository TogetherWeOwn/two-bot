import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Db, Statement } from '../src/store/db.ts';
import { DiscordRest } from '../src/discord/rest.ts';
import { ANOMALIES, windowBounds } from '../src/analytics/anomalies.ts';
import { RANKS, runRankSnapshotCycle } from '../src/jobs/communitySnapshots.ts';

const GUILD = 'guild-test';
const OLD = '2026-09-30T12:00:00.000Z';
const NOW = '2026-09-30T12:10:00.000Z';
const RECOVERED = '2026-09-30T12:20:00.000Z';
const roleId = (key: string) => `role-${key}`;
const roles = (): Array<{ id: string; name: string }> =>
  RANKS.map((rank) => ({ id: roleId(rank.key), name: rank.label }));
const member = (id: string, held: string[] = [], bot = false) => ({
  user: { id, bot }, roles: held,
});
const raids = ANOMALIES.filter((a) => a.kind === 'raid');

function fixture(t: TestContext) {
  // Track the publication bindings by table/key, including every timestamp.
  // This is not a SQL engine: only the collector's reads/writes are supported.
  const cache = {
    counter_snapshots: new Map<string, unknown[]>(),
    guild_counters: new Map<string, unknown[]>(),
    web_contract_meta: new Map<string, unknown[]>(),
    rank_ladder: new Map<string, unknown[]>(),
    rank_snapshots: new Map<string, unknown[]>(),
    member_ranks: new Map<string, unknown[]>(),
    member_exclusions: new Map<string, unknown[]>(),
  };
  const reads: unknown[][] = [];
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const paths: string[] = [];
  let transactions = 0;
  let inTransaction = false;
  let observedAt = OLD;
  let roleResponse = roles();
  let roster = [member('old-human', [roleId('prospect')])];
  const excluded = raids.map((_, i) => member(`raid-${i}`, RANKS.map((rank) => roleId(rank.key))));

  const db: Db = {
    prepare(sql: string): Statement {
      return {
        async get() { throw new Error(`unexpected get: ${sql}`); },
        async all<T>(...params: unknown[]): Promise<T[]> {
          assert.match(sql, /FROM members/);
          const index = raids.findIndex((raid) => {
            const { from, to } = windowBounds(raid);
            return params[1] === from && params[2] === to;
          });
          assert.equal(params[0], GUILD);
          assert.ok(index >= 0, 'read a configured raid window');
          reads.push(params);
          return [{ member_id: `raid-${index}`, first_message_at: null, first_voice_at: null, left_at: null }] as T[];
        },
        async run(...params: unknown[]) {
          assert.ok(inTransaction, 'publication must stay inside the transaction');
          const match = sql.match(/^\s*(INSERT INTO|UPDATE|DELETE FROM) (\w+)/);
          assert.ok(match, `unexpected write: ${sql}`);
          const [, operation, table] = match;
          assert.ok(Object.hasOwn(cache, table), `unexpected table: ${table}`);
          const rows = cache[table as keyof typeof cache];
          if (operation === 'DELETE FROM') {
            assert.ok(table === 'member_ranks' || table === 'member_exclusions');
            assert.deepEqual(params, [GUILD]);
            rows.clear();
          } else {
            const key = table === 'rank_ladder' ? params[2]
              : table === 'web_contract_meta' ? 'singleton'
              : table === 'counter_snapshots' || table === 'guild_counters' ? params[0]
              : params[1];
            assert.equal(typeof key, 'string');
            rows.set(key as string, [...params]);
          }
          writes.push({ sql, params });
          return { changes: 1 };
        },
      };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      transactions++;
      inTransaction = true;
      try { return await fn(db); }
      finally { inTransaction = false; }
    },
    async exec() { throw new Error('unexpected exec'); },
    async close() {},
  };
  const rest = new DiscordRest({
    token: 'test-token',
    fetchImpl: async () => { throw new Error('offline fixture forbids network access'); },
  });
  t.mock.method(rest, 'get', async (path: string) => {
    paths.push(path);
    if (path === `/guilds/${GUILD}/roles`) return roleResponse;
    assert.equal(path, `/guilds/${GUILD}/members?limit=1000&after=0`);
    return [...roster, ...excluded, member('bot', [], true)];
  });

  return {
    cache, reads, writes, paths,
    cycle: () => runRankSnapshotCycle({ db, rest, guildId: GUILD, now: () => observedAt }),
    setRoles(value: ReturnType<typeof roles>) { roleResponse = value; },
    setTime(value: string) { observedAt = value; },
    useNewRoster() {
      roster = [
        member('new-member', [roleId('prospect'), roleId('member')]),
        member('new-soldier', [roleId('prospect'), roleId('member'), roleId('soldier')]),
        member('unranked'),
      ];
    },
    resetCalls() { transactions = 0; reads.length = writes.length = paths.length = 0; },
    get transactions() { return transactions; },
  };
}

const cases = [
  ...['Member', 'member', '  mEmBeR\t'].map((name) => ({
    name: `duplicate Member name ${JSON.stringify(name)}`,
    roles: () => [{ id: 'role-duplicate-member', name }, ...roles()],
  })),
  {
    name: 'Soldier renamed away from the required name',
    roles: () => roles().map((role) => role.id === roleId('soldier') ? { ...role, name: 'Trooper' } : role),
  },
];

for (const scenario of cases) {
  test(`${scenario.name} refuses before publication and preserves the last-good snapshot`, async (t) => {
    const f = fixture(t);
    const initial = await f.cycle();
    assert.equal(initial.recorded, true, 'seed a real successful collector publication');
    assert.equal(initial.humanMemberCount, 1);
    assert.equal(initial.rankedMemberCount, 1);
    assert.equal(f.cache.rank_ladder.size, 5);
    assert.equal(f.cache.rank_snapshots.size, 5);
    assert.deepEqual(f.cache.guild_counters.get(GUILD), [GUILD, 1, OLD]);
    assert.deepEqual(f.cache.counter_snapshots.get(GUILD), [GUILD, 1, OLD]);
    assert.deepEqual(f.cache.rank_snapshots.get('prospect'), [GUILD, 'prospect', 1, 1, OLD]);
    assert.deepEqual(f.cache.member_ranks.get('old-human'), [GUILD, 'old-human', 'prospect', OLD]);
    assert.equal(f.cache.member_exclusions.size, raids.length);
    const lastGood = structuredClone(f.cache);

    f.resetCalls();
    f.setTime(NOW);
    f.useNewRoster();
    f.setRoles(scenario.roles());
    assert.deepEqual(await f.cycle(), {
      recorded: false, reason: 'rank_role_missing', observedAt: NOW,
      humanMemberCount: null, rankedMemberCount: null, raidAccountsExcluded: null,
    });
    assert.equal(f.reads.length, raids.length, 'raid history was grounded, not an earlier refusal');
    assert.deepEqual(f.paths, [
      `/guilds/${GUILD}/members?limit=1000&after=0`, `/guilds/${GUILD}/roles`,
    ]);
    assert.equal(f.transactions, 0, 'no transaction even begins');
    assert.deepEqual(f.writes, [], 'no cache, ladder, counter, or timestamp write');
    assert.deepEqual(f.cache, lastGood, 'all last-good tables and timestamps remain unchanged');

    f.resetCalls();
    f.setTime(RECOVERED);
    // Unique normalized names still work, even with case/whitespace variation.
    f.setRoles(roles().map((role) => ({ ...role, name: ` ${role.name.toUpperCase()}\t` })));
    assert.deepEqual(await f.cycle(), {
      recorded: true, reason: undefined, observedAt: RECOVERED,
      humanMemberCount: 3, rankedMemberCount: 2, raidAccountsExcluded: raids.length,
    });
    assert.equal(f.transactions, 1);
    assert.ok(f.writes.length > 0);
    assert.deepEqual(f.cache.guild_counters.get(GUILD), [GUILD, 3, RECOVERED]);
    assert.deepEqual(f.cache.counter_snapshots.get(GUILD), [GUILD, 3, RECOVERED]);
    assert.deepEqual(f.cache.web_contract_meta.get('singleton'), [GUILD]);
    for (const rank of RANKS) {
      assert.deepEqual(f.cache.rank_ladder.get(rank.key), [rank.label, roleId(rank.key), rank.key]);
      assert.equal(f.cache.rank_snapshots.get(rank.key)?.[4], RECOVERED);
    }
    assert.equal(f.cache.member_ranks.has('old-human'), false);
    assert.equal(f.cache.member_ranks.size, 3);
    assert.deepEqual(f.cache.member_ranks.get('new-member'), [GUILD, 'new-member', 'member', RECOVERED]);
    assert.deepEqual(f.cache.member_ranks.get('new-soldier'), [GUILD, 'new-soldier', 'soldier', RECOVERED]);
    assert.deepEqual(f.cache.member_ranks.get('unranked'), [GUILD, 'unranked', null, RECOVERED]);
    for (const [i] of raids.entries()) {
      assert.deepEqual(f.cache.member_exclusions.get(`raid-${i}`), [GUILD, `raid-${i}`, RECOVERED]);
    }
  });
}
