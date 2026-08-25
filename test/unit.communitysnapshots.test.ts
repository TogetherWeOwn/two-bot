import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../src/store/db.ts';
import { stubRest } from './helpers/stubRest.ts';
import {
  LIVE_COUNTER_INTERVAL_MS,
  RANK_SNAPSHOT_INTERVAL_MS,
  RANKS,
  buildCommunitySnapshot,
  runLiveCounterCycle,
  runRankSnapshotCycle,
} from '../src/jobs/communitySnapshots.ts';
import { ANOMALIES, windowBounds } from '../src/analytics/anomalies.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUILD = '326474832151838730';
const NOW = '2026-08-25T20:00:00.000Z';
const MIGRATIONS = [
  'migrations/0003_web_contract_tables.sql',
  'migrations/0005_counter_snapshots.sql',
];
const ROLE_IDS = Object.fromEntries(RANKS.map((rank) => [rank.key, `role-${rank.key}`]));

function roles() {
  return RANKS.map((rank) => ({ id: ROLE_IDS[rank.key], name: rank.label }));
}

function member(id: string, held: string[] = [], bot = false) {
  return { user: { id, bot }, joined_at: '2026-01-01T00:00:00.000Z', roles: held };
}

function raidMembers(held: string[] = []) {
  return ANOMALIES.filter((a) => a.kind === 'raid').map((_, i) => member(`raid-${i}`, held));
}

async function groundRaids(db: Db) {
  for (const [index, raid] of ANOMALIES.filter((a) => a.kind === 'raid').entries()) {
    const { from } = windowBounds(raid);
    await db
      .prepare(
        `INSERT INTO members (guild_id, member_id, joined_at, is_bot)
         VALUES (?, ?, ?, 0)`,
      )
      .run(GUILD, `raid-${index}`, from);
  }
}

async function readCount(db: Db) {
  return db
    .prepare(
      `SELECT human_member_count, human_member_count_at
         FROM guild_counters WHERE guild_id = ?`,
    )
    .get<{ human_member_count: number; human_member_count_at: string }>(GUILD);
}

describe('community snapshot arithmetic', () => {
  test('the intervals are the contract values', () => {
    assert.equal(LIVE_COUNTER_INTERVAL_MS, 60_000);
    assert.equal(RANK_SNAPSHOT_INTERVAL_MS, 600_000);
  });

  test('one pass excludes bots and raids from both counter and ranks', () => {
    const rankRoles = RANKS.map((rank) => ({ ...rank, roleId: ROLE_IDS[rank.key] }));
    const raidWindows = [{ id: 'raid', excludedMemberIds: new Set(['raid']) }];
    const snapshot = buildCommunitySnapshot(
      [
        member('prospect', [ROLE_IDS.prospect]),
        member('legend', Object.values(ROLE_IDS)),
        member('none'),
        member('raid', Object.values(ROLE_IDS)),
        member('bot', Object.values(ROLE_IDS), true),
      ],
      rankRoles,
      raidWindows,
    );

    assert.ok(snapshot);
    assert.equal(snapshot.humanMemberCount, 3);
    assert.equal(snapshot.raidAccountsExcluded, 1);
    assert.equal(snapshot.rankRows.find((rank) => rank.key === 'prospect')?.holdersCount, 2);
    assert.equal(snapshot.rankRows.find((rank) => rank.key === 'prospect')?.memberCount, 1);
    assert.equal(snapshot.rankRows.find((rank) => rank.key === 'legend')?.memberCount, 1);
    assert.equal(snapshot.rankRows.reduce((sum, rank) => sum + rank.memberCount, 0), 2);
  });

  test('a member holding a higher rank without every lower rank is not nested', () => {
    const rankRoles = RANKS.map((rank) => ({ ...rank, roleId: ROLE_IDS[rank.key] }));
    const snapshot = buildCommunitySnapshot(
      [member('broken', [ROLE_IDS.prospect, ROLE_IDS.soldier])],
      rankRoles,
      [],
    );
    assert.equal(snapshot?.nested, false);
  });
});

