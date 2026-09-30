import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, type MemberRow } from '../src/analytics/dashboard.ts';
import type { Anomaly } from '../src/analytics/anomalies.ts';
import type { Db, RunResult, Statement } from '../src/store/driver.ts';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const JOINED_AT = '2026-09-22T10:00:00.000Z';
const LEFT_AT = '2026-09-30T10:00:00.000Z';

type LeaveRow = { member_id: string | null; occurred_at: string };

function member(member_id: string, is_bot: boolean, left_at: string | null): MemberRow & { is_bot: boolean } {
  return {
    member_id,
    is_bot,
    joined_at: JOINED_AT,
    join_source: 'invite:good',
    gate_cleared_at: null,
    first_message_at: null,
    first_voice_at: null,
    last_active_at: null,
    left_at,
  };
}

/** Raw bot and human events stay mixed; only the members query filters bot flags. */
function fakeDb(leaves: LeaveRow[]): Db {
  const members = [
    member('human', false, leaves.find((e) => e.member_id === 'human')?.occurred_at ?? null),
    member('bot', true, LEFT_AT),
  ];
  const joins = members.map((m) => ({
    member_id: m.member_id,
    occurred_at: JOINED_AT,
    source: 'invite:good',
  }));
  const statement = (sql: string): Statement => ({
    async get<T>(): Promise<T | undefined> {
      assert.match(sql, /SELECT guild_id FROM events/);
      return { guild_id: '999' } as T;
    },
    async all<T>(): Promise<T[]> {
      if (sql.includes('FROM members')) {
        assert.match(sql, /WHERE NOT is_bot/, 'the member census must exclude known bots');
        return members.filter((m) => !m.is_bot).map((m) => ({ ...m })) as T[];
      }
      if (sql.includes("event_type = 'member_join'")) {
        return joins.map((e) => ({ ...e })) as T[];
      }
      if (sql.includes("event_type = 'member_leave'")) {
        assert.match(
          sql,
          /SELECT member_id, occurred_at FROM events/,
          'the leave collector must retain identity so raw bot departures can be excluded',
        );
        return leaves.map((e) => ({ ...e })) as T[];
      }
      if (
        sql.includes("event_type = 'voice_session_end'") ||
        sql.includes("event_type = 'gate_cleared'") ||
        sql.includes("source LIKE 'channel:%'")
      ) return [];
      throw new Error(`fakeDb: unexpected query: ${sql}`);
    },
    async run(): Promise<RunResult> {
      throw new Error('fakeDb: the dashboard never writes');
    },
  });
  const db: Db = {
    prepare: statement,
    exec: async () => { throw new Error('fakeDb: the dashboard never writes'); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>) => fn(db),
    close: async () => {},
  };
  return db;
}

const BOT_LEAVES: LeaveRow[] = [
  { member_id: 'bot', occurred_at: '2026-09-23T10:00:00.000Z' },
  { member_id: 'bot', occurred_at: LEFT_AT },
];

test('bot-only departures do not change human weekly leaves or net', async () => {
  const d = await buildDashboard(fakeDb(BOT_LEAVES), { now: NOW, weeks: 2, anomalies: [] });

  assert.deepEqual(d.thisWeek, { start: '2026-09-28', joins: 0, leaves: 0, net: 0 });
  assert.deepEqual(d.lastWeek, { start: '2026-09-21', joins: 1, leaves: 0, net: 1 });
  assert.deepEqual(d.weeks.map((w) => [w.joins, w.leaves, w.net]), [[1, 0, 1], [0, 0, 0]]);
  assert.equal(d.humansInServer, 1);
  assert.equal(d.cohorts[0].size, 1);
});

test('a real human departure counts once even though that human has left the server', async () => {
  const d = await buildDashboard(fakeDb([
    ...BOT_LEAVES,
    { member_id: 'human', occurred_at: LEFT_AT },
  ]), { now: NOW, weeks: 2, anomalies: [] });

  assert.deepEqual(d.thisWeek, { start: '2026-09-28', joins: 0, leaves: 1, net: -1 });
  assert.deepEqual(d.lastWeek, { start: '2026-09-21', joins: 1, leaves: 0, net: 1 });
  assert.equal(d.weeks[1].leaves, 1);
  assert.equal(d.weeks[1].net, -1);
  assert.equal(d.humansInServer, 0, 'departed humans still belong to the churn identity set');
});

test('anomaly-excluded human departures remain excluded from leaves and net', async () => {
  const anomalies: Anomaly[] = [{
    id: 'test-prune',
    kind: 'prune',
    start: '2026-09-30',
    end: '2026-09-30',
    eventTypes: ['member_leave'],
    status: 'confirmed',
    label: 'test prune',
    note: '',
  }];
  const d = await buildDashboard(fakeDb([
    ...BOT_LEAVES,
    { member_id: 'human', occurred_at: LEFT_AT },
  ]), { now: NOW, weeks: 2, anomalies });

  assert.deepEqual(d.thisWeek, { start: '2026-09-28', joins: 0, leaves: 0, net: 0 });
  assert.deepEqual(d.lastWeek, { start: '2026-09-21', joins: 1, leaves: 0, net: 1 });
  assert.equal(d.weeks[1].leaves, 0);
  assert.equal(d.weeks[1].net, 0);
});

test('departures without a known human identity do not invent human churn', async () => {
  const d = await buildDashboard(fakeDb([
    ...BOT_LEAVES,
    { member_id: null, occurred_at: LEFT_AT },
    { member_id: 'unknown', occurred_at: LEFT_AT },
  ]), { now: NOW, weeks: 2, anomalies: [] });

  assert.deepEqual(d.thisWeek, { start: '2026-09-28', joins: 0, leaves: 0, net: 0 });
});