describe('community snapshot collector', () => {
  let db: Db;

  before(async () => {
    db = await openDb(':memory:');
    for (const path of MIGRATIONS) await db.exec(readFileSync(join(ROOT, path), 'utf8'));
  });
  after(async () => db.close());
  beforeEach(async () => {
    for (const table of [
      'events',
      'members',
      'guild_counters',
      'counter_snapshots',
      'rank_snapshots',
      'member_ranks',
      'member_exclusions',
    ]) {
      await db.exec(`DELETE FROM ${table}`);
    }
  });

  test('an ungrounded raid window publishes nothing on first run', async () => {
    const { rest } = stubRest(() => [member('human', [ROLE_IDS.prospect])]);
    const res = await runLiveCounterCycle({ db, rest, guildId: GUILD, now: () => NOW });

    assert.equal(res.recorded, false);
    assert.equal(res.reason, 'raid_history_not_grounded');
    assert.equal(await readCount(db), undefined);
    assert.equal(
      await db.prepare(`SELECT * FROM counter_snapshots WHERE guild_id = ?`).get(GUILD),
      undefined,
    );
  });

  test('a failed Discord page leaves the previous snapshot untouched', async () => {
    await groundRaids(db);
    await db
      .prepare(
        `INSERT INTO guild_counters (guild_id, human_member_count, human_member_count_at)
         VALUES (?, 54, '2026-08-25T19:00:00.000Z')`,
      )
      .run(GUILD);
    const { rest } = stubRest(() => undefined);
    const res = await runLiveCounterCycle({ db, rest, guildId: GUILD, now: () => NOW });

    assert.equal(res.recorded, false);
    assert.equal(res.reason, 'discord_read_failed');
    assert.deepEqual({ ...(await readCount(db)) }, {
      human_member_count: 54,
      human_member_count_at: '2026-08-25T19:00:00.000Z',
    });
  });

  test('the live cycle publishes the same one-pass exclusion to both cache tables', async () => {
    await groundRaids(db);
    const members = [
      member('human', [ROLE_IDS.prospect]),
      member('bot', [], true),
      ...raidMembers(),
    ];
    const { rest } = stubRest(() => members);
    const res = await runLiveCounterCycle({ db, rest, guildId: GUILD, now: () => NOW });

    assert.equal(res.recorded, true);
    assert.equal(res.humanMemberCount, 1);
    assert.equal(res.raidAccountsExcluded, 3);
    assert.equal((await readCount(db))?.human_member_count, 1);
    const audit = await db
      .prepare(`SELECT human_member_count, human_member_count_at FROM counter_snapshots`)
      .get();
    assert.deepEqual({ ...audit }, { human_member_count: 1, human_member_count_at: NOW });
  });

  test('rank cycle writes five aggregates, highest rank, and public exclusions atomically', async () => {
    await groundRaids(db);
    const members = [
      member('prospect', [ROLE_IDS.prospect]),
      member('legend', Object.values(ROLE_IDS)),
      member('none'),
      ...raidMembers(Object.values(ROLE_IDS)),
    ];
    const { rest } = stubRest((path) => (path.endsWith('/roles') ? roles() : members));
    const res = await runRankSnapshotCycle({ db, rest, guildId: GUILD, now: () => NOW });

    assert.equal(res.recorded, true);
    assert.equal(res.humanMemberCount, 3);
    assert.equal(res.rankedMemberCount, 2);
    assert.ok((res.rankedMemberCount ?? 0) <= (res.humanMemberCount ?? -1));

    const ranks = await db
      .prepare(`SELECT rank_key, member_count, holders_count FROM rank_snapshots ORDER BY rank_key`)
      .all();
    assert.equal(ranks.length, 5);
    assert.deepEqual(
      (
        await db.prepare(`SELECT member_id, rank_key FROM member_ranks ORDER BY member_id`).all()
      ).map((row) => ({ ...row })),
      [
        { member_id: 'legend', rank_key: 'legend' },
        { member_id: 'none', rank_key: null },
        { member_id: 'prospect', rank_key: 'prospect' },
      ],
    );
    assert.deepEqual(
      (await db.prepare(`SELECT member_id FROM member_exclusions ORDER BY member_id`).all()).map(
        (row) => row.member_id,
      ),
      ['raid-0', 'raid-1', 'raid-2'],
    );
  });

  test('non-nested ranks are a finding and write nothing', async () => {
    await groundRaids(db);
    const members = [
      member('broken', [ROLE_IDS.prospect, ROLE_IDS.soldier]),
      ...raidMembers(),
    ];
    const { rest } = stubRest((path) => (path.endsWith('/roles') ? roles() : members));
    const res = await runRankSnapshotCycle({ db, rest, guildId: GUILD, now: () => NOW });

    assert.equal(res.recorded, false);
    assert.equal(res.reason, 'ranks_not_nested');
    assert.deepEqual(await db.prepare(`SELECT * FROM rank_snapshots`).all(), []);
    assert.equal(await readCount(db), undefined);
  });
});
